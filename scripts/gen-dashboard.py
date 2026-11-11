#!/usr/bin/env python3
"""Generate the Grafana dashboard k8s/observability/dashboards/pfd-overview.json.

Panels are grouped by the operational questions in docs/metrics.md:
  Q1 Is ingestion healthy for clients?   Q2 Does processing keep up with ingestion?
  Q3 Is there enough capacity, and what limits it?
Run: python3 scripts/gen-dashboard.py
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "k8s/observability/dashboards/pfd-overview.json"
PROM = {"type": "prometheus", "uid": "prometheus"}
LOKI = {"type": "loki", "uid": "loki"}
NS = 'namespace="$namespace"'

panels: list[dict] = []
_id = 0
_y = 0


def nid() -> int:
    global _id
    _id += 1
    return _id


def row(title: str) -> None:
    global _y
    panels.append({"type": "row", "title": title, "id": nid(), "collapsed": False,
                   "gridPos": {"h": 1, "w": 24, "x": 0, "y": _y}})
    _y += 1


def target(expr: str, legend: str = "", ref: str = "A", instant: bool = False) -> dict:
    t = {"datasource": PROM, "expr": expr, "legendFormat": legend, "refId": ref}
    if instant:
        t["instant"] = True
        t["range"] = False
    return t


def ts(title, desc, targets, unit, x, w, h=8, thresholds=None, stack=False, min0=True, soft_max=None):
    p = {
        "type": "timeseries", "id": nid(), "title": title, "description": desc, "datasource": PROM,
        "gridPos": {"h": h, "w": w, "x": x, "y": _y},
        "targets": [target(*t) if isinstance(t, tuple) else t for t in targets],
        "fieldConfig": {"defaults": {
            "unit": unit,
            "min": 0 if min0 else None,
            "custom": {"axisSoftMax": soft_max, "lineWidth": 2, "fillOpacity": 15 if stack else 5, "showPoints": "never",
                       "stacking": {"mode": "normal" if stack else "none"},
                       "thresholdsStyle": {"mode": "dashed" if thresholds else "off"}},
            "thresholds": {"mode": "absolute", "steps": thresholds or [{"color": "green", "value": None}]},
        }, "overrides": []},
        "options": {"legend": {"displayMode": "table", "placement": "bottom", "calcs": ["lastNotNull", "max"]},
                    "tooltip": {"mode": "multi", "sort": "desc"}},
    }
    panels.append(p)


def stat(title, desc, expr, unit, x, w, steps, h=5, decimals=2):
    panels.append({
        "type": "stat", "id": nid(), "title": title, "description": desc, "datasource": PROM,
        "gridPos": {"h": h, "w": w, "x": x, "y": _y},
        "targets": [target(expr, "", "A", instant=True)],
        "fieldConfig": {"defaults": {"unit": unit, "decimals": decimals,
                                     "thresholds": {"mode": "absolute", "steps": steps},
                                     "noValue": "no traffic"}, "overrides": []},
        "options": {"colorMode": "background", "graphMode": "none", "reduceOptions": {"calcs": ["lastNotNull"]}},
    })


def advance(h: int) -> None:
    global _y
    _y += h


# ------------------------------------------------------------------ volume counter
row("Volume · events received in the selected time range")
_vol = 'round(sum{by}(increase(events_received_total{{{ns}{extra}}}[$__range])))'
panels.append({
    "type": "stat", "id": nid(), "title": "Events received (selected time range)",
    "description": "How many events reached the API in the time range chosen in the time picker (top right). "
                   "Total = accepted + duplicates + rejected (exact: counted by the API pods). For processed totals use /v1/stats.",
    "datasource": PROM, "gridPos": {"h": 5, "w": 24, "x": 0, "y": _y},
    "targets": [
        target(_vol.format(by="", ns=NS, extra=""), "Total received", "A", instant=True),
        target(_vol.format(by="", ns=NS, extra=',outcome="accepted"'), "Accepted", "B", instant=True),
        target(_vol.format(by="", ns=NS, extra=',outcome="duplicate"'), "Duplicates", "C", instant=True),
        target(_vol.format(by="", ns=NS, extra=',outcome="rejected"'), "Rejected", "D", instant=True),
    ],
    "fieldConfig": {"defaults": {"unit": "locale", "decimals": 0, "noValue": "0",
                                 "thresholds": {"mode": "absolute", "steps": [{"color": "text", "value": None}]}},
                    "overrides": [
                        {"matcher": {"id": "byName", "options": "Total received"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "#151515"}}]},
                        {"matcher": {"id": "byName", "options": "Accepted"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "green"}}]},
                        {"matcher": {"id": "byName", "options": "Duplicates"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "purple"}}]},
                        {"matcher": {"id": "byName", "options": "Rejected"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}}]},
                    ]},
    "options": {"colorMode": "value", "graphMode": "none", "textMode": "value_and_name", "orientation": "vertical",
                "justifyMode": "center", "reduceOptions": {"calcs": ["lastNotNull"]}},
})
advance(5)

# ------------------------------------------------------------------ SLO summary
row("SLOs (7-day window)  ·  availability ≥ 99.5%  ·  freshness ≥ 99% within 5 s")
stat("Availability SLI (7d)", "Share of ingestion requests (/v1/events*) that did not return 5xx. SLO: 99.5%.",
     f"1 - pfd:sli_availability:error_ratio_rate7d{{{NS}}}", "percentunit", 0, 6,
     [{"color": "red", "value": None}, {"color": "orange", "value": 0.99}, {"color": "green", "value": 0.995}], decimals=3)
stat("Availability error budget left", "1 - (observed error ratio / allowed error ratio 0.5%). Below 0 = SLO breached.",
     f"pfd:slo_availability:error_budget_remaining{{{NS}}}", "percentunit", 6, 6,
     [{"color": "red", "value": None}, {"color": "orange", "value": 0.25}, {"color": "green", "value": 0.5}], decimals=1)
stat("Freshness SLI (7d)", "Share of processed events whose receive→processed lag was ≤ 5 s. SLO: 99%.",
     f"1 - pfd:sli_freshness:error_ratio_rate7d{{{NS}}}", "percentunit", 12, 6,
     [{"color": "red", "value": None}, {"color": "orange", "value": 0.98}, {"color": "green", "value": 0.99}], decimals=3)
stat("Freshness error budget left", "1 - (observed late ratio / allowed late ratio 1%).",
     f"pfd:slo_freshness:error_budget_remaining{{{NS}}}", "percentunit", 18, 6,
     [{"color": "red", "value": None}, {"color": "orange", "value": 0.25}, {"color": "green", "value": 0.5}], decimals=1)
advance(5)

# ------------------------------------------------------------------ Q1
row("Q1 · Is ingestion healthy for clients?")
ts("Ingestion rate by outcome", "Events/s received, split by accepted / duplicate / rejected (1m rate).",
   [(f"sum by (outcome) (pfd:events_ingested:rate1m{{{NS}}})", "{{outcome}}")], "reqps", 0, 8, stack=True)
ts("Rejections by reason", "Rejected events/s by validation reason. A spike in one reason points to a faulty client or device.",
   [(f"sum by (reason) (rate(events_rejected_total{{{NS}}}[1m]))", "{{reason}}")], "reqps", 8, 8, stack=True)
ts("Ingestion API latency (/v1/events*)", "Server-side request duration percentiles. Dashed line = 250 ms latency SLI threshold.",
   [(f'histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket{{{NS},route=~"/v1/events.*"}}[2m])))', "p50", "A"),
    (f'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{{{NS},route=~"/v1/events.*"}}[2m])))', "p95", "B"),
    (f'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{{{NS},route=~"/v1/events.*"}}[2m])))', "p99", "C")],
   "s", 16, 8, thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 0.25}])
advance(8)
ts("HTTP responses by status (ingestion)", "Requests/s to /v1/events* by status code. 5xx consume the availability error budget; 4xx are client errors.",
   [(f'sum by (status_code) (rate(http_request_duration_seconds_count{{{NS},route=~"/v1/events.*"}}[1m]))', "{{status_code}}")],
   "reqps", 0, 12, stack=True)
ts("SLO burn: availability error ratio", "Error ratio over 5m and 1h. Alert fires when both exceed 14.4 × 0.5% = 7.2% (dashed).",
   [(f"pfd:sli_availability:error_ratio_rate5m{{{NS}}}", "5m", "A"), (f"pfd:sli_availability:error_ratio_rate1h{{{NS}}}", "1h", "B")],
   "percentunit", 12, 12, thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 0.072}], soft_max=0.25)
advance(8)

# ------------------------------------------------------------------ Q2
row("Q2 · Does processing keep up with ingestion?")
ts("Accepted vs processed rate", "If processed stays below accepted, the backlog grows. Lines should overlap in steady state.",
   [(f'sum(pfd:events_ingested:rate1m{{{NS},outcome="accepted"}})', "accepted (in)", "A"),
    (f'sum(pfd:events_processed:rate1m{{{NS},result="processed"}})', "processed (out)", "B"),
    (f'sum(pfd:events_processed:rate1m{{{NS},result="failed"}})', "failed", "C")], "reqps", 0, 8)
ts("Backlog (events waiting)", "Events in pending / processing state (database count, polled every 5s).",
   [(f"pfd:events_backlog:max{{{NS}}}", "{{status}}")], "short", 8, 8,
   thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 200}])
ts("Wait vs processing time (p95)", "Lag = receive→processed (queue wait + processing). Processing = effective work per event. "
   "The gap between them is time spent waiting in the queue.",
   [(f"histogram_quantile(0.95, sum by (le) (rate(event_processing_lag_seconds_bucket{{{NS}}}[2m])))", "lag p95 (wait + processing)", "A"),
    (f"histogram_quantile(0.95, sum by (le) (rate(event_processing_duration_seconds_bucket{{{NS}}}[2m])))", "processing p95", "B")],
   "s", 16, 8, thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 5}])
advance(8)
ts("SLO burn: freshness (late events ratio)", "Share of events processed later than 5 s, over 5m and 1h. Alert threshold 14.4 × 1% = 14.4% (dashed).",
   [(f"pfd:sli_freshness:error_ratio_rate5m{{{NS}}}", "5m", "A"), (f"pfd:sli_freshness:error_ratio_rate1h{{{NS}}}", "1h", "B")],
   "percentunit", 0, 12, thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 0.144}], soft_max=0.25)
ts("Business alerts raised", "Threshold violations detected by the processor (events/s by metric).",
   [(f"sum by (metric) (rate(business_alerts_total{{{NS}}}[1m]))", "{{metric}}")], "reqps", 12, 12, stack=True)
advance(8)

# ------------------------------------------------------------------ Q3
row("Q3 · Capacity: is there enough, and what limits it?")
ts("CPU usage per pod vs request", "CPU cores used (5m rate) per container; dashed series are the CPU requests.",
   [(f'sum by (pod) (rate(container_cpu_usage_seconds_total{{{NS},container!="",container!="POD"}}[5m]))', "{{pod}}", "A"),
    (f'sum by (pod) (kube_pod_container_resource_requests{{{NS},resource="cpu"}})', "request {{pod}}", "B")],
   "cores", 0, 8)
ts("Memory working set per pod vs limit", "Working-set bytes per pod (what the OOM killer looks at) and memory limits.",
   [(f'sum by (pod) (container_memory_working_set_bytes{{{NS},container!="",container!="POD"}})', "{{pod}}", "A"),
    (f'sum by (pod) (kube_pod_container_resource_limits{{{NS},resource="memory"}})', "limit {{pod}}", "B")],
   "bytes", 8, 8)
ts("Node CPU and memory utilisation", "Whole VM (all namespaces, including observability).",
   [('1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))', "CPU", "A"),
    ("1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes", "memory", "B")],
   "percentunit", 16, 8, thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 0.8}], soft_max=1)
advance(8)
ts("Pod restarts", "Container restarts in the namespace (probe failures, OOM kills, crashes).",
   [(f'sum by (pod) (increase(kube_pod_container_status_restarts_total{{{NS},pod!~"ar-pull.*|migrate.*"}}[10m]))', "{{pod}}")], "short", 0, 8)
panels.append({
    "type": "logs", "id": nid(), "title": "Warnings and errors (logs)", "datasource": LOKI,
    "description": "Structured logs from Loki; expand a line and click trace_id to open the trace in Tempo.",
    "gridPos": {"h": 8, "w": 16, "x": 8, "y": _y},
    "targets": [{"datasource": LOKI, "refId": "A",
                 "expr": '{k8s_namespace_name="$namespace"} | json | level=~"warn|error|fatal"'}],
    "options": {"showTime": True, "wrapLogMessage": True, "enableLogDetails": True, "sortOrder": "Descending"},
})
advance(8)
panels.append({
    "type": "alertlist", "id": nid(), "title": "Active alerts", "gridPos": {"h": 6, "w": 24, "x": 0, "y": _y},
    "options": {"alertListOptions": {"stateFilter": {"firing": True, "pending": True}},
                "showOptions": "current", "maxItems": 20, "datasource": "Alertmanager",
                "alertInstanceLabelFilter": "", "groupMode": "default"},
})

dashboard = {
    "uid": "pfd-overview",
    "title": "PFD · Event ingestion overview",
    "description": "Escenario 3: ingestion, processing, SLOs and capacity. Generated by scripts/gen-dashboard.py.",
    "tags": ["pfd", "slo"],
    "timezone": "browser",
    "schemaVersion": 41,
    "refresh": "30s",
    "time": {"from": "now-1h", "to": "now"},
    "templating": {"list": [{
        "name": "namespace", "label": "Environment", "type": "custom",
        "query": "pfd-prod,pfd-dev", "current": {"text": "pfd-prod", "value": "pfd-prod"},
        "options": [{"text": "pfd-prod", "value": "pfd-prod", "selected": True},
                    {"text": "pfd-dev", "value": "pfd-dev", "selected": False}],
    }]},
    "annotations": {"list": [{
        "name": "Deployments", "datasource": PROM, "enable": True, "iconColor": "purple",
        "expr": f'changes(kube_deployment_status_observed_generation{{{NS},deployment=~"ingest-api|processor"}}[1m]) > 0',
        "titleFormat": "Rollout {{deployment}}", "step": "60s",
    }]},
    "panels": panels,
}

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(dashboard, indent=2) + "\n")
print(f"wrote {OUT} ({len([p for p in panels if p['type'] != 'row'])} panels)")
