# Evidence index

Everything below can be regenerated. Raw outputs (JSON, logs, CSV) are the objective evidence;
screenshots are for the slides. Spec 5.8 asks for reproducible checks, "not only screenshots".

## How to reproduce

```bash
scripts/vm.sh start && scripts/vm.sh tunnel &          # VM up + K3s API on localhost:16443
export KUBECONFIG=~/.kube/pfd-k3s.yaml
kubectl -n observability port-forward svc/kps-prometheus 19090:9090 &
kubectl -n observability port-forward svc/loki 13100:3100 &
kubectl -n observability port-forward svc/tempo 13200:3200 &

scripts/p3-tests.sh prod                               # P3-1..P3-4, PASS/FAIL per check
scripts/degradation-experiment.sh prod 70              # P3-5 / MET-07 controlled degradation
python3 scripts/export-evidence.py prod docs/evidence/<date>-prod/degradation
(cd tools/evidence && npm ci)                          # screenshots (uses the system Chrome)
GRAFANA_PASSWORD=... node tools/evidence/grafana-shot.mjs --env pfd-prod --from <ms> --to <ms> --out x.png
node tools/evidence/terminal-shot.mjs --in <log> --out x.png --title "..."
```

## Scenario 3 tests (prod, 2026-11-11)

Folder: [`2026-11-11-prod/`](2026-11-11-prod/). Log: [`p3-tests.log`](2026-11-11-prod/p3-tests.log), screenshot `screenshots/p3-tests-terminal.png`.

| Test | What was done | Objective check | Result |
|---|---|---|---|
| **P3-1** burst | 1,000 unique valid events, concurrency 20 (65 ev/s achieved) | `/v1/stats` delta: accepted +1000, processed +1000, rejected 0 | **PASS**: drained in 5 s |
| **P3-2** sustained | 20 ev/s × 120 s = 2,400 events | accepted +2400, processed +2400, 0 HTTP errors | **PASS**: 19.99 ev/s achieved, client p95 132 ms, drained 2 s after load |
| **P3-3** duplicates + out-of-order | 50 retransmissions + 50 events older than ones already sent | duplicates +50 (not re-stored); generator recomputes min/max/avg/count per device over `[from, to)` by `generatedAt` and compares with the API | **PASS**: 10/10 devices match |
| **P3-4** interruption | Processor scaled to 0 during a 20 ev/s load (878 pending), restored with no new input | backlog → 0, processed = accepted (+1200), nothing lost | **PASS**: drained in 10 s after restore |
| **P3-5** evidence | Rates, lag and backlog under load, plus a degradation from reduced capacity | see `degradation/` | see below |

Counting invariants, verified on every run: `received = accepted + duplicates + rejected` and
`accepted = pending + processing + processed + failed`.

**Effect on the freshness SLO:** P3-1 (burst above processing capacity) and P3-4 (processor stopped) produce
events that are *correctly* counted as late (> 5 s). They consume freshness error budget by design, which
is why the 7-day freshness SLI in prod dropped below target right after the tests. The SLI measures what clients
experience, and test traffic is real traffic to the system.

## Degradation experiment (MET-07, spec 5.11)

Folder: [`2026-11-11-prod/degradation/`](2026-11-11-prod/degradation/). Write-up: [`docs/incident-report.md`](../incident-report.md).

| File | Content |
|---|---|
| `timeline.log` | Every phase with UTC timestamps, periodic snapshots (pending, lag p95, processed rate, firing alerts) |
| `marks.env` | Machine-readable timestamps of each phase |
| `series.csv` | 15 s resolution: accepted/processed rate, backlog, lag p95, processing p95, late ratio 5m/1h, API p95, processor CPU, alert state |
| `comparison.md` | Before / during / after table and timeline relative to fault injection |
| `logs-sample.txt`, `trace.txt` | Processor logs and a slow trace from the degraded phase |
| `screenshots/` | Dashboard for the experiment window, and alert states |

`2026-11-11-prod/degradation-aborted-dirty-baseline/` is a first attempt, stopped before any fault was injected
because the freshness alert was still firing from the P3 tests. It's kept on purpose: a baseline must be clean
before a cause can be attributed.

## Where the other rubric evidence lives

| Requirement | Evidence |
|---|---|
| DEV-01 PRs reviewed | GitHub → Pull requests (every change merged through a PR with required checks) |
| DEV-03 CI blocks failures | PR #1, first run: `k8s manifests` failed and blocked the merge, fixed in a follow-up commit |
| DEV-04 commit ↔ workflow ↔ image | `curl https://api.<domain>/version` → `gitSha`; image tag = full SHA in Artifact Registry; OCI label `pfd.workflow-run` |
| DEV-05 controlled delivery | `release` workflow: dev automatic, prod behind the required reviewer on the `prod` environment |
| DEV-06/07/08 Terraform | `infra/`, GCS remote state with locking, plan comment on every PR (read-only SA), apply only from `infra-prod` |
| DEV-12 rollback | Automatic `rollout undo` in `deploy.yml` (exercised on the first release, PR #2 context); manual undo in the degradation experiment |
| DEV-14 costs | `docs/costs.md`, budget alerts in infra/bootstrap |
| MET-01…06 | `docs/metrics.md`, `k8s/observability/` |
