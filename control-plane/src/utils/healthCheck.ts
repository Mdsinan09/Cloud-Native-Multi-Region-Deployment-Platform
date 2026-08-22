/**
 * Health check utility with polling, retries, timeouts, and per-region port fallback
 */
import dotenv from 'dotenv';

dotenv.config();

export interface PollHealthCheckOptions {
  hostHeader?: string;
  fallbackPort?: number;
  retries?: number;
  intervalMs?: number;
  timeoutMs?: number;
  onProgress?: (
    attempt: number,
    maxRetries: number,
    success: boolean,
    message: string
  ) => Promise<void> | void;
}

/**
 * Robust health check polling for newly deployed services
 * If the ingress hostname doesn't resolve (no /etc/hosts entry),
 * it falls back to http://localhost:<fallbackPort> with the Host header set automatically.
 */
export async function pollHealthCheck(
  url: string,
  options: PollHealthCheckOptions = {}
): Promise<boolean> {
  const maxRetries =
    options.retries ??
    parseInt(process.env.HEALTH_CHECK_RETRIES || '10', 10);
  const retryInterval =
    options.intervalMs ??
    parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '5000', 10);
  const timeoutMs =
    options.timeoutMs ??
    parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS || '3000', 10);

  const parsedUrl = new URL(url);
  const ingressHost = options.hostHeader || parsedUrl.hostname;
  const pathAndQuery = `${parsedUrl.pathname}${parsedUrl.search}`;
  const fallbackPort =
    options.fallbackPort ??
    (parsedUrl.port ? parseInt(parsedUrl.port, 10) : 8080);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let success = false;
    let message = '';

    // Attempt 1: Direct request to target URL
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: options.hostHeader ? { Host: options.hostHeader } : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        success = true;
        message = `Health check OK (${response.status}) directly via ${url}`;
      } else {
        message = `Health check returned status ${response.status} from ${url}`;
      }
    } catch (directErr: any) {
      // Attempt 2: Fallback to k3d ingress on localhost:<fallbackPort> with Host header
      try {
        const fallbackUrl = `http://localhost:${fallbackPort}${pathAndQuery}`;
        const fallbackResponse = await fetch(fallbackUrl, {
          method: 'GET',
          headers: {
            Host: ingressHost,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (fallbackResponse.ok) {
          success = true;
          message = `Health check OK (${fallbackResponse.status}) via k3d fallback (${fallbackUrl} with Host: ${ingressHost})`;
        } else {
          message = `Fallback returned status ${fallbackResponse.status} from ${fallbackUrl}`;
        }
      } catch (fallbackErr: any) {
        message = `Request failed: ${directErr.message} (fallback error: ${fallbackErr.message})`;
      }
    }

    if (options.onProgress) {
      await options.onProgress(attempt, maxRetries, success, message);
    }

    if (success) {
      return true;
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, retryInterval));
    }
  }

  return false;
}

export default pollHealthCheck;
