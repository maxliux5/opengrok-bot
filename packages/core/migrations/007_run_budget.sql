ALTER TABLE runs ADD COLUMN budget_json jsonb NOT NULL DEFAULT '{
  "maxModelSteps": 12,
  "maxToolCalls": 30,
  "maxTokens": 40000,
  "maxWallMs": 86400000,
  "maxModelCallMs": 120000,
  "maxModelOutputTokens": 2048,
  "maxArtifactBytes": 2000000
}'::jsonb;
ALTER TABLE runs ADD COLUMN token_usage_estimated boolean NOT NULL DEFAULT false;
