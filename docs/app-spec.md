# App specification — Scenario 3: Event ingestion and analysis

This file is the **contract** between the application (`app/`, `tools/`) and the platform
(`k8s/`, `infra/`, `.github/`). Do not change ports, env vars, endpoints, or commands without
updating this file — the manifests and pipelines depend on them.

Source requirements: `Proyecto de Cátedra.pdf`, sections 3, 5, 6.3 (ESC3-01..10, P3-1..P3-5) and
Annex II (8.2 metrics).

## 1. Architecture

```
generator ──HTTPS──▶ ingress-nginx ──▶ ingest-api (NestJS)
                                         validate → INSERT event (processing_status=pending)
                                         UNIQUE(device_id, event_id) → dedupe
                                         ▼
                                     PostgreSQL 16
                                         ▲
                       processor (NestJS worker) — SELECT … FOR UPDATE SKIP LOCKED
                       → business alerts, processing_status=processed
```

- The `events` table doubles as the work queue (no Kafka/Redis). "Accepted" (HTTP 202) is
  returned **only after the INSERT commits**.
- The processor can be stopped (replicas=0) and the backlog must drain to 0 after it restarts.

## 2. Repository layout (app side)

```
app/                      NestJS monorepo (npm, Node 22 LTS, TypeScript strict)
  apps/ingest-api/        HTTP API
  apps/processor/         background worker (+ small HTTP server for health/metrics)
  libs/common/            db, config, logging, telemetry, metrics shared code
  migrations/             SQL migrations (ordered, idempotent, forward-compatible)
  Dockerfile              multi-stage, build arg APP=ingest-api|processor
  docker-compose.yml      local dev: postgres + both apps (+ optional otel/jaeger)
  .env.example
tools/generator/          reproducible event generator CLI (Node/TS)
```

## 3. Runtime contract

### Ports and probes (both apps)

| App | Port | Liveness | Readiness | Metrics | Version |
|---|---|---|---|---|---|
| ingest-api | 3000 | `GET /healthz/live` | `GET /healthz/ready` (DB reachable) | `GET /metrics` | `GET /version` |
| processor | 3001 | `GET /healthz/live` (loop not stuck > 60s) | `GET /healthz/ready` (DB reachable) | `GET /metrics` | `GET /version` |

Probe and metrics endpoints require no auth. `/version` returns `{ "app", "version", "gitSha" }`.

### Environment variables

| Var | App | Secret? | Default | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | both | yes | — | `postgres://user:pass@host:5432/db` |
| `PORT` | both | no | 3000 / 3001 | |
| `LOG_LEVEL` | both | no | `info` | |
| `APP_ENV` | both | no | `dev` | `dev` or `prod`; added to logs/resource attrs |
| `GIT_SHA` | both | no | `unknown` | baked at build via build arg, overridable |
| `APP_VERSION` | both | no | `0.0.0` | baked at build via build arg |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | both | no | unset → tracing disabled | e.g. `http://otel-collector.observability:4318` |
| `OTEL_SERVICE_NAME` | both | no | app name | |
| `INGEST_API_KEYS` | ingest-api | yes | — | comma-separated keys accepted in `X-API-Key` for ingestion and read endpoints |
| `ADMIN_API_KEY` | ingest-api | yes | — | `X-API-Key` for admin endpoints (installations, devices, thresholds) |
| `MAX_FUTURE_SKEW_SECONDS` | ingest-api | no | 300 | reject events generated further in the future |
| `PROCESSOR_BATCH_SIZE` | processor | no | 100 | |
| `PROCESSOR_POLL_INTERVAL_MS` | processor | no | 500 | sleep when queue empty |
| `PROCESSOR_LEASE_SECONDS` | processor | no | 60 | rows stuck in `processing` longer than this are reclaimed |
| `PROCESSOR_ARTIFICIAL_DELAY_MS` | processor | no | 0 | per-event delay, used ONLY for the degradation experiment |

### Commands (package.json scripts in `app/`)

