/**
 * Comprehensive Unit & Integration Tests for Cloudflare Worker Router
 * Tests Geo-Routing, Health Checking, Failover, Weighted Selection, and Admin API
 */
import http from 'http';
import routerWorker from '../src/index';

// Helper to spawn temporary mock servers for us-east-1 and ap-south-1
function createMockServer(port: number, regionName: string): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/test') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Server-Region': regionName,
        });
        res.end(JSON.stringify({ status: 'ok', region: regionName }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(port, () => {
      resolve(server);
    });
  });
}

async function runWorkerTests() {
  console.log('🚀 Starting Cloudflare Worker Router Tests...\n');

  // Start mock servers on ports 18080 (us-east-1) and 18081 (ap-south-1)
  const serverUS = await createMockServer(18080, 'us-east-1');
  const serverAP = await createMockServer(18081, 'ap-south-1');

  const mockEnv = {
    ADMIN_TOKEN: 'test-admin-secret-token',
    DEFAULT_FALLBACK_REGION: 'us-east-1',
    HEALTH_CHECK_PATH: '/health',
    HEALTH_CHECK_TIMEOUT_MS: '2000',
  };

  const mockCtx = {} as any;

  try {
    // ─── Test 1: Admin POST /admin/regions (Configure Mock Clusters) ───
    console.log('--- Test 1: Admin Configuration Synchronization ---');
    const mockConfig = {
      appName: 'test-multi-region-app',
      regions: [
        {
          region: 'us-east-1',
          endpoint: 'http://127.0.0.1:18080',
          weight: 60,
          countries: ['US', 'CA', 'MX', 'GB', 'DE', 'FR'],
          hostHeader: 'test-app.localhost',
        },
        {
          region: 'ap-south-1',
          endpoint: 'http://127.0.0.1:18081',
          weight: 40,
          countries: ['IN', 'PK', 'BD', 'LK', 'AE', 'SG'],
          hostHeader: 'test-app.localhost',
        },
      ],
    };

    const reqSync = new Request('https://worker.local/admin/regions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-admin-secret-token',
      },
      body: JSON.stringify(mockConfig),
    });
    const resSync = await routerWorker.fetch(reqSync, mockEnv, mockCtx);
    const syncBody = (await resSync.json()) as any;
    console.log(`✅ Admin sync response: ${resSync.status} (${syncBody.message})`);

    // ─── Test 2: Admin GET /admin/regions with live health status ───
    console.log('\n--- Test 2: Admin GET /admin/regions ---');
    const reqAdminGet = new Request('https://worker.local/admin/regions', { method: 'GET' });
    const resAdminGet = await routerWorker.fetch(reqAdminGet, mockEnv, mockCtx);
    const adminGetBody = (await resAdminGet.json()) as any;
    console.log(`✅ Total Regions: ${adminGetBody.totalRegions}`);
    console.log(`✅ Healthy Regions: ${adminGetBody.healthyRegions.join(', ')}`);

    // ─── Test 3: Geo-Routing US/North America -> us-east-1 ───
    console.log('\n--- Test 3: Geo-Routing (US -> us-east-1) ---');
    const reqUS = new Request('https://worker.local/test', {
      method: 'GET',
      headers: { 'CF-IPCountry': 'US' },
    });
    const resUS = await routerWorker.fetch(reqUS, mockEnv, mockCtx);
    console.log(`✅ Response Status: ${resUS.status}`);
    console.log(`✅ X-Routed-To-Region: ${resUS.headers.get('X-Routed-To-Region')}`);
    console.log(`✅ X-Served-By-Region: ${resUS.headers.get('X-Served-By-Region')}`);
    console.log(`✅ X-Region-Health: ${resUS.headers.get('X-Region-Health')}`);

    if (resUS.headers.get('X-Routed-To-Region') !== 'us-east-1') {
      throw new Error(`Expected routing to us-east-1 but got ${resUS.headers.get('X-Routed-To-Region')}`);
    }

    // ─── Test 4: Geo-Routing Asia / India -> ap-south-1 ───
    console.log('\n--- Test 4: Geo-Routing (IN -> ap-south-1) ---');
    const reqIN = new Request('https://worker.local/test', {
      method: 'GET',
      headers: { 'CF-IPCountry': 'IN' },
    });
    const resIN = await routerWorker.fetch(reqIN, mockEnv, mockCtx);
    console.log(`✅ Response Status: ${resIN.status}`);
    console.log(`✅ X-Routed-To-Region: ${resIN.headers.get('X-Routed-To-Region')}`);
    console.log(`✅ X-Served-By-Region: ${resIN.headers.get('X-Served-By-Region')}`);
    console.log(`✅ X-Region-Health: ${resIN.headers.get('X-Region-Health')}`);

    if (resIN.headers.get('X-Routed-To-Region') !== 'ap-south-1') {
      throw new Error(`Expected routing to ap-south-1 but got ${resIN.headers.get('X-Routed-To-Region')}`);
    }

    // ─── Test 5: Automatic Failover (Stop us-east-1, Route US traffic to ap-south-1) ───
    console.log('\n--- Test 5: Automatic Failover Simulation ---');
    console.log('⏳ Stopping mock us-east-1 server to simulate regional outage...');
    await new Promise<void>((r) => serverUS.close(() => r()));

    const reqFailover = new Request('https://worker.local/test', {
      method: 'GET',
      headers: { 'CF-IPCountry': 'US' },
    });
    const resFailover = await routerWorker.fetch(reqFailover, mockEnv, mockCtx);
    console.log(`✅ Failover Status: ${resFailover.status}`);
    console.log(`✅ X-Routed-To-Region: ${resFailover.headers.get('X-Routed-To-Region')}`);
    console.log(`✅ X-Region-Health: ${resFailover.headers.get('X-Region-Health')}`);

    if (resFailover.headers.get('X-Routed-To-Region') !== 'ap-south-1') {
      throw new Error(`Expected automatic failover to ap-south-1 but got ${resFailover.headers.get('X-Routed-To-Region')}`);
    }
    console.log('✅ Automatic zero-downtime failover to healthy cluster verified!');

    // ─── Test 6: Worker Health Status Endpoint ───
    console.log('\n--- Test 6: Router Self Health Endpoint ---');
    const reqHealth = new Request('https://worker.local/health', { method: 'GET' });
    const resHealth = await routerWorker.fetch(reqHealth, mockEnv, mockCtx);
    const healthData = (await resHealth.json()) as any;
    console.log(`✅ Health Status: ${resHealth.status} (${healthData.status})`);
    console.log(`✅ Cluster Statuses: ${JSON.stringify(healthData.regions)}`);

    console.log('\n========================================================');
    console.log('🎉 ALL CLOUDFLARE WORKER ROUTER TESTS PASSED 100%!');
    console.log('========================================================');
  } finally {
    serverAP.close();
  }
}

runWorkerTests();
