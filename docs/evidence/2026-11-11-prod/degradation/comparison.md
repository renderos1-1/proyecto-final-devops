## Timeline

| Mark | UTC | t (s) from fault injection |
|---|---|---|
| load_start | 02:00:33 | -196 |
| baseline_end | 02:03:41 | -8 |
| fault_injected | 02:03:49 | +0 |
| freshness_alert_firing | 02:05:47 | +118 |
| backlog_alert_firing | 02:09:57 | +368 |
| mitigated | 02:10:08 | +379 |
| backlog_recovered | 02:10:59 | +430 |
| freshness_alert_resolved | 02:15:59 | +730 |
| backlog_alert_resolved | 02:15:59 | +730 |
| load_end | 02:18:05 | +856 |

## Before / during / after

| Signal | baseline (end of phase 1) | degraded (just before mitigation) | recovered (end of observation) |
|---|---|---|---|
| `accepted_per_s` | 19.933 | 19.756 | 19.711 |
| `processed_per_s` | 20.000 | 12.400 | 20.067 |
| `backlog_pending` | 1.000 | 2677.000 | 2.000 |
| `lag_p95_s` | 0.498 | 288.000 | 0.496 |
| `processing_mean_s` | 0.010 | 0.080 | 0.009 |
| `processing_p95_s` | 0.083 | 0.097 | 0.082 |
| `late_ratio_5m` | 0.000 | 1.000 | 0.000 |
| `api_p95_s` | 0.041 | 0.024 | 0.028 |
| `processor_cpu_cores` | 0.076 | 0.060 | 0.086 |
