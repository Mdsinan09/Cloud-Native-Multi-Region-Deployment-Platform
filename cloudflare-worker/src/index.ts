/**
 * Cloudflare Worker: Multi-Region Traffic Router (Phase 3)
 * Features:
 * - Parallel health checking across all upstream regions
 * - Geo-aware routing (e.g. IN/PK/BD -> ap-south-1, US/CA/MX -> us-east-1)
 * - Weighted random distribution across healthy clusters
 * - Automatic zero-downtime failover
 * - Admin API (/admin/regions) for live configuration updates via KV
 */

export interface Env {
  REGION_CONFIG?: KVNamespace;
  ADMIN_TOKEN?: string;
  DEFAULT_FALLBACK_REGION?: string;
  HEALTH_CHECK_PATH?: string;
  HEALTH_CHECK_TIMEOUT_MS?: string;
}

export interface RegionDefinition {
  region: string;
  endpoint: string;
  weight: number;
  countries: string[];
  healthCheckUrl?: string;
  hostHeader?: string;
}

export interface AppRegionConfig {
  appName?: string;
  deploymentId?: string;
  regions: RegionDefinition[];
  updatedAt: string;
}

// In-memory fallback default configuration
const DEFAULT_REGIONS: RegionDefinition[] = [
  {
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:8080',
    weight: 50,
    countries: ['US', 'CA', 'MX', 'BR', 'GB', 'DE', 'FR', 'EU', 'SA'],
    hostHeader: 'multi-region-demo-app.localhost',
  },
  {
    region: 'ap-south-1',
    endpoint: 'http://127.0.0.1:8081',
    weight: 50,
    countries: ['IN', 'PK', 'BD', 'LK', 'AE', 'SG', 'AU', 'JP', 'CN', 'KR', 'AS'],
    hostHeader: 'multi-region-demo-app.localhost',
  },
];

let inMemoryConfig: AppRegionConfig = {
  appName: 'default-app',
  regions: DEFAULT_REGIONS,
  updatedAt: new Date().toISOString(),
};

/**
 * Load active region configuration from KV or in-memory default
 */
async function loadRegionConfig(env: Env): Promise<AppRegionConfig> {
  if (env.REGION_CONFIG) {
    try {
      const stored = await env.REGION_CONFIG.get<AppRegionConfig>('active_config', 'json');
      if (stored && stored.regions && stored.regions.length > 0) {
        return stored;
      }
    } catch (err) {
      console.warn('Failed to load region config from KV, using fallback:', err);
    }
  }
  return inMemoryConfig;
}

/**
 * Perform parallel health checks across all regions
 */
