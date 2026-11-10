# Application implementation notes

`docs/app-spec.md` remains authoritative and unchanged. The application is in `app/`;
its standalone generator is in `tools/generator/`. Both use Node 22, strict TypeScript,
npm, and committed lockfiles.

## Contract clarifications

- The specification asks for stats invariants in the root README, but the implementation
  request explicitly prohibits modifying that file. They are documented here instead:
  `received = accepted + duplicates + rejected` and
  `accepted = pending + processing + processed + failed`.
- Stats count durable event receipts. Unauthorized requests, malformed JSON, invalid
  batch envelopes, and infrastructure failures that cannot commit are HTTP errors,
  not event rejections. A valid batch contributes one receipt per committed item.
  Stats windows filter each table's `received_at` in `[from,to)`; processing counts
  are the current states of accepted events in that same receipt window. All counts
  use one database snapshot. Event/aggregate/alert queries instead use `generated_at`.
- Batch responses are `{ "results": [...] }`, in input order. A failed database
  operation produces an error envelope for that item; subsequent items are still
  attempted. Clients may safely retransmit items after ambiguous network failures.
- Event queries return `{ "events": [...], "nextCursor": string|null }`. Fields use
  camelCase, including `eventPk`, `eventId`, `deviceId`, `generatedAt`, `receivedAt`,
  and `processingStatus`. IDs backed by `bigserial` remain strings to avoid JavaScript
  precision loss. Default page size is 100; valid sizes are 1 through 500. Cursors
  encode the last `(generated_at,event_id)` pair. Keep the device and window unchanged
  while paging. Ordering and cursors preserve PostgreSQL microsecond precision.
- UTC timestamps support `Z` and `+00:00`, including fractional seconds; PostgreSQL
  stores them at microsecond precision. Supplied windows require `from < to`.
  Omitted bounds are unbounded and are returned as `null` by aggregates. Empty
  aggregates have `count: 0` and null min/max/avg.
- Installation and device creation are idempotent by ID: an existing record is
  returned without overwriting its name or ownership. Admin keys also authorize
  ingestion and read routes. Device metadata (`GET /v1/devices/:id`) is an admin
  route, as listed in the specification.
- An installation threshold replaces the global threshold for that metric. A null
  bound disables that comparison; null/null disables that metric for that
  installation. Equality with a bound is not an alert. Operational status alone
  does not create a threshold alert.
- Rejection payloads are conservatively bounded below the 4 KB JSONB limit. Oversize
  input becomes a truncated preview. JSON values PostgreSQL cannot represent (NUL
  or unpaired UTF-16 surrogates) use a bounded base64 preview. Payloads never enter
  application logs. The HTTP JSON body limit is 2 MB.

## Running and verifying

From `app/`, with Node 22 selected:

```sh
npm ci
npm run lint
npm run build
npm test
DATABASE_URL='<postgres-connection-url>' npm run test:e2e
DATABASE_URL='<postgres-connection-url>' npm run migrate
```

End-to-end tests create a uniquely named database on the supplied PostgreSQL server
and remove only that database afterward. The database role therefore needs
`CREATEDB`. The existing database is not truncated or migrated by the test suite.
Tests cover real HTTP, SQL transactions, concurrent requests/workers, lease recovery,
retry exhaustion, graceful shutdown, generator verification, and OTLP export to a
local test collector. No Docker is needed for tests. `test:e2e` builds the application
so it can also exercise the production entry points.

For local processes, copy `app/.env.example` to `app/.env`, replace its placeholders,
set `DATABASE_URL`, run migrations, then run `npm run start:ingest-api` and
`npm run start:processor` in separate terminals. The apps load `.env` from the working
directory. `PORT` defaults to 3000/3001. Applications do not run migrations at startup.

