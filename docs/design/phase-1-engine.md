# Phase 1 design: the Migration Studio engine

Status: **draft for review**. Nothing in this document is built yet. Comment on the pull request. Decisions 1–4 in section 8 are settled; the data-movement decision is open.

## 1. Why change the design

Today Migration Studio is a careful planning and pilot tool for one workload at a time:

- All state lives in one browser tab until the user saves a project JSON file.
- The local runners write receipt files that the user imports back into the browser by hand. Most of the High findings in the v0.20 review come from that loop: evidence wiped by unrelated edits, runs replaced or orphaned, cleanup racing a deploy, receipts that cannot be authenticated.
- Scope is one Deployment with one replica. Waves can be planned but not executed.
- Some planning is quadratic and the runners call `kubectl` per operation, so large inventories are slow.

A migration engine has to hold state, run the work itself and record evidence directly. Phase 1 builds that foundation and runs **one pilot end to end with no files passed back and forth**. Waves, the estate UI and stateful migration come in later phases.

## 2. Goals and non-goals

**Phase 1 goals**

1. One container image that serves the UI and the engine API, run locally with `docker run`.
2. Durable state in SQLite: projects, clusters, inventories, plans, runs, evidence and an audit log.
3. The engine runs collection, target preflight and the single-workload pilot (validate, deploy, observe, inspect, cleanup) itself and records evidence directly. No receipt import.
4. Evidence bound to a content hash of the inputs it covers, so unrelated edits never invalidate it.
5. Reuse the existing analysis modules and their tests unchanged.
6. The first UI screens in the new Clarity-style look: estate overview, workload detail, pilot run monitor.

**Not in phase 1**

- Multi-workload waves and parallel execution (phase 2).
- In-cluster deployment with a Helm chart, multi-user access and OIDC (phase 2).
- Stateful migration and data movement (phase 3; see section 8, decision 5).
- GitOps execution mode (phase 3).
- Production traffic cutover. The production gate stays closed.

## 3. Architecture

```
 Browser (UI)  ──HTTP/JSON──►  Engine API (Fastify, TypeScript)
                                  │
                ┌─────────────────┼──────────────────────┐
                ▼                 ▼                      ▼
        Planning core       Job runner             Store (SQLite)
   (existing dist/*.js,   (leases, retries,     projects, clusters,
    reused as-is)          heartbeats)          snapshots, plans,
                                  │              runs, evidence, audit
                                  ▼
                         Cluster adapters
                (phase 1a: existing Python runners
                 phase 1b: TypeScript Kubernetes client)
                                  │
                                  ▼
                  Source cluster      VKS target cluster
                 (kubeconfig contexts, mounted read-only)
```

### 3.1 Engine API

- **Fastify** with JSON Schema validation on every route. The schemas double as the OpenAPI description, so a CLI or CI job can drive the engine without the UI.
- Listens on `127.0.0.1` only by default. A random access token is generated at first start, printed once, and required on every request, so another local process or web page cannot drive the engine.
- Main resources:

| Resource | Purpose |
|---|---|
| `/projects` | A migration project: source, target, settings |
| `/clusters` | Registered contexts (name, role, observed cluster UID). No credentials stored |
| `/projects/{id}/inventories` | Collected or imported snapshots, immutable once stored |
| `/projects/{id}/workloads` | Workloads with their current state and findings |
| `/projects/{id}/plans` | Pilot plans, each with its content hash |
| `/jobs` | Collection, preflight and pilot steps; status, progress, logs |
| `/runs/{id}` | A pilot run: every step, its evidence and its current lifecycle state |
| `/audit` | Append-only event log |
| `/projects/{id}/export` | Project JSON and ZIP, as today, for backup and handoff |

### 3.2 Planning core: reuse, don't rewrite

The browser modules in `dist/` (engine, preflight, pilot, execution, routing, images, gitops, security, storage, acceptance, waves, handoff) already load in Node with `require()`. Their test suites keep running unchanged.

- Phase 1 loads them as they are, behind TypeScript type declarations (`.d.ts`) written for the functions the engine calls.
- Modules move to TypeScript source one at a time later, each move gated by its existing tests. No big-bang rewrite.
- The modules stay pure: input in, plan or findings out. All I/O lives in the engine.

### 3.3 Store

- **SQLite** through `better-sqlite3`, in WAL mode, in one file on a mounted volume (`/data/studio.db`).
- Queries go through **Kysely**, so phase 2 can switch to PostgreSQL for in-cluster mode without rewriting them.
- Large documents (inventory snapshots, manifests, receipts) are stored as compressed JSON blobs keyed by SHA-256. Rows reference blobs by hash, so identical snapshots are stored once.
- Indexed tables replace the in-memory scans that made security planning quadratic.

Core tables:

