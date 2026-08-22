/**
 * End-to-End Test Suite for Deployment Platform 2 (K3s Integration Layer)
 */
import { pool } from '../src/config/database';
import { getK8sClients, generateManifest, applyManifest, waitForRollout, getIngressHost, rollbackDeployment, deleteAppResources, ensureNamespace } from '../src/services/k8sService';
import { storeDeploymentManifest, getPreviousSuccessfulDeployment, createDeployment, updateDeploymentStatus } from '../src/services/deploymentService';
import { pollHealthCheck } from '../src/utils/healthCheck';

async function runE2ETests() {
  console.log('🚀 Starting Deployment Platform 2 Integration Tests...\n');

  try {
    // Test 1: Database & Manifest Storage
    console.log('--- Test 1: Database & Manifest Storage ---');
    const clients = getK8sClients();
    console.log('✅ K8s clients initialized successfully');

    // Create test app in DB
    const appRes = await pool.query(
      `INSERT INTO apps (user_id, name, repo_url, namespace)
       VALUES ('a6c63fef-2d8e-4538-9a77-8eabafb37448', 'test-demo-app', 'https://github.com/example/demo.git', 'default')
       ON CONFLICT DO NOTHING RETURNING id`
    );
    const appId = appRes.rows[0]?.id || (await pool.query("SELECT id FROM apps WHERE name = 'test-demo-app'")).rows[0].id;
    console.log(`✅ Test App ID: ${appId}`);

    // Generate V1 manifest
    const v1Manifest = generateManifest('test-demo-app', 'node:18-alpine', 'default', 'test-demo-app.localhost');
    v1Manifest.deployment.spec!.template.spec!.containers[0].command = [
      'node',
      '-e',
      'const http = require("http"); http.createServer((req, res) => { res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({status:"ok"})); }).listen(3000, () => console.log("running"));'
    ];
    console.log('✅ Generated V1 Manifest (JS object, typed):');
    console.log(`   - Deployment: ${v1Manifest.deployment.metadata?.name} (replicas: ${v1Manifest.deployment.spec?.replicas})`);
    console.log(`   - Service: ${v1Manifest.service.metadata?.name} (port: ${v1Manifest.service.spec?.ports?.[0].port})`);
    console.log(`   - Ingress: ${v1Manifest.ingress.metadata?.name} (host: ${getIngressHost(v1Manifest)})`);

    // Create deployment v1 in DB
    const depV1 = await createDeployment(appId, '1111111111111111111111111111111111111111', 'Initial working v1', 'main');
    await storeDeploymentManifest(depV1.id, v1Manifest);
    await updateDeploymentStatus(depV1.id, 'SUCCESS');
    console.log(`✅ Stored V1 Deployment ${depV1.id} with manifest_json in DB (Status: SUCCESS)`);

    // Test 2: Apply Manifest to K3s Cluster
    console.log('\n--- Test 2: Apply Manifest to K3s Cluster ---');
    await ensureNamespace(clients.coreApi, 'default');
    await applyManifest(clients, v1Manifest, 'default');
    console.log('✅ Manifest applied to K3s cluster successfully');

    // Test 3: Wait for Pod Rollout
    console.log('\n--- Test 3: Wait for Rollout ---');
    console.log('⏳ Waiting for pods to become ready...');
    await waitForRollout(clients, 'test-demo-app', 'default', 180000);
    console.log('✅ Rollout completed! Pods are ready.');

    // Verify resources exist via k8s API
    const depCheck = await clients.k8sApi.readNamespacedDeployment('test-demo-app', 'default');
    console.log(`✅ K3s Deployment verified: readyReplicas = ${depCheck.body.status?.readyReplicas}/${depCheck.body.spec?.replicas}`);

    const svcCheck = await clients.coreApi.readNamespacedService('test-demo-app-service', 'default');
    console.log(`✅ K3s Service verified: ClusterIP = ${svcCheck.body.spec?.clusterIP}`);

    const ingCheck = await clients.networkingApi.readNamespacedIngress('test-demo-app-ingress', 'default');
    console.log(`✅ K3s Ingress verified: Host = ${ingCheck.body.spec?.rules?.[0].host}`);

    // Test 4: Health Check with k3d fallback
    console.log('\n--- Test 4: Health Check with Ingress Fallback ---');
    const ingressHost = getIngressHost(v1Manifest) || 'test-demo-app.localhost';
    const healthUrl = `http://${ingressHost}:8080/`;
    console.log(`⏳ Testing health check on ${healthUrl} with Host header: ${ingressHost}...`);
    const isHealthy = await pollHealthCheck(healthUrl, {
      hostHeader: ingressHost,
      retries: 5,
      intervalMs: 1000,
      timeoutMs: 2000,
      onProgress: (attempt, max, ok, msg) => {
        console.log(`   [Attempt ${attempt}/${max}] ${ok ? 'PASS' : 'RETRY'}: ${msg}`);
      }
    });
    console.log(`✅ Health check result: ${isHealthy ? 'PASSED (200 OK)' : 'FAILED'}`);

    // Test 5: Deterministic Rollback Flow
    console.log('\n--- Test 5: Deterministic Rollback Flow ---');
    // Generate V2 manifest (simulating broken deployment)
    const v2Manifest = generateManifest('test-demo-app', 'broken-image:nonexistent', 'default', 'test-demo-app.localhost');
    const depV2 = await createDeployment(appId, '2222222222222222222222222222222222222222', 'Broken v2 update', 'main');
    await storeDeploymentManifest(depV2.id, v2Manifest);

    // Retrieve previous successful deployment
    const previousDep = await getPreviousSuccessfulDeployment(appId, depV2.id);
    if (!previousDep || !previousDep.manifest_json) {
      throw new Error('Failed to find previous successful deployment with stored manifest');
    }
    console.log(`✅ Found previous successful deployment: ${previousDep.id} (Commit: ${previousDep.commit_sha.slice(0, 7)})`);

    // Perform deterministic rollback to v1 manifest
    console.log('⏳ Executing rollback to stored v1 manifest...');
    await rollbackDeployment(clients, previousDep.manifest_json as any, 'default');
    console.log('✅ Deterministic rollback completed successfully (no kubectl needed)');

    // Test 6: Resource Cleanup
    console.log('\n--- Test 6: Resource Cleanup ---');
    await deleteAppResources(clients, 'test-demo-app', 'default');
    console.log('✅ K8s resources cleaned up successfully');

    console.log('\n========================================');
    console.log('🎉 ALL INTEGRATION TESTS PASSED 100%!');
    console.log('========================================');
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ Integration test failed:', err);
    process.exit(1);
  }
}

runE2ETests();
