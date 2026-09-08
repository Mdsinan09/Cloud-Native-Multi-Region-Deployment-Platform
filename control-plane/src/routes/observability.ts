/**
 * Observability Routes
 * Pod logs, pod status, and metrics for deployments.
 */
import { Router } from 'express';
import { pool } from '../config/database';
import { authenticateToken } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import {
  getPodLogs,
  getDeploymentPods,
  getPodMetrics,
  getTopPods,
} from '../services/k8sService';
import { allRegions } from '../config/kubernetes';

const router = Router();

router.use(authenticateToken);

/**
 * GET /api/deployments/:id/pods
 * List pods for a deployment. Query: ?region=us-east-1 (optional).
 * If no region specified, returns pods from ALL regions.
 */
router.get(
  '/:id/pods',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const regionQuery = req.query.region as string | undefined;

    // Fetch deployment + app
    const depResult = await pool.query('SELECT * FROM deployments WHERE id = $1', [id]);
    const deployment = depResult.rows[0];
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    const appResult = await pool.query('SELECT * FROM apps WHERE id = $1', [deployment.app_id]);
    const app = appResult.rows[0];

    const regionsToQuery = regionQuery
      ? [regionQuery]
      : allRegions.map((r) => r.region);

    const results = await Promise.all(
      regionsToQuery.map(async (region) => {
        try {
          const pods = await getDeploymentPods(app.name, app.namespace || 'default', region);
          return { region, pods, error: null };
        } catch (err: any) {
          return { region, pods: [], error: err.message };
        }
      })
    );

    res.json({ deploymentId: id, regions: results });
  })
);

/**
 * GET /api/deployments/:id/logs
 * Get logs from a pod. Query: ?region=us-east-1&tailLines=100&previous=false
 */
router.get(
  '/:id/logs',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const region = req.query.region as string;
    const tailLines = parseInt(req.query.tailLines as string || '100', 10);
    const previous = req.query.previous === 'true';
    const container = req.query.container as string | undefined;

    if (!region) {
      res.status(400).json({ error: 'region query param is required' });
      return;
    }

    const depResult = await pool.query('SELECT * FROM deployments WHERE id = $1', [id]);
    const deployment = depResult.rows[0];
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    const appResult = await pool.query('SELECT * FROM apps WHERE id = $1', [deployment.app_id]);
    const app = appResult.rows[0];

    // Find a running pod to get logs from
    const pods = await getDeploymentPods(app.name, app.namespace || 'default', region);
    const targetPod = pods.find((p) => p.status === 'Running') || pods[0];

    if (!targetPod) {
      res.status(404).json({ error: 'No pods found in this region' });
      return;
    }

    const logs = await getPodLogs(targetPod.name, app.namespace || 'default', region, {
      container,
      tailLines,
      previous,
      timestamps: true,
    });

    res.json({
      logs,
      podName: targetPod.name,
      region,
      tailLines,
      previous,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * GET /api/deployments/:id/metrics
 * Get CPU/memory metrics for a pod. Query: ?region=us-east-1&pod=<name>
 */
router.get(
  '/:id/metrics',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const region = req.query.region as string;
    const podName = req.query.pod as string;

    if (!region) {
      res.status(400).json({ error: 'region query param is required' });
      return;
    }

    const depResult = await pool.query('SELECT * FROM deployments WHERE id = $1', [id]);
    const deployment = depResult.rows[0];
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    const appResult = await pool.query('SELECT * FROM apps WHERE id = $1', [deployment.app_id]);
    const app = appResult.rows[0];

    let targetPodName = podName;
    if (!targetPodName) {
      const pods = await getDeploymentPods(app.name, app.namespace || 'default', region);
      const running = pods.find((p) => p.status === 'Running');
      targetPodName = running?.name || pods[0]?.name;
    }

    if (!targetPodName) {
      res.status(404).json({ error: 'No pods found', available: false });
      return;
    }

    const metrics = await getPodMetrics(targetPodName, app.namespace || 'default', region);

    if (metrics) {
      res.json({ ...metrics, podName: targetPodName, region, available: true });
    } else {
      res.json({
        podName: targetPodName,
        region,
        available: false,
        message: 'Metrics-server not installed or pod has no metrics yet',
      });
    }
  })
);

/**
 * GET /api/deployments/:id/top
 * Get top pods (CPU/memory) for a deployment. Query: ?region=us-east-1
 */
router.get(
  '/:id/top',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const region = req.query.region as string;

    if (!region) {
      res.status(400).json({ error: 'region query param is required' });
      return;
    }

    const depResult = await pool.query('SELECT * FROM deployments WHERE id = $1', [id]);
    const deployment = depResult.rows[0];
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    const appResult = await pool.query('SELECT * FROM apps WHERE id = $1', [deployment.app_id]);
    const app = appResult.rows[0];

    const top = await getTopPods(app.name, app.namespace || 'default', region);
    res.json({ region, pods: top, available: top.length > 0 });
  })
);

export default router;
