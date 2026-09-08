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
} from '../services/deploymentService';
import { releaseLock } from '../services/lockService';
import { rollbackDeployment } from '../services/k8sService';
import { allRegions } from '../config/kubernetes';

const router = Router();

router.use(authenticateToken);

/**
 * GET /api/deployments/:id
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
 * GET /api/deployments/app/:appId
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
 * Manual rollback — triggers across ALL regions
 */
router.post(
  '/:id/rollback',
  asyncHandler(async (req, res) => {
    const deployment = await getDeploymentById(req.params.id);
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    const rollbackable: DeploymentStatus[] = ['SUCCESS', 'HEALTH_CHECK_FAILED'];
    if (!rollbackable.includes(deployment.status)) {
      res.status(400).json({ error: `Cannot rollback deployment in ${deployment.status} status` });
      return;
    }

    await updateDeploymentStatus(deployment.id, 'ROLLING_BACK');
    await logDeploymentEvent(deployment.id, 'ROLLBACK_INITIATED', 'Manual rollback triggered');

    const appResult = await pool.query('SELECT * FROM apps WHERE id = $1', [deployment.app_id]);
    const app = appResult.rows[0];

    if (deployment.manifest_json) {
      const manifest = deployment.manifest_json as any;

      // Rollback every region
      const results = await Promise.allSettled(
        allRegions.map(async (regionConfig) => {
          await rollbackDeployment(regionConfig, app.name, app.namespace || 'default', manifest);
          await logDeploymentEvent(
            deployment.id,
            'ROLLBACK_REGION_SUCCESS',
            `Rolled back in ${regionConfig.region}`
          );
        })
      );

      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        await logDeploymentEvent(deployment.id, 'ROLLBACK_REGION_FAILED', `${failed.length} region(s) failed`);
      }
    } else {
      await logDeploymentEvent(deployment.id, 'ROLLBACK_NO_MANIFEST', 'No stored manifest found');
    }

    await updateDeploymentStatus(deployment.id, 'ROLLED_BACK');
    await logDeploymentEvent(deployment.id, 'ROLLED_BACK', 'Manual rollback completed');
    await releaseLock(deployment.app_id);

    res.json({ message: 'Rollback completed', deploymentId: deployment.id });
  })
);

export default router;
