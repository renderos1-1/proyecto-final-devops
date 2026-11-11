#!/usr/bin/env bash
# Reproducible Scenario 3 acceptance tests P3-1..P3-4 (spec 6.3 and 5.8).
#
#   scripts/p3-tests.sh [dev|prod] [p31 p32 p33 p34 ...]     (default: prod, all tests)
#
# Requirements: node 22 (generator), kubectl with cluster-admin through the IAP tunnel
# (scripts/vm.sh tunnel; KUBECONFIG=~/.kube/pfd-k3s.yaml), API keys in ~/.config/pfd/secrets-<env>.env.
# Each test prints PASS/FAIL from objective checks against /v1/stats; outputs go to
# docs/evidence/<UTC date>-<env>/.
set -euo pipefail

ENV=${1:-prod}; shift || true
TESTS=${*:-p31 p32 p33 p34}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NS=pfd-$ENV
DOMAIN=136-71-37-219.sslip.io
BASE=https://$([ "$ENV" = prod ] && echo api || echo api-dev).$DOMAIN
OUT=$ROOT/docs/evidence/$(date -u +%Y-%m-%d)-$ENV
GEN="node $ROOT/tools/generator/dist/cli.js"
export KUBECONFIG=${KUBECONFIG:-$HOME/.kube/pfd-k3s.yaml}
mkdir -p "$OUT"

set -a; . "$HOME/.config/pfd/secrets-$ENV.env"; set +a
KEY=${INGEST_API_KEYS%%,*}
[ -f "$ROOT/tools/generator/dist/cli.js" ] || (cd "$ROOT/tools/generator" && npm ci --silent && npm run build --silent)