| Table | Key fields |
|---|---|
| `projects` | id, name, source_cluster_id, target_cluster_id, settings |
| `clusters` | id, context_name, role, observed_uid, last_seen_at |
| `snapshots` | id, cluster_id, blob_hash, collected_at, coverage |
| `workloads` | id, project_id, resource_id, state, wave_id |
| `plans` | id, workload_id, input_hash, blob_hash, created_at |
| `runs` | id, plan_id, run_id (the label value), state, lease_owner, heartbeat_at |
| `evidence` | id, run_id, kind, input_hash, blob_hash, observed_at |
| `jobs` | id, type, payload, state, attempts, lease_until |
| `audit` | seq, at, actor, action, subject, detail (append-only) |

### 3.4 Evidence binding (fixes the v0.20 High findings)

Every piece of evidence records the **content hash of exactly the inputs it covers**, never a global revision:

- A pilot plan's hash covers the workload manifests, image digests, service account mapping, target context, both cluster UIDs and the execution settings. Nothing else.
- Evidence (validation, deploy, observation, inspection, cleanup) stores the plan hash it ran against.
- Editing a storage plan, GitOps settings or an acceptance case changes other hashes and leaves pilot evidence untouched.
- If a plan's inputs change while a run is still unresolved, the old run **stays visible and stays first in the action list**, marked "plan changed since this run". Only an Absent inspection or cleanup closes it.

This removes the class of bugs where an unrelated save discarded a running pilot's receipt.

### 3.5 Workload state machine

```
Discovered → Assessed → Planned → Validated → Piloting → PilotPassed
                                       │           │
                                       │           ├→ PilotFailed → Recovering → Cleaned
                                       │           └→ NeedsReview  ↗
                                       └→ Blocked (findings must be resolved)
```

- Transitions happen only in the engine, inside a database transaction, and each one writes an audit row.
- `Migrated`, `Verified`, `CutOver` and `RolledBack` are reserved for phases 2 and 3.
- Every state shows in the UI with its evidence and the next allowed action.

### 3.6 Job runner

- An in-process queue persisted in the `jobs` table. No Redis or external broker.
- Every job takes a **lease** with a heartbeat. A crashed engine leaves expired leases; on restart, those jobs are resumed or marked `NeedsReview`, never silently restarted.
- **One active run per workload**, enforced by a unique index. This removes the "cleanup while a deploy is still running" race from the review.
- Concurrency limit per target cluster (default 1 in phase 1).
- Steps are idempotent: each records what it is about to create *before* sending it, as the current runner already does. A lost response always resolves to Owned, Recovered or Absent on the next inspection.

### 3.7 Cluster adapters

**Phase 1a: wrap the existing runners.** The engine calls `pilot-runner.py`, `target-preflight.py`, `collect.py` and `image-runner.py` as subprocesses inside the container, and reads their JSON results directly. This reuses tested code, including its safety checks, and gets an end-to-end pilot working quickly.

**Phase 1b: native TypeScript adapter.** Port the runner logic to `@kubernetes/client-node`:
- paged list and watch instead of one `kubectl` call per operation;
- UID and resourceVersion preconditions sent by the API client;
- spec-based comparison (uid, generation, template hash) for cleanup, instead of resourceVersion, which changes on every status update.

The Python runners stay available as standalone tools for people who want to work without the engine.

**Decided:** port to TypeScript in milestone 1.4.

### 3.8 Credentials and VKS sign-in

- The engine **never stores cluster credentials**. Local mode mounts the user's kubeconfig read-only and uses named contexts.
- VKS contexts created with `kubectl vsphere login` carry short-lived tokens. When a token expires mid-run, the job pauses as `WaitingForCredentials` and the UI asks the user to log in again on their machine. The engine never asks for a vSphere password.
- `kubectl-vsphere` is **not** bundled in the image. Users log in on the host and the mounted kubeconfig picks up the new token.
- Registry credentials for Skopeo follow the same rule: the user's local auth file is mounted read-only.

### 3.9 Container image

- Multi-stage build, Debian slim base. Contents: Node 22 LTS runtime, Python 3, a pinned `kubectl`, Skopeo, the engine, the built UI.
- Runs as a non-root user with a read-only root filesystem. Writable paths are only `/data` and `/tmp`.
- Built for amd64 and arm64, published to GHCR with an SBOM and a cosign signature, from GitHub Actions on each tagged release.

Local run:

```bash
docker run --rm -p 127.0.0.1:8080:8080 \
  -v "$HOME/.kube:/home/studio/.kube:ro" \
  -v studio-data:/data \
  ghcr.io/avnish80/vks-migration-studio:1.0.0-alpha.1
```

On Windows the same command works in PowerShell with `$env:USERPROFILE\.kube`.

### 3.10 Security

- Engine bound to localhost, with the token check from 3.1; CSRF protection on state-changing routes.
- Strict Content Security Policy on the UI (`default-src 'self'`), already shown to work with the current app.
- Redaction on collection stays as in phase 0. Secrets and ConfigMap data are never collected.
- The audit log records who did what to which object. In local mode "who" is the local user; real identities come with OIDC in phase 2.
- The runner label is renamed from `migration-studio.openai/pilot-run` to `vks-migration-studio.io/pilot-run`. Inspection and cleanup still recognise the old label so pilots that are already deployed can be cleaned up.

### 3.11 Observability

