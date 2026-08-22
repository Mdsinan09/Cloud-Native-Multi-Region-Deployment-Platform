/**
 * BullMQ Build Worker (Phase 2: Multi-Region Parallel Fan-Out)
 * Processes full deployment pipeline across ALL configured regions in parallel:
 * QUEUED → CLONING → BUILDING → PUSHING → DEPLOYING → HEALTH_CHECK → SUCCESS
 *                                                         ↓
 *                                              HEALTH_CHECK_FAILED → ROLLING_BACK → ROLLED_BACK
 */
import { Worker, Queue } from 'bullmq';
import redis from '../config/redis';
import { pool } from '../config/database';
import { allRegions } from '../config/kubernetes';
import {
  updateDeploymentStatus,
  logDeploymentEvent,
  createSubDeployment,
  updateSubDeploymentStatus,
  storeDeploymentManifest,
  getPreviousSuccessfulDeployment,
} from '../services/deploymentService';
import { releaseLock } from '../services/lockService';
import { runBuild, cleanupBuildDir } from '../services/buildService';
import {
  generateManifest,
  ensureNamespace,
  applyManifest,
  waitForRollout,
  getIngressHost,
  rollbackDeployment,
} from '../services/k8sService';
import { pollHealthCheck } from '../utils/healthCheck';

// Build queue for adding jobs
export const buildQueue = new Queue('build-queue', { connection: redis });

