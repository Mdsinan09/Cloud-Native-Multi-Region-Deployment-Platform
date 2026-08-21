/**
 * Kubernetes client configuration
 * Supports single cluster (Phase 1) and multi-cluster (Phase 2)
 */
import * as k8s from '@kubernetes/client-node';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Load kubeconfig from file path and create API clients
 */
function createK8sClient(kubeconfigPath: string): {
  kubeConfig: k8s.KubeConfig;
  appsApi: k8s.AppsV1Api;
  coreApi: k8s.CoreV1Api;
  networkingApi: k8s.NetworkingV1Api;
} {
  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromFile(kubeconfigPath);

  const appsApi = kubeConfig.makeApiClient(k8s.AppsV1Api);
  const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
  const networkingApi = kubeConfig.makeApiClient(k8s.NetworkingV1Api);

  return { kubeConfig, appsApi, coreApi, networkingApi };
}

// Primary cluster (Phase 1)
const primaryKubeconfigPath = process.env.KUBECONFIG_PATH;
if (!primaryKubeconfigPath) {
  console.warn('⚠️ KUBECONFIG_PATH not set. K8s operations will fail.');
}

export const primaryK8s = primaryKubeconfigPath
  ? createK8sClient(primaryKubeconfigPath)
  : null;

// Multi-region clusters (Phase 2)
export const regionClients: Map<string, ReturnType<typeof createK8sClient>> = new Map();

if (process.env.KUBECONFIG_PATHS) {
  const paths = process.env.KUBECONFIG_PATHS.split(',');
  paths.forEach((path, index) => {
    const region = index === 0 ? 'us-east-1' : `region-${index + 1}`;
    try {
      regionClients.set(region, createK8sClient(path.trim()));
      console.log(`✅ K8s client loaded for region: ${region}`);
    } catch (err) {
      console.error(`❌ Failed to load K8s client for ${region}:`, err);
    }
  });
}

// Fallback: if no multi-region configs, use primary
if (regionClients.size === 0 && primaryK8s) {
  regionClients.set('us-east-1', primaryK8s);
}

export { createK8sClient };
export default primaryK8s;
