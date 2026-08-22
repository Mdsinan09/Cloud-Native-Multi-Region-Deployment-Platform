/**
 * PostgreSQL configuration and initialization
 */
import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
  process.exit(-1);
});

/**
 * Initialize database schema
 */
export async function initDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Enable UUID extension
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Apps table
    await client.query(`
      CREATE TABLE IF NOT EXISTS apps (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        repo_url TEXT NOT NULL,
        github_webhook_secret VARCHAR(255),
        namespace VARCHAR(255) DEFAULT 'default',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Deployments table
    await client.query(`
      CREATE TABLE IF NOT EXISTS deployments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        app_id UUID REFERENCES apps(id) ON DELETE CASCADE NOT NULL,
        commit_sha VARCHAR(40) NOT NULL,
        commit_message TEXT,
        branch VARCHAR(255),
        status VARCHAR(50) NOT NULL DEFAULT 'QUEUED',
        image_tag VARCHAR(255),
        region VARCHAR(50) DEFAULT 'us-east-1',
        manifest_json JSONB,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        rollback_to_deployment_id UUID REFERENCES deployments(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(app_id, commit_sha)
      )
    `);

    // Deployment events table
    await client.query(`
      CREATE TABLE IF NOT EXISTS deployment_events (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        deployment_id UUID REFERENCES deployments(id) ON DELETE CASCADE NOT NULL,
        event VARCHAR(50) NOT NULL,
        message TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Sub-deployments table (for multi-region)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sub_deployments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        deployment_id UUID REFERENCES deployments(id) ON DELETE CASCADE NOT NULL,
        region VARCHAR(50) NOT NULL,
        status VARCHAR(50) NOT NULL,
        namespace VARCHAR(255),
        deployment_name VARCHAR(255),
        ingress_host VARCHAR(500),
        health_check_url VARCHAR(500),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Indexes for performance
    await client.query(`CREATE INDEX IF NOT EXISTS idx_deployments_app_id ON deployments(app_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_deployment_events_deployment_id ON deployment_events(deployment_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sub_deployments_deployment_id ON sub_deployments(deployment_id)`);

    await client.query('COMMIT');
    console.log('✅ Database initialized successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Database initialization failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
