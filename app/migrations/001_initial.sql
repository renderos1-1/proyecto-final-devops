CREATE TABLE IF NOT EXISTS installations (
  id text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS devices (
  id text PRIMARY KEY, installation_id text NOT NULL REFERENCES installations(id),
  name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS thresholds (
  installation_id text REFERENCES installations(id),
  metric text NOT NULL CHECK (metric IN ('temperature', 'humidity')),
  min numeric, max numeric,
  CHECK (min IS NULL OR max IS NULL OR min <= max),
  UNIQUE NULLS NOT DISTINCT (installation_id, metric)
);
INSERT INTO thresholds (installation_id, metric, min, max)
VALUES (NULL, 'temperature', -10, 60), (NULL, 'humidity', 10, 90)
ON CONFLICT (installation_id, metric) DO NOTHING;
CREATE TABLE IF NOT EXISTS events (
  pk bigserial PRIMARY KEY, device_id text NOT NULL REFERENCES devices(id), event_id text NOT NULL,
  generated_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  temperature numeric NOT NULL, humidity numeric NOT NULL, op_status text NOT NULL,
  processing_status text NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed')),
  attempts int NOT NULL DEFAULT 0, locked_at timestamptz, processed_at timestamptz,
  last_error text, traceparent text,
  UNIQUE (device_id, event_id)
);
CREATE INDEX IF NOT EXISTS events_queue_idx ON events (processing_status, received_at);
CREATE INDEX IF NOT EXISTS events_device_generated_idx ON events (device_id, generated_at, event_id);
CREATE TABLE IF NOT EXISTS rejections (
  id bigserial PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now(),
  device_id text, event_id text, reason text NOT NULL, payload jsonb NOT NULL,
  CHECK (octet_length(payload::text) <= 4096)
);
CREATE TABLE IF NOT EXISTS duplicate_receipts (
  id bigserial PRIMARY KEY, device_id text NOT NULL, event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS duplicate_receipts_received_idx ON duplicate_receipts (received_at);
CREATE INDEX IF NOT EXISTS rejections_received_idx ON rejections (received_at);
CREATE TABLE IF NOT EXISTS business_alerts (
  id bigserial PRIMARY KEY, event_pk bigint NOT NULL REFERENCES events(pk), device_id text NOT NULL,
  metric text NOT NULL CHECK (metric IN ('temperature', 'humidity')), value numeric NOT NULL,
  threshold_min numeric, threshold_max numeric, generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (event_pk, metric)
);
CREATE INDEX IF NOT EXISTS business_alerts_device_generated_idx ON business_alerts (device_id, generated_at);
