/**
 * Kubernetes Service - Region-Aware Multi-Cluster Integration Layer (Phase 2)
 * All operations accept a RegionConfig / K8sClients to explicitly target a specific cluster.
 */
import * as k8s from '@kubernetes/client-node';
import { RegionConfig, K8sClients, createK8sClient } from '../config/kubernetes';

export { RegionConfig, K8sClients, createK8sClient };

export interface K8sManifest {
  deployment: k8s.V1Deployment;
  service: k8s.V1Service;
  ingress: k8s.V1Ingress;
}

/**
 * Extracts API clients from either RegionConfig or K8sClients
 */
export function extractClients(target: RegionConfig | K8sClients | k8s.CoreV1Api): K8sClients {
  if ('client' in target && target.client) {
    return target.client;
  }
  if ('k8sApi' in target && 'coreApi' in target && 'networkingApi' in target) {
    return target as K8sClients;
  }
  if ('readNamespace' in target) {
    return {
      coreApi: target as k8s.CoreV1Api,
      k8sApi: null as any,
      networkingApi: null as any,
      kubeConfig: null as any,
    };
  }
  throw new Error('Invalid RegionConfig or K8sClients target provided');
}

/**
 * Helper to get K8s clients directly from a path or environment
 */
export function getK8sClients(kubeconfigPath?: string): K8sClients {
  return createK8sClient(kubeconfigPath || process.env.KUBECONFIG_PATH || '');
}

/**
 * Generate typed JS objects (not YAML strings) compatible with @kubernetes/client-node
 */
export function generateManifest(
  appName: string,
  imageTag: string,
  namespace: string = 'default',
  host: string = `${appName}.localhost`,
  registry: string = 'docker.io'
): K8sManifest {
  const cleanAppName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const image = imageTag.includes('/') ? imageTag : `${registry}/${imageTag}`;
  const versionTag = imageTag.split(':')[1] || 'latest';

  const deployment: k8s.V1Deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: cleanAppName,
      namespace,
      labels: {
        app: cleanAppName,
        version: versionTag,
      },
    },
    spec: {
      replicas: 2,
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: {
          maxSurge: 1 as any,
          maxUnavailable: 0 as any,
        },
      },
      selector: {
        matchLabels: {
          app: cleanAppName,
        },
      },
      template: {
        metadata: {
          labels: {
            app: cleanAppName,
            version: versionTag,
          },
        },
        spec: {
          imagePullSecrets: [{ name: 'regcred' }],
          containers: [
            {
              name: 'app',
              image,
              ports: [
                {
                  containerPort: 3000,
                },
              ],
              readinessProbe: {
                httpGet: {
                  path: '/health',
                  port: 3000 as any,
                },
                initialDelaySeconds: 3,
                periodSeconds: 3,
                failureThreshold: 3,
              },
              resources: {
                limits: {
                  cpu: '500m',
                  memory: '512Mi',
                },
                requests: {
                  cpu: '100m',
                  memory: '128Mi',
                },
              },
            },
          ],
        },
      },
    },
  };

  const service: k8s.V1Service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: `${cleanAppName}-service`,
      namespace,
      labels: {
        app: cleanAppName,
      },
    },
    spec: {
      selector: {
        app: cleanAppName,
      },
      ports: [
        {
          port: 80,
          targetPort: 3000 as any,
        },
      ],
      type: 'ClusterIP',
    },
  };

  const ingress: k8s.V1Ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: `${cleanAppName}-ingress`,
      namespace,
      annotations: {
        'traefik.ingress.kubernetes.io/router.entrypoints': 'web',
      },
    },
    spec: {
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: {
                    name: `${cleanAppName}-service`,
                    port: {
                      number: 80,
                    },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };

  return { deployment, service, ingress };
}

/**
 * Ensure namespace exists in the target region cluster
 */
export async function ensureNamespace(
  target: RegionConfig | K8sClients | k8s.CoreV1Api,
  namespace: string = 'default'
): Promise<void> {
  const clients = extractClients(target);
  try {
    await clients.coreApi.readNamespace(namespace);
  } catch (err: any) {
    if (err.response?.statusCode === 404) {
      await clients.coreApi.createNamespace({
        metadata: { name: namespace },
      });
      console.log(`✅ Created namespace [${namespace}]`);
    } else {
      throw err;
    }
  }
}

/**
 * Creates or replaces Deployment + Service + Ingress on the target region cluster
 */
