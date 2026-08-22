/**
 * Deployments Routes
 */
import { Router } from 'express';
import { pool } from '../config/database';
import { authenticateToken } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthenticatedRequest, DeploymentStatus } from '../types';
import {
  getDeploymentById,
  getDeploymentEvents,
  getSubDeployments,
  getDeploymentsByAppId,
  updateDeploymentStatus,
  logDeploymentEvent,
  getPreviousSuccessfulDeployment,
} from '../services/deploymentService';
import { releaseLock } from '../services/lockService';
import { regionClients, primaryK8s } from '../config/kubernetes';
import { rollbackDeployment, K8sClients } from '../services/k8sService';

const router = Router();

router.use(authenticateToken);

/**
 * GET /api/deployments/:id
 * Get full deployment with events and sub-deployments
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const deployment = await getDeploymentById(req.params.id);
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    const events = await getDeploymentEvents(req.params.id);
    const subDeployments = await getSubDeployments(req.params.id);

    res.json({
      ...deployment,
      events,
      subDeployments,
    });
  })
);

/**
 * GET /api/apps/:id/deployments
 * List deployments for an app
 */
router.get(
  '/app/:appId',
  asyncHandler(async (req, res) => {
    const deployments = await getDeploymentsByAppId(req.params.appId);
    res.json(deployments);
  })
);

/**
 * POST /api/deployments/:id/rollback
 * Manual rollback trigger
 */
router.post(
  '/:id/rollback',
  asyncHandler(async (req, res) => {
    const deployment = await getDeploymentById(req.params.id);
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    // Can only rollback failed or successful deployments
    const rollbackable: DeploymentStatus[] = ['SUCCESS', 'HEALTH_CHECK_FAILED'];
    if (!rollbackable.includes(deployment.status)) {
      res.status(400).json({ error: `Cannot rollback deployment in ${deployment.status} status` });
      return;
    }

    await updateDeploymentStatus(deployment.id, 'ROLLING_BACK');
    await logDeploymentEvent(deployment.id, 'ROLLBACK_INITIATED', 'Manual rollback triggered');

    // Get app info
    const appResult = await pool.query('SELECT * FROM apps WHERE id = $1', [deployment.app_id]);
    const app = appResult.rows[0];

    // Find previous successful deployment with stored manifest
    const targetDeployment = await getPreviousSuccessfulDeployment(deployment.app_id, deployment.id);
    if (!targetDeployment || !targetDeployment.manifest_json) {
      res.status(400).json({ error: 'No previous successful deployment with stored manifest available to rollback to' });
      return;
    }

    // Rollback in each region
    const clients: [string, K8sClients][] = regionClients.size > 0
      ? Array.from(regionClients.entries())
      : [['us-east-1', primaryK8s]];

    for (const [region, client] of clients) {
      try {
        await rollbackDeployment(client, targetDeployment.manifest_json as any, app.namespace || 'default');
        await logDeploymentEvent(deployment.id, 'ROLLBACK_REGION_SUCCESS', `Rolled back in ${region} to commit ${targetDeployment.commit_sha.slice(0, 7)}`);
      } catch (err: any) {
        await logDeploymentEvent(deployment.id, 'ROLLBACK_REGION_FAILED', `Failed in ${region}: ${err.message}`);
      }
    }

    await updateDeploymentStatus(deployment.id, 'ROLLED_BACK');
    await logDeploymentEvent(deployment.id, 'ROLLED_BACK', `Rollback completed to ${targetDeployment.commit_sha.slice(0, 7)}`);
    await releaseLock(deployment.app_id);

    res.json({
      message: 'Rollback completed',
      deploymentId: deployment.id,
      rolledBackTo: targetDeployment.id,
      commitSha: targetDeployment.commit_sha,
    });
  })
);

export default router;
