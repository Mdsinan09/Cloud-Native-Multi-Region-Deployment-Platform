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
import { getPrometheusMetrics } from './utils/metrics';

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
app.get('/metrics', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
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
