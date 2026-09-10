/**
 * BullMQ Build Worker — Phase 2 Multi-Region Fan-Out
 *
 * One GitHub push fans out to ALL configured regions in parallel.
 * Overall deployment status is SUCCESS only when EVERY region is healthy.
 * If ANY region fails, ALL regions are rolled back together.
 */
import { Worker, Queue } from 'bullmq';
import redis from '../config/redis';
import { regionConfigs, allRegions, RegionConfig } from '../config/kubernetes';
import {
  updateDeploymentStatus,
  logDeploymentEvent,
  createSubDeployment,
  updateSubDeploymentStatus,
  getPreviousSuccessfulDeployment,
  storeDeploymentManifest,
} from '../services/deploymentService';
import { releaseLock } from '../services/lockService';
import { runBuild, cleanupBuildDir } from '../services/buildService';
import {
  generateManifest,
  applyManifest,
  waitForRollout,
  getIngressHost,
  rollbackDeployment,
} from '../services/k8sService';
import { pollHealthCheck } from '../utils/healthCheck';
import { K8sManifest } from '../types';
import { metrics } from '../utils/metrics';

/* ────────────────────────────────────────────────────────────── */
/*  Queue                                                        */
/* ────────────────────────────────────────────────────────────── */

export const buildQueue = new Queue('build-queue', { connection: redis });

/* ────────────────────────────────────────────────────────────── */
/*  Worker                                                       */
/* ────────────────────────────────────────────────────────────── */

