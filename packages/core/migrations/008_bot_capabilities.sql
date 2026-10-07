ALTER TABLE bots ADD COLUMN capabilities_json jsonb NOT NULL
  DEFAULT '["public_web","workspace","artifact","memory","shell"]'::jsonb;
ALTER TABLE runs ADD COLUMN capabilities_json jsonb NOT NULL
  DEFAULT '["public_web","workspace","artifact","memory","shell"]'::jsonb;