- Prometheus metrics on `/metrics`: jobs by state, step durations, API latency, cluster call errors.
- Structured JSON logs. Raw kubectl or registry stderr is never written to evidence, only to local debug logs, and only when debug logging is turned on.

## 4. UI

Phase 1 replaces the browser-only app with a React + Vite app served by the engine. It uses the Clarity visual language (Clarity City font, palette, density, MIT-licensed icons) on components we own, not the archived Clarity Core package.

Phase 1 screens:

1. **Estate overview.** One table of all workloads: namespace, kind, state, blockers, last evidence. Filters and search. Health blocks at the top that click through, like the vks-fleet dashboard.
2. **Workload detail.** Findings, dependencies, the generated plan and its diff, evidence timeline, next allowed action.
3. **Pilot run monitor.** Live step progress (polling, server-sent events later), created objects with UIDs, rollout and smoke results, and inspect and cleanup actions.
4. **Clusters.** Registered contexts, observed cluster UID, token status.

The remaining v0.20 views (security, storage, routing, images, GitOps, acceptance, waves, handoff) move to the new UI in phase 2; their planning logic is already in the reused core. The old static UI is **not** shipped with the engine. v0.20 stays available as a tagged release for anyone who needs those views before phase 2.

Design rules carried from the review:
- the production-gate caveat lives in one status strip, not on every page;
- unsaved form edits are never lost on navigation;
- every error message names what differs and what to do.

## 5. Repository layout

```
/engine        TypeScript engine (Fastify, job runner, store, adapters)
/ui            React + Vite UI
/dist          existing browser modules, reused by the engine; the old static UI is not served
/runners       existing Python runners (moved from dist/ in a later step)
/test          existing suites, plus engine unit and integration tests
/deploy        Dockerfile; Helm chart in phase 2
/docs          design docs and user guide
```

## 6. Testing

- All existing suites keep running in CI unchanged.
- Engine unit tests (Vitest) for the state machine, leases, evidence binding and every API route.
- Integration tests against a **kind** cluster in CI: collect, plan, validate, deploy, observe, inspect and cleanup a sample workload end to end, including:
  - a killed engine mid-deploy that resumes correctly;
  - an expired token that pauses and resumes;
  - an HPA or route that blocks the pilot;
  - status churn during cleanup.
- A manual lab checklist for real VKS (from the review's integration plan), run before each release: NSX ALB / AKO, Contour, namespace-scoped RBAC, `kubectl vsphere` token expiry, Harbor.

## 7. Milestones

| Milestone | Exit criteria |
|---|---|
| **1.0 Skeleton** | Container builds and runs; engine serves an empty new UI shell; SQLite store with migrations; token auth; CI builds and signs the image |
| **1.1 Inventory** | Register clusters; run collection as a job; snapshots stored and diffed; estate overview lists workloads with findings |
| **1.2 Pilot (wrapped runners)** | Plan, validate, deploy, observe, inspect and cleanup run as jobs with evidence recorded directly; one active run per workload; run monitor screen; kind integration test passes |
| **1.3 Hardening** | Engine restart mid-run recovers; token expiry pauses jobs; audit log complete; metrics; lab test on real VKS |
| **1.4 Native adapter** | TypeScript Kubernetes adapter replaces the Python pilot runner inside the engine; same tests pass |

## 8. Decisions

**Settled (16 Oct 2026)**

1. **Runner port:** native TypeScript adapter in milestone 1.4.
2. **UI framework:** React.
3. **Classic UI:** not shipped with the engine. v0.20 stays available as a tagged release.
4. **Versioning:** the engine starts at 1.0.0-alpha.

**Open: 5. Data movement for stateful workloads (phase 3)**

Proposal: no single mover. The engine defines a `DataMover` interface (prepare, pre-sync, quiesce, final sync, verify, rollback) and picks a mover per volume. This follows the methods in Broadcom's July 2026 migration papers for VKS, and adds what those papers say their example scripts leave out: persistent state, retries, concurrency control, rollback and finalizer recovery.

| Mover | When | Notes |
|---|---|---|
| **FCD adoption** (zero copy) | Source is vSphere CSI on the same or a reachable vCenter (VKS to VKS, TKG to VKS) | Move the First Class Disk with vMotion and register it with `CnsRegisterVolume`. No data copy; RWO filesystem volumes only; versions must be validated |
| **rsync (pv-migrate)** | Any filesystem PVC from any source platform | Pre-sync while the app runs, then a short final sync after quiesce. Needs TCP 22 from source to a temporary VKS LoadBalancer |
| **Application-native replication** | Databases and queues (PostgreSQL, MySQL, Kafka, Redis) | Lowest downtime. The application owner runs replication; the engine checks lag and gates the cutover |
| **Velero with Kopia data mover** | Networks where SSH cannot cross, or volumes the other movers cannot handle (check block-mode support for the Velero version used) | Copies through an S3 bucket; slower, but works where the others cannot |

Kubernetes objects keep coming from the engine's own generated manifests, not from Velero object backups, so every object stays reviewable and digest-pinned.
