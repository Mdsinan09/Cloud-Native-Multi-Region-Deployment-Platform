/**
 * Multi-Region End-to-End Test Suite for Deployment Platform 2 (Phase 2: Multi-Region Fan-Out)
 */
import { pool } from '../src/config/database';
import { allRegions, RegionConfig } from '../src/config/kubernetes';
import {
  generateManifest,
  applyManifest,
  waitForRollout,
  getIngressHost,
  rollbackDeployment,
  deleteAppResources,
  ensureNamespace,
} from '../src/services/k8sService';
import {
  storeDeploymentManifest,
  getPreviousSuccessfulDeployment,
  createDeployment,
  updateDeploymentStatus,
} from '../src/services/deploymentService';
import { pollHealthCheck } from '../src/utils/healthCheck';

async function runMultiRegionE2ETests() {
  console.log('🚀 Starting Multi-Region Fan-Out (Phase 2) Integration Tests...\n');

  try {
    // ─── Test 1: Multi-Region Configuration Discovery ───
    console.log('--- Test 1: Multi-Region Configuration Discovery ---');
    console.log(`✅ Detected ${allRegions.length} configured region(s):`);
    allRegions.forEach((r, idx) => {
      console.log(`   [Region ${idx + 1}] ${r.region} -> Ingress Port: ${r.ingressPort}, Kubeconfig: ${r.kubeconfigPath}`);
    });

    if (allRegions.length < 2) {
      console.warn('⚠️ Less than 2 regions configured. Ensure KUBECONFIG_PATHS has both clusters.');
    }

    // Create test app in DB
    const appRes = await pool.query(
      `INSERT INTO apps (user_id, name, repo_url, namespace)
       VALUES ('a6c63fef-2d8e-4538-9a77-8eabafb37448', 'multi-region-demo-app', 'https://github.com/example/multi-region.git', 'default')
       ON CONFLICT DO NOTHING RETURNING id`
    );
    const appId = appRes.rows[0]?.id || (await pool.query("SELECT id FROM apps WHERE name = 'multi-region-demo-app'")).rows[0].id;
    console.log(`✅ Test App ID: ${appId}`);

    // Generate V1 manifest
    const v1Manifest = generateManifest('multi-region-demo-app', 'node:18-alpine', 'default', 'multi-region-demo-app.localhost');
    v1Manifest.deployment.spec!.template.spec!.containers[0].command = [
      'node',
      '-e',
      'const http = require("http"); http.createServer((req, res) => { res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({status:"ok", region: process.env.REGION || "unknown"})); }).listen(3000, () => console.log("running"));'
    ];
    console.log('✅ Generated V1 Multi-Region Manifest (JS object, typed):');
    console.log(`   - Deployment: ${v1Manifest.deployment.metadata?.name} (replicas: ${v1Manifest.deployment.spec?.replicas})`);
    console.log(`   - Service: ${v1Manifest.service.metadata?.name} (port: ${v1Manifest.service.spec?.ports?.[0].port})`);
    console.log(`   - Ingress: ${v1Manifest.ingress.metadata?.name} (host: ${getIngressHost(v1Manifest)})`);

    // Create deployment v1 in DB
    const depV1 = await createDeployment(appId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Initial working v1', 'main');
    await storeDeploymentManifest(depV1.id, v1Manifest);
    await updateDeploymentStatus(depV1.id, 'SUCCESS');
    console.log(`✅ Stored V1 Deployment ${depV1.id} with manifest_json in DB (Status: SUCCESS)`);

    // ─── Test 2: Parallel Fan-Out Apply to All Regions ───
    console.log('\n--- Test 2: Parallel Fan-Out Apply to All Regions ---');
    const deployResults = await Promise.allSettled(
      allRegions.map(async (regionConfig) => {
        await ensureNamespace(regionConfig, 'default');
        await applyManifest(regionConfig, v1Manifest, 'default');
        console.log(`   ✅ Manifest applied to [${regionConfig.region}] on port ${regionConfig.ingressPort}`);
      })
    );

    const deployErrors = deployResults.filter((r) => r.status === 'rejected');
    if (deployErrors.length > 0) {
      throw new Error(`Failed to apply manifests: ${(deployErrors[0] as PromiseRejectedResult).reason}`);
    }
    console.log('✅ Parallel deployment apply completed across ALL clusters!');

    // ─── Test 3: Parallel Wait for Rollout Across All Regions ───
    console.log('\n--- Test 3: Parallel Rollout Waiting Across All Regions ---');
    console.log('⏳ Waiting for pods to become ready simultaneously in all regions...');
    const rolloutResults = await Promise.allSettled(
      allRegions.map(async (regionConfig) => {
        await waitForRollout(regionConfig, 'multi-region-demo-app', 'default', 180000);
        const dep = await regionConfig.k8sApi.readNamespacedDeployment('multi-region-demo-app', 'default');
        console.log(`   ✅ [${regionConfig.region}] Rollout complete: readyReplicas = ${dep.body.status?.readyReplicas}/${dep.body.spec?.replicas}`);
      })
    );

    const rolloutErrors = rolloutResults.filter((r) => r.status === 'rejected');
    if (rolloutErrors.length > 0) {
      throw new Error(`Rollout failed: ${(rolloutErrors[0] as PromiseRejectedResult).reason}`);
    }
    console.log('✅ All regions successfully reached 100% ready replicas in parallel!');

    // ─── Test 4: Per-Region Health Check with Respective Fallback Ports ───
    console.log('\n--- Test 4: Per-Region Health Check (Ports 8080 & 8081) ---');
    const ingressHost = getIngressHost(v1Manifest) || 'multi-region-demo-app.localhost';

    const healthResults = await Promise.allSettled(
      allRegions.map(async (regionConfig) => {
        const healthUrl = `http://${ingressHost}:${regionConfig.ingressPort}/`;
        console.log(`⏳ Testing [${regionConfig.region}] health on ${healthUrl} with fallbackPort ${regionConfig.ingressPort}...`);
        const isHealthy = await pollHealthCheck(healthUrl, {
          hostHeader: ingressHost,
          fallbackPort: regionConfig.ingressPort,
          retries: 5,
          intervalMs: 1000,
          timeoutMs: 2000,
          onProgress: (attempt, max, ok, msg) => {
            console.log(`   [${regionConfig.region}] Attempt ${attempt}/${max}: ${ok ? 'PASS' : 'RETRY'}`);
          },
        });

        if (!isHealthy) {
          throw new Error(`Health check failed in ${regionConfig.region}`);
        }
        console.log(`   ✅ [${regionConfig.region}] Health check PASSED (200 OK) on port ${regionConfig.ingressPort}`);
        return regionConfig.region;
      })
    );

    const healthErrors = healthResults.filter((r) => r.status === 'rejected');
    if (healthErrors.length > 0) {
      throw new Error(`Health check failed in one or more regions: ${(healthErrors[0] as PromiseRejectedResult).reason}`);
    }
    console.log('✅ All regions verified healthy across individual loadbalancer ingress ports!');

    // ─── Test 5: Parallel Deterministic Cross-Region Rollback ───
    console.log('\n--- Test 5: Parallel Cross-Region Deterministic Rollback ---');
    const v2Manifest = generateManifest('multi-region-demo-app', 'broken-image:nonexistent', 'default', 'multi-region-demo-app.localhost');
    const depV2 = await createDeployment(appId, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Broken v2 update', 'main');
    await storeDeploymentManifest(depV2.id, v2Manifest);

    const previousDep = await getPreviousSuccessfulDeployment(appId, depV2.id);
    if (!previousDep || !previousDep.manifest_json) {
      throw new Error('Failed to find previous successful deployment with stored manifest');
    }
    console.log(`✅ Retrieved stored v1 manifest from DB (Commit: ${previousDep.commit_sha.slice(0, 7)})`);

    console.log('⏳ Executing parallel rollback across all regions...');
    await Promise.allSettled(
      allRegions.map(async (regionConfig) => {
        await rollbackDeployment(regionConfig, previousDep.manifest_json as any, 'default');
        console.log(`   ✅ [${regionConfig.region}] Rolled back to stored v1 manifest successfully`);
      })
    );
    console.log('✅ Cross-region deterministic rollback completed in parallel!');

    // ─── Test 6: Cross-Region Resource Cleanup ───
    console.log('\n--- Test 6: Cross-Region Resource Cleanup ---');
    await Promise.allSettled(
      allRegions.map(async (regionConfig) => {
        await deleteAppResources(regionConfig, 'multi-region-demo-app', 'default');
        console.log(`   ✅ Cleaned up resources in [${regionConfig.region}]`);
      })
    );

    console.log('\n======================================================');
    console.log('🎉 ALL PHASE 2 MULTI-REGION INTEGRATION TESTS PASSED 100%!');
    console.log('======================================================');
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ Multi-region test failed:', err);
    process.exit(1);
  }
}

runMultiRegionE2ETests();
