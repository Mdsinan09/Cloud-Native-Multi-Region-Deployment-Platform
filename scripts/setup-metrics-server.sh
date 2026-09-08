#!/bin/bash
# Setup metrics-server on k3d clusters for kubectl top / pod metrics

set -e

REGIONS=("k3d-deploy-platform" "k3d-deploy-platform-ap-south")

for ctx in "${REGIONS[@]}"; do
  echo "🔧 Setting up metrics-server on $ctx..."
  kubectl config use-context "$ctx"

  # Apply metrics-server
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

  # Patch to allow insecure TLS (required for k3d self-signed certs)
  kubectl patch deployment metrics-server -n kube-system --type='json' \
    -p='[{"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--kubelet-insecure-tls"}]'

  echo "⏳ Waiting for metrics-server to be ready..."
  kubectl wait --for=condition=available --timeout=60s deployment/metrics-server -n kube-system

  echo "✅ $ctx metrics-server ready"
  echo ""
done

echo "🎉 All clusters have metrics-server installed!"
echo "Test with: kubectl top pods -n default"
