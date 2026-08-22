/**
 * Regions & Cloudflare Worker Sync Routes (Phase 3)
 */
import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { allRegions } from '../config/kubernetes';
import {
  getMultiRegionRouterConfig,
  syncRegionsToCloudflareWorker,
} from '../services/trafficRouter';

const router = Router();

router.use(authenticateToken);

/**
 * GET /api/regions
 * List active cluster regions, ingress ports, and endpoint configurations
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { appName, deploymentId } = req.query;
    const routerConfig = getMultiRegionRouterConfig(
      (appName as string) || 'default-app',
      (deploymentId as string) || undefined
    );

    const regionSummaries = await Promise.all(
      allRegions.map(async (r) => {
        let clusterReady = false;
        try {
          const nodes = await r.coreApi.listNode();
          clusterReady = (nodes.body.items?.length || 0) > 0;
        } catch (_) {
          clusterReady = false;
        }

        return {
          region: r.region,
          ingressPort: r.ingressPort,
          kubeconfigPath: r.kubeconfigPath,
          endpoint: `http://127.0.0.1:${r.ingressPort}`,
          clusterReady,
        };
      })
    );

    res.json({
      totalRegions: allRegions.length,
      regions: regionSummaries,
      routerConfig,
    });
  })
);

/**
 * POST /api/regions/sync
 * Push active multi-region cluster endpoints to Cloudflare Worker KV / Admin API
 */
router.post(
  '/sync',
  asyncHandler(async (req, res) => {
    const { workerUrl, adminToken, appName, deploymentId, baseHostOverride } = req.body;

    if (!workerUrl || !adminToken) {
      res.status(400).json({
        error: 'Missing required parameters: workerUrl and adminToken are required',
      });
      return;
    }

    const syncResult = await syncRegionsToCloudflareWorker(
      workerUrl,
      adminToken,
      appName,
      deploymentId,
      baseHostOverride
    );

    if (!syncResult.success) {
      res.status(502).json({
        error: syncResult.error,
      });
      return;
    }

    res.json({
      message: 'Regions successfully synced to Cloudflare Worker',
      details: syncResult.data,
    });
  })
);

export default router;
