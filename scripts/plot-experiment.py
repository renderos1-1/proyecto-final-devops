# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8"]
# ///
"""Timeline figure of the degradation experiment from series.csv + marks.env.

usage: uv run scripts/plot-experiment.py <experiment dir>   ->  <dir>/screenshots/experiment-timeline.png
"""
import csv
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

d = Path(sys.argv[1])
marks = {k: int(v) for k, v in (l.split("=") for l in (d / "marks.env").read_text().split())}
t0 = marks["fault_injected"]
rows = list(csv.DictReader(open(d / "series.csv")))


def col(name: str, scale: float = 1.0):
    xs, ys = [], []
    for r in rows:
        if r[name] not in ("", "NaN"):
            xs.append((int(r["unix_time"]) - t0) / 60)
            ys.append(float(r[name]) * scale)
    return xs, ys


fig, axes = plt.subplots(4, 1, figsize=(13, 10), sharex=True, gridspec_kw={"height_ratios": [3, 3, 3, 1.4]})
fig.suptitle("Controlled degradation: processor capacity reduced under 20 events/s (prod, 2026-11-11)", fontsize=13, weight="bold")

ax = axes[0]
ax.plot(*col("accepted_per_s"), label="accepted (input)", color="#2563eb", lw=2)
ax.plot(*col("processed_per_s"), label="processed (output)", color="#16a34a", lw=2)
ax.set_ylabel("events/s"); ax.legend(loc="upper left"); ax.set_title("Throughput: output drops below input while degraded", loc="left", fontsize=10)

ax = axes[1]
ax.plot(*col("backlog_pending"), color="#ea580c", lw=2)
ax.axhline(200, ls="--", color="#ea580c", alpha=0.5, lw=1); ax.text(-3.2, 260, "backlog alert threshold (200)", color="#ea580c", fontsize=8)
ax.set_ylabel("pending events"); ax.set_title("Backlog grows ~6 events/s, drains in < 1 min after rollback", loc="left", fontsize=10)

ax = axes[2]
ax.plot(*col("lag_p95_s"), label="lag p95 (wait + processing)", color="#7c3aed", lw=2)
ax.plot(*col("processing_mean_s"), label="processing mean", color="#64748b", lw=2)
ax.axhline(5, ls="--", color="#dc2626", alpha=0.6, lw=1); ax.text(-3.2, 7, "freshness SLI threshold (5 s)", color="#dc2626", fontsize=8)
ax.set_yscale("log"); ax.set_ylabel("seconds (log)"); ax.legend(loc="upper left")
ax.set_title("Lag p95 climbs past 4 min (interpolated in the 60–300 s bucket); per-event work only goes 10 ms -> 80 ms", loc="left", fontsize=10)

ax = axes[3]
for name, y, color, label in [("alert_freshness", 1, "#dc2626", "PfdFreshnessBurnRate"), ("alert_backlog", 0, "#ea580c", "PfdEventBacklogGrowing")]:
    xs, ys = col(name)
    on = [x for x, v in zip(xs, ys) if v >= 1]
    if on:
        ax.broken_barh([(min(on), max(on) - min(on) + 0.25)], (y - 0.35, 0.7), color=color)
    ax.text(-3.2, y, label, va="center", fontsize=8, color=color)
ax.set_ylim(-0.6, 1.6); ax.set_yticks([]); ax.set_title("Alerts firing", loc="left", fontsize=10)
ax.set_xlabel("minutes relative to fault injection")

phases = [("baseline_end", "fault injected\n(70 ms/event)"), ("mitigated", "rollout undo"), ("freshness_alert_resolved", "alerts resolved")]
for a in axes:
    a.grid(alpha=0.25)
    a.axvspan(0, (marks["mitigated"] - t0) / 60, color="#fee2e2", alpha=0.45, lw=0)
    for k, _ in phases:
        a.axvline((marks[k if k != "baseline_end" else "fault_injected"] - t0) / 60, color="#111827", ls=":", lw=1)
for k, label in phases:
    x = (marks[k if k != "baseline_end" else "fault_injected"] - t0) / 60
    axes[0].text(x + 0.1, axes[0].get_ylim()[1] * 0.97, label, fontsize=8, va="top")

out = d / "screenshots" / "experiment-timeline.png"
out.parent.mkdir(exist_ok=True)
fig.tight_layout()
fig.savefig(out, dpi=140)
print(f"saved {out}")
