/**
 * Kubernetes Service — Phases 1-5 Multi-Region Integration & Observability Layer
 * All operations accept a RegionConfig / K8sClients / region string to explicitly target a specific cluster.
 * Full Observability support: Pod Status, Pod Logs, Top Pods, and CPU/Memory Metrics.
 */
import * as k8s from '@kubernetes/client-node';
import { RegionConfig, K8sClients, createK8sClient, regionConfigs } from '../config/kubernetes';

export { RegionConfig, K8sClients, createK8sClient };

export interface K8sManifest {
  deployment: k8s.V1Deployment;
  service: k8s.V1Service;
  ingress: k8s.V1Ingress;
}

export interface PodInfo {
  name: string;
  status: string;
  restarts: number;
  ready: string;
  age: string;
  node: string;
  containers: Array<{
    name: string;
    ready: boolean;
    restartCount: number;
    state: string;
    reason?: string;
    message?: string;
  }>;
}

export interface PodMetrics {
  cpu?: string;
  memory?: string;
}

/**
 * Extracts API clients from either RegionConfig, K8sClients, or region name string
 */
export function extractClients(target: RegionConfig | K8sClients | k8s.CoreV1Api | string): K8sClients {
  if (typeof target === 'string') {
    const config = regionConfigs.get(target);
    if (!config) throw new Error(`Region [${target}] not configured`);
    return config.client;
  }
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
 * Helper to get a RegionConfig by name
 */
export function getRegionConfig(region: string): RegionConfig {
  const cfg = regionConfigs.get(region);
  if (!cfg) throw new Error(`Region ${region} not configured`);
  return cfg;
}

/**
 * Generate typed JS objects compatible with @kubernetes/client-node
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
  target: RegionConfig | K8sClients | k8s.CoreV1Api | string,
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
  target: RegionConfig | K8sClients | string,
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
  target: RegionConfig | K8sClients | string,
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
  targetOrManifest: RegionConfig | K8sClients | K8sManifest | { ingress?: any } | string,
  ingressName?: string,
  namespace: string = 'default'
): string | null {
  if (typeof ingressName === 'string' && typeof targetOrManifest !== 'object') {
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
  target: RegionConfig | K8sClients | string,
  appNameOrManifest: string | K8sManifest | { deployment: any; service: any; ingress: any },
  namespace: string = 'default',
  previousManifest?: K8sManifest | { deployment: any; service: any; ingress: any }
): Promise<void> {
  const manifest = (typeof appNameOrManifest === 'object' ? appNameOrManifest : previousManifest) as K8sManifest;
  if (!manifest) {
    throw new Error('Previous manifest is required for rollback');
  }
  const appName = typeof appNameOrManifest === 'string' ? appNameOrManifest : manifest.deployment.metadata?.name || 'app';
  console.log(`🔄 Rolling back ${appName}...`);
  await applyManifest(target, manifest, namespace);
  const cleanName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  await waitForRollout(target, cleanName, namespace, 120000);
  console.log(`✅ Rollback complete for ${appName}`);
}

/**
 * Cleans up all K8s resources for an app on the target region cluster
 */
export async function deleteAppResources(
  target: RegionConfig | K8sClients | string,
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

/* ═══════════════════════════════════════════════════════════════ */
/*  PHASE 5: OBSERVABILITY — Pod Logs, Status, Metrics           */
/* ═══════════════════════════════════════════════════════════════ */

function formatAge(startTime?: Date): string {
  if (!startTime) return 'Unknown';
  const diff = Date.now() - new Date(startTime).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Stream logs from a specific pod.
 */
export async function getPodLogs(
  podName: string,
  namespace: string,
  region: string,
  options: {
    container?: string;
    tailLines?: number;
    timestamps?: boolean;
    previous?: boolean;
  } = {}
): Promise<string> {
  const clients = extractClients(region);
  const {
    container,
    tailLines = 100,
    timestamps = true,
    previous = false,
  } = options;

  try {
    const { body } = await clients.coreApi.readNamespacedPodLog(
      podName,
      namespace,
      container,
      false,
      false,
      undefined,
      undefined,
      previous,
      undefined,
      tailLines,
      timestamps
    );
    return body as string;
  } catch (err: any) {
    console.error(`❌ [${region}] Failed to get logs for ${podName}:`, err.message);
    return `Error fetching logs: ${err.message}`;
  }
}

/**
 * List all pods for a deployment (matched by label selector app=<app-name>).
 */
export async function getDeploymentPods(
  appName: string,
  namespace: string,
  region: string
): Promise<PodInfo[]> {
  const clients = extractClients(region);
  const cleanAppName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const labelSelector = `app=${cleanAppName}`;

  try {
    const { body } = await clients.coreApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    return (body.items || []).map((pod: k8s.V1Pod): PodInfo => {
      const status = (pod.status || {}) as k8s.V1PodStatus;
      const spec = (pod.spec || {}) as k8s.V1PodSpec;
      const containerStatuses = status.containerStatuses || [];

      const totalContainers = containerStatuses.length || (spec.containers || []).length || 1;
      const readyContainers = containerStatuses.filter((c) => c.ready).length;
      const restarts = containerStatuses.reduce((sum, c) => sum + (c.restartCount || 0), 0);

      const containers = containerStatuses.map((cs) => {
        const state = cs.state || {};
        let stateName = 'unknown';
        let reason: string | undefined;
        let message: string | undefined;

        if (state.running) {
          stateName = 'running';
        } else if (state.waiting) {
          stateName = 'waiting';
          reason = state.waiting.reason;
          message = state.waiting.message;
        } else if (state.terminated) {
          stateName = 'terminated';
          reason = state.terminated.reason;
          message = state.terminated.message;
        }

        return {
          name: cs.name,
          ready: cs.ready || false,
          restartCount: cs.restartCount || 0,
          state: stateName,
          reason,
          message,
        };
      });

      let podStatus = status.phase || 'Unknown';
      const waitingReason = containers.find((c) => c.state === 'waiting')?.reason;
      if (waitingReason && ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull'].includes(waitingReason)) {
        podStatus = waitingReason;
      }
      if (containers.some((c) => c.state === 'terminated' && c.reason === 'Error')) {
        podStatus = 'Error';
      }

      return {
        name: pod.metadata!.name!,
        status: podStatus,
        restarts,
        ready: `${readyContainers}/${totalContainers}`,
        age: formatAge(status.startTime ? new Date(status.startTime) : undefined),
        node: spec.nodeName || 'Unknown',
        containers,
      };
    });
  } catch (err: any) {
    console.error(`❌ [${region}] Failed to list pods for ${appName}:`, err.message);
    return [];
  }
}

/**
 * Get pod metrics (CPU/memory) via metrics-server.
 */
export async function getPodMetrics(
  podName: string,
  namespace: string,
  region: string
): Promise<PodMetrics | null> {
  const clients = extractClients(region);

  try {
    const customApi = clients.kubeConfig.makeApiClient(k8s.CustomObjectsApi);
    const res: any = await customApi.getNamespacedCustomObject(
      'metrics.k8s.io',
      'v1beta1',
      namespace,
      'pods',
      podName
    );

    const containers = res.body?.containers || [];
    if (containers.length === 0) return null;

    const first = containers[0];
    return {
      cpu: first.usage?.cpu || undefined,
      memory: first.usage?.memory || undefined,
    };
  } catch (err: any) {
    if (err.response?.statusCode === 404) {
      return null;
    }
    console.warn(`⚠️ [${region}] Metrics fetch failed for ${podName}:`, err.message);
    return null;
  }
}

/**
 * Get top pods for a deployment (like kubectl top pods).
 */
export async function getTopPods(
  appName: string,
  namespace: string,
  region: string
): Promise<Array<{ name: string; cpu: string; memory: string }>> {
  const clients = extractClients(region);
  const cleanAppName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  try {
    const customApi = clients.kubeConfig.makeApiClient(k8s.CustomObjectsApi);
    const res: any = await customApi.listNamespacedCustomObject(
      'metrics.k8s.io',
      'v1beta1',
      namespace,
      'pods',
      undefined,
      undefined,
      undefined,
      undefined,
      `app=${cleanAppName}`
    );

    return (res.body?.items || []).map((item: any) => {
      const container = item.containers?.[0];
      return {
        name: item.metadata?.name || 'unknown',
        cpu: container?.usage?.cpu || '0',
        memory: container?.usage?.memory || '0',
      };
    });
  } catch (err: any) {
    if (err.response?.statusCode === 404) {
      return [];
    }
    console.warn(`⚠️ [${region}] Top pods failed for ${appName}:`, err.message);
    return [];
  }
}

export default {
  generateManifest,
  applyManifest,
  waitForRollout,
  getIngressHost,
  rollbackDeployment,
  deleteAppResources,
  ensureNamespace,
  getPodLogs,
  getDeploymentPods,
  getPodMetrics,
  getTopPods,
};
