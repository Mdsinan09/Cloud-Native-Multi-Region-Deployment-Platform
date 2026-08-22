/**
 * Kubernetes client configuration
 * Supports single cluster (Phase 1) and multi-cluster (Phase 2)
 */
import { getK8sClients, K8sClients } from '../services/k8sService';
import dotenv from 'dotenv';

dotenv.config();

// Primary cluster client
const primaryKubeconfigPath = process.env.KUBECONFIG_PATH;
if (!primaryKubeconfigPath) {
  console.warn('⚠️ KUBECONFIG_PATH not set. K8s operations will use default kubeconfig or fail.');
}

export const primaryK8s: K8sClients = getK8sClients(primaryKubeconfigPath);

// Multi-region clusters
export const regionClients: Map<string, K8sClients> = new Map();

if (process.env.KUBECONFIG_PATHS) {
  const paths = process.env.KUBECONFIG_PATHS.split(',');
  paths.forEach((path, index) => {
    const region = index === 0 ? 'us-east-1' : `region-${index + 1}`;
    try {
      regionClients.set(region, getK8sClients(path.trim()));
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

export { getK8sClients };
export default primaryK8s;
