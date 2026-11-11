# Alert runbooks

Dashboard: Grafana → PFD → *Event ingestion overview* (select the environment). Cluster access: `scripts/vm.sh tunnel`.

## PfdIngestAvailabilityBurnRate

**Meaning:** more than 7.2% of ingestion requests returned 5xx over the last hour and the last 5 minutes.

1. Dashboard Q1, "HTTP responses by status": which status code (500, 502, 503)?
2. `kubectl -n <ns> get pods`. Are ingest-api pods Ready? `kubectl -n <ns> describe pod <pod>` for probe failures.
3. 503 from the ingress plus a failing readiness probe usually means **the database is unreachable**: check `postgres-0` and its events.
4. Logs: `{k8s_namespace_name="<ns>", service_name="ingest-api"} | json | level="error"`. Open a `trace_id` to see which span failed.
5. Started right after a deploy (purple annotation)? Roll back: `kubectl -n <ns> rollout undo deployment/ingest-api`,
   or run the `deploy` workflow with the previous SHA.

## PfdFreshnessBurnRate

**Meaning:** more than 14.4% of events took longer than 5 s from receipt to processed.

1. Dashboard Q2, "Wait vs processing time". If processing p95 is high, each event is slow (DB, artificial delay,
   CPU throttling). If only the lag is high, events are **waiting**: the processor can't keep up.
2. "Accepted vs processed": is input above output? Then also check `PfdEventBacklogGrowing`.
3. Check the processor config: `kubectl -n <ns> get cm pfd-config -o yaml` (`PROCESSOR_ARTIFICIAL_DELAY_MS`, batch size).
4. Mitigate: fix the slowdown, or add capacity with `kubectl -n <ns> scale deployment/processor --replicas=2`.
   It's safe to run several replicas, because rows are claimed with `FOR UPDATE SKIP LOCKED`.

## PfdEventBacklogGrowing

**Meaning:** more than 200 pending events, and the count is still rising after 5 minutes.

1. Is the input legitimately higher (load test, burst)? Compare the accepted rate with the processed rate.
2. Is the processor healthy? `kubectl -n <ns> get deploy processor`, its logs, and `PfdProcessorStalled`.
3. Mitigate as for freshness. Once processed > accepted, the backlog drains on its own. Estimate drain time as
   backlog / (processed rate − accepted rate).

## PfdProcessorStalled

**Meaning:** there are pending events but nothing has been processed for 5 minutes.

1. `kubectl -n <ns> get deploy,pods -l app.kubernetes.io/name=processor`. Is it scaled to 0, crash-looping or not Ready?
2. `kubectl -n <ns> logs deploy/processor --tail=50` and `kubectl -n <ns> get events --sort-by=.lastTimestamp`.
3. Liveness restarts a processor whose loop is stuck for over 60 s. Repeated restarts point to a crash at startup
   (configuration, DB credentials).
4. Restore: `kubectl -n <ns> scale deployment/processor --replicas=1`, or roll back. Rows left in `processing` are
   reclaimed after `PROCESSOR_LEASE_SECONDS` (60 s), so nothing accepted is lost.