log()   { echo "[$(date -u +%H:%M:%SZ)] $*"; }
stats() { curl -sf -H "X-API-Key: $KEY" "$BASE/v1/stats"; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
delta() { python3 -c "import json; a=json.loads('''$1'''); b=json.loads('''$2'''); print(json.dumps({k: b[k]-a[k] for k in b}))"; }
check() { if [ "$2" = "$3" ]; then log "  PASS $1 (expected $3, got $2)"; else log "  FAIL $1 (expected $3, got $2)"; FAILED=1; fi; }
wait_drained() {  # wait until nothing is pending/processing; prints seconds waited
  local t0=$SECONDS
  until s=$(stats) && [ "$(echo "$s" | field pending)" = 0 ] && [ "$(echo "$s" | field processing)" = 0 ]; do sleep 2; done
  echo $((SECONDS - t0))
}
summary() { python3 -c "import json; s=json.load(open('$1'))['summary']; print('  generator:', {k: s[k] for k in ('sent','accepted','duplicate','rejected','httpErrors','achievedRate')}, 'latency ms p50/p95/p99 =', [round(s['latencyMs'][q]) for q in ('p50','p95','p99')])"; }
FAILED=0

run_p31() {
  log "P3-1 burst: 1000 unique valid events, concurrency 20"
  local before after d
  before=$(stats)
  $GEN burst --base-url "$BASE" --api-key "$KEY" --count 1000 --concurrency 20 --seed 3101 --out "$OUT/p3-1-burst.json" >/dev/null
  summary "$OUT/p3-1-burst.json"
  log "  waiting for the processor to drain..."; log "  drained in $(wait_drained)s"
  after=$(stats); d=$(delta "$before" "$after"); echo "$d" > "$OUT/p3-1-stats-delta.json"; log "  /v1/stats delta: $d"
  check "accepted +1000" "$(echo "$d" | field accepted)" 1000
  check "processed +1000 (no confirmed event lost)" "$(echo "$d" | field processed)" 1000
  check "rejected +0" "$(echo "$d" | field rejected)" 0
}

run_p32() {
  log "P3-2 sustained: 20 events/s for 120 s (2400 unique events)"
  local before after d
  before=$(stats); date -u +%s > "$OUT/p3-2-start.ts"
  $GEN sustained --base-url "$BASE" --api-key "$KEY" --rate 20 --duration 120 --seed 3201 --out "$OUT/p3-2-sustained.json" >/dev/null
  date -u +%s > "$OUT/p3-2-end.ts"
  summary "$OUT/p3-2-sustained.json"
  log "  drained in $(wait_drained)s after the load ended"
  after=$(stats); d=$(delta "$before" "$after"); echo "$d" > "$OUT/p3-2-stats-delta.json"; log "  /v1/stats delta: $d"
  check "accepted +2400" "$(echo "$d" | field accepted)" 2400
  check "processed +2400" "$(echo "$d" | field processed)" 2400
  check "HTTP errors" "$(python3 -c "import json; print(json.load(open('$OUT/p3-2-sustained.json'))['summary']['httpErrors'])")" 0
}

run_p33() {
  log "P3-3 duplicates and out-of-order: 50 retransmissions + 50 late events, then verify aggregates"
  local before after d rc=0
  before=$(stats)
  $GEN dupes-ooo --base-url "$BASE" --api-key "$KEY" --duplicates 50 --out-of-order 50 --seed 3301 --out "$OUT/p3-3-dupes-ooo.json" >/dev/null || rc=$?
  summary "$OUT/p3-3-dupes-ooo.json"
  log "  drained in $(wait_drained)s"
  after=$(stats); d=$(delta "$before" "$after"); echo "$d" > "$OUT/p3-3-stats-delta.json"; log "  /v1/stats delta: $d"
  check "duplicates counted" "$(echo "$d" | field duplicates)" 50
  check "generator aggregate verification exit code" "$rc" 0
  python3 -c "
import json; r=json.load(open('$OUT/p3-3-dupes-ooo.json')); v=r['verification']
print('  aggregate checks per device (min/max/avg/count by generatedAt window):', sum(v.values()), 'of', len(v), 'match')"
}

run_p34() {
  log "P3-4 interruption: stop the processor while events arrive, then recover"
  local before after d drain
  before=$(stats)
  log "  load: 20 events/s for 60 s in background"
  $GEN sustained --base-url "$BASE" --api-key "$KEY" --rate 20 --duration 60 --seed 3401 --out "$OUT/p3-4-load.json" >/dev/null &
  local gen=$!
  sleep 15
  log "  STOP processor (scale to 0) while events are pending"
  kubectl -n "$NS" scale deployment/processor --replicas=0
  kubectl -n "$NS" wait --for=delete pod -l app.kubernetes.io/name=processor --timeout=90s >/dev/null 2>&1 || true
  wait $gen
  log "  load finished; no further input from here on"
  local mid; mid=$(stats); echo "$mid" > "$OUT/p3-4-stats-while-stopped.json"
  log "  while stopped: pending=$(echo "$mid" | field pending) processing=$(echo "$mid" | field processing)"
  kubectl -n "$NS" get deploy processor --no-headers | tee "$OUT/p3-4-deploy-stopped.txt"
  sleep 20
  log "  RESTORE processor (scale to 1)"
  kubectl -n "$NS" scale deployment/processor --replicas=1
  kubectl -n "$NS" rollout status deployment/processor --timeout=120s
  drain=$(wait_drained); log "  backlog drained to 0 in ${drain}s after restore, with no new input"
  after=$(stats); d=$(delta "$before" "$after"); echo "$d" > "$OUT/p3-4-stats-delta.json"; log "  /v1/stats delta: $d"
  check "accepted +1200" "$(echo "$d" | field accepted)" 1200
  check "processed +1200 (nothing lost across the stop)" "$(echo "$d" | field processed)" 1200
  check "pending after recovery" "$(echo "$after" | field pending)" 0
}

{
  log "Scenario 3 tests against $ENV ($BASE), tests: $TESTS"
  log "deployed version: $(curl -sf "$BASE/version")"
  if ! curl -sf -H "X-API-Key: $ADMIN_API_KEY" "$BASE/v1/devices/generator-device-1-1" >/dev/null; then
    log "seeding installations and devices"; $GEN seed --base-url "$BASE" --admin-key "$ADMIN_API_KEY" --seed 1 >/dev/null
  fi
  for t in $TESTS; do "run_$t"; echo; done
  log "final /v1/stats: $(stats)"
  [ $FAILED = 0 ] && log "ALL CHECKS PASSED" || log "SOME CHECKS FAILED"
} 2>&1 | tee "$OUT/p3-tests.log"
