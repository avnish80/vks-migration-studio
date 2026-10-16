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

k apply -f - <<YAML
apiVersion: v1
kind: Namespace
metadata: { name: $ns }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: $name, namespace: $ns }
---
apiVersion: v1
kind: Secret
metadata:
  name: $name-token
  namespace: $ns
  annotations: { kubernetes.io/service-account.name: $name }
type: kubernetes.io/service-account-token
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: $name }
rules:
  # Read-only. Secrets and ConfigMaps are deliberately absent.
  - apiGroups: [""]
    resources: [namespaces, nodes, pods, services, serviceaccounts, persistentvolumeclaims, persistentvolumes, resourcequotas, limitranges]
    verbs: [get, list]
  - apiGroups: [apps]
    resources: [deployments, statefulsets, daemonsets, replicasets]
    verbs: [get, list]
  - apiGroups: [batch]
    resources: [jobs, cronjobs]
    verbs: [get, list]
  - apiGroups: [networking.k8s.io]
    resources: [ingresses, ingressclasses, networkpolicies]
    verbs: [get, list]
  - apiGroups: [storage.k8s.io]
    resources: [storageclasses, csidrivers]
    verbs: [get, list]
  - apiGroups: [rbac.authorization.k8s.io]
    resources: [roles, rolebindings, clusterroles, clusterrolebindings]
    verbs: [get, list]
  - apiGroups: [policy]
    resources: [poddisruptionbudgets]
    verbs: [get, list]
  - apiGroups: [autoscaling]
    resources: [horizontalpodautoscalers]
    verbs: [get, list]
  - apiGroups: [apiextensions.k8s.io]
    resources: [customresourcedefinitions]
    verbs: [get, list]
  - apiGroups: [admissionregistration.k8s.io]
    resources: [validatingwebhookconfigurations, mutatingwebhookconfigurations, validatingadmissionpolicies, validatingadmissionpolicybindings]
    verbs: [get, list]
  # Controller and policy types the collector records when the cluster has them.
  - apiGroups:
      - gateway.networking.k8s.io
      - snapshot.storage.k8s.io
      - policy.networking.k8s.io
      - config.gatekeeper.sh
      - syncset.gatekeeper.sh
      - externaldata.gatekeeper.sh
      - mutations.gatekeeper.sh
      - templates.gatekeeper.sh
      - constraints.gatekeeper.sh
      - kyverno.io
      - policies.kyverno.io
      - k8s.cni.cncf.io
      - argoproj.io
      - helm.toolkit.fluxcd.io
      - kustomize.toolkit.fluxcd.io
      - external-secrets.io
      - crd.antrea.io
      - crd.projectcalico.org
      - cilium.io
      - security.istio.io
      - keda.sh
      - autoscaling.k8s.io
      - projectcontour.io
    resources: ["*"]
    verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: $name }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: $name }
subjects:
  - { kind: ServiceAccount, name: $name, namespace: $ns }
YAML

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
