/**
 * Deployment Service
 * Core business logic for creating and managing deployments
 */
import { pool } from '../config/database';
import { Deployment, DeploymentEvent, DeploymentStatus, SubDeployment } from '../types';

/**
 * Create a new deployment record
 */
export async function createDeployment(
  appId: string,
  commitSha: string,
  commitMessage: string | null,
  branch: string | null,
  region: string = 'us-east-1'
): Promise<Deployment> {
  const result = await pool.query(
    `INSERT INTO deployments (app_id, commit_sha, commit_message, branch, status, region, started_at)
     VALUES ($1, $2, $3, $4, 'QUEUED', $5, NOW())
     ON CONFLICT (app_id, commit_sha) DO NOTHING
     RETURNING *`,
    [appId, commitSha, commitMessage, branch, region]
  );

  if (result.rows.length === 0) {
    // Conflict - return existing
    const existing = await pool.query(
      'SELECT * FROM deployments WHERE app_id = $1 AND commit_sha = $2',
      [appId, commitSha]
    );
    return existing.rows[0] as Deployment;
  }

  return result.rows[0] as Deployment;
}

/**
 * Update deployment status
 */
export async function updateDeploymentStatus(
  deploymentId: string,
  status: DeploymentStatus
): Promise<void> {
  const updates: string[] = ['status = $1'];
  const values: (string | null)[] = [status];

  if (status === 'SUCCESS' || status === 'ROLLED_BACK') {
    updates.push('completed_at = NOW()');
  }

  const query = `UPDATE deployments SET ${updates.join(', ')} WHERE id = $${values.length + 1}`;
  values.push(deploymentId);

  await pool.query(query, values);
}

/**
 * Log a deployment event
 */
export async function logDeploymentEvent(
  deploymentId: string,
  event: string,
  message?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `INSERT INTO deployment_events (deployment_id, event, message, metadata)
     VALUES ($1, $2, $3, $4)`,
    [deploymentId, event, message || null, metadata ? JSON.stringify(metadata) : null]
  );
}

/**
 * Get deployment by ID with events and sub-deployments
 */
export async function getDeploymentById(deploymentId: string): Promise<Deployment | null> {
  const result = await pool.query('SELECT * FROM deployments WHERE id = $1', [deploymentId]);
  return result.rows[0] as Deployment || null;
}

/**
 * Get deployment events
 */
export async function getDeploymentEvents(deploymentId: string): Promise<DeploymentEvent[]> {
  const result = await pool.query(
    'SELECT * FROM deployment_events WHERE deployment_id = $1 ORDER BY created_at ASC',
    [deploymentId]
  );
  return result.rows as DeploymentEvent[];
}

/**
 * Get sub-deployments for a deployment
 */
export async function getSubDeployments(deploymentId: string): Promise<SubDeployment[]> {
  const result = await pool.query(
    'SELECT * FROM sub_deployments WHERE deployment_id = $1 ORDER BY created_at ASC',
    [deploymentId]
  );
  return result.rows as SubDeployment[];
}

/**
 * Get deployments for an app
 */
export async function getDeploymentsByAppId(appId: string): Promise<Deployment[]> {
  const result = await pool.query(
    'SELECT * FROM deployments WHERE app_id = $1 ORDER BY created_at DESC',
    [appId]
  );
  return result.rows as Deployment[];
}

/**
 * Create a sub-deployment for multi-region
 */
export async function createSubDeployment(
  deploymentId: string,
  region: string,
  namespace: string,
  deploymentName: string,
  ingressHost: string,
  healthCheckUrl: string
): Promise<SubDeployment> {
  const result = await pool.query(
    `INSERT INTO sub_deployments (deployment_id, region, status, namespace, deployment_name, ingress_host, health_check_url, started_at)
     VALUES ($1, $2, 'DEPLOYING', $3, $4, $5, $6, NOW())
     RETURNING *`,
    [deploymentId, region, namespace, deploymentName, ingressHost, healthCheckUrl]
  );
  return result.rows[0] as SubDeployment;
}

/**
 * Update sub-deployment status
 */
export async function updateSubDeploymentStatus(
  subDeploymentId: string,
  status: DeploymentStatus
): Promise<void> {
  const updates = ['status = $1'];
  const values: (string | null)[] = [status];

  if (status === 'SUCCESS' || status === 'ROLLED_BACK') {
    updates.push('completed_at = NOW()');
  }

  const query = `UPDATE sub_deployments SET ${updates.join(', ')} WHERE id = $${values.length + 1}`;
  values.push(subDeploymentId);

  await pool.query(query, values);
}

/**
 * Get the previous successful deployment for rollback
 */
export async function getPreviousSuccessfulDeployment(
  appId: string,
  currentDeploymentId: string
): Promise<Deployment | null> {
  const result = await pool.query(
    `SELECT * FROM deployments 
     WHERE app_id = $1 AND id != $2 AND status = 'SUCCESS'
     ORDER BY created_at DESC LIMIT 1`,
    [appId, currentDeploymentId]
  );
  return result.rows[0] as Deployment || null;
}
