/**
 * Distributed Lock Service using Redis
 * Prevents concurrent deployments of the same app
 */
import redis from '../config/redis';

const LOCK_PREFIX = 'deploy:lock:';
const DEFAULT_TTL = 600; // 10 minutes

/**
 * Acquire a distributed lock for an app
 * Returns true if lock was acquired, false if already locked
 */
export async function acquireLock(
  appId: string,
  deploymentId: string,
  ttlSeconds: number = DEFAULT_TTL
): Promise<boolean> {
  const key = `${LOCK_PREFIX}${appId}`;
  const result = await redis.set(key, deploymentId, 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

/**
 * Release a distributed lock for an app
 */
export async function releaseLock(appId: string): Promise<void> {
  const key = `${LOCK_PREFIX}${appId}`;
  await redis.del(key);
}

/**
 * Check if an app is currently locked
 */
export async function isLocked(appId: string): Promise<boolean> {
  const key = `${LOCK_PREFIX}${appId}`;
  const exists = await redis.exists(key);
  return exists === 1;
}

/**
 * Get the deployment ID holding the lock
 */
export async function getLockHolder(appId: string): Promise<string | null> {
  const key = `${LOCK_PREFIX}${appId}`;
  return await redis.get(key);
}
