#!/usr/bin/env python3
"""Export objective evidence for the degradation experiment (MET-07 / spec 5.11).

usage: python3 scripts/export-evidence.py <dev|prod> <experiment dir with marks.env>
Needs port-forwards: Prometheus :19090, Loki :13100, Tempo :13200 (see docs/evidence/README.md).
Writes: series.csv (time series), comparison.md (before / during / after), logs-sample.txt, trace.txt
"""
import csv
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

PROM, LOKI, TEMPO = "http://localhost:19090", "http://localhost:13100", "http://localhost:13200"
env, out = sys.argv[1], Path(sys.argv[2])
ns = f"pfd-{env}"
marks = {k: int(v) for k, v in (l.split("=") for l in (out / "marks.env").read_text().split())}


def get(url: str, **params) -> dict:
    return json.load(urllib.request.urlopen(f"{url}?{urllib.parse.urlencode(params)}", timeout=60))


def instant(q: str, t: int) -> float | None:
    r = get(f"{PROM}/api/v1/query", query=q, time=t)["data"]["result"]
    return float(r[0]["value"][1]) if r else None


SERIES = {
    "accepted_per_s": f'sum(pfd:events_ingested:rate1m{{namespace="{ns}",outcome="accepted"}})',
    "processed_per_s": f'sum(pfd:events_processed:rate1m{{namespace="{ns}",result="processed"}})',
    "backlog_pending": f'pfd:events_backlog:max{{namespace="{ns}",status="pending"}}',
    "lag_p95_s": f'histogram_quantile(0.95, sum by (le) (rate(event_processing_lag_seconds_bucket{{namespace="{ns}"}}[1m])))',
    "processing_p95_s": f'histogram_quantile(0.95, sum by (le) (rate(event_processing_duration_seconds_bucket{{namespace="{ns}"}}[1m])))',
    "processing_mean_s": f'sum(rate(event_processing_duration_seconds_sum{{namespace="{ns}"}}[1m])) / sum(rate(event_processing_duration_seconds_count{{namespace="{ns}"}}[1m]))',
    "late_ratio_5m": f'pfd:sli_freshness:error_ratio_rate5m{{namespace="{ns}"}}',
    "late_ratio_1h": f'pfd:sli_freshness:error_ratio_rate1h{{namespace="{ns}"}}',
    "api_p95_s": f'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{{namespace="{ns}",route=~"/v1/events.*"}}[1m])))',
    "processor_cpu_cores": f'sum(rate(container_cpu_usage_seconds_total{{namespace="{ns}",pod=~"processor.*",container!=""}}[1m]))',
    "alert_freshness": f'max(ALERTS{{alertname="PfdFreshnessBurnRate",alertstate="firing",namespace="{ns}"}}) or vector(0)',
    "alert_backlog": f'max(ALERTS{{alertname="PfdEventBacklogGrowing",alertstate="firing",namespace="{ns}"}}) or vector(0)',
}

start, end = marks["load_start"] - 60, marks.get("load_end", marks["load_start"] + 1800) + 60
cols: dict[str, dict[int, str]] = {}
for name, q in SERIES.items():
    r = get(f"{PROM}/api/v1/query_range", query=q, start=start, end=end, step=15)["data"]["result"]
    cols[name] = {int(float(t)): v for t, v in (r[0]["values"] if r else [])}
times = sorted({t for c in cols.values() for t in c})
with open(out / "series.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["unix_time", "seconds_since_load_start", *SERIES])
    for t in times:
        w.writerow([t, t - marks["load_start"], *(cols[n].get(t, "") for n in SERIES)])

# before / during / after, each evaluated at the end of its phase (1-minute rates)
points = {
    "baseline (end of phase 1)": marks["baseline_end"],
    "degraded (just before mitigation)": marks["mitigated"] - 5,
    "recovered (end of observation)": marks.get("load_end", end) - 10,
}
rows = ["| Signal | " + " | ".join(points) + " |", "|---|" + "---|" * len(points)]
for name in ["accepted_per_s", "processed_per_s", "backlog_pending", "lag_p95_s", "processing_mean_s", "processing_p95_s", "late_ratio_5m", "api_p95_s", "processor_cpu_cores"]:
    vals = [instant(SERIES[name], t) for t in points.values()]
    rows.append(f"| `{name}` | " + " | ".join("n/a" if v is None else f"{v:.3f}" for v in vals) + " |")
tl = ["| Mark | UTC | t (s) from fault injection |", "|---|---|---|"]
for k, v in sorted(marks.items(), key=lambda kv: kv[1]):
    from datetime import datetime, timezone
    tl.append(f"| {k} | {datetime.fromtimestamp(v, timezone.utc):%H:%M:%S} | {v - marks['fault_injected']:+d} |")
(out / "comparison.md").write_text("## Timeline\n\n" + "\n".join(tl) + "\n\n## Before / during / after\n\n" + "\n".join(rows) + "\n")

# logs: processor lines during the degraded phase
logs = get(f"{LOKI}/loki/api/v1/query_range",
           query=f'{{k8s_namespace_name="{ns}", service_name="processor"}} | json | msg="Event processed"',
           start=(marks["fault_injected"] + 120) * 10**9, end=(marks["fault_injected"] + 300) * 10**9, limit=15)
with open(out / "logs-sample.txt", "w") as f:
    for stream in logs["data"]["result"]:
        for _, line in stream["values"]:
            f.write(line + "\n")

# one slow process_event trace from the degraded phase
tr = get(f"{TEMPO}/api/search", q='{name="process_event" && duration > 50ms}',
         start=marks["fault_injected"], end=marks["mitigated"], limit=1).get("traces", [])
(out / "trace.txt").write_text(
    (f"traceID={tr[0]['traceID']} root={tr[0].get('rootServiceName')}/{tr[0].get('rootTraceName')} "
     f"duration={tr[0].get('durationMs')}ms\nGrafana: Explore -> Tempo -> paste the traceID\n") if tr else "no trace found\n")
print((out / "comparison.md").read_text())
