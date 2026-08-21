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
import { regionClients } from '../config/kubernetes';
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

    // Rollback in each region
    const clients = Array.from(regionClients.entries());
    for (const [region, client] of clients) {
      try {
        await rollbackDeployment(client, app.name, app.namespace || 'default');
        await logDeploymentEvent(deployment.id, 'ROLLBACK_REGION_SUCCESS', `Rolled back in ${region}`);
      } catch (err: any) {
        await logDeploymentEvent(deployment.id, 'ROLLBACK_REGION_FAILED', `Failed in ${region}: ${err.message}`);
      }
    }

    await updateDeploymentStatus(deployment.id, 'ROLLED_BACK');
    await logDeploymentEvent(deployment.id, 'ROLLED_BACK', 'Rollback completed');
    await releaseLock(deployment.app_id);

    res.json({ message: 'Rollback completed', deploymentId: deployment.id });
  })
);

export default router;
