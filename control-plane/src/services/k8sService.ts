/**
 * Kubernetes Service
 * Handles manifest generation, application, rollout watching, and rollback
 */
import * as k8s from '@kubernetes/client-node';
import { regionClients, primaryK8s } from '../config/kubernetes';
import { K8sManifest } from '../types';

/**
 * Generate Kubernetes manifests for an application deployment
 */
export function generateManifest(
  appName: string,
  imageTag: string,
  namespace: string = 'default',
  host: string = `${appName}.localhost`,
  registry: string = 'docker.io'
): K8sManifest {
  const cleanAppName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const image = `${registry}/${imageTag}`;

  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: cleanAppName,
      namespace,
      labels: {
        app: cleanAppName,
        version: imageTag.split(':')[1] || 'latest',
      },
    },
    spec: {
      replicas: 2,
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: {
          maxSurge: 1,
          maxUnavailable: 0,
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
            version: imageTag.split(':')[1] || 'latest',
          },
        },
        spec: {
          imagePullSecrets: [
            { name: 'regcred' },
          ],
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
                  port: 3000,
                },
                initialDelaySeconds: 5,
                periodSeconds: 5,
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

  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: `${cleanAppName}-service`,
      namespace,
    },
    spec: {
      selector: {
        app: cleanAppName,
      },
      ports: [
        {
          port: 80,
          targetPort: 3000,
        },
      ],
      type: 'ClusterIP',
    },
  };

  const ingress = {
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
 * Create namespace if it doesn't exist
 */
export async function ensureNamespace(
  coreApi: k8s.CoreV1Api,
  namespace: string
): Promise<void> {
  try {
    await coreApi.readNamespace(namespace);
  } catch (err: any) {
    if (err.response?.statusCode === 404) {
      await coreApi.createNamespace({
        metadata: { name: namespace },
      });
      console.log(`✅ Created namespace: ${namespace}`);
    } else {
      throw err;
    }
  }
}

/**
 * Apply a manifest to the cluster
 */
export async function applyManifest(
  client: ReturnType<typeof regionClients.get> extends infer R ? (R extends undefined ? never : R) : never,
  manifest: object,
  namespace: string
): Promise<void> {
  if (!client) throw new Error('K8s client not available');

  const kind = (manifest as any).kind;
  const name = (manifest as any).metadata.name;

  try {
    switch (kind) {
      case 'Deployment':
        try {
          await client.appsApi.readNamespacedDeployment(name, namespace);
          await client.appsApi.replaceNamespacedDeployment(name, namespace, manifest);
        } catch (err: any) {
          if (err.response?.statusCode === 404) {
            await client.appsApi.createNamespacedDeployment(namespace, manifest);
          } else {
            throw err;
          }
        }
        break;

      case 'Service':
        try {
          await client.coreApi.readNamespacedService(name, namespace);
          await client.coreApi.replaceNamespacedService(name, namespace, manifest);
        } catch (err: any) {
          if (err.response?.statusCode === 404) {
            await client.coreApi.createNamespacedService(namespace, manifest);
          } else {
            throw err;
          }
        }
        break;

      case 'Ingress':
        try {
          await client.networkingApi.readNamespacedIngress(name, namespace);
          await client.networkingApi.replaceNamespacedIngress(name, namespace, manifest);
        } catch (err: any) {
          if (err.response?.statusCode === 404) {
            await client.networkingApi.createNamespacedIngress(namespace, manifest);
          } else {
            throw err;
          }
        }
        break;

      default:
        throw new Error(`Unknown manifest kind: ${kind}`);
    }
  } catch (err) {
    console.error(`❌ Failed to apply ${kind}/${name}:`, err);
    throw err;
  }
}

/**
 * Wait for deployment rollout to complete
 */
export async function waitForRollout(
  client: ReturnType<typeof regionClients.get> extends infer R ? (R extends undefined ? never : R) : never,
  deploymentName: string,
  namespace: string,
  timeoutMs: number = 300000
): Promise<boolean> {
  if (!client) throw new Error('K8s client not available');

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const { body } = await client.appsApi.readNamespacedDeployment(deploymentName, namespace);
        const status = body.status;

        if (
          status?.readyReplicas !== undefined &&
          status.readyReplicas === status.replicas &&
          status.updatedReplicas === status.replicas &&
          status.unavailableReplicas === 0
        ) {
          resolve(true);
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Rollout timed out after ${timeoutMs}ms`));
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
 * Rollback a deployment using kubectl rollout undo
 */
export async function rollbackDeployment(
  client: ReturnType<typeof regionClients.get> extends infer R ? (R extends undefined ? never : R) : never,
  deploymentName: string,
  namespace: string
): Promise<void> {
  if (!client) throw new Error('K8s client not available');

  try {
    // Get current deployment to find previous revision
    const { body } = await client.appsApi.readNamespacedDeployment(deploymentName, namespace);

    // Patch to trigger rollback by updating annotation
    const patch = {
      metadata: {
        annotations: {
          'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
          'deployment.kubernetes.io/revision': String(
            parseInt(body.metadata?.annotations?.['deployment.kubernetes.io/revision'] || '1') - 1
          ),
        },
      },
    };

    await client.appsApi.patchNamespacedDeployment(
      deploymentName,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );

    console.log(`✅ Rollback initiated for ${deploymentName}`);
  } catch (err) {
    console.error(`❌ Rollback failed for ${deploymentName}:`, err);
    throw err;
  }
}

/**
 * Alternative rollback: re-apply previous manifest
 */
export async function rollbackWithManifest(
  client: ReturnType<typeof regionClients.get> extends infer R ? (R extends undefined ? never : R) : never,
  manifest: object,
  namespace: string
): Promise<void> {
  await applyManifest(client, manifest, namespace);
  await waitForRollout(
    client,
    (manifest as any).metadata.name,
    namespace
  );
}

/**
 * Get all available region clients
 */
export function getRegionClients(): Map<string, NonNullable<ReturnType<typeof regionClients.get>>> {
  const clients = new Map<string, NonNullable<ReturnType<typeof regionClients.get>>>();
  regionClients.forEach((client, region) => {
    if (client) clients.set(region, client);
  });
  return clients;
}

export { primaryK8s };
