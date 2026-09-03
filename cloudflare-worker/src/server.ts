/**
 * Local Development Server for Cloudflare Worker Router
 * Runs the worker router fetch handler on localhost:8787
 */
import http from 'http';
import routerWorker, { Env } from './index';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8787;

const env: Env = {
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'your-admin-token',
  DEFAULT_FALLBACK_REGION: 'us-east-1',
  HEALTH_CHECK_PATH: '/health',
  HEALTH_CHECK_TIMEOUT_MS: '2000',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        value.forEach((v) => headers.append(key, v));
      } else if (value !== undefined) {
        headers.set(key, value);
      }
    }

    let body: Buffer | undefined;
    if (['POST', 'PUT', 'PATCH'].includes(req.method || '')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      body = Buffer.concat(chunks);
    }

    const workerReq = new Request(url.toString(), {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : body,
    });

    const workerRes = await routerWorker.fetch(workerReq, env, {} as any);

    res.writeHead(workerRes.status, Object.fromEntries(workerRes.headers.entries()));
    const resBuffer = Buffer.from(await workerRes.arrayBuffer());
    res.end(resBuffer);
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`⚡ Cloudflare Worker Local Server running on http://localhost:${PORT}`);
});
