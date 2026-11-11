#!/usr/bin/env python3
"""Generate k8s/observability/rules/pfd-slo-rules.yaml (SLI recording rules, SLOs, alerts).

SLO targets and windows are defined once here. Run after changing them:
    python3 scripts/gen-slo-rules.py
Definitions and rationale: docs/metrics.md.
"""
from pathlib import Path

import yaml

OUT = Path(__file__).resolve().parent.parent / "k8s/observability/rules/pfd-slo-rules.yaml"

SLO_AVAILABILITY = 0.995  # ingestion requests that are not 5xx
SLO_FRESHNESS = 0.99      # processed events whose receive->processed lag is <= 5 s
FRESH_LE = "5.0"          # histogram bucket boundary (Prometheus 3 renders le as float strings)
FAST_LE = "0.25"          # latency SLI threshold (250 ms)
WINDOWS = ["5m", "30m", "1h", "6h", "7d"]
INGEST = 'route=~"/v1/events.*"'
RUNBOOK = "https://github.com/renderos1-1/proyecto-final-devops/blob/main/docs/runbooks/alerts.md"


def total(w: str) -> str:
    return f"sum by (namespace) (rate(http_request_duration_seconds_count{{{INGEST}}}[{w}]))"


def recording_rules() -> list[dict]:
    rules = []
    for w in WINDOWS:
        # "or 0 * total": when no 5xx series exists yet, the error ratio is 0 rather than empty.
        errors = (
            f'sum by (namespace) (rate(http_request_duration_seconds_count{{{INGEST},status_code=~"5.."}}[{w}]))'
            f"\nor\n0 * {total(w)}"
        )
        rules.append({"record": f"pfd:sli_availability:error_ratio_rate{w}",
                      "expr": f"(\n{errors}\n)\n/\n{total(w)}"})
        rules.append({"record": f"pfd:sli_freshness:error_ratio_rate{w}",
                      "expr": (f'1 - (\n  sum by (namespace) (rate(event_processing_lag_seconds_bucket{{le="{FRESH_LE}"}}[{w}]))\n'
                               f"  /\n  sum by (namespace) (rate(event_processing_lag_seconds_count[{w}]))\n)")})
        rules.append({"record": f"pfd:sli_latency:good_ratio_rate{w}",
                      "expr": (f'sum by (namespace) (rate(http_request_duration_seconds_bucket{{{INGEST},le="{FAST_LE}"}}[{w}]))'
                               f"\n/\n{total(w)}")})
    rules += [
        {"record": "pfd:events_ingested:rate1m", "expr": "sum by (namespace, outcome) (rate(events_received_total[1m]))"},
        {"record": "pfd:events_processed:rate1m", "expr": "sum by (namespace, result) (rate(events_processed_total[1m]))"},
        # both apps export events_backlog (same DB count); max() avoids double counting
        {"record": "pfd:events_backlog:max", "expr": "max by (namespace, status) (events_backlog)"},
        {"record": "pfd:slo_availability:error_budget_remaining",
         "expr": f"1 - (pfd:sli_availability:error_ratio_rate7d / (1 - {SLO_AVAILABILITY}))"},
        {"record": "pfd:slo_freshness:error_budget_remaining",
         "expr": f"1 - (pfd:sli_freshness:error_ratio_rate7d / (1 - {SLO_FRESHNESS}))"},
    ]
    return rules


def burn_alert(name: str, sli: str, slo: float, slo_txt: str, summary: str) -> dict:
    budget = round(1 - slo, 6)
    return {
        "alert": name,
        "expr": (f"pfd:{sli}:error_ratio_rate1h > (14.4 * {budget})\n"
                 f"and\npfd:{sli}:error_ratio_rate5m > (14.4 * {budget})"),
        "for": "1m",
        "labels": {"severity": "critical", "slo": sli.split("_", 1)[1]},
        "annotations": {
            "summary": summary,
            "description": (f"{{{{ $labels.namespace }}}}: 1h error ratio {{{{ $value | humanizePercentage }}}} burns the "
                            f"{slo_txt} budget at >14.4x (1h at this rate = ~8.6% of the 7-day budget)."),
            "runbook_url": RUNBOOK,
        },
    }


def alerts() -> list[dict]:
    return [
        burn_alert("PfdIngestAvailabilityBurnRate", "sli_availability", SLO_AVAILABILITY, "99.5% availability",
                   "Ingestion API returns 5xx fast enough to threaten the availability SLO"),
        burn_alert("PfdFreshnessBurnRate", "sli_freshness", SLO_FRESHNESS, "99% freshness (<=5s)",
                   "Events take longer than 5s to be processed, threatening the freshness SLO"),
        {
            "alert": "PfdEventBacklogGrowing",
            "expr": ('pfd:events_backlog:max{status="pending"} > 200\n'
                     'and\nderiv(pfd:events_backlog:max{status="pending"}[5m]) > 0'),
            "for": "5m",
            "labels": {"severity": "warning"},
            "annotations": {"summary": "Pending events keep growing: processing is not keeping up with ingestion",
                            "description": "{{ $labels.namespace }}: {{ $value }} pending events and still rising for 5m.",
                            "runbook_url": RUNBOOK},
        },
        {
            "alert": "PfdProcessorStalled",
            "expr": ('pfd:events_backlog:max{status="pending"} > 0\n'
                     "unless on (namespace)\n"
                     "sum by (namespace) (rate(events_processed_total[5m])) > 0"),
            "for": "3m",
            "labels": {"severity": "critical"},
            "annotations": {"summary": "Pending events but nothing processed in the last 5 minutes",
                            "description": "{{ $labels.namespace }}: backlog > 0 and processing rate is 0 "
                                           "(processor down, stuck, or failing every event).",
                            "runbook_url": RUNBOOK},
        },
    ]


class Dumper(yaml.SafeDumper):
    pass


Dumper.add_representer(str, lambda d, s: d.represent_scalar("tag:yaml.org,2002:str", s, style="|" if "\n" in s else None))

HEADER = f"""# GENERATED by scripts/gen-slo-rules.py; edit the script, not this file.
# SLO 1, availability: {SLO_AVAILABILITY:.1%} of ingestion requests are not 5xx (7-day window)
# SLO 2, freshness: {SLO_FRESHNESS:.0%} of processed events finish within 5s of receipt (7-day window)
# Burn-rate alerts use the multi-window pattern (1h + 5m) to fire fast on real incidents and
# clear quickly after mitigation. Definitions: docs/metrics.md
"""

doc = {
    "apiVersion": "monitoring.coreos.com/v1",
    "kind": "PrometheusRule",
    "metadata": {"name": "pfd-slo", "namespace": "observability", "labels": {"app.kubernetes.io/part-of": "pfd"}},
    "spec": {"groups": [
        {"name": "pfd-sli.rules", "interval": "30s", "rules": recording_rules()},
        {"name": "pfd-alerts", "rules": alerts()},
    ]},
}

OUT.write_text(HEADER + yaml.dump(doc, Dumper=Dumper, sort_keys=False, width=140))
print(f"wrote {OUT}")
