/**
 * Traffic Router Service (Phase 3: Cloudflare Workers Integration)
 * Builds region configurations and syncs active endpoints to Cloudflare Worker KV
 */
import { allRegions, RegionConfig } from '../config/kubernetes';

export interface RegionDefinition {
  region: string;
  endpoint: string;
  weight: number;
  countries: string[];
  healthCheckUrl?: string;
  hostHeader?: string;
}

export interface AppRegionConfig {
  appName: string;
  deploymentId?: string;
  regions: RegionDefinition[];
  updatedAt: string;
}

// Country code mappings per region
const REGION_GEO_MAP: Record<string, string[]> = {
  'us-east-1': ['US', 'CA', 'MX', 'BR', 'GB', 'DE', 'FR', 'EU', 'SA'],
  'ap-south-1': ['IN', 'PK', 'BD', 'LK', 'AE', 'SG', 'AU', 'JP', 'CN', 'KR', 'AS'],
};

/**
 * Builds worker-compatible region definition array from active k3d / k8s cluster configs
 */
export function getMultiRegionRouterConfig(
  appName: string = 'app',
  deploymentId?: string,
  baseHostOverride?: string
): AppRegionConfig {
  const host = baseHostOverride || `${appName}.localhost`;

  const regions: RegionDefinition[] = allRegions.map((r: RegionConfig) => {
    const countries = REGION_GEO_MAP[r.region] || ['US', 'CA'];
    const endpoint = `http://${host}:${r.ingressPort}`;

    return {
      region: r.region,
      endpoint,
      weight: 50,
      countries,
      healthCheckUrl: `${endpoint}/health`,
      hostHeader: host,
    };
  });

  return {
    appName,
    deploymentId,
    regions,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Synchronizes the active multi-region cluster configuration with the Cloudflare Worker API
 */
export async function syncRegionsToCloudflareWorker(
  workerUrl: string,
  adminToken: string,
  appName: string = 'app',
  deploymentId?: string,
  baseHostOverride?: string
): Promise<{ success: boolean; data?: any; error?: string }> {
  const config = getMultiRegionRouterConfig(appName, deploymentId, baseHostOverride);
  const targetAdminUrl = `${workerUrl.replace(/\/+$/, '')}/admin/regions`;

  try {
    const response = await fetch(targetAdminUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(5000),
    });

    const responseBody = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        success: false,
        error: `Cloudflare Worker returned ${response.status}: ${JSON.stringify(responseBody)}`,
      };
    }

    return {
      success: true,
      data: responseBody,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Failed contacting Cloudflare Worker: ${err.message}`,
    };
  }
}

export default {
  getMultiRegionRouterConfig,
  syncRegionsToCloudflareWorker,
};
