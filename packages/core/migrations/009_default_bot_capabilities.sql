ALTER TABLE bots ALTER COLUMN capabilities_json SET DEFAULT
  '["public_web","workspace","artifact","memory"]'::jsonb;
ALTER TABLE runs ALTER COLUMN capabilities_json SET DEFAULT
  '["public_web","workspace","artifact","memory"]'::jsonb;
