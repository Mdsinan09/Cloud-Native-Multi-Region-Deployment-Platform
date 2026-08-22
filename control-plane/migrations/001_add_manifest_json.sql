-- Migration 001: Add manifest_json column to deployments table
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS manifest_json JSONB;
