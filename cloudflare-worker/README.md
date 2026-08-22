# Cloudflare Worker: Multi-Region Traffic Router (Phase 3)

Intelligent, low-latency edge router that distributes user requests across multi-region Kubernetes clusters with health-aware failover and Geo-IP routing.

---

## 🌟 Architecture & Flow

```
User Request
     │
     ▼
Cloudflare Worker (Edge)
     │
     ├── 1. Health-check all upstream regions in parallel
     │
     ├── 2. Extract Client Geo-IP (CF-IPCountry)
     │      ├─ IN/PK/BD/LK/AE/SG/AU → ap-south-1 (Port 8081)
     │      └─ US/CA/MX/BR/EU/GB    → us-east-1 (Port 8080)
     │
     ├── 3. Weighted Random distribution across healthy regions
     │
     └── 4. Proxy request & append telemetry headers:
            ├─ X-Routed-To-Region: <region>
            ├─ X-Served-By-Region: <region>
            └─ X-Region-Health: 2/2
```

---

## 🚀 Setup & Deployment

### 1. Install Dependencies
```bash
cd cloudflare-worker
pnpm install
```

### 2. Login to Cloudflare
```bash
npx wrangler login
```

### 3. Create KV Namespace & Update `wrangler.toml`
```bash
npx wrangler kv:namespace create "REGION_CONFIG"
```
Copy the generated `id` into [`wrangler.toml`](./wrangler.toml):
```toml
kv_namespaces = [
  { binding = "REGION_CONFIG", id = "YOUR_KV_NAMESPACE_ID" }
]
```

### 4. Deploy the Worker
```bash
pnpm deploy
```

---

## 🔧 Control Plane Sync API

After deploying an application across clusters, synchronize the cluster configuration directly to the Cloudflare Worker:

```bash
curl -X POST http://localhost:3001/api/regions/sync \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "workerUrl": "https://multi-region-traffic-router.your-subdomain.workers.dev",
    "adminToken": "your-admin-token-change-in-production",
    "appName": "my-app",
    "deploymentId": "optional-deployment-id"
  }'
```

---

## 🧪 Testing the Router

### 1. Test Geo-Routing
```bash
# Test US routing
curl -i -H "CF-IPCountry: US" https://your-worker.workers.dev/health
# Header: X-Served-By-Region: us-east-1

# Test India routing
curl -i -H "CF-IPCountry: IN" https://your-worker.workers.dev/health
# Header: X-Served-By-Region: ap-south-1
```

### 2. View Active Region Status (Admin)
```bash
curl https://your-worker.workers.dev/admin/regions
```

### 3. Live Failover Simulation
If one cluster goes down, the Cloudflare Worker automatically routes 100% of traffic to the remaining healthy cluster with zero downtime.
