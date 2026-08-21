/**
 * BullMQ Build Worker
 * Processes build jobs: clone → build → push → deploy → health check
 */
import { Worker, Queue } from 'bullmq';
import redis from '../config/redis';
import { pool } from '../config/database';
import { regionClients } from '../config/kubernetes';
import {
  updateDeploymentStatus,
  logDeploymentEvent,
  createSubDeployment,
  updateSubDeploymentStatus,
  getPreviousSuccessfulDeployment,
} from '../services/deploymentService';
import { releaseLock } from '../services/lockService';
import { runBuild, cleanupBuildDir } from '../services/buildService';
import {
  generateManifest,
  ensureNamespace,
  applyManifest,
  waitForRollout,
  rollbackDeployment,
} from '../services/k8sService';

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
      namespace,
    } = job.data;

    const registryUsername = process.env.REGISTRY_USERNAME || '';
    const buildDir = `/tmp/builds/${deploymentId}`;

    try {
      // ─── CLONING ───
      await updateDeploymentStatus(deploymentId, 'CLONING');
      await logDeploymentEvent(deploymentId, 'CLONING', `Cloning ${repoUrl} at ${commitSha}`);

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

      // ─── PUSHING COMPLETE (runBuild handles BUILDING + PUSHING internally) ───
      await updateDeploymentStatus(deploymentId, 'DEPLOYING');
      await logDeploymentEvent(deploymentId, 'DEPLOYING', `Deploying image ${buildResult.imageTag}`);

      // ─── DEPLOY TO K8s ───
      const clients = Array.from(regionClients.entries());
      const host = `${appName}-${deploymentId.slice(0, 8)}.localhost`;
      const manifest = generateManifest(appName, buildResult.imageTag, namespace, host);

      for (const [region, client] of clients) {
        try {
          await ensureNamespace(client.coreApi, namespace);
          await applyManifest(client, manifest.deployment, namespace);
          await applyManifest(client, manifest.service, namespace);
          await applyManifest(client, manifest.ingress, namespace);

          await createSubDeployment(
            deploymentId,
            region,
            namespace,
            appName,
            host,
            `http://${host}:8080/health`
          );

          await logDeploymentEvent(deploymentId, 'MANIFEST_APPLIED', `Applied to ${region}`);
        } catch (err: any) {
          await logDeploymentEvent(deploymentId, 'DEPLOY_FAILED', `Failed in ${region}: ${err.message}`);
          throw err;
        }
      }

      // ─── WAIT FOR ROLLOUT ───
      for (const [region, client] of clients) {
        try {
          await waitForRollout(client, appName, namespace, 300000);
          await logDeploymentEvent(deploymentId, 'ROLLOUT_COMPLETE', `Rollout complete in ${region}`);
        } catch (err: any) {
          await logDeploymentEvent(deploymentId, 'ROLLOUT_TIMEOUT', `Timeout in ${region}: ${err.message}`);
          throw err;
        }
      }

      // ─── HEALTH CHECK ───
      await updateDeploymentStatus(deploymentId, 'HEALTH_CHECK');
      await logDeploymentEvent(deploymentId, 'HEALTH_CHECK', `Polling http://${host}:8080/health`);

      let healthCheckPassed = false;
      const maxRetries = 10;
      const retryInterval = 5000;

      for (let i = 0; i < maxRetries; i++) {
        try {
          const response = await fetch(`http://${host}:8080/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
          });

          if (response.ok) {
            healthCheckPassed = true;
            await logDeploymentEvent(deploymentId, 'HEALTH_CHECK_PASS', `Attempt ${i + 1}: ${response.status}`);
            break;
          } else {
            await logDeploymentEvent(deploymentId, 'HEALTH_CHECK_RETRY', `Attempt ${i + 1}: ${response.status}`);
          }
        } catch (err: any) {
          await logDeploymentEvent(deploymentId, 'HEALTH_CHECK_RETRY', `Attempt ${i + 1}: ${err.message}`);
        }

        await new Promise((resolve) => setTimeout(resolve, retryInterval));
      }

      if (healthCheckPassed) {
        // ─── SUCCESS ───
        await updateDeploymentStatus(deploymentId, 'SUCCESS');
        await logDeploymentEvent(deploymentId, 'SUCCESS', 'Deployment completed successfully');
        await releaseLock(appId);

        // Update sub-deployments
        const subResult = await pool.query(
          'SELECT id FROM sub_deployments WHERE deployment_id = $1',
          [deploymentId]
        );
        for (const row of subResult.rows) {
          await updateSubDeploymentStatus(row.id, 'SUCCESS');
        }
      } else {
        // ─── HEALTH CHECK FAILED → ROLLBACK ───
        await updateDeploymentStatus(deploymentId, 'HEALTH_CHECK_FAILED');
        await logDeploymentEvent(deploymentId, 'HEALTH_CHECK_FAILED', 'Health check failed after max retries');

        await updateDeploymentStatus(deploymentId, 'ROLLING_BACK');
        await logDeploymentEvent(deploymentId, 'ROLLING_BACK', 'Initiating automatic rollback');

        for (const [region, client] of clients) {
          try {
            await rollbackDeployment(client, appName, namespace);
            await logDeploymentEvent(deploymentId, 'ROLLBACK_SUCCESS', `Rolled back in ${region}`);
          } catch (err: any) {
            await logDeploymentEvent(deploymentId, 'ROLLBACK_FAILED', `Failed in ${region}: ${err.message}`);
          }
        }

        await updateDeploymentStatus(deploymentId, 'ROLLED_BACK');
        await logDeploymentEvent(deploymentId, 'ROLLED_BACK', 'Automatic rollback completed');
        await releaseLock(appId);

        const subResult = await pool.query(
          'SELECT id FROM sub_deployments WHERE deployment_id = $1',
          [deploymentId]
        );
        for (const row of subResult.rows) {
          await updateSubDeploymentStatus(row.id, 'ROLLED_BACK');
        }
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
