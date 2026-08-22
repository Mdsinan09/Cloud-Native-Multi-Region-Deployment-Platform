/**
 * Kubernetes Multi-Region Client Configuration (Phase 2)
 * Reads KUBECONFIG_PATHS, REGIONS, and REGION_INGRESS_PORTS to orchestrate multi-region deployments
 */
import * as k8s from '@kubernetes/client-node';
import dotenv from 'dotenv';

dotenv.config();

export interface K8sClients {
  k8sApi: k8s.AppsV1Api;
  coreApi: k8s.CoreV1Api;
  networkingApi: k8s.NetworkingV1Api;
  kubeConfig: k8s.KubeConfig;
}

export interface RegionConfig {
  region: string;
  kubeconfigPath: string;
  ingressPort: number;
  client: K8sClients;
  k8sApi: k8s.AppsV1Api;
  coreApi: k8s.CoreV1Api;
  networkingApi: k8s.NetworkingV1Api;
  kubeConfig: k8s.KubeConfig;
}

/**
 * Creates API clients for a specific kubeconfig file
 */
export function createK8sClient(kubeconfigPath: string): K8sClients {
  const kubeConfig = new k8s.KubeConfig();
  if (kubeconfigPath) {
    try {
      kubeConfig.loadFromFile(kubeconfigPath);
    } catch (err: any) {
      console.warn(`⚠️ Failed to load kubeconfig from ${kubeconfigPath}: ${err.message}. Falling back to default.`);
      kubeConfig.loadFromDefault();
    }
  } else {
    kubeConfig.loadFromDefault();
  }

  const k8sApi = kubeConfig.makeApiClient(k8s.AppsV1Api);
  const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
  const networkingApi = kubeConfig.makeApiClient(k8s.NetworkingV1Api);

  return { k8sApi, coreApi, networkingApi, kubeConfig };
}

// Build region configurations map
export const regionConfigs: Map<string, RegionConfig> = new Map();

const kubeconfigPaths = process.env.KUBECONFIG_PATHS
  ? process.env.KUBECONFIG_PATHS.split(',').map((p) => p.trim()).filter(Boolean)
  : (process.env.KUBECONFIG_PATH ? [process.env.KUBECONFIG_PATH.trim()] : []);

const regionNames = process.env.REGIONS
  ? process.env.REGIONS.split(',').map((r) => r.trim()).filter(Boolean)
  : ['us-east-1', 'ap-south-1'];

const regionPorts = process.env.REGION_INGRESS_PORTS
  ? process.env.REGION_INGRESS_PORTS.split(',').map((p) => parseInt(p.trim(), 10)).filter((p) => !isNaN(p))
  : [8080, 8081];

if (kubeconfigPaths.length > 0) {
  kubeconfigPaths.forEach((path, index) => {
    const region = regionNames[index] || (index === 0 ? 'us-east-1' : `region-${index + 1}`);
    const ingressPort = regionPorts[index] || (8080 + index);
    const client = createK8sClient(path);
    const config: RegionConfig = {
      region,
      kubeconfigPath: path,
      ingressPort,
      client,
      k8sApi: client.k8sApi,
      coreApi: client.coreApi,
      networkingApi: client.networkingApi,
      kubeConfig: client.kubeConfig,
    };
    regionConfigs.set(region, config);
    console.log(`✅ Loaded K8s config for region [${region}] (port ${ingressPort}) from: ${path}`);
  });
} else {
  // Default single-region fallback
  const defaultClient = createK8sClient('');
  const defaultConfig: RegionConfig = {
    region: 'us-east-1',
    kubeconfigPath: '',
    ingressPort: 8080,
    client: defaultClient,
    k8sApi: defaultClient.k8sApi,
    coreApi: defaultClient.coreApi,
    networkingApi: defaultClient.networkingApi,
    kubeConfig: defaultClient.kubeConfig,
  };
  regionConfigs.set('us-east-1', defaultConfig);
}

export const allRegions: RegionConfig[] = Array.from(regionConfigs.values());
export const primaryRegion: RegionConfig = allRegions[0];
export const primaryK8s: K8sClients = primaryRegion.client;
export const regionClients: Map<string, K8sClients> = new Map(
  Array.from(regionConfigs.entries()).map(([k, v]) => [k, v.client])
);

export default regionConfigs;
