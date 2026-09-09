/**
 * Control Plane Main Application
 * Express server with all routes and middleware
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { initDatabase } from './config/database';
import { errorHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth';
import appsRoutes from './routes/apps';
import deploymentsRoutes from './routes/deployments';
import webhooksRoutes from './routes/webhooks';
import regionsRoutes from './routes/regions';
import observabilityRoutes from './routes/observability';
import { metrics, getPrometheusMetrics } from './utils/metrics';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Root landing
app.get('/', (_req, res) => {
  res.json({
    name: 'Cloud-Native Multi-Region Deployment Platform - Control Plane API',
    status: 'running',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      metrics: '/metrics',
      auth: ['/auth/login', '/auth/register'],
      apps: '/api/apps',
      deployments: '/api/deployments',
      regions: '/api/regions',
      observability: '/api/observability/:id/(pods|logs|metrics|top)',
      webhooks: '/api/webhooks/github',
    },
    dashboardUrl: 'http://localhost:5173',
  });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Prometheus metrics endpoint
app.get('/metrics', async (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  try {
    const { pool } = await import('./config/database');
    const statusCounts = await pool.query(
      'SELECT status, COUNT(*)::int as count FROM deployments GROUP BY status'
    );
    for (const row of statusCounts.rows) {
      metrics.inc('deployment_total', { status: row.status, region: 'all' }, 0);
      const counter = (metrics as any).counters?.get('deployment_total')?.find(
        (c: any) => c.labels.status === row.status && c.labels.region === 'all'
      );
      if (counter) counter.value = row.count;
    }

    const activeRes = await pool.query(
      "SELECT COUNT(*)::int as count FROM deployments WHERE status IN ('QUEUED', 'BUILDING', 'DEPLOYING')"
    );
    metrics.gauge('active_deployments', activeRes.rows[0]?.count || 0);

    const durationsRes = await pool.query(
      "SELECT EXTRACT(EPOCH FROM (updated_at - created_at)) as duration FROM deployments WHERE status = 'SUCCESS' AND updated_at IS NOT NULL"
    );
    if (durationsRes.rows.length > 0) {
      for (const row of durationsRes.rows) {
        if (row.duration && Number(row.duration) > 0) {
          metrics.observe('deployment_duration_seconds', Number(row.duration));
        }
      }
    }
  } catch (err: any) {
    // Fallback to in-memory metrics
  }

  res.send(getPrometheusMetrics());
});

// Routes
app.use('/auth', authRoutes);
app.use('/api/apps', appsRoutes);
app.use('/api/deployments', deploymentsRoutes);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/regions', regionsRoutes);
app.use('/api/observability', observabilityRoutes);

// Error handler (must be last)
app.use(errorHandler);

// Start server
async function startServer() {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`🚀 Control Plane running on http://localhost:${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
      console.log(`📈 Metrics: http://localhost:${PORT}/metrics`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

startServer();

export default app;
