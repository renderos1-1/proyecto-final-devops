#!/usr/bin/env bash
# Cost control for the K3s VM (DEV-14). Usage: scripts/vm.sh start|stop|status|tunnel|ssh
# A stopped VM stops compute charges; the disk (~US$4/mo) and static IP (~US$3.6/mo) still bill.
# Full teardown: see docs/runbooks/rebuild.md ("Destroy").
set -euo pipefail
VM=pfd-k3s ZONE=us-central1-a PROJECT=devops-esen
case "${1:-status}" in
  start)  gcloud compute instances start "$VM" --zone "$ZONE" --project "$PROJECT" ;;
  stop)   gcloud compute instances stop  "$VM" --zone "$ZONE" --project "$PROJECT" ;;
  status) gcloud compute instances describe "$VM" --zone "$ZONE" --project "$PROJECT" --format='value(status)' ;;
  tunnel) exec gcloud compute start-iap-tunnel "$VM" 6443 --local-host-port=localhost:16443 --zone "$ZONE" --project "$PROJECT" ;;
  ssh)    shift; exec gcloud compute ssh "$VM" --zone "$ZONE" --project "$PROJECT" --tunnel-through-iap "$@" ;;
  *) echo "usage: $0 start|stop|status|tunnel|ssh" >&2; exit 2 ;;
esac
