/**
 * BullMQ Build Worker
 * Processes full deployment pipeline:
 * QUEUED → CLONING → BUILDING → PUSHING → DEPLOYING → HEALTH_CHECK → SUCCESS
 *                                                         ↓
 *                                              HEALTH_CHECK_FAILED → ROLLING_BACK → ROLLED_BACK
 */
import { Worker, Queue } from 'bullmq';
import redis from '../config/redis';
import { pool } from '../config/database';
import { regionClients, primaryK8s } from '../config/kubernetes';
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
  K8sClients,
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

      // ─── 3. DEPLOYING ───
      await updateDeploymentStatus(deploymentId, 'DEPLOYING');
      await logDeploymentEvent(deploymentId, 'DEPLOYING', `Deploying image ${buildResult.imageTag}`);

      // Generate Kubernetes Manifest objects (typed JS objects)
      const host = `${appName}-${deploymentId.slice(0, 8)}.localhost`;
      const manifest = generateManifest(appName, buildResult.imageTag, namespace, host);

      // Save generated manifest in Database as JSONB
      await storeDeploymentManifest(deploymentId, manifest);
      await logDeploymentEvent(deploymentId, 'MANIFEST_STORED', 'K8s manifest stored in database');

      // Get target cluster clients
      const clients: [string, K8sClients][] = regionClients.size > 0
        ? Array.from(regionClients.entries())
        : [['us-east-1', primaryK8s]];

      // Apply K8s resources to all target regions/clusters
      for (const [region, client] of clients) {
        try {
          await ensureNamespace(client.coreApi, namespace);
          await applyManifest(client, manifest, namespace);

          const ingressHost = getIngressHost(manifest) || host;
          const healthCheckUrl = `http://${ingressHost}:8080/health`;

          await createSubDeployment(
            deploymentId,
            region,
            namespace,
            appName,
            ingressHost,
            healthCheckUrl
          );

          await logDeploymentEvent(deploymentId, 'MANIFEST_APPLIED', `Manifest applied to ${region}`);
        } catch (err: any) {
          await logDeploymentEvent(deploymentId, 'DEPLOY_FAILED', `Failed in ${region}: ${err.message}`);
          throw err;
        }
      }

      // Wait for rollout (pods ready)
      for (const [region, client] of clients) {
        try {
          await logDeploymentEvent(deploymentId, 'ROLLOUT_WAITING', `Waiting for rollout in ${region}`);
          await waitForRollout(client, appName, namespace, 300000);
          await logDeploymentEvent(deploymentId, 'ROLLOUT_COMPLETE', `Rollout complete in ${region}`);
        } catch (err: any) {
          await logDeploymentEvent(deploymentId, 'ROLLOUT_TIMEOUT', `Rollout timeout in ${region}: ${err.message}`);
          throw err;
        }
      }

      // ─── 4. HEALTH CHECK ───
      await updateDeploymentStatus(deploymentId, 'HEALTH_CHECK');
      const ingressHost = getIngressHost(manifest) || host;
      const targetHealthUrl = `http://${ingressHost}:8080/health`;
      await logDeploymentEvent(deploymentId, 'HEALTH_CHECK', `Polling ${targetHealthUrl}`);

      const healthCheckPassed = await pollHealthCheck(targetHealthUrl, {
        hostHeader: ingressHost,
        onProgress: async (attempt, maxRetries, success, msg) => {
          if (success) {
            await logDeploymentEvent(deploymentId, 'HEALTH_CHECK_PASS', `Attempt ${attempt}/${maxRetries}: ${msg}`);
          } else {
            await logDeploymentEvent(deploymentId, 'HEALTH_CHECK_RETRY', `Attempt ${attempt}/${maxRetries}: ${msg}`);
          }
        },
      });

      if (healthCheckPassed) {
        // ─── 5. SUCCESS ───
        await updateDeploymentStatus(deploymentId, 'SUCCESS');
        await logDeploymentEvent(deploymentId, 'SUCCESS', 'Deployment completed successfully and verified healthy');
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
        // ─── 6. HEALTH CHECK FAILED → ROLLBACK ───
        await updateDeploymentStatus(deploymentId, 'HEALTH_CHECK_FAILED');
        await logDeploymentEvent(
          deploymentId,
          'HEALTH_CHECK_FAILED',
          'Health check failed after maximum retries'
        );

        // Fetch last known successful deployment with stored manifest
        const previous = await getPreviousSuccessfulDeployment(appId, deploymentId);

        if (previous && previous.manifest_json) {
          await updateDeploymentStatus(deploymentId, 'ROLLING_BACK');
          await logDeploymentEvent(
            deploymentId,
            'ROLLING_BACK',
            `Initiating deterministic rollback to previous deployment (${previous.commit_sha.slice(0, 7)})`
          );

          for (const [region, client] of clients) {
            try {
              await rollbackDeployment(
                client,
                previous.manifest_json as any,
                namespace
              );
              await logDeploymentEvent(
                deploymentId,
                'ROLLBACK_SUCCESS',
                `Re-applied previous manifest successfully in ${region}`
              );
            } catch (err: any) {
              await logDeploymentEvent(
                deploymentId,
                'ROLLBACK_FAILED',
                `Failed rollback in ${region}: ${err.message}`
              );
            }
          }

          // Verify health of rolled-back deployment
          const prevIngressHost = getIngressHost(previous.manifest_json as any) || host;
          const prevHealthUrl = `http://${prevIngressHost}:8080/health`;
          await pollHealthCheck(prevHealthUrl, { hostHeader: prevIngressHost });

          await updateDeploymentStatus(deploymentId, 'ROLLED_BACK');
          await logDeploymentEvent(deploymentId, 'ROLLED_BACK', 'Automatic rollback to stable version completed');

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
