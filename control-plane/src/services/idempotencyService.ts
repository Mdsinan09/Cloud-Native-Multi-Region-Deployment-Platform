/**
 * Idempotency Service
 * Prevents duplicate deployments for the same app + commit SHA
 */
import { pool } from '../config/database';
import { Deployment } from '../types';

export interface IdempotencyResult {
  exists: boolean;
  deployment: Deployment | null;
}

/**
 * Check if a deployment already exists for the given app and commit SHA
 */
export async function checkIdempotency(
  appId: string,
  commitSha: string
): Promise<IdempotencyResult> {
  const result = await pool.query(
    `SELECT * FROM deployments WHERE app_id = $1 AND commit_sha = $2`,
    [appId, commitSha]
  );

  if (result.rows.length > 0) {
    return {
      exists: true,
      deployment: result.rows[0] as Deployment,
    };
  }

  return { exists: false, deployment: null };
}