For Compose, populate `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, and the API
keys in `app/.env`, then run `docker compose up --build` from `app/`. Compose replaces
`DATABASE_URL` with its internal database address and waits for the migration service.
Use URL-safe database credentials or percent-encode them when constructing URLs.
The Dockerfile selects the literal exec-form command using `APP=ingest-api|processor`,
runs as UID 10001, includes production dependencies and `dist/migrate.js`, and supports
a read-only root filesystem. Docker builds were not executed in the implementation
environment because Docker access was explicitly unavailable.

Migrations are ordered SQL files applied transactionally under a PostgreSQL advisory
lock. Applied checksums are recorded; repeat runs are no-ops, and concurrent runners
serialize. Never edit an already-applied migration: add a new additive migration.
The initial SQL is also idempotent and seeds globals without replacing custom values.

Workers fence claims with the stored `locked_at` value, then retain a row lock while
committing alerts and completion together. Expired batch members can be reclaimed;
a worker with an old claim skips them. Failures roll back the event transaction,
increment attempts, and return to pending until the fifth failure sets failed.
`last_error` stores a bounded database/error code rather than SQL or payload text.
SIGTERM finishes the current batch and flushes telemetry before closing resources.
Default metrics are per process; durable global receipt counts come from `/v1/stats`.
Backlog gauges refresh every five seconds. Threshold-alert counters increment only
for newly inserted alerts. Trace export is disabled unless the OTLP endpoint is set.

## Generator

From `tools/generator/`:

```sh
npm ci
npm run lint
npm run build
npm test
npm start -- seed --admin-key '<admin-key>'
npm start -- burst --api-key '<ingest-key>' --seed 42 --count 1000 --concurrency 20
npm start -- sustained --api-key '<ingest-key>' --rate 20 --duration 120
npm start -- dupes-ooo --api-key '<ingest-key>' --duplicates 50 --out-of-order 50 --out report.json
npm start -- burst --seed 42 --count 10 --dry-run
```

The built CLI is also available as `node dist/cli.js`. `--help` lists every option.
Keys may instead come from `INGEST_API_KEY` and `ADMIN_API_KEY` environment variables.
Reports and console output never include keys. `--base-url` defaults to
`http://localhost:3000`. Seed defaults to two installations and five devices **per
installation**, named `generator-installation-I` and `generator-device-I-J`.
Use the same installation/device counts for later scenarios.

`--seed` controls complete reproducible payloads, including event IDs, values, and
historical UTC timestamps (anchored on 2024-01-02). Repeating a scenario with the same
seed intentionally retransmits the same events; use a new seed for fresh unique
work. Within a scenario, valid event IDs are unique. Default initial count is 1000;
sustained instead emits `rate * duration` events, paced against a monotonic clock.
Batches group adjacent scheduled events and concurrency bounds active HTTP requests.
If the server cannot maintain the requested rate, elapsed time and achieved rate
reflect that. Invalid extras are sent after the valid workload.

`--invalid-ratio R` **adds** `round(valid_unique_count * R)` clearly identified
out-of-range events. It does not reduce the requested number of valid events;
`R=1` adds one invalid event per valid unique event. `--batch-size` is 1..500;
values greater than one use the batch endpoint even for a final partial batch.

`dupes-ooo` sends initial events, retransmissions, and older unique events in separate
phases. It snapshots existing accepted rows in the window, calculates expected
aggregates locally with event deduplication, writes expectations to the report before
sending, and verifies the API afterward. Existing rows win over retransmitted
payloads. This supports repeating a seed without corrupting the expectation. Run
without concurrent external writes to the same devices/window for reproducible
verification. It defaults to `report.json`; a mismatch or HTTP error exits nonzero.

Every successful invocation prints a JSON report and writes it when `--out` is set.
Summary fields are `sent`, `accepted`, `duplicate`, `rejected`, `httpErrors`,
`latencyMs.{p50,p95,p99}`, `achievedRate`, and `durationSeconds`. Receipt counts are per
event; latency percentiles are per workload HTTP request (per batch when batching).
Seed reports count administrative operations. `httpErrors` counts affected workload
items, plus a failed baseline/verification operation if applicable. Achieved rate is
sent items divided by total run duration, including baseline and verification work.
Dry runs make no network calls, emit the deterministic plan, report planned `sent`,
and leave observed outcome counts, latencies, duration, and achieved rate at zero.

## Verification recorded for this implementation

Verified using Node 22.23.4 and npm 10.9.10:

- `app/`: `npm ci && npm run lint && npm run build && npm test` passed (8 unit tests).
- `npm run test:e2e` passed all 14 scenarios against the supplied PostgreSQL 16
  server, using a disposable database; the server was not started or stopped.
- `npm run migrate` passed twice against a separate disposable database.
- `tools/generator/`: clean install, lint, build, and all 7 unit tests passed;
  the compiled CLI dry-run produced its JSON report without network requests.
- `npm audit --omit=dev` reported zero production vulnerabilities. The full install
  reported seven moderate development-only advisories in the TypeScript ESLint /
  minimatch dependency chain. No forced downgrade or incompatible override was used.
- Container files were inspected but not built or launched, per the request.