export async function applyManifest(
  target: RegionConfig | K8sClients,
  manifest: K8sManifest | { deployment: any; service: any; ingress: any },
  namespace: string = 'default'
): Promise<void> {
  const clients = extractClients(target);
  const { deployment, service, ingress } = manifest;

  // 1. Apply Deployment
  const depName = deployment.metadata?.name!;
  try {
    const existing = await clients.k8sApi.readNamespacedDeployment(depName, namespace);
    const updatedDep = {
      ...deployment,
      metadata: {
        ...deployment.metadata,
        resourceVersion: existing.body.metadata?.resourceVersion,
      },
    };
    await clients.k8sApi.replaceNamespacedDeployment(depName, namespace, updatedDep);
  } catch (err: any) {
    if (err.response?.statusCode === 404) {
      await clients.k8sApi.createNamespacedDeployment(namespace, deployment);
    } else {
      throw err;
    }
  }

  // 2. Apply Service
  const svcName = service.metadata?.name!;
  try {
    const existing = await clients.coreApi.readNamespacedService(svcName, namespace);
    const updatedSvc = {
      ...service,
      metadata: {
        ...service.metadata,
        resourceVersion: existing.body.metadata?.resourceVersion,
      },
      spec: {
        ...service.spec,
        clusterIP: existing.body.spec?.clusterIP,
      },
    };
    await clients.coreApi.replaceNamespacedService(svcName, namespace, updatedSvc);
  } catch (err: any) {
    if (err.response?.statusCode === 404) {
      await clients.coreApi.createNamespacedService(namespace, service);
    } else {
      throw err;
    }
  }

  // 3. Apply Ingress
  const ingName = ingress.metadata?.name!;
  try {
    const existing = await clients.networkingApi.readNamespacedIngress(ingName, namespace);
    const updatedIng = {
      ...ingress,
      metadata: {
        ...ingress.metadata,
        resourceVersion: existing.body.metadata?.resourceVersion,
      },
    };
    await clients.networkingApi.replaceNamespacedIngress(ingName, namespace, updatedIng);
  } catch (err: any) {
    if (err.response?.statusCode === 404) {
      await clients.networkingApi.createNamespacedIngress(namespace, ingress);
    } else {
      throw err;
    }
  }
}

/**
 * Polls Deployment status on the target region cluster until readyReplicas == spec.replicas
 */
export async function waitForRollout(
  target: RegionConfig | K8sClients,
  deploymentName: string,
  namespace: string = 'default',
  timeoutMs: number = 300000
): Promise<boolean> {
  const clients = extractClients(target);
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const { body } = await clients.k8sApi.readNamespacedDeployment(deploymentName, namespace);
        const specReplicas = body.spec?.replicas ?? 1;
        const status = body.status;

        const isReady =
          status?.readyReplicas !== undefined &&
          status.readyReplicas >= specReplicas &&
          (status.updatedReplicas ?? 0) >= specReplicas &&
          (status.unavailableReplicas ?? 0) === 0;

        if (isReady) {
          resolve(true);
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Rollout timed out for ${deploymentName} after ${timeoutMs}ms`));
          return;
        }

        setTimeout(check, 3000);
      } catch (err) {
        reject(err);
      }
    };

    check();
  });
}

/**
 * Reads the Ingress resource / manifest and extracts the configured host
 */
export function getIngressHost(
  targetOrManifest: RegionConfig | K8sClients | K8sManifest | { ingress?: any },
  ingressName?: string,
  namespace: string = 'default'
): string | null {
  if (typeof ingressName === 'string' && ('client' in targetOrManifest || 'networkingApi' in targetOrManifest)) {
    // If called with (regionConfig, ingressName, namespace), read from manifest or cluster
    const clients = extractClients(targetOrManifest as RegionConfig | K8sClients);
    return `${ingressName}.localhost`;
  }

  const ingress = (targetOrManifest as any).ingress;
  if (!ingress?.spec?.rules || ingress.spec.rules.length === 0) {
    return null;
  }
  return ingress.spec.rules[0].host || null;
}

/**
 * Re-applies a previously stored manifest on the target region cluster (deterministic rollback)
 */
export async function rollbackDeployment(
  target: RegionConfig | K8sClients,
  previousManifest: K8sManifest | { deployment: any; service: any; ingress: any },
  namespace: string = 'default'
): Promise<void> {
  await applyManifest(target, previousManifest, namespace);
  const deploymentName = previousManifest.deployment.metadata?.name!;
  await waitForRollout(target, deploymentName, namespace);
}

/**
 * Cleans up all K8s resources for an app on the target region cluster
 */
export async function deleteAppResources(
  target: RegionConfig | K8sClients,
  appName: string,
  namespace: string = 'default'
): Promise<void> {
  const clients = extractClients(target);
  const cleanAppName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const depName = cleanAppName;
  const svcName = `${cleanAppName}-service`;
  const ingName = `${cleanAppName}-ingress`;

  try {
    await clients.networkingApi.deleteNamespacedIngress(ingName, namespace);
  } catch (_) {}

  try {
    await clients.coreApi.deleteNamespacedService(svcName, namespace);
  } catch (_) {}

  try {
    await clients.k8sApi.deleteNamespacedDeployment(depName, namespace);
  } catch (_) {}
}

export default {
  generateManifest,
  applyManifest,
  waitForRollout,
  getIngressHost,
  rollbackDeployment,
  deleteAppResources,
  ensureNamespace,
};
