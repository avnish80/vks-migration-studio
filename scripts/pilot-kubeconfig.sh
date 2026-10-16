#!/usr/bin/env bash
# Creates the pilot login for a VKS target cluster: a service account that can create, check and
# delete a pilot Deployment and its Services in ONE namespace, and read what the pilot checks need.
# Writes a kubeconfig whose context name is "<context>-pilot".
#
# Usage:  scripts/pilot-kubeconfig.sh <target-context> <namespace> [output-file]
# The namespace must already exist on the target (the pilot keeps the source namespace name).
set -euo pipefail

ctx="${1:?Usage: $0 <target-context> <namespace> [output-file]}"
namespace="${2:?Usage: $0 <target-context> <namespace> [output-file]}"
out="${3:-${ctx}-pilot.kubeconfig}"
sa_ns=vks-migration-studio-pilot
name=vks-migration-studio-pilot
k() { kubectl --context "$ctx" "$@"; }

[ -e "$out" ] && { echo "$out already exists; choose another file name." >&2; exit 1; }
case "$ctx" in *[!A-Za-z0-9._@:/-]*|-*) echo "Context name '$ctx' has unusual characters; rename it with kubectl config rename-context first." >&2; exit 1;; esac
[[ "$namespace" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || { echo "'$namespace' is not a valid namespace name." >&2; exit 1; }
k get namespace "$namespace" >/dev/null 2>&1 || { echo "Namespace $namespace does not exist on $ctx. Create it with the labels, quotas and policies it needs first." >&2; exit 1; }

here="$(cd "$(dirname "$0")" && pwd)"
rbac="$here/../deploy/kubernetes/pilot-rbac.yaml"
[ -f "$rbac" ] || rbac="$here/pilot-rbac.yaml"
[ -f "$rbac" ] || { echo "pilot-rbac.yaml not found next to this script or in deploy/kubernetes/." >&2; exit 1; }
sed "s/__NAMESPACE__/$namespace/g" "$rbac" | k apply -f -

echo "Waiting for the token…"
token=""
for _ in $(seq 1 30); do
  token=$(k -n "$sa_ns" get secret "$name-token" -o jsonpath='{.data.token}' 2>/dev/null || true)
  [ -n "$token" ] && break
  sleep 1
done
[ -n "$token" ] || { echo "The service account token was not issued. Check the cluster's token controller." >&2; exit 1; }

server=$(kubectl config view --minify --context "$ctx" -o jsonpath='{.clusters[0].cluster.server}')
ca=$(k -n "$sa_ns" get secret "$name-token" -o jsonpath='{.data.ca\.crt}')
pilot="$ctx-pilot"

umask 077
cat > "$out" <<KUBECONFIG
apiVersion: v1
kind: Config
clusters:
  - name: $pilot
    cluster:
      server: $server
      certificate-authority-data: $ca
users:
  - name: $pilot
    user:
      token: $(printf '%s' "$token" | base64 --decode)
contexts:
  - name: $pilot
    context: { cluster: $pilot, user: $pilot, namespace: $namespace }
current-context: $pilot
KUBECONFIG

echo "Wrote $out with context $pilot (write access to namespace $namespace only). Keep it private."
echo "Add it to the engine's kubeconfig Secret, then choose $pilot as the pilot login on the Clusters page."
