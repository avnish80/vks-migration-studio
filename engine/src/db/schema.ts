import type { Generated } from 'kysely';

/** Table types for Kysely. Columns mirror docs/design/phase-1-engine.md section 3.3. */
export interface Database {
  projects: { id: string; name: string; description: string; source_cluster_id: string | null; target_cluster_id: string | null; settings: string; created_at: string; updated_at: string };
  clusters: { id: string; context_name: string; name: string | null; role: 'source' | 'target'; observed_uid: string | null; last_seen_at: string | null; last_error: string | null; retired_at: string | null; created_at: string };
  blobs: { hash: string; size: number; compressed: Buffer; created_at: string };
  snapshots: { id: string; project_id: string; side: 'source' | 'target'; origin: 'collected' | 'imported' | 'demo'; cluster_id: string | null; blob_hash: string; analysis_hash: string | null; resource_count: number; collected_at: string; stored_at: string; coverage: string };
  workloads: { id: string; project_id: string; resource_id: string; kind: string | null; namespace: string | null; name: string | null; snapshot_id: string | null; blockers: Generated<number>; reviews: Generated<number>; state: string; wave_id: string | null; updated_at: string };
  plans: { id: string; workload_id: string; input_hash: string; blob_hash: string; created_at: string };
  runs: { id: string; plan_id: string; workload_id: string; run_label: string; state: string; lease_owner: string | null; heartbeat_at: string | null; created_at: string; updated_at: string };
  evidence: { id: string; run_id: string; kind: string; input_hash: string; blob_hash: string; observed_at: string };
  jobs: { id: string; type: string; project_id: string | null; payload: string; state: string; attempts: number; lease_owner: string | null; lease_until: string | null; progress: string | null; result: string | null; error: string | null; created_at: string; updated_at: string };
  audit: { seq: Generated<number>; at: string; actor: string; action: string; subject: string; detail: string };
}
