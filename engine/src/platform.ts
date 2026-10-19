/**
 * Platform add-ons are workloads that come with the cluster or its platform (VKS system services,
 * Carvel packages, mesh, certificates, identity, backup) rather than applications to migrate. They are
 * kept apart so the estate shows the applications; the operator can override each one.
 */

/** Namespaces that hold cluster or platform services on VKS and common add-ons. */
const NAMESPACES: [RegExp, string][] = [
  [/^kube-(system|public|node-lease)$/, 'Kubernetes system namespace'],
  [/^(vmware-system-|tkg-system$|tkg-|tanzu-system|tanzu-|vks-system)/, 'VKS or Tanzu system namespace'],
  [/^(kapp-controller|secretgen-controller|carvel-)/, 'Carvel package tooling'],
  [/^cert-manager$/, 'cert-manager add-on'],
  [/^(istio-system|istio-ingress|istio-egress|istio-gateways?|istio-waypoints|istio-cni)$/, 'Istio service mesh'],
  [/^pinniped-/, 'Pinniped authentication'],
  [/^velero$/, 'Velero backup'],
  [/^(avi-system|ako-system|nsx-system|antrea-|calico-|tigera-)/, 'Networking or load-balancer integration'],
  [/^(gatekeeper-system|kyverno)$/, 'Policy engine'],
];

interface Meta { labels?: Record<string, string>; annotations?: Record<string, string> }

/** The reason a workload looks like a platform add-on, or null for an application. */
export function platformReason(namespace: string, meta: Meta | undefined): string | null {
  for (const [pattern, reason] of NAMESPACES) if (pattern.test(namespace)) return `${reason} (namespace ${namespace})`;
  const labels = meta?.labels ?? {}, annotations = meta?.annotations ?? {};
  if ('kapp.k14s.io/app' in labels || 'kapp.k14s.io/identity' in annotations) return 'Installed by a Carvel package (kapp)';
  return null;
}

/** Effective classification after the operator's override. */
export function effectivePlatform(auto: string | null, override: string | null): string | null {
  if (override === 'app') return null;
  if (override === 'platform') return auto ?? 'Marked as a platform add-on';
  return auto;
}
