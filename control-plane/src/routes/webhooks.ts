/**
 * GitHub Webhooks Route
 * Handles push events from GitHub with HMAC validation
 */
import { Router, Request } from 'express';
import crypto from 'crypto';
import { pool } from '../config/database';
import { asyncHandler } from '../middleware/errorHandler';
import { rawBodyMiddleware } from '../middleware/rawBody';
import { checkIdempotency } from '../services/idempotencyService';
import { acquireLock } from '../services/lockService';
import { createDeployment, logDeploymentEvent } from '../services/deploymentService';
import { buildQueue } from '../workers/buildWorker';
import { metrics } from '../utils/metrics';

const router = Router();

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

/**
 * Validate GitHub HMAC signature
 */
function validateHmac(rawBody: string, signature?: string): boolean {
  if (!GITHUB_WEBHOOK_SECRET) {
    console.warn('⚠️ GITHUB_WEBHOOK_SECRET not set, skipping HMAC validation');
    return true;
  }

  if (!signature) {
    console.warn('⚠️ No signature header provided on webhook request');
    return false;
  }

  const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
  hmac.update(rawBody, 'utf8');
  const digest = `sha256=${hmac.digest('hex')}`;

  try {
    const digestBuffer = Buffer.from(digest);
    const signatureBuffer = Buffer.from(signature);
    if (digestBuffer.length !== signatureBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(digestBuffer, signatureBuffer);
  } catch {
    return false;
  }
}

/**
 * POST /api/webhooks/github
 * Handle GitHub push events
 */
router.post(
  '/github',
  rawBodyMiddleware,
  asyncHandler(async (req, res) => {
    const signature = req.headers['x-hub-signature-256'] as string;
    const event = req.headers['x-github-event'] as string;
    const rawBody = (req as Request & { rawBody?: string }).rawBody || '';

    // Handle GitHub ping event immediately (sent when configuring/testing webhook)
    if (event === 'ping') {
      console.log('✅ Received GitHub webhook ping event! Connection verified.');
      res.status(200).json({ status: 'ok', message: 'Pong! Webhook connected successfully' });
      return;
    }

    // Validate HMAC
    if (!validateHmac(rawBody, signature)) {
      res.status(401).json({ error: 'Invalid signature. Please ensure the secret in GitHub matches GITHUB_WEBHOOK_SECRET in .env' });
      return;
    }

    metrics.inc('webhook_received_total', { event: event || 'unknown' });

    // Only handle push events
    if (event !== 'push') {
      res.status(200).json({ message: `Ignored event: ${event}` });
      return;
    }

    const payload = JSON.parse(rawBody);
    const repoUrl = payload.repository?.clone_url;
    const repoFullName = payload.repository?.full_name;
    const commitSha = payload.after;
    const commitMessage = payload.head_commit?.message || null;
    const branch = payload.ref?.replace('refs/heads/', '') || null;

    if (!repoUrl || !commitSha) {
      res.status(400).json({ error: 'Missing repository URL or commit SHA' });
      return;
    }

    // Find app by repo URL
    const appResult = await pool.query(
      'SELECT * FROM apps WHERE repo_url = $1',
      [repoUrl]
    );

    if (appResult.rows.length === 0) {
      res.status(404).json({ error: 'No app configured for this repository' });
      return;
    }

    const app = appResult.rows[0];

    // Check idempotency
    const idempotency = await checkIdempotency(app.id, commitSha);
    if (idempotency.exists) {
      res.status(200).json({
        message: 'Deployment already exists',
        deploymentId: idempotency.deployment?.id,
      });
      return;
    }

    // Create deployment record
    const deployment = await createDeployment(app.id, commitSha, commitMessage, branch);
    await logDeploymentEvent(deployment.id, 'QUEUED', `Received push event for ${branch}`);

    // Acquire lock
    const lockAcquired = await acquireLock(app.id, deployment.id);
    if (!lockAcquired) {
      await logDeploymentEvent(deployment.id, 'LOCK_FAILED', 'Another deployment is in progress');
      res.status(423).json({ error: 'Another deployment is in progress for this app' });
      return;
    }

    // Enqueue build job
    await buildQueue.add('build', {
      deploymentId: deployment.id,
      appId: app.id,
      repoUrl,
      commitSha,
      appName: app.name,
      namespace: app.namespace || 'default',
    });

    await logDeploymentEvent(deployment.id, 'BUILD_ENQUEUED', 'Build job queued in BullMQ');

    res.status(202).json({
      message: 'Deployment queued',
      deploymentId: deployment.id,
    });
  })
);

export default router;