- `npm run lint`, `npm run build`
- `npm test` — unit tests, no external deps
- `npm run test:e2e` — needs `DATABASE_URL` pointing at an empty Postgres (CI provides a service container)
- `npm run migrate` — applies migrations to `DATABASE_URL`; must be safe to run repeatedly. Available in the
  production image as `node dist/migrate.js` (k8s runs it as a Job before rollout).

### Docker image

- `docker build -f app/Dockerfile --build-arg APP=ingest-api --build-arg GIT_SHA=... --build-arg APP_VERSION=... app/`
- Multi-stage, `node:22-alpine` (or distroless) runtime, prod deps only, runs as non-root UID 10001,
  read-only root filesystem compatible (no writes outside `/tmp`), `CMD ["node", "dist/apps/<APP>/main.js"]`.
- OCI labels: `org.opencontainers.image.revision=$GIT_SHA`, `org.opencontainers.image.version=$APP_VERSION`.

## 4. Data model (PostgreSQL)

- `installations(id text pk, name, created_at)`
- `devices(id text pk  -- stable device identifier, installation_id fk, name, created_at)`
- `thresholds(installation_id fk null = global, metric text check in ('temperature','humidity'), min numeric null, max numeric null)`;
  seed a global default: temperature max 60, min -10; humidity max 90, min 10.
- `events(pk bigserial, device_id fk, event_id text, generated_at timestamptz, received_at timestamptz default now(),
  temperature numeric, humidity numeric, op_status text, processing_status text check in ('pending','processing','processed','failed'),
  attempts int default 0, locked_at timestamptz null, processed_at timestamptz null, last_error text null,
  traceparent text null, UNIQUE(device_id, event_id))`
  - index `(processing_status, received_at)` for the queue, `(device_id, generated_at)` for queries.
- `rejections(id bigserial, received_at, device_id text null, event_id text null, reason text, payload jsonb trimmed to 4 KB)`
- `duplicate_receipts(id bigserial, device_id, event_id, received_at)` — one row per retransmission (so duplicates are countable and observable).
- `business_alerts(id bigserial, event_pk fk, device_id, metric, value, threshold_min, threshold_max, generated_at, created_at, UNIQUE(event_pk, metric))`

## 5. API (ingest-api)

All `/v1/*` require `X-API-Key`. 401 if missing/invalid, 403 if a non-admin key calls an admin route.
Errors use `{ "error": { "code", "message", "details"? }, "requestId" }`.

Admin:
- `POST /v1/installations` `{id, name}` · `GET /v1/installations`
- `POST /v1/devices` `{id, installationId, name}` · `GET /v1/devices/:id`
- `PUT /v1/thresholds` `{installationId|null, metric, min, max}` · `GET /v1/thresholds`

Ingestion:
- `POST /v1/events` — single event:
  `{ "eventId": "string 1..128", "deviceId": "string", "generatedAt": "ISO-8601 UTC (must end in Z or +00:00)",
     "temperature": -40..85 (°C), "humidity": 0..100 (%), "status": "ok|warning|fault|offline" }`
  - 202 `{ "result": "accepted", "eventPk", "deviceId", "eventId" }` after commit
  - 200 `{ "result": "duplicate", "eventPk", ... }` if `(deviceId, eventId)` already exists (record a `duplicate_receipts` row; do NOT create work)
  - 422 `{ "result": "rejected", "reason" }` for validation errors (missing field, out of range, unknown device, future timestamp) — record in `rejections`
- `POST /v1/events/batch` — `{ "events": [ ...up to 500 ] }` → 207-style 200 response with per-item results in the same order. Each item handled independently.

Queries:
- `GET /v1/devices/:id/events?from&to&limit&cursor` — `from` inclusive, `to` exclusive, by `generated_at`; ordered by `(generated_at, event_id)` regardless of arrival order. Only accepted events (any processing status) are returned.
- `GET /v1/devices/:id/aggregates?from&to` — `{ count, temperature:{min,max,avg}, humidity:{min,max,avg}, from, to }` computed over `generated_at ∈ [from, to)`; duplicates can never affect it because they are never stored twice.
- `GET /v1/alerts?deviceId&from&to`
- `GET /v1/stats?from&to` (optional window, default all-time):
  `{ received, accepted, duplicates, rejected, pending, processing, processed, failed }` with invariants
  `received = accepted + duplicates + rejected` and `accepted = pending + processing + processed + failed`. Document these in the README.

