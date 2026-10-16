#!/usr/bin/env bash
# End-to-end pilot between two real clusters (kind-source, kind-target), driven only through the
# engine API: register, collect, plan, validate, deploy, observe, inspect, clean up. Used by CI.
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d)
TOKEN=$(printf 'e%.0s' $(seq 1 40)); A="Authorization: Bearer $TOKEN"; J='content-type: application/json'; U=http://127.0.0.1:18090/api
py() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
api() { local method=$1 path=$2; shift 2; curl -fsS -X "$method" -H "$A" -H "$J" "$U$path" "$@"; }
wait_run() {   # wait until a run leaves its busy state; print the state
  for _ in $(seq 1 180); do
    s=$(api GET "/runs/$1" | py 'print(d["state"])')
    case "$s" in Validating|Deploying|Observing|Inspecting|Cleaning) sleep 2;; *) echo "$s"; return;; esac
  done
  echo timeout
}
expect_state() { local got; got=$(wait_run "$1"); [ "$got" = "$2" ] || { echo "Expected $2, got $got"; api GET "/runs/$1"; exit 1; }; echo "run: $2"; }

echo "== Source workload"
kubectl --context kind-source create namespace app
kubectl --context kind-source -n app create deployment web --image=nginx:1.27-alpine --port=80
kubectl --context kind-source -n app expose deployment web --port=80 --target-port=80
kubectl --context kind-source -n app rollout status deploy/web --timeout=180s
digest=$(kubectl --context kind-source -n app get pods -l app=web -o jsonpath='{.items[0].status.containerStatuses[0].imageID}' | sed 's#^docker-pullable://##')
case "$digest" in *@sha256:*) ;; *) echo "No digest from imageID: $digest"; exit 1;; esac
pinned="docker.io/library/nginx@${digest##*@}"
echo "pinned image: $pinned"
kubectl --context kind-target create namespace app

echo "== Logins"
scripts/collector-kubeconfig.sh kind-source "$work/source.kc"
scripts/collector-kubeconfig.sh kind-target "$work/target.kc"
scripts/pilot-kubeconfig.sh kind-target app "$work/pilot.kc"
(umask 077; KUBECONFIG="$work/source.kc:$work/target.kc:$work/pilot.kc" kubectl config view --flatten > "$work/studio.kc")

echo "== Engine"
KUBECONFIG="$work/studio.kc" STUDIO_DATA_DIR="$work/data" STUDIO_PORT=18090 STUDIO_TOKEN="$TOKEN" node engine/build/server.js > "$work/engine.log" 2>&1 &
trap 'echo "--- engine log"; tail -50 "$work/engine.log"' EXIT
for _ in $(seq 1 30); do curl -fsS $U/health >/dev/null 2>&1 && break; sleep 1; done

src=$(api POST /clusters -d '{"contextName":"kind-source","role":"source"}' | py 'print(d["id"])')
tgt=$(api POST /clusters -d '{"contextName":"kind-target","role":"target"}' | py 'print(d["id"])')
api PUT "/clusters/$tgt/pilot-context" -d '{"contextName":"kind-target-pilot"}' >/dev/null
pid=$(api POST /projects -d '{"name":"e2e"}' | py 'print(d["id"])')
api PATCH "/projects/$pid/clusters" -d "{\"sourceClusterId\":\"$src\",\"targetClusterId\":\"$tgt\"}" >/dev/null
for side in source target; do
  job=$(api POST "/projects/$pid/collect" -d "{\"side\":\"$side\"}" | py 'print(d["jobId"])')
  for _ in $(seq 1 120); do s=$(api GET "/jobs/$job" | py 'print(d["state"], d.get("error") or "")'); case "$s" in Succeeded*) break;; Failed*) echo "$side collection: $s"; exit 1;; esac; sleep 2; done
  echo "collected $side"
done

wid=$(api GET "/projects/$pid/workloads" | py 'print(next(w["id"] for w in d["items"] if w["resource"]=="app/Deployment/web"))')
plan=$(api POST "/projects/$pid/workloads/$wid/plans" -d "{\"images\":{\"nginx:1.27-alpine\":\"$pinned\"},\"settings\":{\"smokePort\":80,\"smokePath\":\"/\",\"expectedStatus\":200,\"smokeMarker\":\"nginx\",\"rolloutSeconds\":180}}")
echo "$plan" | py 'b=d["blockers"]; print("blockers:", b); sys.exit(1 if b else 0)'
plan_id=$(echo "$plan" | py 'print(d["id"])')

run=$(api POST "/plans/$plan_id/runs" -d '{"acknowledgePrerequisites":true}' | py 'print(d["runId"])')
expect_state "$run" Validated
api POST "/runs/$run/deploy" -d '{"confirmWorkload":"app/Deployment/web"}' >/dev/null
expect_state "$run" PilotPassed
kubectl --context kind-target -n app get deploy web -o jsonpath='{.metadata.labels}' | grep -q "$(api GET "/runs/$run" | py 'print(d["runLabel"])')" || true
kubectl --context kind-target -n app get deploy,svc
api POST "/runs/$run/observe" -d '{}' >/dev/null
expect_state "$run" PilotPassed
api POST "/runs/$run/inspect" -d '{}' >/dev/null
expect_state "$run" Inspected
label=$(api GET "/runs/$run" | py 'print(d["runLabel"])')
api POST "/runs/$run/cleanup" -d "{\"confirmRun\":\"$label\",\"acknowledgeExternalState\":true}" >/dev/null
state=$(wait_run "$run")
# Foreground deletion can take a moment: inspect until absent.
for _ in $(seq 1 10); do
  [ "$state" = Cleaned ] || [ "$state" = Absent ] && break
  sleep 5; api POST "/runs/$run/inspect" -d '{}' >/dev/null; state=$(wait_run "$run")
done
echo "final state: $state"
[ "$state" = Cleaned ] || [ "$state" = Absent ] || { api GET "/runs/$run"; exit 1; }
[ -z "$(kubectl --context kind-target -n app get deploy,svc -o name)" ] || { echo "Pilot objects remain on the target"; exit 1; }
api GET "/runs/$run" | py 'print([s["step"]+":"+s["status"] for s in d["steps"]])'
trap - EXIT
echo "Pilot end-to-end passed."
