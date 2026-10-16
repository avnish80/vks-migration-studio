# VKS Migration Studio

Plan and pilot the move of Kubernetes workloads onto VMware vSphere Kubernetes Service (VKS).

Migration Studio analyses a source cluster inventory, compares it with a VKS target, and prepares a reviewable, isolated single-workload pilot. Separate local runners validate, deploy, observe, inspect and clean up that pilot against an explicit kubeconfig context.

> **Status: pre-release.** The automated suites use mocked cluster interfaces. Live VKS integration testing is still pending, and the production gate is permanently closed. Do not use this for production migrations.

## Run the UI locally

No build or npm install is needed. From the repository root:

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory dist   # Windows: py -3 -m http.server ...
```

Open http://127.0.0.1:8080. A demo inventory loads automatically. The browser never contacts a cluster and stores no credentials; save your work explicitly as project JSON.

## Run the local tools

The scripts in `dist/` run on your workstation and need Python 3. `collect.py`, `target-preflight.py` and `pilot-runner.py` also need `kubectl`; `image-runner.py` needs Skopeo. Each takes an explicit `--context`. See the release notes below for each tool's commands and safety checks.

## Run the tests

```bash
./scripts/run-tests.sh
```

This needs Node.js 22 and Python 3. CI runs the same script on every push and pull request.

## License

Apache License 2.0. See [LICENSE](LICENSE).

This is a community project. It uses only public Kubernetes APIs and open-source tools, and is not a VMware or Broadcom product.

## Original design notes

Read-only inventory analysis MVP. Buildless browser application with no external dependencies.

Serve `dist/` using any static web server. The browser makes no cluster API calls and stores no cluster credentials, server uploads or automatic browser persistence. Downloaded local runners use explicit kubeconfig contexts; the pilot runner can create scoped resources only through its separately invoked deploy command. Explicit downloadable project files provide save/resume. Import processing occurs in browser memory.

# Release notes

## Guided action checklist and focused pilot workflow (v0.20)
The dashboard now provides a migration action checklist derived from the same current handoff review. Filter Project, Selected pilot and Inventory work; inspect priority items and open the relevant workbench directly. Existing-run recovery moves to the top when unresolved. Status labels distinguish recorded scope, no generated blockers, reported evidence and required independent review; there is no readiness percentage or manual completion toggle.

The pilot page now has four focused steps: Prepare draft, Validate & run, Observe & timeline, and Inspect & recover. A shared workload selector, reported lifecycle state, receipt import and error area stay visible. Checklist shortcuts open the appropriate pilot step. A successful receipt import selects its relevant step; invalid imports preserve current evidence. Changing workload returns to preparation and invalidates scope-bound evidence as before. Phase and checklist filter selection are navigation state only, not saved approval/project state. Save form edits before changing steps.

Project JSON, source/target behavior and local runner safeguards remain unchanged. Export `migration-action-checklist.json` from the dashboard; the full migration ZIP also includes `handoff/migration-action-checklist.json`. The full handoff remains in Project & bundle. The older migration-flow reference is collapsible to reduce dashboard clutter.

Validation: handoff/checklist tests cover scope separation, reported-evidence labels, recovery priority and immutable derivation. UI tests cover each pilot phase in isolation, navigation without evidence invalidation, scope filters, safe shortcut targets, shared selection and checklist exports/ZIP inclusion. Full existing regression checks pass; live VKS and visual browser verification remain pending.

## Guided pilot handoff (v0.19)
Project & bundle now includes a guided handoff review, linked from the dashboard. It groups current execution blockers, unverified owner prerequisites, missing/failing preflight checks, reported pilot/recovery state, security coverage, application acceptance, data recovery, inventory-wide blockers and external approvals. Unresolved existing-run observations/recovery take priority over further migration work. Pilot and inventory scopes remain explicit; counts are not combined into a readiness score.

The review includes reported evidence date ranges and existing acceptance/data owner labels and references. Dates are historical and do not establish freshness. Role labels identify a required reviewer without assigning a person or recording approval. Generated prerequisites, external state/writer ownership, security coverage and production-change authorization remain open even after complete reported cases. No PVC or observed security control is not proof of statelessness or coverage.

Download `pilot-handoff.md` / `pilot-handoff.json` from the project page. The full migration ZIP includes `handoff/pilot-handoff.md` and `.json`, alongside the project, original-bound execution plan, timeline and acceptance workbook. Assessment and Markdown plan exports also contain the current derived review. Resume through project JSON; handoff exports are for review and never execute commands or authorize production. The handoff is recomputed from current saved form settings and validated observations; no new manual approval state is trusted.

Validation: `test-handoff.cjs` covers scoped missing evidence, complete reported cases with permanently closed approval, recovery-first guidance, scoped absence, stale/foreign receipt rejection, dates/references, immutable derivation and Markdown escaping. UI tests cover the project review, both downloads and ZIP entries. Live VKS and browser visual verification remain pending.

## Pilot observation history and timeline (v0.18)
The pilot workbench now displays the original deployment/validation, up to 50 normalized observation receipts, and the current linked inspection/cleanup in reported UTC order. Each observation shows changes in rollout, HTTP smoke, root identity and container observations versus the previous retained observation, with expandable startup/image details. Import earlier observations without replacing newer state. Exact duplicates are ignored; observations with identical timestamps conservatively prefer unresolved results for the current summary.

History is scoped to the original plan and run. Reimporting an identical normalized original receipt preserves it; changing the original receipt or relevant workspace scope clears it. Save the matching project before switching runs. History retains the most recent 50 observations and displays a notice when earlier imports may have been omitted. Save previous project exports for a complete review. The timeline is a historical review, not a live monitor or authenticated audit log; it includes only the latest inspection/cleanup, not their complete history.

Download `pilot-timeline.json` from the pilot workbench, or use project JSON / the full migration ZIP to preserve validated history. Standalone timeline JSON is for review; resume through project JSON. Existing v0.17 single-observation projects automatically seed their history. Projects without execution evidence remain supported. Every restored/imported observation is revalidated against the original run and current plan; production approval remains closed.

Validation: `test-timeline.cjs` covers ordering, equal timestamps, deduplication, retention, deltas, invalid linkage and export structure. Project/UI tests cover legacy migration, save/resume, older imports, duplicate original receipts, downloads and scope reset. Live VKS execution and browser visual verification remain pending.

## Observe an existing pilot (v0.17)
The exported runner adds `observe --context TARGET --receipt pilot-run.json --output pilot-observation.json`. Use the original bound plan and deploy receipt, with recorded UIDs for every root. Observation checks cluster/root identity and scope, refreshes rollout and owned Pod/container startup observations, repeats the approved loopback HTTP GET, then checks roots again. It makes no Kubernetes resource writes; the application GET may have effects and must remain approved. Partial, missing, replaced or terminating roots require recovery review before probing. Observation does not redeploy or remove resources.

Import the observation alongside its original deploy receipt. The dashboard now shows the latest linked execution, observation and recovery state by observation time, and directs unresolved runs to recovery review. Reports and project ZIPs preserve observation records; older projects remain compatible. Scope changes clear current observations. Records are historical, unauthenticated imports, not continuous monitoring. The probe bypasses Service/Ingress paths and production approval remains closed.

Validation: `test-pilot-observe.py` covers identity/partial-run guards, rollout and probe failures, identity changes during probing, private exclusive output and browser importer compatibility. `test-observation.cjs`, project, journey and UI checks cover linkage, chronology, persistence and navigation. Cluster commands are mocked; live VKS and visual verification remain pending.

## Pilot recovery inspection and cleanup (v0.16)
The runnable pilot package now supports inspect and a separately invoked cleanup command using the original bound execution plan and deploy receipt. Save the matching project and retain the original package before changing the workspace. New recovery modes also work with a v0.15 plan/receipt using the updated runner and matching preflight helper beside the original bound plan/receipt; download links are on the recovery panel. Existing execution bindings are preserved.

Inspect is read-only: it binds the live cluster UID, queries each planned root by exact name, checks recorded UID/run label, isolated run selectors, stateless scope and unexpected owner references, and reports resource versions and finalizer counts. Unknown creates are recoverable only when the original receipt marked the name uncertain and the live run label matches. It lists at most 200 run-labeled Pods/ReplicaSets in the pilot namespace. Absent means only that the scoped roots and queried run-labeled descendants were not observed; external state and other resources remain unverified.

Cleanup requires the exact --confirm-run, explicit --ack-external-state and an unblocked inspection less than ten minutes old. This acknowledgment means the operator has owner approval for writer fencing, external effects/reconciliation and resource removal; it is not independent proof that these steps were completed. It checks the complete frozen root scope before any delete, then rechecks cluster UID, object UID, resourceVersion, run label and owner/deletion status immediately before each request. Kubernetes DeleteOptions includes both UID and resourceVersion preconditions. Any changed object requires another inspection. It requests Service deletion before Deployment deletion with Foreground propagation and normal grace/finalizer behavior; no forced deletion or finalizer removal is implemented. Garbage collection may remove dependents of the requested root objects, so review effective owner relationships.

Deletion requests are journaled before submission. A failed response may still have requested deletion; no automatic retry or rollback occurs. Reports distinguish Failed, Pending and scoped Absent, rather than equating accepted deletion with completed cleanup. Re-run inspect with a fresh output filename after partial/failed cleanup or while termination/garbage collection is pending. Explicit targets exclude namespaces, PVCs, policies, secrets, registry/source resources and arbitrary label-wide deletion. Runtime Service exposure/selector or persistent-storage scope changes block the normal cleanup path for manual review.

The existing pilot importer accepts original deploy, inspection and cleanup receipts in order. Cleanup imports require the matching imported inspection; new deployment/inspection imports clear downstream receipts. Project saves revalidate this linkage; older projects get null recovery records. Relevant scope changes clear recovery observations, and migration reports/ZIPs include the latest records. The production gate always stays closed.

Validation: python3 -B test-pilot-recovery.py covers read-only inspection, protected deletes, API precondition races, stale inspection, wrong cluster/object/run identity, selector/storage changes, ambiguous creates, pending descendants/finalizers, partial/lost delete responses, exclusive outputs and browser import compatibility. node test-recovery.cjs plus project/UI tests cover schema/linkage/persistence and truthful absence. All kubectl requests in tests are mocked; no real cluster cleanup or browser visual verification has occurred here.

References: https://kubernetes.io/docs/reference/kubernetes-api/common-definitions/delete-options/ and https://github.com/kubernetes/kubectl/blob/master/pkg/cmd/delete/delete.go

## Runnable isolated pilot (v0.15)
Stateless pilot now exports a runnable ZIP with execution-plan.json, a separate review-only manifest snapshot, pilot-runner.py, target-preflight.py, README.md and RECOVERY.md. The exported execution Deployment is one replica, with digest-pinned images and runtime run-label refinement of Deployment/Service selectors. Scope is exactly one apps/v1 Deployment and up to ten matching ClusterIP Services in the existing source namespace on the target. Existing draft review and dry-run-only downloads remain available separately.

Import source and target inventories containing distinct kube-system namespace UIDs, configure the target context in Target preflight, and define the approved Pod HTTP smoke port/path, status, optional response marker, latency ceiling and rollout timeout. Namespace, referenced configuration, security controls, external-state permissions and recovery must be prepared and owner-approved. Inherited Argo/Helm/Flux/external DNS behavior annotations are blocked for execution. Source image/draft blockers remain blockers. A stateless manifest is not proof of harmless application startup.

Run validate with an explicit context and a new output filename. Deploy requires a passing validation bound to this plan/context within thirty minutes, exact --confirm-workload and --ack-prerequisites. It repeats live identity/prerequisite/isolation checks, dry-runs create semantics with the exact runtime labels, then uses create-only API calls for Services followed by the Deployment. It cannot merge/overwrite a same-named object. It checks live cluster identity again before each create. Existing target Services, controllers and Pods whose labels/selectors overlap block the pilot; this observation is not a lock, so coordinate reconcilers and concurrent target changes.

Private, exclusive output receipts are atomically updated after each checkpoint and record run labels, created object UIDs and uncertain responses. A timed-out/failed API response may still have created resources; the runner attempts name/run-label-based UID recovery and preserves uncertainty. Rollout and current owned Pod/container image IDs are recorded; unresolved startup observations include waiting reason codes without raw messages where available. A loopback-only kubectl port-forward performs one HTTP GET without proxies or redirects; response bodies, raw API objects/diagnostics and credentials are omitted from result observations. The HTTP probe bypasses normal Service/Ingress/policy paths. Runtime image IDs are observations, not comparison against a multi-platform manifest digest.

Failures keep resources and receipts for owner review; there is no automatic deletion, rollback, source traffic switch or data reconciliation. RECOVERY.md requires current cluster/object UID and run-label verification and an approved UID-preconditioned cleanup procedure. Retain source service and reconcile any external writes before failback. Import validate/deploy results back into the pilot page; project save/resume and migration exports preserve bound historical observations. Relevant scope/settings changes invalidate them. Execution outcomes never auto-complete source/target acceptance or open the production gate. Older projects receive default execution settings.

Tests: node test-execution.cjs checks plan scope and result consistency; python3 -B test-pilot-runner.py exercises mocked kubectl creates, stale validation, explicit acknowledgment, isolation/identity failure, ambiguous create recovery, rollout failure, loopback cleanup and exclusive private receipts. Project/UI tests cover persistence, imports, exports and invalidation. No real cluster deployment, image pull or rollout has been performed here. Browser visual and real kubectl/version integration remain pending.

## Workload migration waves (v0.14)
The existing Migration plan page now includes explicit workload wave planning, without adding navigation items. Start with three empty draft waves, customize names/owners/entry criteria/exit criteria/rollback procedures, add up to twelve waves, reorder them, and remove only unassigned waves while retaining at least one. Names such as Pilot and Stateful workloads are suggestions; no workload is assigned automatically.

Assign discovered Deployments, StatefulSets, DaemonSets, Jobs, CronJobs and observed Pods without a reported controlling owner to a wave and application group, record an owner and notes, and declare up to twenty prerequisite workloads. ReplicaSets and Pods/Jobs with a reported controlling owner are excluded; collect their controlling desired-state resources even if absent from the current snapshot. Remaining observed resources can still overlap application boundaries; reconcile membership with application owners before estimating workload totals. The planner does not infer runtime service calls or external dependencies from manifest reference edges.

Reviews distinguish unassigned prerequisites, later-wave prerequisites, manual ordering within a wave and workloads in/dependent on a cyclic chain. Earlier-wave placement is order only, never evidence that a prerequisite is ready. Notes about retained-source arrangements do not suppress structural conflicts. StatefulSets and declared PVC/hostPath volumes receive data consistency/recovery cautions; absence does not prove statelessness. Resource-scoped open findings are counted separately from global findings and remain open after assignment. Wave statuses always require owner review; the production gate remains closed.

Project saves restore validated wave definitions and source-bound assignments; old projects receive empty defaults. Unknown workload/wave/dependency references, self-dependencies, duplicates and malformed fields are rejected. Source adoption resets wave planning, while target adoption retains planning definitions for renewed review. Wave planning edits do not alter manifests or test scope, and therefore do not clear unrelated security/preflight/acceptance evidence. JSON assessment exports, Markdown plans and migration ZIPs include wave plans and runbooks. No execution, deployment, scheduling or cutover occurs.

Validation: node test-waves.cjs covers assignment gaps, dependency direction/cycles, scoped findings, storage cautions, reorder/remove constraints, unsafe inputs and readiness. Project/UI tests cover save/restore, legacy defaults, forms, exports and inventory-refresh behavior. Browser visual and live integration checks remain pending.

## Inventory change review (v0.13)
Inventory changes is under Discover & assess. Stage a fresh source or target JSON snapshot without replacing the active workspace; normal imports route through review when replacing an imported source or an existing target. First imports and replacement of the illustrative demo retain their existing behavior. Review added, no-longer-observed, changed and recreated objects, version/collection differences and reported kube-system UID identity before adopting.

Identity is API group + kind + namespace + name; API version changes are compared, and changed known UIDs are reported as recreations. Object keys and inventory order are canonicalized. Runtime metadata/status and common secret/configuration payloads are excluded by sanitization; arrays remain order-sensitive. Reviews export changed JSON Pointer paths only, without field values, bounded at 100 paths per resource. Tables paginate 100 objects. Missing resources can reflect permissions, scope or collection errors, not deletion. Unknown UID evidence does not establish cluster identity.

Adoption validates a complete prepared project before replacing active state. A different reported cluster UID requires explicit identity review. Source adoption resets source-bound plans, selections, mappings and external evidence. Target adoption clears class/security mappings, security/preflight/acceptance results, target storage references and measured recovery values; source registry records and planning definitions remain historical inputs, never target validation. A changed known target UID also clears target context labels. Save your current project before adopting if its old state is needed.

Staged snapshots and latest change review are session-only. Project saves contain only active adopted inventories; download the review separately. The latest adopted review is also included in assessment JSON and migration ZIPs within the same session. Restoring a project or directly replacing inventories discards pending session review state. No cluster query, apply, delete or readiness escalation occurs.

Validation: node test-changes.cjs covers canonical comparisons, runtime noise, API group/version boundaries, recreation/cluster identity, redaction, bounded paths and duplicate/invalid input. UI tests cover read-only staging, failed-import preservation, source/target adoption, evidence invalidation, identity acknowledgment, context reset and atomic validation failure. Browser visual and live cluster verification remain pending.

## Application acceptance (v0.12)
Application acceptance is a secondary workbench under Validate & hand off. It documents six cases for the selected Deployment pilot: functional smoke test, image pull/startup, dependency/route behavior, observability, load/scaling and recovery. Define an accountable owner, approved procedure and measurable expectation for each; procedures are documentation and never executed by the app.

Bind distinct source/target context names. If target preflight has a configured context, the acceptance target must match it. These names do not authenticate cluster identity. Export the plan, Markdown workbook and JSON evidence template; externally execute approved tests, then import source/target observations. Executed outcomes require a timestamp with timezone, detail and artifact reference. Blank templates, missing cases, Fail and Error remain unresolved. A reported pass requires a complete case definition. Pass on both sides means the owner reports that the documented expectation was met; the app does not compare measurements or authenticate references.

Evidence is bound to pilot, plan revision, case and side/context. Relevant settings changes (including acceptance definitions) clear imported acceptance, security and preflight records. Save/resume preserves revalidated historical records; old projects receive empty acceptance settings. Reports and migration ZIPs include acceptance plans, templates, review and workbook. Dashboard guidance points to acceptance after scoped preflight and observed security cases; the production gate always remains closed, even with all reported matches.

Tests: node test-acceptance.cjs covers complete/partial/error cases, definitions, stale revision, wrong scope/context, duplicate/unknown records and no readiness escalation. Project and UI tests cover persistence, legacy compatibility, invalidation and exports. No behavior test was run against a real application or cluster. Visual browser verification remains pending.

## Guided workspace (v0.11)
Six navigation groups retain all fourteen workbench hashes. Secondary links expose each group's workbenches, and a persistent context bar shows source mode, target snapshot, selected pilot and the closed production gate.

The dashboard derives the next action from current state: replace demo inventory, supply target evidence, select a pilot, resolve its transformation blockers, collect preflight observations, review security evidence/coverage, then review remaining acceptance gates. This sequence is guidance rather than authorization to deploy. Inventory findings remain open and distinct from scoped pilot blockers, unverified prerequisites and external reported results. Images, routing and stateful data remain explicit additional workstreams.

Derived journey state is recomputed after project restore; it is included in assessment reports, Markdown plans and migration-journey.json in the full ZIP. No new saved-project schema is required. No imported or complete reported result opens the production gate.

Validation: node test-journey.cjs covers navigation coverage, action precedence, scope separation, immutability and the closed gate. node test-ui.cjs checks all workbench hashes, grouped links, selected secondary links, shared context, project restore and consolidated export. Browser visual verification and live cluster integration remain pending.

## Real inventory
Download `collect.py` from the application. Requires Python 3, kubectl and a configured explicit source context:

    python3 collect.py --context SOURCE --output inventory.json

The collector only reads. Secret/ConfigMap queries are skipped. It removes data, stringData, binaryData, env value, status and managedFields recursively. Arbitrary custom fields, annotations and commands may contain sensitive data; inspect output locally. Output is created exclusively with mode 0600. API query failures and collection limitations are recorded. Coverage is deliberately never attested complete.

Imports accept an array, Kubernetes List, or collector object with items. Limits: 15 MB / 30,000 resources. Imported secret payloads and env values are removed from the model before rendering/export.

## Runnable target preflight (v0.10)
Target preflight replaces the former target-profile-only page while retaining destination assumptions below the checker. Export target-plan.json and target-preflight.py, run from a configured kubectl workstation with an explicit --context, and import target-results.json. Scope is the selected stateless pilot plus optional routing.

Checks include kube-system UID binding against the imported target and source inventories, required API group/versions, node Ready/uncordoned counts, active namespaces, name-only required Secret/ConfigMap/ServiceAccount/IngressClass reads, same-name object conflicts, current Gateway Programmed/listener observations, and final server-side dry-run. Unknown identity, failed/unknown prerequisites, empty manifests or known blockers prevent dry-run. The UID check is an inventory binding heuristic; imported reports are not an authenticated attestation.

Every kubectl call carries the explicit context; no current-context switch or persistent resource write occurs. Server-side dry-run still requires normal create/patch authorization and compatible admission webhooks. Node health is not placement/free-capacity validation. Name-only reads do not verify secret/config keys, registry credentials or application access. Secret/ConfigMap objects are requested locally with name-only CLI output; values, raw objects and raw stderr are not exported. Runtime errors remain errors; ignore-not-found separates successful absence from failed reads.

Reports must match the current plan revision and expected context, contain recognized unique checks and valid observation timestamps. Dry-run pass contradicting unresolved prerequisites is rejected. Complete reported checks still leave production readiness false. Configuration and relevant artifact changes clear old results. Project save/resume preserves historical external records, and migration ZIPs include a target/ directory with plan, review and runner. Existing project files remain compatible.

Tests: node test-target-checks.cjs and python3 test-target-preflight.py cover identity, scope, references, stale/partial records, wrong contexts, absence/forbidden distinction, node cordoning, Gateway generations and dry-run gating. Runner tests mock kubectl; no live target has been queried in this session. All fourteen UI views and project restore tests pass. Browser visual verification remains pending.

References: https://kubernetes.io/docs/reference/using-api/api-concepts/ and https://kubernetes.io/docs/reference/node/node-status/

## GitOps handoff (v0.9)
GitOps handoff packages the selected stateless pilot as a repository scaffold: portable cleaned base resources, destination JSON patches under overlays/vks, optional reviewed routing, an Argo CD Application draft, an expected-resource fixture and a local validation script. Image patching is per-container index to preserve distinct mappings for different tags of the same repository and for init containers. Namespace is preserved. Routing that references Services outside the selected pilot scope is blocked. Source Argo/Helm behavior annotations are omitted and explicitly blocked for owner review.

The Application uses an explicit HTTPS Git URL, revision/path, Argo project/namespace and registered destination cluster name. Embedded credentials, queries and fragments are rejected. Automated sync is omitted, FailOnSharedResource is enabled, and no pruning/force/replace, namespace creation, cascade-delete finalizer or ignore-differences bypass is introduced. These settings do not transfer repository credentials, register clusters or resolve existing desired-state ownership.

Download the GitOps handoff ZIP or find it under gitops/ in the full migration ZIP. Copy repository/ contents into the configured repository path only after review. Run validate-gitops.sh TARGET_CONTEXT from the package root: known blockers stop it; otherwise it runs kubectl Kustomize rendering, server dry-run and diff. It never pushes Git, installs an Application, syncs Argo or deploys resources. GitOps settings survive project save/resume; older projects get defaults.

The scaffold comes from sanitized inventory, not the original Helm/Git desired state. Recover omitted configuration, establish ownership, close security/data gates and verify actual versions before any synchronization. expected-resources.json is an expected-object fixture, not proof of a Kustomize build. Helm charts/values, ApplicationSets, operators and stateful migration are not generated.

Validation: node test-gitops.cjs uses an independent YAML parser and JSON-patch application, checks per-container changes, namespace/routing scope and inherited directives, verifies manual-sync settings, and exercises Bash against mocked kubectl. Project compatibility and fourteen UI views pass. kubectl/Kustomize/Argo CD are not installed here; actual rendering, controller integration and browser visual checks remain pending.

References: https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/ and https://argo-cd.readthedocs.io/en/latest/user-guide/application-specification/

## Stateful storage planning (v0.8)
Stateful & data inventories actual PVCs, direct declared workload consumers and separate StatefulSet volumeClaimTemplate rows. Templates expose replica count, starting ordinal and retention settings; they may overlap observed claims and must not be added to actual capacity totals. Node-local/non-PVC storage and StatefulSets with no observed persistent claim declaration create coverage gaps. External databases and operator-managed state remain unknown.

Record per-claim/template destination class, optional destination PVC, application-supported strategy, owner, consistency group, RPO/RTO targets, writer fencing/quiescence and failback after destination writes. Optional measured loss/recovery durations and backup/restore/integrity/failback references are owner-supplied planning records, never authenticated evidence. Existing target claims are inspected only: smaller requested size, class, access-mode or volume-mode mismatches are flagged. StorageClass presence does not prove CSI capabilities, topology, performance or usable capacity. Supported common decimal/binary quantities use exact integer arithmetic; unsupported formats remain unknown.

CSI snapshot transfer requires explicit portability evidence; snapshot API presence does not prove transfer compatibility. Raw block volumes cannot use file-level backup/restore. Exceeding recorded RPO/RTO targets is a blocker. Consistency-group labels are planning identifiers and implement no synchronization. The checkpoint before accepting target writes is explicit: reversing DNS alone cannot reconcile new data. Target inventory replacement clears target-specific validation references and measurements.

Export stateful-plan.json and stateful-runbook.md. Settings are preserved in project files and included under stateful/ in migration ZIPs. v0.7 project files open with empty stateful settings. No PVC/PV, retention, snapshot, replication, backup, write-fencing, data transfer, cutover or failback operation executes. The data migration gate remains closed regardless of reported planning inputs. Collector v0.4 additionally queries discoverable CSI driver and snapshot class metadata.

Tests: node test-storage.cjs covers quantities, templates, capacity mismatches, RPO/RTO breaches, snapshot/volume constraints and incomplete coverage. Project round-trip/backward compatibility and all thirteen UI views pass. Real CSI/application recovery and visual browser verification remain pending.

References: https://kubernetes.io/docs/concepts/storage/volume-snapshots/ and https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/

## Portable projects and consolidated bundles (v0.7)
Project & bundle saves a versioned VKSProject JSON file and opens it locally to resume source/target inventory, target profile, class mappings, image settings/reported evidence, selected pilot and routing drafts, security mappings/scenarios/evidence and checklist notes. Project names and notes are included. There is no automatic browser or server persistence; explicitly save a snapshot after changes. Only saved form settings are included.

Opening a file validates schema, limits, resource selections, mapping types and reported evidence before replacing current state. Invalid files preserve the existing workspace. Inventories are sanitized again; findings are recomputed and claimed readiness flags in imported files are ignored. Security expectations and evidence are re-evaluated against restored cases; image evidence must match the restored registry plan. External evidence stays historical, unauthenticated and subject to new tests after environment changes. Production readiness remains false. Project files are unencrypted and may contain sensitive annotations, commands, notes or evidence references despite common secret-field redaction.

Export migration ZIP creates a portable uncompressed archive containing the project, inventories, assessment/comparison, Markdown plan, security plan/template/summary/evidence, image plan/runner/evidence, collector and selected pilot/routing drafts with review reports and dry-run scripts. Missing selections are documented, not invented. Runner assets must download successfully before the ZIP is emitted. No script or cluster/registry action executes when saving, opening or exporting. Project JSON is capped at 75 MB and bundle content at 200 MB. Archive entries use fixed safe paths, verified CRC32 values and appropriate local file attributes.

The Security workbench finding-table update bug is fixed. UI tests now return null for absent finding-table elements rather than implicitly creating every requested element.

Validation: node test-project.cjs tests snapshot round trips, secret-field redaction, evidence revalidation, unsafe/invalid inputs, recomputed readiness and ZIP interoperability with Python zipfile. UI tests render twelve views, exercise invalid/valid project opening, bundle creation and failed asset download. Browser visual verification remains pending.

## Security mapping and evidence (v0.6)
The Security workbench inventories observed native/vendor network controls, Gatekeeper/Kyverno, PSA, RBAC definitions/bindings, cloud service accounts, secret integrations, mesh, webhooks and NADs. Each required control has an explicit retain/replace/manual action, observed target resource, rationale and positive/violation scenario. Known source deny/warn/audit expectations cannot be weakened by destination mapping. Definitions/dependencies use documented review cases. Unknown modes require explicit expected behavior and actual source/target tests.

Export security-plan.json, security-evidence-template.json and security-review.json. Import externally run test records bound to the current session revision. Records require context, timestamp, exact outcome, evidence reference and detail. Duplicate, unknown and mismatched-revision records are rejected. Missing data, future timestamps, runtime errors and mismatching outcomes remain unresolved. A timeout or auth failure is not a policy denial. A control needs both cases on distinct source and target contexts, complete scenarios and an observed mapping to be shown as reported complete.

The production gate is always closed in this release: external records are not authenticated or rerun, coverage is partial and independent owner review has no automated completion mechanism. Nothing installs policy, alters enforcement, performs network probes, or grants access. Source/target imports, security scenarios and relevant artifact/mapping changes invalidate evidence. Plans and reports expose security status; normal pilot dry-run remains available for schema testing. The UI contains no waiver/bypass or claimed automatic parity score.

Collector v0.3 adds native admission bindings and optional Gatekeeper dependency/mutation, Kyverno and extended network-policy types when discoverable. Unsupported, inaccessible and unknown resources still require collection/review; full coverage is never attested.

Validation: node test-security.cjs covers catalog modes, fixed source expectations, revision matching, blank/error evidence, missing references, source/target context checks and the closed production gate. All eleven UI views render in stub tests; actual security enforcement and visual browser verification remain pending.

References: https://kubernetes.io/docs/concepts/services-networking/network-policies/ and https://open-policy-agent.github.io/gatekeeper/website/docs/api/

## Routing migration workbench (v0.5)
Convert standard networking.k8s.io/v1 Ingress into an Ingress with an explicit destination class, or HTTPRoutes attached to an existing Gateway listener. Namespace remains unchanged. Gateway mode emits one HTTPRoute per host rule, translates Exact/Prefix paths and resolves named backend ports to source Service port numbers. No Gateway, certificate or DNS object is created or changed.

The preview includes changed fields, unconverted annotations, blockers, prerequisites and route test cases marked Not run. Download routing-draft.json, routing-review.json and validate-routing.sh. The script stops on blockers; otherwise it runs server dry-run and diff only with an explicit context.

Blockers cover unconverted controller annotations, ImplementationSpecific paths, Gateway defaultBackend translation, wildcard hostname semantics, unresolved Service ports, observed TLS downgrades, denied listener namespace/kind attachments, hostname scope loss, missing observed classes/listeners, target API absence and same-name conflicts. Annotation-free demos illustrate the basic path. Target presence never proves enforcement or traffic readiness.

Existing HTTPRoutes, proprietary API gateway resources/plugins, WAF/auth/rate-limit translations, TLS passthrough, automated traffic tests, DNS updates and live cutover remain outside this release. TLS secrets, controller support, route status, certificate lifecycle and ownership transfer require separate validation.

Validation: node test-routing.cjs covers transformations, restrictions, TLS, API gaps and conflicts; UI stub tests render eleven views and exercise routing mode selection. Real controller integration and browser visual verification remain pending.

References: https://gateway-api.sigs.k8s.io/guides/getting-started/migrating-from-ingress/ and https://gateway-api.sigs.k8s.io/docs/concepts/api-overview/

## Image Migration Manager (v0.4)
Plan registry reuse or copying to an explicit destination registry/project. The planner normalizes Docker Hub shorthand, retains repository paths, detects destination collisions and rejects unsupported/credential-bearing references. Copy destinations are tags; source digest pins and successful externally reported results can supply destination digest pins to the pilot builder. Planned mappings never imply a successful copy.

Download image-plan.json and image-runner.py. The Python runner requires locally installed Skopeo and local registry authentication. Default mode inspects registry manifests only. Explicit --copy writes destination tags (which can overwrite existing tags), resolves mutable source tags to immutable digests, uses skopeo copy --all --preserve-digests, and compares source/destination raw manifest digests. It never deletes source images or changes a cluster. Reports are created with exclusive mode 0600 and sanitized failure summaries; registry stderr is not included. Copy operations are sequential and failures are recorded per image. Partial failures do not trigger automatic rollback or deletion.

Import results to display reported digest matches/failures and optionally supply matching digest pins to the pilot. Reports are externally supplied, not independently authenticated by the app. Results must match current plan references, and changing the plan clears prior evidence and pilot mappings. Signatures, SBOM/referrer migration, vulnerability scans, full platform compatibility, credential setup, and VKS node image pulls require separate testing. Registry size, copy progress, private cloud identity and automatic image deletion are not implemented.

Tests: node test-images.cjs, python3 test-image-runner.py, plus the existing analyzer/preflight/pilot/UI tests. Registry runner tests mock Skopeo: no real registry transfer or target pull has been verified. UI tests render ten views and exercise planned-image handoff to the pilot. Browser visual verification remains unavailable.

Skopeo references: https://github.com/podman-container-tools/skopeo/blob/main/docs/skopeo-copy.1.md and https://github.com/podman-container-tools/skopeo/blob/main/docs/skopeo-inspect.1.md

## Stateless pilot builder (v0.3)
The Stateless pilot view generates a Kubernetes JSON List containing one apps/v1 Deployment and matching isolated ClusterIP Services. It preserves the namespace and pod selector labels, removes source lifecycle metadata and source Service IP allocations, and records explicit image and service-account mappings. Target registry images are references only: no image copying occurs.

Download pilot-draft.json, pilot-review.json and validate-pilot.sh. The review report includes exact manifests, changes, blockers, prerequisites and omitted resource IDs. The shell script requires an explicit context; it performs server dry-run and diff only and stops before kubectl when blockers exist. It handles diff exit 1 as expected differences and propagates errors above 1. It never deploys, changes current context or performs a cutover.

Blockers include redacted inline environment values, durable/node-local storage, NAD/host networking, privileged/GPU requirements, unresolved cloud identity, shared/non-ClusterIP Services, operator ownership, invalid source selector absence and same-name destination objects. Configuration, secrets, security parity, namespace policy, external state, ingress, scaling and disruption controls require separate preparation and verification. JSON exports are drafts, including when no rule-detected blocker remains. Use complete desired-state repositories to restore omitted data and transfer GitOps ownership.

The added web-pilot demo demonstrates a basic Deployment path; all example image access and behavior remain unverified.

Tests: node test-pilot.cjs covers transformations and actual Bash execution against a mocked kubectl. Existing analyzer, preflight and UI stub tests also pass. Browser visual verification and real-cluster integration remain pending.

## Target comparison (v0.2)
Collect source and target with collector v0.2 and import target JSON in Target comparison. Successful API discovery and resource queries distinguish observed presence, confirmed gaps and unknown coverage. Explicit class mappings record intent only. Presence is not verified controller behavior. A collected target version drives removed-API checks.

The migration plan includes prerequisite phases, finding references, target gaps and workload dependencies. StatefulSets, PVC and hostPath consumers enter the stateful phase; other workloads need owner confirmation for external state. Full dependency scheduling and cycle resolution are not implemented. Reports include comparison and generated plan. Evidence or mapping changes clear checklist notes.

Verification: node test-engine.cjs; node test-preflight.cjs; node test-ui.cjs; Python collector syntax checks. UI tests use a DOM stub and are not visual browser tests.

## Current capabilities
- Evidence-led rules for APIs, images, storage, cloud identity, admission/network policies, NAD, scheduling, GPU, RBAC, GitOps and controllers.
- Declared references and service-to-workload selector relationships.
- Target assumptions, finding detail, local import, report export, planning checklist and Markdown plan export.
- Demo inventory explicitly identified as illustrative.

## Limits / next stages
Not an exhaustive analyzer or support matrix. No live-cluster connection, DB transfer or cluster execution. Registry copying is available only through the exported, explicitly invoked local runner. Manifest transformation is limited to the scoped pilot drafts. No claimed security equivalence. Version support, image access, enforcement, runtime dependencies and data consistency remain unverified. Target profile is input, not evidence. Imported destination inventory establishes presence/coverage only. Live API exports cannot detect obsolete desired-state versions hidden in Git. Planning checkboxes are not validated test results.

Next: secure collector service, release-specific capability catalog, Git/Helm parsing, scoped custom-resource adapters, target preflight, behavioral test runners, registry copy, then stateless execution with reversible checkpoints.
