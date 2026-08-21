# Cloud-Native Multi-Region Deployment Platform

A lightweight, multi-tenant deployment platform for containerized applications with automated builds, multi-region Kubernetes deployments, state machines, and real-time event logs.

---

## 🏗️ Architecture

```
                       +-------------------+
                       |    GitHub Webhook |
                       +---------+---------+
                                 |
                                 v
+------------------+   +---------+---------+   +-------------------+
|  React Dashboard |<->|   Control Plane   |<->|    PostgreSQL     |
|   (Vite + TS)    |   |   (Express + TS)  |   | (Apps/Deployments)|
+------------------+   +---------+---------+   +-------------------+
                                 |
                                 v
                       +---------+---------+   +-------------------+
                       |   Redis Queue /   |<->|   Build Worker    |
                       | Distributed Locks |   | (Docker/Kaniko)   |
                       +---------+---------+   +---------+---------+
                                                         |
                                                         v
                                               +---------+---------+
                                               |  Kubernetes (k3s) |
                                               | Cluster Deployment|
                                               +-------------------+
```

---

## ✨ Features

- **Automated GitOps Pipelines**: Webhook & API-triggered builds with commit tracking.
- **State Machine Engine**: Robust deployment lifecycle (`QUEUED` -> `CLONING` -> `BUILDING` -> `PUSHING` -> `DEPLOYING` -> `HEALTH_CHECK` -> `SUCCESS` / `ROLLING_BACK` / `ROLLED_BACK`).
- **Distributed Locking**: Redis-backed concurrency control preventing overlapping deployments of the same app.
- **Multi-Region Orchestration**: Track and manage sub-deployments across multiple regions or clusters.
- **Instant Rollback**: One-click rollbacks to previous stable deployments upon health check failures.
- **Real-Time Event Timeline**: Granular audit log of all deployment events and operational state changes.
- **Modern Dashboard**: Built with React 18, Vite, TypeScript, Tailwind CSS, and Lucide icons.

---

## 🚀 Quick Start

### 1. Prerequisites
- [Docker & Docker Compose](https://www.docker.com/)
- [Node.js (v18+)](https://nodejs.org/) & [pnpm](https://pnpm.io/)
- [k3d](https://k3d.io/) *(optional for local Kubernetes clusters)*

### 2. Start PostgreSQL & Redis
```bash
docker-compose -f docker-compose.dev.yml up -d
```

### 3. Setup Kubernetes Cluster (Optional)
```bash
k3d cluster create deploy-platform --servers 1 --agents 2 --port "8080:80@loadbalancer"
export KUBECONFIG=$(k3d kubeconfig write deploy-platform)
```

### 4. Setup Control Plane
```bash
cd control-plane
cp .env.example .env
# Configure .env with your secrets and registry credentials

pnpm install
pnpm dev        # Runs Control Plane API on http://localhost:3001
```

In a separate terminal:
```bash
cd control-plane
pnpm worker     # Starts background deployment worker
```

### 5. Setup Dashboard
```bash
cd dashboard
pnpm install
pnpm dev        # Runs Dashboard on http://localhost:5173
```

---

## 🛠️ Tech Stack

- **Frontend**: React, Vite, TypeScript, Tailwind CSS, Lucide React, Axios, React Router.
- **Backend API**: Node.js, Express, TypeScript, BullMQ, Redis (ioredis), PostgreSQL (pg), Dockerode, @kubernetes/client-node.
- **Infrastructure**: Docker Compose, PostgreSQL 15, Redis 7, Kubernetes (k3s/k3d).
