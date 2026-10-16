#!/usr/bin/env bash
# Creates a read-only "collector" identity in one cluster and writes a kubeconfig for it.
# The engine uses this kubeconfig to collect inventory. It can list workloads, networking,
# storage, RBAC and policy objects, but it cannot read Secrets or ConfigMaps or change anything.
#
# Usage:  scripts/collector-kubeconfig.sh <context> [output-file]
# Run it with your own admin context (for VKS: after kubectl vsphere login).
set -euo pipefail

ctx="${1:?Usage: $0 <context> [output-file]}"
out="${2:-${ctx}-collector.kubeconfig}"
ns=vks-migration-studio-collector
name=vks-migration-studio-collector
k() { kubectl --context "$ctx" "$@"; }

[ -e "$out" ] && { echo "$out already exists; choose another file name." >&2; exit 1; }
# The context name is written into the kubeconfig; keep it to characters that need no quoting.
case "$ctx" in *[!A-Za-z0-9._@:/-]*|-*) echo "Context name '$ctx' has unusual characters; rename it with kubectl config rename-context first." >&2; exit 1;; esac

rbac="$(cd "$(dirname "$0")" && pwd)/../deploy/kubernetes/collector-rbac.yaml"
[ -f "$rbac" ] || rbac="$(cd "$(dirname "$0")" && pwd)/collector-rbac.yaml"
[ -f "$rbac" ] || { echo "collector-rbac.yaml not found next to this script or in deploy/kubernetes/." >&2; exit 1; }
k apply -f "$rbac"

echo "Waiting for the token…"
token=""
for _ in $(seq 1 30); do
  token=$(k -n "$ns" get secret "$name-token" -o jsonpath='{.data.token}' 2>/dev/null || true)
  [ -n "$token" ] && break
  sleep 1
done
[ -n "$token" ] || { echo "The service account token was not issued. Check the cluster's token controller." >&2; exit 1; }

server=$(kubectl config view --minify --context "$ctx" -o jsonpath='{.clusters[0].cluster.server}')
ca=$(k -n "$ns" get secret "$name-token" -o jsonpath='{.data.ca\.crt}')

umask 077
cat > "$out" <<KUBECONFIG
apiVersion: v1
kind: Config
clusters:
  - name: $ctx
    cluster:
      server: $server
      certificate-authority-data: $ca
users:
  - name: $ctx-collector
    user:
      token: $(printf '%s' "$token" | base64 --decode)
contexts:
  - name: $ctx
    context: { cluster: $ctx, user: $ctx-collector }
current-context: $ctx
KUBECONFIG

echo "Wrote $out (read-only collector for context $ctx). Keep it private: it is a long-lived credential."
echo "Remove the identity later with: kubectl --context $ctx delete clusterrolebinding,clusterrole $name && kubectl --context $ctx delete namespace $ns"