// Worker processor
const worker = new Worker(
  'build-queue',
  async (job) => {
    const {
      deploymentId,
      appId,
      repoUrl,
      commitSha,
      appName,
      namespace = 'default',
    } = job.data;

    const registryUsername = process.env.REGISTRY_USERNAME || '';
    const buildDir = `/tmp/builds/${deploymentId}`;

    try {
      // ─── 1. CLONING ───
      await updateDeploymentStatus(deploymentId, 'CLONING');
      await logDeploymentEvent(deploymentId, 'CLONING', `Cloning ${repoUrl} at ${commitSha}`);

      // ─── 2. BUILDING & PUSHING ───
      const buildResult = await runBuild(
        {
          repoUrl,
          commitSha,
          appName,
          registryUsername,
          buildDir,
        },
        async (log) => {
          await logDeploymentEvent(deploymentId, 'BUILD_LOG', log);
        }
      );

      if (!buildResult.success) {
        throw new Error(buildResult.error || 'Build failed');
      }

      // ─── 3. MULTI-REGION PARALLEL FAN-OUT DEPLOYMENT ───
      await updateDeploymentStatus(deploymentId, 'DEPLOYING');
      await logDeploymentEvent(
        deploymentId,
        'DEPLOYING',
        `Deploying image ${buildResult.imageTag} simultaneously to ${allRegions.length} region(s) [${allRegions.map(r => r.region).join(', ')}]`
      );

      // Generate Kubernetes Manifest objects (typed JS objects)
      const host = `${appName}-${deploymentId.slice(0, 8)}.localhost`;
      const manifest = generateManifest(appName, buildResult.imageTag, namespace, host);

      // Save generated manifest in Database as JSONB
      await storeDeploymentManifest(deploymentId, manifest);
      await logDeploymentEvent(deploymentId, 'MANIFEST_STORED', 'K8s manifest stored in database');

      // Deploy to ALL regions in parallel
      const deployResults = await Promise.allSettled(
        allRegions.map(async (regionConfig) => {
          const region = regionConfig.region;
          await ensureNamespace(regionConfig, namespace);
          await applyManifest(regionConfig, manifest, namespace);

          const ingressHost = getIngressHost(manifest) || host;
          const healthCheckUrl = `http://${ingressHost}:${regionConfig.ingressPort}/health`;

          await createSubDeployment(
            deploymentId,
            region,
            namespace,
            appName,
            ingressHost,
            healthCheckUrl
          );

          await logDeploymentEvent(deploymentId, 'MANIFEST_APPLIED', `Manifest applied to ${region} (port ${regionConfig.ingressPort})`);
          return region;
        })
      );

      // Verify if any region failed during apply
      const deployErrors = deployResults.filter((r) => r.status === 'rejected');
      if (deployErrors.length > 0) {
        const firstErr = (deployErrors[0] as PromiseRejectedResult).reason;
        throw new Error(`Deployment apply failed in one or more regions: ${firstErr?.message || firstErr}`);
      }

      // ─── 4. PARALLEL ROLLOUT WAITING ───
      const rolloutResults = await Promise.allSettled(
        allRegions.map(async (regionConfig) => {
          await logDeploymentEvent(deploymentId, 'ROLLOUT_WAITING', `Waiting for rollout in ${regionConfig.region}`);
          await waitForRollout(regionConfig, appName, namespace, 300000);
          await logDeploymentEvent(deploymentId, 'ROLLOUT_COMPLETE', `Rollout complete in ${regionConfig.region}`);
          return regionConfig.region;
        })
      );

      const rolloutErrors = rolloutResults.filter((r) => r.status === 'rejected');
      if (rolloutErrors.length > 0) {
        const firstErr = (rolloutErrors[0] as PromiseRejectedResult).reason;
        throw new Error(`Rollout failed or timed out: ${firstErr?.message || firstErr}`);
      }

      // ─── 5. MULTI-REGION HEALTH CHECK PHASE ───
      await updateDeploymentStatus(deploymentId, 'HEALTH_CHECK');
      const ingressHost = getIngressHost(manifest) || host;

      const healthCheckResults = await Promise.allSettled(
        allRegions.map(async (regionConfig) => {
          const targetHealthUrl = `http://${ingressHost}:${regionConfig.ingressPort}/health`;
          await logDeploymentEvent(deploymentId, 'HEALTH_CHECK', `Polling ${regionConfig.region} at ${targetHealthUrl}`);

          const passed = await pollHealthCheck(targetHealthUrl, {
            hostHeader: ingressHost,
            fallbackPort: regionConfig.ingressPort,
            onProgress: async (attempt, maxRetries, success, msg) => {
              if (success) {
                await logDeploymentEvent(
                  deploymentId,
                  'HEALTH_CHECK_PASS',
                  `[${regionConfig.region}] Attempt ${attempt}/${maxRetries}: ${msg}`
                );
              } else {
                await logDeploymentEvent(
                  deploymentId,
                  'HEALTH_CHECK_RETRY',
                  `[${regionConfig.region}] Attempt ${attempt}/${maxRetries}: ${msg}`
                );
              }
            },
          });

          if (!passed) {
            throw new Error(`Health check failed in ${regionConfig.region} after maximum retries`);
          }

          return regionConfig.region;
        })
      );

      const allHealthy = healthCheckResults.every((r) => r.status === 'fulfilled');

      if (allHealthy) {
        // ─── 6. SUCCESS (Only when ALL regions pass) ───
        await updateDeploymentStatus(deploymentId, 'SUCCESS');
        await logDeploymentEvent(
          deploymentId,
          'SUCCESS',
          `Deployment completed successfully across ALL ${allRegions.length} regions`
        );
        await releaseLock(appId);

        // Update all sub-deployments to SUCCESS
        const subResult = await pool.query(
          'SELECT id FROM sub_deployments WHERE deployment_id = $1',
          [deploymentId]
        );
        for (const row of subResult.rows) {
          await updateSubDeploymentStatus(row.id, 'SUCCESS');
        }
      } else {
        // ─── 7. HEALTH CHECK FAILED → DETERMINISTIC MULTI-REGION ROLLBACK ───
        await updateDeploymentStatus(deploymentId, 'HEALTH_CHECK_FAILED');
        await logDeploymentEvent(
          deploymentId,
          'HEALTH_CHECK_FAILED',
          'Health check failed in one or more regions. Triggering cross-region rollback for consistency.'
        );

        // Fetch last known successful deployment with stored manifest
        const previous = await getPreviousSuccessfulDeployment(appId, deploymentId);

        if (previous && previous.manifest_json) {
          await updateDeploymentStatus(deploymentId, 'ROLLING_BACK');
          await logDeploymentEvent(
            deploymentId,
            'ROLLING_BACK',
            `Initiating parallel rollback across all regions to commit ${previous.commit_sha.slice(0, 7)}`
          );

          // Re-apply previous manifest across ALL regions in parallel
          await Promise.allSettled(
            allRegions.map(async (regionConfig) => {
              try {
                await rollbackDeployment(
                  regionConfig,
                  previous.manifest_json as any,
                  namespace
                );
                await logDeploymentEvent(
                  deploymentId,
                  'ROLLBACK_SUCCESS',
                  `Re-applied previous manifest in ${regionConfig.region}`
                );
              } catch (err: any) {
                await logDeploymentEvent(
                  deploymentId,
                  'ROLLBACK_FAILED',
                  `Rollback failed in ${regionConfig.region}: ${err.message}`
                );
              }
            })
          );

          // Verify health of rolled-back deployment in parallel
          const prevIngressHost = getIngressHost(previous.manifest_json as any) || host;
          await Promise.allSettled(
            allRegions.map(async (regionConfig) => {
              const prevHealthUrl = `http://${prevIngressHost}:${regionConfig.ingressPort}/health`;
              await pollHealthCheck(prevHealthUrl, {
                hostHeader: prevIngressHost,
                fallbackPort: regionConfig.ingressPort,
              });
            })
          );

          await updateDeploymentStatus(deploymentId, 'ROLLED_BACK');
          await logDeploymentEvent(
            deploymentId,
            'ROLLED_BACK',
            'Cross-region rollback to stable version completed'
          );

          const subResult = await pool.query(
            'SELECT id FROM sub_deployments WHERE deployment_id = $1',
            [deploymentId]
          );
          for (const row of subResult.rows) {
            await updateSubDeploymentStatus(row.id, 'ROLLED_BACK');
          }
        } else {
          await logDeploymentEvent(
            deploymentId,
            'ROLLBACK_SKIPPED',
            'No previous successful deployment found with stored manifest to roll back to'
          );
        }

        await releaseLock(appId);
      }
    } catch (err: any) {
      // ─── UNEXPECTED ERROR ───
      console.error('Build worker error:', err);
      await logDeploymentEvent(deploymentId, 'ERROR', err.message);
      await updateDeploymentStatus(deploymentId, 'HEALTH_CHECK_FAILED');
      await releaseLock(appId);
      throw err;
    } finally {
      // Clean up build directory
      await cleanupBuildDir(buildDir);
    }
  },
  {
    connection: redis,
    concurrency: 3,
  }
);

worker.on('completed', (job) => {
  console.log(`✅ Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`❌ Job ${job?.id} failed:`, err);
});

console.log('🔧 Build worker started');

export default worker;
