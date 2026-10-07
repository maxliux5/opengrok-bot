CREATE TABLE service_heartbeats (
  service_name text NOT NULL,
  instance_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service_name, instance_id)
);
CREATE INDEX service_heartbeats_recent ON service_heartbeats(service_name, last_seen_at DESC);
