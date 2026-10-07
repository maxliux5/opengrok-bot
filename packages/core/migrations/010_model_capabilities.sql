ALTER TABLE model_profiles ADD COLUMN capabilities_json jsonb NOT NULL DEFAULT
  '{"text":true,"tools":true,"vision":false,"streaming":true}'::jsonb;
