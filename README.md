# Cloud-Native Multi-Region Deployment Platform

A production-grade, GitOps-driven multi-region deployment platform that orchestrates deployments across multiple Kubernetes (K3s) clusters with parallel fan-out, automated health checks, deterministic stored-manifest rollbacks, Prometheus observability, and Cloudflare Worker edge routing.

---

## 🏗️ Architecture

```
GitHub Push → Webhook → Control Plane (Port 3001) → BullMQ Worker
                                                      ↓
                                        ┌─────────────┴─────────────┐
                                        ▼                           ▼
                                  us-east-1 (8080)            ap-south-1 (8081)
                                  1 Svr, 2 Agents             1 Svr, 2 Agents
                                        │                           │
                                        └─────────────┬─────────────┘
                                                      ▼
                                       Cloudflare Worker (Port 8787)
                                      (Geo-Routing + Health Failover)
```

---

## 🌟 Platform Phases & Capabilities

| Phase | Feature & Capability | Status |
| :--- | :--- | :---: |
| **Phase 1** | **K3s Kubernetes Integration Layer**: Native `@kubernetes/client-node` client, typed JS manifests, idempotent apply, rollout polling, DB manifest storage (`manifest_json JSONB`). | ✅ |
| **Phase 2** | **Multi-Region Parallel Fan-Out**: Concurrent dispatch across `us-east-1` (port 8080) and `ap-south-1` (port 8081), synchronized cross-region rollbacks on failure. | ✅ |
| **Phase 3** | **Cloudflare Worker Traffic Router**: Geo-IP routing (`CF-IPCountry`), health-aware upstream proxies, zero-downtime failover, and Control Plane sync API. | ✅ |
| **Phase 4** | **Deterministic Rollback Engine**: Auto-rollback on health check failure using stored DB manifests (zero `kubectl` shelling required). | ✅ |
| **Phase 5** | **Full-Stack Observability**: Live pod status, pod container details, streaming pod logs, top CPU/memory metrics, and Prometheus `/metrics` scraping. | ✅ |

---

## 🚀 Quick Start

### 1. Start Infrastructure (PostgreSQL & Redis)
```bash
docker-compose -f docker-compose.dev.yml up -d
```

### 2. Provision Multi-Region K3d Clusters
```bash
# Cluster 1: us-east-1
k3d cluster create deploy-platform --servers 1 --agents 2 --port "8080:80@loadbalancer"

# Cluster 2: ap-south-1
k3d cluster create deploy-platform-ap-south --servers 1 --agents 2 --port "8081:80@loadbalancer" --port "8444:443@loadbalancer"
```

### 3. Setup Metrics Server (Optional, for Pod CPU/Memory)
```bash
./scripts/setup-metrics-server.sh
```

### 4. Setup Control Plane
```bash
cd control-plane
cp .env.example .env
pnpm install

# Start API (Terminal 1)
pnpm dev

# Start Build Worker (Terminal 2)
pnpm worker
```

### 5. Setup Dashboard UI
```bash
cd dashboard
pnpm install

# Start Frontend (Terminal 3)
pnpm dev
```

### 6. Setup Cloudflare Worker Edge Router (Optional)
```bash
cd cloudflare-worker
pnpm install

# Run local development server (Port 8787)
pnpm serve

# Or deploy to Cloudflare Edge
npx wrangler login
npx wrangler kv:namespace create "REGION_CONFIG"
pnpm deploy
```

---

## 📡 API Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/` | `GET` | API root landing and service status |
| `/health` | `GET` | API health check |
| `/metrics` | `GET` | Prometheus metrics scrape endpoint |
| `/auth/register` | `POST` | Create developer account |
| `/auth/login` | `POST` | Authenticate and obtain JWT token |
| `/api/apps` | `GET` / `POST` | List and create applications |
| `/api/deployments/:id` | `GET` | Get deployment lifecycle status, events, and sub-deployments |
| `/api/deployments/:id/rollback` | `POST` | Trigger manual cross-region rollback |
| `/api/regions` | `GET` | List active cluster regions, endpoints, and health |
| `/api/regions/sync` | `POST` | Synchronize active cluster endpoints to Cloudflare Worker |
| `/api/observability/:id/pods` | `GET` | List live pods with container states and restart counts across regions |
| `/api/observability/:id/logs` | `GET` | Stream / retrieve pod container logs with tail lines & timestamps |
| `/api/observability/:id/metrics`| `GET` | Fetch real-time CPU & memory consumption per pod |
| `/api/observability/:id/top` | `GET` | Top resource-consuming pods for a deployment |
| `/api/webhooks/github` | `POST` | GitHub push webhook receiver |

---

## 📈 Prometheus Metrics Exported

Scraped via `GET http://localhost:3001/metrics`:

```text
deployment_total{status="SUCCESS",region="all"}
deployment_duration_seconds_bucket{le="30"}
deployment_duration_seconds_sum
deployment_duration_seconds_count
active_deployments
build_failures_total
webhook_received_total
rollback_total{trigger="auto"}
```

---

## 🧪 Running Automated Tests

```bash
# Multi-Region K3s Integration & Rollback Test Suite
cd control-plane
npx ts-node scripts/test-e2e.ts

# Cloudflare Worker Router & Geo-Routing Unit Tests
cd ../cloudflare-worker
npx tsx test/router.test.ts
```

---

## 📄 License
MIT
