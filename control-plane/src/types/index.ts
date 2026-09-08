/**
 * Shared TypeScript types for the control plane
 */

export interface User {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

export interface App {
  id: string;
  user_id: string;
  name: string;
  repo_url: string;
  github_webhook_secret: string | null;
  namespace: string;
  created_at: Date;
}

export type DeploymentStatus =
  | 'QUEUED'
  | 'CLONING'
  | 'BUILDING'
  | 'PUSHING'
  | 'DEPLOYING'
  | 'HEALTH_CHECK'
  | 'SUCCESS'
  | 'HEALTH_CHECK_FAILED'
  | 'ROLLING_BACK'
  | 'ROLLED_BACK';

export interface Deployment {
  id: string;
  app_id: string;
  commit_sha: string;
  commit_message: string | null;
  branch: string | null;
  status: DeploymentStatus;
  image_tag: string | null;
  region: string;
  started_at: Date | null;
  completed_at: Date | null;
  rollback_to_deployment_id: string | null;
  manifest_json: Record<string, unknown> | null;
  created_at: Date;
}

export interface DeploymentEvent {
  id: string;
  deployment_id: string;
  event: string;
  message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface SubDeployment {
  id: string;
  deployment_id: string;
  region: string;
  status: DeploymentStatus;
  namespace: string | null;
  deployment_name: string | null;
  ingress_host: string | null;
  health_check_url: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

export interface AuthenticatedRequest extends Express.Request {
  user?: User;
}

export interface K8sManifest {
  deployment: object;
  service: object;
  ingress: object;
}