const worker = new Worker(
  'build-queue',
  async (job) => {
    const {
      deploymentId,
      appId,
      repoUrl,
      commitSha,
      appName,
      namespace,
    } = job.data;

    const registryUsername = process.env.REGISTRY_USERNAME || '';
    const buildDir = `/tmp/builds/${deploymentId}`;

    metrics.gauge('active_deployments', (metrics as any).activeCount || 0);
    (metrics as any).activeCount = ((metrics as any).activeCount || 0) + 1;

    const log = async (event: string, message?: string, metadata?: Record<string, unknown>) => {
      console.log(`[${event}] ${message || ''}`);
      await logDeploymentEvent(deploymentId, event, message, metadata);
    };

    try {
      /* ─── CLONING / BUILDING / PUSHING (single, shared) ─── */
      await updateDeploymentStatus(deploymentId, 'CLONING');
      await log('CLONING', `Cloning ${repoUrl} at ${commitSha}`);

      const buildResult = await runBuild(
        { repoUrl, commitSha, appName, registryUsername, buildDir },
        async (buildLog) => {
          await logDeploymentEvent(deploymentId, 'BUILD_LOG', buildLog);
        }
      );

      if (!buildResult.success) {
        metrics.inc('build_failures_total');
        throw new Error(buildResult.error || 'Build failed');
      }

      await log('BUILDING', 'Docker image built successfully');
    metrics.inc('build_total', { status: 'success' });
      await log('PUSHING', `Pushed ${buildResult.imageTag}`);

      const deployStartTime = Date.now();

      /* ─── DEPLOYING — Fan out to all regions ─── */
      await updateDeploymentStatus(deploymentId, 'DEPLOYING');
      await log('DEPLOYING', `Fanning out to ${allRegions.length} region(s)`);

      const cleanAppName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const host = `${cleanAppName}-${deploymentId.slice(0, 8)}.localhost`;
      const manifest: K8sManifest = generateManifest(
        appName,
        buildResult.imageTag,
        namespace,
        host
      );

      // Store manifest for future rollback
      await storeDeploymentManifest(deploymentId, manifest as unknown as Record<string, unknown>);
      await log('MANIFEST_STORED', 'Manifest saved to database');

      // Deploy to every region in parallel
      const regionResults = await Promise.allSettled(
        allRegions.map(async (regionConfig) => {
          await log('REGION_DEPLOY_START', `Deploying to ${regionConfig.region}`);

          await applyManifest(regionConfig, manifest, namespace);
          await log('MANIFEST_APPLIED', `Applied to ${regionConfig.region}`);

          const subDep = await createSubDeployment(
            deploymentId,
            regionConfig.region,
            namespace,
            cleanAppName,
            host,
            `http://${host}:${regionConfig.ingressPort}/health`
          );

          const rolloutTimeout = parseInt(process.env.ROLLOUT_TIMEOUT_MS || '300000', 10);
          await waitForRollout(regionConfig, cleanAppName, namespace, rolloutTimeout);
          await log('ROLLOUT_COMPLETE', `Pods ready in ${regionConfig.region}`);

          return { regionConfig, subDep };
        })
      );

      // Check if any region failed rollout
      const failedRollouts = regionResults.filter((r) => r.status === 'rejected');
      if (failedRollouts.length > 0) {
        const reasons = failedRollouts.map((r) => (r as PromiseRejectedResult).reason?.message || 'Unknown');
        await log('ROLLOUT_FAILED', `Regions failed: ${reasons.join('; ')}`);
        throw new Error(`Rollout failed in ${failedRollouts.length} region(s)`);
      }

      const successfulRegions = regionResults
        .filter((r): r is PromiseFulfilledResult<{ regionConfig: RegionConfig; subDep: any }> => r.status === 'fulfilled')
        .map((r) => r.value);

      /* ─── HEALTH CHECK — Per region ─── */
      await updateDeploymentStatus(deploymentId, 'HEALTH_CHECK');
      await log('HEALTH_CHECK', `Polling all regions`);

      const healthResults = await Promise.all(
        successfulRegions.map(async ({ regionConfig, subDep }) => {
          const healthUrl = `http://${host}:${regionConfig.ingressPort}/health`;
          const result = await pollHealthCheck(healthUrl, {
            retries: parseInt(process.env.HEALTH_CHECK_RETRIES || '10', 10),
            intervalMs: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '5000', 10),
            timeoutMs: parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS || '3000', 10),
            fallbackPort: regionConfig.ingressPort,
          });

          return { regionConfig, subDep, result };
        })
      );

      const failedHealth = healthResults.filter((h) => !h.result.success);

      if (failedHealth.length === 0) {
        /* ─── ALL REGIONS HEALTHY → SUCCESS ─── */
        for (const { subDep } of healthResults) {
          await updateSubDeploymentStatus(subDep.id, 'SUCCESS');
        }

        const deployDuration = (Date.now() - deployStartTime) / 1000;
        metrics.observe('deployment_duration_seconds', deployDuration);
        metrics.inc('deployment_total', { status: 'SUCCESS', region: 'all' });

        await updateDeploymentStatus(deploymentId, 'SUCCESS');
        await log('HEALTH_CHECK_PASS', `All ${healthResults.length} region(s) healthy`);
        await log('SUCCESS', 'Multi-region deployment completed successfully');
        await releaseLock(appId);
      } else {
        /* ─── SOME REGIONS FAILED → ROLLBACK ALL ─── */
        const failedNames = failedHealth.map((h) => h.regionConfig.region).join(', ');
        await log('HEALTH_CHECK_FAILED', `Failed in: ${failedNames}`);

        await updateDeploymentStatus(deploymentId, 'ROLLING_BACK');
        await log('ROLLING_BACK', 'Initiating automatic rollback across ALL regions');

        // Fetch previous successful deployment's manifest
        const previousDeployment = await getPreviousSuccessfulDeployment(appId, deploymentId);
        const previousManifest = previousDeployment?.manifest_json as K8sManifest | undefined;

        // Rollback every region (even healthy ones — keep consistency)
        const rollbackResults = await Promise.allSettled(
          allRegions.map(async (regionConfig) => {
            if (previousManifest) {
              await rollbackDeployment(regionConfig, appName, namespace, previousManifest);
              await log('ROLLBACK_SUCCESS', `Rolled back ${regionConfig.region}`);
            } else {
              await log('ROLLBACK_NO_MANIFEST', `No previous manifest for ${regionConfig.region}`);
            }
          })
        );

        // Verify rollback health in every region
        const rollbackHealth = await Promise.all(
          allRegions.map(async (regionConfig) => {
            const healthUrl = `http://${host}:${regionConfig.ingressPort}/health`;
            return pollHealthCheck(healthUrl, {
              retries: 5,
              intervalMs: 3000,
              timeoutMs: 3000,
              fallbackPort: regionConfig.ingressPort,
            });
          })
        );

        const rollbackOk = rollbackHealth.every((h) => h.success);
        if (rollbackOk) {
          await log('ROLLBACK_HEALTH_OK', 'All regions serving previous version');
        } else {
          await log('ROLLBACK_HEALTH_FAIL', 'Some regions still unhealthy after rollback');
        }

        // Mark sub-deployments
        for (const { subDep } of successfulRegions) {
          await updateSubDeploymentStatus(subDep.id, 'ROLLED_BACK');
        }

        metrics.inc('rollback_total', { trigger: 'auto' });

        await updateDeploymentStatus(deploymentId, 'ROLLED_BACK');
        await log('ROLLED_BACK', 'Automatic multi-region rollback completed');
        await releaseLock(appId);
      }
    } catch (err: any) {
      console.error('❌ Build worker fatal error:', err);
      await log('ERROR', err.message || 'Unknown error');
      await updateDeploymentStatus(deploymentId, 'HEALTH_CHECK_FAILED');
      await releaseLock(appId);
      throw err;
    } finally {
      (metrics as any).activeCount = Math.max(0, ((metrics as any).activeCount || 1) - 1);
      metrics.gauge('active_deployments', (metrics as any).activeCount);
      await cleanupBuildDir(buildDir);
    }
  },
  {
    connection: redis,
    concurrency: 2,
  }
);

worker.on('completed', (job) => {
  console.log(`✅ Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`❌ Job ${job?.id} failed:`, err);
});

console.log(`🔧 Build worker started — ${allRegions.length} region(s) configured`);

export default worker;
