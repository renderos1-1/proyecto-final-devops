#!/usr/bin/env bash
# Live demo from INSIDE the K3s VM (only needs bash, curl and the k3s kubectl; nothing to install).
#
#   sudo bash demo-vm.sh <command> [args]        (default environment: dev; use ENV=prod for production)
#
# Commands:
#   status              nodes, pods and running version
#   stats               counters from /v1/stats
#   send [N]            send N valid events (default 50) and count the responses
#   duplicate           send the same event twice: 202 (accepted) then 200 (duplicate)
#   invalid             invalid event (422) and request without key (401)
#   interrupt [N]       P3-4: stop the processor, send N events (default 200), show the backlog, restore, wait for 0
#   kill-pod            delete the processor pod and watch Kubernetes recreate it
#   persistence         restart postgres-0 and show the counters are unchanged
#   rollback            show the ingest-api history and roll back to the previous version (asks first)
#   logs                last processor log lines
#
# How it reaches the API: through the NGINX ingress inside the cluster (curl --resolve), so it works
# from the VM regardless of whether the VM can reach its own public IP. Keys come from the
# pfd-secrets Secret of the chosen namespace.
set -euo pipefail

ENV=${ENV:-dev}
NS=pfd-$ENV
DOMAIN=136-71-37-219.sslip.io
HOST=$([ "$ENV" = prod ] && echo "api.$DOMAIN" || echo "api-dev.$DOMAIN")
K=${KUBECTL:-k3s kubectl}

say()  { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }

# ---- connection and keys ----------------------------------------------------------------
if [ -z "${NO_RESOLVE:-}" ]; then
  NGINX_IP=$($K -n ingress-nginx get svc nginx-ingress-controller -o jsonpath='{.spec.clusterIP}')
  RESOLVE=(--resolve "$HOST:443:$NGINX_IP")
else
  RESOLVE=()
fi
BASE="https://$HOST"
secret() { $K -n "$NS" get secret pfd-secrets -o "jsonpath={.data.$1}" | base64 -d; }
KEY=${API_KEY:-$(secret INGEST_API_KEYS | cut -d, -f1)}
ADMIN=${ADMIN_KEY:-$(secret ADMIN_API_KEY)}

api() {  # api METHOD PATH [JSON] [KEY]  -> prints "<http code> <body>"
  local m=$1 p=$2 d=${3:-} k=${4-$KEY}
  local args=(-s -o /tmp/demo-body -w '%{http_code}' -X "$m" "${RESOLVE[@]}" -H 'Content-Type: application/json')
  [ -n "$k" ] && args+=(-H "X-API-Key: $k")
  [ -n "$d" ] && args+=(-d "$d")
  local code; code=$(curl "${args[@]}" "$BASE$p"); echo "$code $(cat /tmp/demo-body)"
}
field() { grep -o "\"$1\":[0-9]*" | head -1 | cut -d: -f2; }
stats_json() { api GET /v1/stats | cut -d' ' -f2-; }
event() {  # event EVENT_ID [TEMPERATURE]
  printf '{"eventId":"%s","deviceId":"demo-device-1","generatedAt":"%s","temperature":%s,"humidity":45.5,"status":"ok"}' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${2:-22.5}"
}
ensure_device() {
  api POST /v1/installations '{"id":"demo-installation","name":"Demo"}' "$ADMIN" >/dev/null
  api POST /v1/devices '{"id":"demo-device-1","installationId":"demo-installation","name":"Sensor demo"}' "$ADMIN" >/dev/null
}
send_many() {  # send_many N PREFIX -> prints count per HTTP code (10 requests in parallel)
  local n=$1 prefix=$2 i
  : > /tmp/demo-codes
  for i in $(seq 1 "$n"); do
    curl -s -o /dev/null -w '%{http_code}\n' -X POST "${RESOLVE[@]}" -H 'Content-Type: application/json' -H "X-API-Key: $KEY" \
      -d "$(event "$prefix-$i" "$((RANDOM % 50)).5")" "$BASE/v1/events" >> /tmp/demo-codes &
    if (( i % 10 == 0 )); then wait; fi
  done
  wait
  sort /tmp/demo-codes | uniq -c | sed 's/^ */  responses: /'
}
wait_pending_zero() {
  local t0=$SECONDS p
  while :; do p=$(stats_json | field pending); [ "${p:-1}" = 0 ] && break; info "pending = $p"; sleep 2; done
  ok "backlog drained to 0 in $((SECONDS - t0)) s"
}

