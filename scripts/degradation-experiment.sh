#!/usr/bin/env bash
# Controlled, reversible degradation (MET-07, P3-5, spec 5.11): temporary reduction of processor
# capacity under the reference load, detection by alerts, mitigation by rollback, verified recovery.
#
#   scripts/degradation-experiment.sh [dev|prod] [delay_ms=70]
#
# Hypothesis: a per-event delay of 70 ms caps the single processor at ~14 events/s (batch of 100
# takes ~7 s). Under 20 events/s input, the backlog should grow by ~6 events/s and the receive->processed
# lag should exceed 5 s within ~1 minute. PfdFreshnessBurnRate should then fire, followed by
# PfdEventBacklogGrowing (~5 min). Rolling back the processor should drain the backlog and resolve both.
#
# Requirements: as scripts/p3-tests.sh, plus a port-forward to Prometheus on :19090
#   kubectl -n observability port-forward svc/kps-prometheus 19090:9090
set -euo pipefail

ENV=${1:-prod}; DELAY=${2:-70}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NS=pfd-$ENV
BASE=https://$([ "$ENV" = prod ] && echo api || echo api-dev).136-71-37-219.sslip.io
OUT=$ROOT/docs/evidence/$(date -u +%Y-%m-%d)-$ENV/degradation
PROM=${PROM:-http://localhost:19090}
GEN="node $ROOT/tools/generator/dist/cli.js"
export KUBECONFIG=${KUBECONFIG:-$HOME/.kube/pfd-k3s.yaml}
mkdir -p "$OUT"
set -a; . "$HOME/.config/pfd/secrets-$ENV.env"; set +a
KEY=${INGEST_API_KEYS%%,*}

log()    { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/timeline.log"; }
mark()   { echo "$1=$(date -u +%s)" >> "$OUT/marks.env"; log "MARK $1"; }
stats()  { curl -sf -H "X-API-Key: $KEY" "$BASE/v1/stats"; }
pq()     { curl -sf --data-urlencode "query=$1" "$PROM/api/v1/query" | python3 -c "import json,sys; r=json.load(sys.stdin)['data']['result']; print(r[0]['value'][1] if r else 'none')"; }
firing() { curl -sf "$PROM/api/v1/alerts" | python3 -c "import json,sys; print(' '.join(sorted({a['labels']['alertname'] for a in json.load(sys.stdin)['data']['alerts'] if a['state']=='firing' and a['labels'].get('namespace')=='$NS' and a['labels']['alertname'].startswith('Pfd')})) or '-')"; }
snapshot() {
  local s; s=$(stats)
  log "  pending=$(echo "$s" | python3 -c "import json,sys; print(json.load(sys.stdin)['pending'])")" \
      "lag_p95_2m=$(pq "histogram_quantile(0.95, sum by (le) (rate(event_processing_lag_seconds_bucket{namespace=\"$NS\"}[2m])))")s" \
      "processed_rate=$(pq "sum(pfd:events_processed:rate1m{namespace=\"$NS\",result=\"processed\"})")/s" \
      "firing=[$(firing)]"
}
wait_until() {  # wait_until <timeout s> <description> <command...>
  local timeout=$1 desc=$2; shift 2; local t0=$SECONDS
  until "$@"; do
    [ $((SECONDS - t0)) -ge "$timeout" ] && { log "  TIMEOUT waiting for: $desc"; return 1; }
    sleep 15; snapshot
  done
  log "  reached: $desc (after $((SECONDS - t0))s)"
}
alert_is()     { firing | grep -qw "$1"; }
alert_clear()  { ! firing | grep -qw "$1"; }
backlog_low()  { [ "$(stats | python3 -c "import json,sys; print(json.load(sys.stdin)['pending'])")" -lt 50 ]; }

: > "$OUT/marks.env"; : > "$OUT/timeline.log"
log "Degradation experiment on $ENV ($BASE); injected per-event delay ${DELAY} ms"
log "version: $(curl -sf "$BASE/version")"
kubectl -n "$NS" rollout history deployment/processor | tail -3 | tee -a "$OUT/timeline.log"

mark load_start
$GEN sustained --base-url "$BASE" --api-key "$KEY" --rate 20 --duration 1500 --seed 5001 --out "$OUT/load.json" >/dev/null 2>&1 &
GENPID=$!
trap 'kill $GENPID 2>/dev/null || true' EXIT

log "Phase 1: baseline (3 min at 20 events/s)"
for _ in 1 2 3 4 5 6; do sleep 30; snapshot; done
mark baseline_end

log "Phase 2: INJECT fault: PROCESSOR_ARTIFICIAL_DELAY_MS=$DELAY (new processor revision)"
kubectl -n "$NS" set env deployment/processor PROCESSOR_ARTIFICIAL_DELAY_MS="$DELAY" | tee -a "$OUT/timeline.log"
kubectl -n "$NS" annotate deployment/processor kubernetes.io/change-cause="experiment: inject ${DELAY}ms delay" --overwrite >/dev/null
kubectl -n "$NS" rollout status deployment/processor --timeout=120s | tail -1 | tee -a "$OUT/timeline.log"
mark fault_injected
wait_until 600 "PfdFreshnessBurnRate firing" alert_is PfdFreshnessBurnRate && mark freshness_alert_firing
wait_until 600 "PfdEventBacklogGrowing firing" alert_is PfdEventBacklogGrowing && mark backlog_alert_firing
snapshot

log "Phase 3: MITIGATE: roll the processor back to the previous revision"
kubectl -n "$NS" rollout undo deployment/processor | tee -a "$OUT/timeline.log"
kubectl -n "$NS" rollout status deployment/processor --timeout=120s | tail -1 | tee -a "$OUT/timeline.log"
log "  active processor env override: $(kubectl -n "$NS" get deploy processor -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PROCESSOR_ARTIFICIAL_DELAY_MS")].value}' || true) (empty = ConfigMap default 0)"
mark mitigated
wait_until 900 "backlog < 50 events" backlog_low && mark backlog_recovered
wait_until 900 "PfdFreshnessBurnRate resolved" alert_clear PfdFreshnessBurnRate && mark freshness_alert_resolved
wait_until 900 "PfdEventBacklogGrowing resolved" alert_clear PfdEventBacklogGrowing && mark backlog_alert_resolved

log "Phase 4: post-recovery observation (2 min), then stop the load"
for _ in 1 2 3 4; do sleep 30; snapshot; done
kill $GENPID 2>/dev/null || true; wait $GENPID 2>/dev/null || true
mark load_end
sleep 20
log "final stats: $(stats)"
kubectl -n "$NS" rollout history deployment/processor | tail -4 | tee -a "$OUT/timeline.log"
log "Experiment finished. Export series with: python3 scripts/export-evidence.py $ENV $OUT"
