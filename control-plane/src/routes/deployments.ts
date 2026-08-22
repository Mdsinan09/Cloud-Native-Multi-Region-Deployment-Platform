/**
 * Deployments Routes (Phase 2: Multi-Region Support)
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
  updateSubDeploymentStatus,
} from '../services/deploymentService';
import { releaseLock } from '../services/lockService';
import { allRegions } from '../config/kubernetes';
import { rollbackDeployment } from '../services/k8sService';

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
 * Manual rollback trigger across ALL regions in parallel
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
    await logDeploymentEvent(deployment.id, 'ROLLBACK_INITIATED', 'Manual rollback triggered across all regions');

    // Get app info
    const appResult = await pool.query('SELECT * FROM apps WHERE id = $1', [deployment.app_id]);
    const app = appResult.rows[0];

    // Find previous successful deployment with stored manifest
    const targetDeployment = await getPreviousSuccessfulDeployment(deployment.app_id, deployment.id);
    if (!targetDeployment || !targetDeployment.manifest_json) {
      res.status(400).json({ error: 'No previous successful deployment with stored manifest available to rollback to' });
      return;
    }

    // Rollback across ALL configured regions using Promise.allSettled
    await Promise.allSettled(
      allRegions.map(async (regionConfig) => {
        try {
          await rollbackDeployment(
            regionConfig,
            targetDeployment.manifest_json as any,
            app.namespace || 'default'
          );
          await logDeploymentEvent(
            deployment.id,
            'ROLLBACK_REGION_SUCCESS',
            `Rolled back in ${regionConfig.region} to commit ${targetDeployment.commit_sha.slice(0, 7)}`
          );
        } catch (err: any) {
          await logDeploymentEvent(
            deployment.id,
            'ROLLBACK_REGION_FAILED',
            `Failed in ${regionConfig.region}: ${err.message}`
          );
        }
      })
    );

    await updateDeploymentStatus(deployment.id, 'ROLLED_BACK');
    await logDeploymentEvent(
      deployment.id,
      'ROLLED_BACK',
      `Manual rollback completed across all regions to ${targetDeployment.commit_sha.slice(0, 7)}`
    );

    // Update sub-deployments
    const subResult = await pool.query(
      'SELECT id FROM sub_deployments WHERE deployment_id = $1',
      [deployment.id]
    );
    for (const row of subResult.rows) {
      await updateSubDeploymentStatus(row.id, 'ROLLED_BACK');
    }

    await releaseLock(deployment.app_id);

    res.json({
      message: 'Rollback completed across all regions',
      deploymentId: deployment.id,
      rolledBackTo: targetDeployment.id,
      commitSha: targetDeployment.commit_sha,
    });
  })
);

export default router;