## 6. Processor

Loop: in one transaction, `SELECT … WHERE processing_status='pending' OR (processing_status='processing' AND locked_at < now() - lease) ORDER BY received_at LIMIT batch FOR UPDATE SKIP LOCKED`, mark `processing`, commit;
for each event evaluate thresholds → insert `business_alerts` (ON CONFLICT DO NOTHING) → mark `processed` + `processed_at`.
On error: increment attempts, `failed` after 5 attempts with `last_error`. Graceful shutdown on SIGTERM (finish current batch, stop polling).
Safe to run with >1 replica.

## 7. Observability (Annex II)

**Logs** — JSON to stdout (pino): `timestamp` (ISO), `level`, `component` (`ingest-api|processor`), `env`, `msg`,
`requestId`, `trace_id`, `span_id`, `deviceId`, `eventId`, `outcome`, `durationMs` where relevant. Log every rejection (with reason),
duplicate, processing failure and state transition at debug/info. Never log API keys, DATABASE_URL, or full payloads.

**Metrics** — prom-client, default Node/process metrics plus:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `events_received_total` | counter | `outcome=accepted\|duplicate\|rejected` | ingestion outcomes |
| `events_rejected_total` | counter | `reason` (bounded enum) | rejection reasons |
| `events_processed_total` | counter | `result=processed\|failed` | processor outcomes |
| `http_request_duration_seconds` | histogram | `method, route (template), status_code` | API latency |
| `event_processing_lag_seconds` | histogram | — | `processed_at - received_at` (wait + processing) |
| `event_processing_duration_seconds` | histogram | — | effective processing time per event |
| `events_backlog` | gauge | `status=pending\|processing` | queue depth (processor polls a COUNT every 5s) |
| `business_alerts_total` | counter | `metric` | threshold alerts raised |

Never use `deviceId`/`eventId` as labels (cardinality).

**Traces** — OpenTelemetry Node SDK with auto-instrumentation (http, express, pg) and OTLP/HTTP exporter, enabled only if
`OTEL_EXPORTER_OTLP_ENDPOINT` is set. ingest-api stores the W3C `traceparent` of the request in `events.traceparent`.
The processor creates a span `process_event` per event (attributes `device.id`, `event.id`, `event.pk`) with a **span link**
to the stored traceparent, inside a `process_batch` span. Inject `trace_id`/`span_id` into logs.

## 8. Generator (`tools/generator`)

CLI, deterministic with `--seed`. Talks to `--base-url` with `--api-key`. Subcommands:

- `seed` — create N installations and M devices (default 2 installations × 5 devices) via admin API (`--admin-key`); idempotent.
- `burst --count 1000 --concurrency 20` — 1000 unique valid events (P3-1).
- `sustained --rate 20 --duration 120` — 2400 unique events at a fixed rate (P3-2).
- `dupes-ooo --duplicates 50 --out-of-order 50` — sends events, then retransmits 50 previous ones and sends 50 with older `generatedAt` than already-sent ones (P3-3). Writes the expected aggregates for a window to a JSON file and then **verifies** them against the API (exit code ≠ 0 on mismatch).
- Common flags: `--invalid-ratio 0..1` (adds identifiable invalid events), `--batch-size` (use batch endpoint when > 1), `--out report.json`.
- Every run prints/writes a summary: sent, accepted, duplicate, rejected, HTTP errors, p50/p95/p99 latency, achieved rate.

## 9. Tests

- Unit: validation rules, threshold evaluation, aggregate math, stats invariants.
- e2e (real Postgres): auth accepted/rejected, accepted/duplicate/rejected paths, out-of-order query ordering,
  `[from,to)` boundaries, processor drains backlog, lease reclaim of a stuck `processing` row, concurrent processors do not double-process.
- `tools/generator` has a `--dry-run` mode and its own unit tests for determinism.
