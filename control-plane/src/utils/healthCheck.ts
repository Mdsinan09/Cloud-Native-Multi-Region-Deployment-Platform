/**
 * Health Check Polling Utility — Phase 2 Multi-Region
 *
 * Robust HTTP polling with retries, timeouts, and per-region
 * ingress port fallback for local k3d clusters.
 */

export interface PollHealthCheckOptions {
  retries?: number;
  intervalMs?: number;
  timeoutMs?: number;
  fallbackPort?: number; // e.g. 8080 for us-east-1, 8081 for ap-south-1
  hostHeader?: string;
  onProgress?: (
    attempt: number,
    maxRetries: number,
    success: boolean,
    message: string
  ) => Promise<void> | void;
}

export interface PollHealthCheckResult {
  success: boolean;
  lastStatus?: number;
  lastError?: string;
}

/**
 * Poll a health endpoint until it returns HTTP 200 or max retries exhausted.
 *
 * For local k3d, if the hostname doesn't resolve, falls back to
 * http://localhost:{fallbackPort} with the Host header set to the ingress host.
 */
export async function pollHealthCheck(
  url: string,
  options: PollHealthCheckOptions = {}
): Promise<PollHealthCheckResult> {
  const {
    retries = 10,
    intervalMs = 5000,
    timeoutMs = 3000,
    fallbackPort = 8080,
    hostHeader,
    onProgress,
  } = options;

  let lastStatus: number | undefined;
  let lastError: string | undefined;

  const parsed = new URL(url);
  const ingressHost = hostHeader || parsed.hostname;
  const path = parsed.pathname + parsed.search;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Try direct URL first
      let response = await fetchWithTimeout(url, timeoutMs, hostHeader ? { Host: hostHeader } : undefined);

      // If DNS fails, fall back to localhost:{fallbackPort} with Host header
      if (!response && ingressHost !== 'localhost') {
        const fallbackUrl = `http://localhost:${fallbackPort}${path}`;
        response = await fetchWithTimeout(fallbackUrl, timeoutMs, {
          Host: ingressHost,
        });
      }

      if (response) {
        lastStatus = response.status;

        if (response.ok) {
          console.log(`✅ [Attempt ${attempt}/${retries}] Health check passed for ${url}`);
          if (onProgress) {
            await onProgress(attempt, retries, true, `Health check OK (${response.status})`);
          }
          return { success: true, lastStatus };
        } else {
          lastError = `HTTP ${response.status}`;
          console.log(`⚠️ [Attempt ${attempt}/${retries}] Health check returned ${response.status} for ${url}`);
          if (onProgress) {
            await onProgress(attempt, retries, false, `Returned status ${response.status}`);
          }
        }
      } else {
        lastError = 'Connection failed';
        console.log(`⚠️ [Attempt ${attempt}/${retries}] Could not connect to ${url}`);
        if (onProgress) {
          await onProgress(attempt, retries, false, 'Connection failed');
        }
      }
    } catch (err: any) {
      lastError = err.message || 'Unknown error';
      console.log(`⚠️ [Attempt ${attempt}/${retries}] Health check error for ${url}:`, lastError);
      if (onProgress) {
        await onProgress(attempt, retries, false, lastError || 'Unknown error');
      }
    }

    if (attempt < retries) {
      await sleep(intervalMs);
    }
  }

  console.error(`❌ Health check failed after ${retries} attempts for ${url}`);
  return { success: false, lastStatus, lastError };
}

/**
 * Fetch with timeout and custom headers, returning null on network errors.
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: headers || {},
    });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default pollHealthCheck;
