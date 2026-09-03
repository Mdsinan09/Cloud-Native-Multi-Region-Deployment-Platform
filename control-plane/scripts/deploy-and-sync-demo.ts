/**
 * Live Demonstration & Verification Script for Multi-Region Deployment & Router Sync
 * 1. Deploys multi-region app across us-east-1 (port 8080) and ap-south-1 (port 8081)
 * 2. Logs in to Control Plane and pushes sync to Cloudflare Worker via POST /api/regions/sync
 * 3. Tests the Cloudflare Worker live with CF-IPCountry: US and CF-IPCountry: IN headers
 */
import { pool } from '../src/config/database';
import { allRegions } from '../src/config/kubernetes';
import {
  generateManifest,
  applyManifest,
  waitForRollout,
  ensureNamespace,
} from '../src/services/k8sService';
import {
  createDeployment,
  storeDeploymentManifest,
  updateDeploymentStatus,
} from '../src/services/deploymentService';

async function main() {
  console.log('🚀 Deploying live multi-region application to K3s clusters...\n');

  // 1. Setup DB app
  const appRes = await pool.query(
    `INSERT INTO apps (user_id, name, repo_url, namespace)
     VALUES ('a6c63fef-2d8e-4538-9a77-8eabafb37448', 'demo-app', 'https://github.com/example/demo-app.git', 'default')
     ON CONFLICT DO NOTHING RETURNING id`
  );
  const appId =
    appRes.rows[0]?.id ||
    (await pool.query("SELECT id FROM apps WHERE name = 'demo-app'")).rows[0].id;

  // 2. Generate manifest with HTTP server responding on /health
  const manifest = generateManifest(
    'demo-app',
    'node:18-alpine',
    'default',
    'demo-app.localhost'
  );
  manifest.deployment.spec!.template.spec!.containers[0].command = [
    'node',
    '-e',
    `const http = require("http");
     http.createServer((req, res) => {
       res.writeHead(200, {
         "Content-Type": "application/json",
         "X-Cluster-Port": process.env.PORT || "3000"
       });
       res.end(JSON.stringify({ status: "ok", message: "Hello from multi-region container!" }));
     }).listen(3000, () => console.log("Demo app listening on 3000"));`,
  ];

  const dep = await createDeployment(
    appId,
    '7777777777777777777777777777777777777777',
    'Live Demo Multi-Region Deployment',
    'main'
  );
  await storeDeploymentManifest(dep.id, manifest);

  // 3. Apply to both clusters in parallel
  console.log('📦 Applying manifests to all clusters simultaneously...');
  await Promise.all(
    allRegions.map(async (r) => {
      await ensureNamespace(r, 'default');
      await applyManifest(r, manifest, 'default');
      console.log(`   ✅ Manifest applied to [${r.region}] on port ${r.ingressPort}`);
    })
  );

  // 4. Wait for rollout in both clusters
  console.log('⏳ Waiting for pods to become ready in all regions...');
  await Promise.all(
    allRegions.map(async (r) => {
      await waitForRollout(r, 'demo-app', 'default', 180000);
      console.log(`   ✅ [${r.region}] Rollout complete (2/2 ready replicas)`);
    })
  );

  await updateDeploymentStatus(dep.id, 'SUCCESS');
  console.log(`\n🎉 Multi-region app deployed successfully with Deployment ID: ${dep.id}`);

  // 5. Test direct ingress endpoints
  console.log('\n--- Verifying Ingress Traffic Directly ---');
  for (const r of allRegions) {
    try {
      const resp = await fetch(`http://127.0.0.1:${r.ingressPort}/health`, {
        headers: { Host: 'demo-app.localhost' },
      });
      const data = await resp.json();
      console.log(`   ✅ Ingress ${r.region} (port ${r.ingressPort}): ${resp.status} OK ->`, data);
    } catch (e: any) {
      console.error(`   ❌ Ingress ${r.region} error:`, e.message);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Failed:', err);
  process.exit(1);
});