async function checkRegionsHealth(
  regions: RegionDefinition[],
  healthPath: string = '/health',
  timeoutMs: number = 2000
): Promise<Map<string, boolean>> {
  const healthMap = new Map<string, boolean>();

  const results = await Promise.allSettled(
    regions.map(async (region) => {
      const healthUrl = region.healthCheckUrl || `${region.endpoint}${healthPath}`;
      try {
        const response = await fetch(healthUrl, {
          method: 'GET',
          headers: region.hostHeader ? { Host: region.hostHeader } : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { region: region.region, healthy: response.ok };
      } catch {
        return { region: region.region, healthy: false };
      }
    })
  );

  results.forEach((res, idx) => {
    if (res.status === 'fulfilled') {
      healthMap.set(res.value.region, res.value.healthy);
    } else {
      healthMap.set(regions[idx].region, false);
    }
  });

  return healthMap;
}

/**
 * Select best healthy region using Geo-IP matching and weighted random selection
 */
function selectRegion(
  regions: RegionDefinition[],
  healthMap: Map<string, boolean>,
  clientCountry?: string | null,
  fallbackRegionName: string = 'us-east-1'
): RegionDefinition | null {
  // 1. Filter to healthy regions only
  const healthyRegions = regions.filter((r) => healthMap.get(r.region) === true);

  if (healthyRegions.length === 0) {
    return null;
  }

  // 2. Geo-routing: Check if any healthy region matches the client country
  if (clientCountry) {
    const geoMatches = healthyRegions.filter((r) =>
      r.countries.map((c) => c.toUpperCase()).includes(clientCountry.toUpperCase())
    );
    if (geoMatches.length === 1) {
      return geoMatches[0];
    }
    if (geoMatches.length > 1) {
      return pickWeightedRegion(geoMatches);
    }
  }

  // 3. Fallback: Preferred default region if healthy
  const defaultRegion = healthyRegions.find((r) => r.region === fallbackRegionName);
  if (defaultRegion) {
    return defaultRegion;
  }

  // 4. Weighted random selection across all remaining healthy regions
  return pickWeightedRegion(healthyRegions);
}

/**
 * Weighted random distribution
 */
function pickWeightedRegion(regions: RegionDefinition[]): RegionDefinition {
  const totalWeight = regions.reduce((sum, r) => sum + (r.weight || 1), 0);
  let random = Math.random() * totalWeight;

  for (const region of regions) {
    random -= region.weight || 1;
    if (random <= 0) {
      return region;
    }
  }

  return regions[0];
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const adminToken = env.ADMIN_TOKEN || 'your-admin-token-change-in-production';
    const defaultRegion = env.DEFAULT_FALLBACK_REGION || 'us-east-1';
    const healthPath = env.HEALTH_CHECK_PATH || '/health';
    const timeoutMs = parseInt(env.HEALTH_CHECK_TIMEOUT_MS || '2000', 10);

    // ─── ADMIN ENDPOINTS ───
    if (url.pathname === '/admin/regions') {
      if (request.method === 'GET') {
        const config = await loadRegionConfig(env);
        const health = await checkRegionsHealth(config.regions, healthPath, timeoutMs);
        return new Response(
          JSON.stringify(
            {
              config,
              health: Object.fromEntries(health),
              totalRegions: config.regions.length,
              healthyRegions: Array.from(health.entries()).filter(([, h]) => h).map(([r]) => r),
            },
            null,
            2
          ),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      if (request.method === 'POST') {
        const authHeader = request.headers.get('Authorization') || '';
        const token = authHeader.replace(/^Bearer\s+/i, '');

        if (token !== adminToken) {
          return new Response(JSON.stringify({ error: 'Unauthorized: Invalid admin token' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        try {
          const body = (await request.json()) as AppRegionConfig;
          if (!body.regions || !Array.isArray(body.regions) || body.regions.length === 0) {
            return new Response(JSON.stringify({ error: 'Invalid config: regions array is required' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          body.updatedAt = new Date().toISOString();
          inMemoryConfig = body;

          if (env.REGION_CONFIG) {
            await env.REGION_CONFIG.put('active_config', JSON.stringify(body));
          }

          return new Response(
            JSON.stringify({
              message: 'Region configuration synchronized successfully',
              config: body,
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        } catch (err: any) {
          return new Response(JSON.stringify({ error: `Failed to parse config: ${err.message}` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    }

    // ─── ROUTER HEALTH CHECK ───
    if (url.pathname === '/health' && request.method === 'GET' && !request.headers.get('X-Proxy-Request')) {
      const config = await loadRegionConfig(env);
      const health = await checkRegionsHealth(config.regions, healthPath, timeoutMs);
      const healthyCount = Array.from(health.values()).filter(Boolean).length;

      return new Response(
        JSON.stringify({
          status: healthyCount > 0 ? 'healthy' : 'degraded',
          regions: Object.fromEntries(health),
          timestamp: new Date().toISOString(),
        }),
        {
          status: healthyCount > 0 ? 200 : 503,
          headers: {
            'Content-Type': 'application/json',
            'X-Healthy-Regions': `${healthyCount}/${config.regions.length}`,
          },
        }
      );
    }

    // ─── TRAFFIC ROUTING & PROXYING ───
    const config = await loadRegionConfig(env);

    // 1. Health check all regions in parallel
    const healthMap = await checkRegionsHealth(config.regions, healthPath, timeoutMs);

    // 2. Extract Client Country
    const clientCountry =
      request.headers.get('CF-IPCountry') ||
      (request as any).cf?.country ||
      null;

    // 3. Select target region
    const selectedRegion = selectRegion(config.regions, healthMap, clientCountry, defaultRegion);

    if (!selectedRegion) {
      return new Response(
        JSON.stringify({
          error: 'Service Unavailable',
          message: 'All upstream deployment regions are currently unhealthy',
          testedRegions: Object.fromEntries(healthMap),
          timestamp: new Date().toISOString(),
        }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '5',
          },
        }
      );
    }

    // 4. Proxy request to selected upstream region
    const targetUrl = new URL(`${selectedRegion.endpoint}${url.pathname}${url.search}`);
    const proxyHeaders = new Headers(request.headers);

    if (selectedRegion.hostHeader) {
      proxyHeaders.set('Host', selectedRegion.hostHeader);
    }
    proxyHeaders.set('X-Proxy-Request', 'true');
    proxyHeaders.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '127.0.0.1');
    proxyHeaders.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

    try {
      const upstreamResponse = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: proxyHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'follow',
      });

      // Clone response and attach routing headers
      const responseHeaders = new Headers(upstreamResponse.headers);
      responseHeaders.set('X-Routed-To-Region', selectedRegion.region);
      responseHeaders.set('X-Served-By-Region', selectedRegion.region);
      responseHeaders.set(
        'X-Region-Health',
        `${Array.from(healthMap.values()).filter(Boolean).length}/${config.regions.length}`
      );
      if (clientCountry) {
        responseHeaders.set('X-Client-Country', clientCountry);
      }

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });
    } catch (err: any) {
      return new Response(
        JSON.stringify({
          error: 'Bad Gateway',
          message: `Failed connecting to upstream region ${selectedRegion.region}: ${err.message}`,
          targetRegion: selectedRegion.region,
          endpoint: selectedRegion.endpoint,
        }),
        {
          status: 502,
          headers: {
            'Content-Type': 'application/json',
            'X-Routed-To-Region': selectedRegion.region,
          },
        }
      );
    }
  },
};
