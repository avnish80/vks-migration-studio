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
    # Exactly what dist/collect.py reads. Secrets, ConfigMaps and Pods (plaintext env values) are absent.
  - apiGroups: [""]
    resources: [namespaces, nodes, services, serviceaccounts, persistentvolumeclaims, persistentvolumes]
    verbs: [get, list]
  - apiGroups: [apps]
    resources: [deployments, statefulsets, daemonsets]
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
  # Controller and policy types, recorded when the cluster has them.
  - { apiGroups: [gateway.networking.k8s.io], resources: [gateways, gatewayclasses, httproutes, grpcroutes, tlsroutes, tcproutes, udproutes, referencegrants], verbs: [get, list] }
  - { apiGroups: [snapshot.storage.k8s.io], resources: [volumesnapshotclasses], verbs: [get, list] }
  - { apiGroups: [policy.networking.k8s.io], resources: [adminnetworkpolicies, baselineadminnetworkpolicies], verbs: [get, list] }
  - { apiGroups: [config.gatekeeper.sh], resources: [configs], verbs: [get, list] }
  - { apiGroups: [syncset.gatekeeper.sh], resources: [syncsets], verbs: [get, list] }
  - { apiGroups: [externaldata.gatekeeper.sh], resources: [providers], verbs: [get, list] }
  - { apiGroups: [mutations.gatekeeper.sh], resources: [assign, assignmetadata, assignimage, modifyset], verbs: [get, list] }
  - { apiGroups: [templates.gatekeeper.sh], resources: [constrainttemplates], verbs: [get, list] }
  # Gatekeeper constraint kinds are named by each template, so this group needs a wildcard; it holds policy parameters only.
  - { apiGroups: [constraints.gatekeeper.sh], resources: ["*"], verbs: [get, list] }
  - { apiGroups: [kyverno.io], resources: [clusterpolicies, policies], verbs: [get, list] }
  - { apiGroups: [policies.kyverno.io], resources: [validatingpolicies, mutatingpolicies], verbs: [get, list] }
  - { apiGroups: [k8s.cni.cncf.io], resources: [network-attachment-definitions], verbs: [get, list] }
  # Argo CD Applications and Flux HelmReleases can carry Helm values; the collector removes them from
  # what it stores, but this login can read them. Drop these two rules if that is not acceptable.
  - { apiGroups: [argoproj.io], resources: [applications, applicationsets], verbs: [get, list] }
  - { apiGroups: [helm.toolkit.fluxcd.io], resources: [helmreleases], verbs: [get, list] }
  - { apiGroups: [kustomize.toolkit.fluxcd.io], resources: [kustomizations], verbs: [get, list] }
  - { apiGroups: [external-secrets.io], resources: [externalsecrets, secretstores, clustersecretstores], verbs: [get, list] }
  - { apiGroups: [crd.antrea.io], resources: [clusternetworkpolicies, networkpolicies], verbs: [get, list] }
  - { apiGroups: [crd.projectcalico.org], resources: [globalnetworkpolicies, networkpolicies], verbs: [get, list] }
  - { apiGroups: [cilium.io], resources: [ciliumnetworkpolicies, ciliumclusterwidenetworkpolicies], verbs: [get, list] }
  - { apiGroups: [security.istio.io], resources: [authorizationpolicies, peerauthentications], verbs: [get, list] }
  - { apiGroups: [keda.sh], resources: [scaledobjects], verbs: [get, list] }
  - { apiGroups: [autoscaling.k8s.io], resources: [verticalpodautoscalers], verbs: [get, list] }
  - { apiGroups: [projectcontour.io], resources: [httpproxies], verbs: [get, list] }
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