cmd=${1:-help}; shift || true
case "$cmd" in
  status)
    say "Environment $ENV ($HOST)"
    $K get nodes
    $K -n "$NS" get pods -o wide
    info "running version: $(api GET /version '' '' | cut -d' ' -f2-)"
    ;;
  stats)
    say "Counters ($ENV)"; stats_json; echo
    info "received = accepted + duplicates + rejected  ·  accepted = pending + processing + processed + failed"
    ;;
  send)
    n=${1:-50}; ensure_device
    say "Sending $n valid events to $ENV"
    before=$(stats_json); send_many "$n" "demo-$(date +%s)"; sleep 3; after=$(stats_json)
    ok "accepted: $(echo "$before" | field accepted) -> $(echo "$after" | field accepted)   processed: $(echo "$before" | field processed) -> $(echo "$after" | field processed)"
    ;;
  duplicate)
    ensure_device; id="dup-$(date +%s)"; body=$(event "$id")
    say "Same event twice (eventId $id)"
    info "1st: $(api POST /v1/events "$body")"
    info "2nd: $(api POST /v1/events "$body")"
    ok "expected: 202 accepted, then 200 duplicate with the same eventPk"
    ;;
  invalid)
    ensure_device
    say "Temperature out of range (999 °C)"
    info "$(api POST /v1/events "$(event "bad-$(date +%s)" 999)")"
    say "Request without API key"
    info "$(api GET /v1/stats '' '')"
    ok "expected: 422 rejected (temperature_out_of_range) and 401"
    ;;
  interrupt)
    n=${1:-200}; ensure_device
    say "P3-4 · stopping the processor in $ENV"
    $K -n "$NS" scale deployment/processor --replicas=0
    $K -n "$NS" wait --for=delete pod -l app.kubernetes.io/name=processor --timeout=90s 2>/dev/null || true
    before=$(stats_json)
    say "Sending $n events while the processor is stopped"
    send_many "$n" "int-$(date +%s)"; sleep 2
    info "while stopped: $(stats_json)"
    say "Restoring the processor"
    $K -n "$NS" scale deployment/processor --replicas=1
    $K -n "$NS" rollout status deployment/processor --timeout=120s
    wait_pending_zero
    after=$(stats_json)
    ok "accepted +$(( $(echo "$after" | field accepted) - $(echo "$before" | field accepted) ))  ·  processed +$(( $(echo "$after" | field processed) - $(echo "$before" | field processed) ))  (equal = nothing lost)"
    ;;
  kill-pod)
    say "Deleting the processor pod in $ENV"
    $K -n "$NS" get pods -l app.kubernetes.io/name=processor
    $K -n "$NS" delete pod -l app.kubernetes.io/name=processor --wait=false
    sleep 3; $K -n "$NS" get pods -l app.kubernetes.io/name=processor
    $K -n "$NS" rollout status deployment/processor --timeout=120s
    ok "Kubernetes created a new pod (different name); pending events are picked up again"
    ;;
  persistence)
    say "Counters before restarting the database"; b=$(stats_json); echo "$b"
    $K -n "$NS" delete pod postgres-0
    $K -n "$NS" wait --for=condition=ready pod/postgres-0 --timeout=180s
    sleep 5; say "Counters after"; a=$(stats_json); echo "$a"
    [ "$(echo "$a" | field accepted)" = "$(echo "$b" | field accepted)" ] && ok "same data: it lives on the persistent volume, not in the pod"
    ;;
  rollback)
    say "ingest-api history in $ENV"
    $K -n "$NS" rollout history deployment/ingest-api
    info "current image: $($K -n "$NS" get deploy ingest-api -o jsonpath='{..image}')"
    read -r -p "  Roll back to the previous revision? [y/N] " r
    if [ "$r" = y ]; then
      $K -n "$NS" rollout undo deployment/ingest-api
      $K -n "$NS" rollout status deployment/ingest-api --timeout=180s
      info "new image: $($K -n "$NS" get deploy ingest-api -o jsonpath='{..image}')"
      info "version reported: $(api GET /version '' '' | cut -d' ' -f2-)"
      ok "to return to the latest version: run 'rollout undo' again or re-run the deploy workflow"
    fi
    ;;
  logs)
    $K -n "$NS" logs deploy/processor --tail="${1:-15}"
    ;;
  *)
    sed -n '2,20p' "$0"
    ;;
esac
