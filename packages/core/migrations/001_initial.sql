CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_owner ON sessions(owner_id);

CREATE TABLE model_profiles (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openai-compatible', 'anthropic')),
  model_id text NOT NULL,
  base_url text,
  encrypted_api_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bots (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  model_profile_id uuid REFERENCES model_profiles(id) ON DELETE SET NULL,
  expected_artifact boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bots_owner ON bots(owner_id, updated_at DESC);

CREATE TABLE bot_execution_slots (
  bot_id uuid PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  active_run_id uuid,
  revision bigint NOT NULL DEFAULT 0
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '新对话',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_bot ON conversations(bot_id, updated_at DESC);

CREATE TABLE runs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  model_profile_id uuid REFERENCES model_profiles(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN (
    'queued', 'running', 'waiting_approval', 'waiting_user', 'waiting_computer',
    'reconciling', 'verifying', 'canceling', 'succeeded', 'failed', 'canceled'
  )),
  input_revision integer NOT NULL DEFAULT 0,
  consumed_input_sequence integer NOT NULL DEFAULT 0,
  event_sequence bigint NOT NULL DEFAULT 0,
  lease_owner text,
  lease_until timestamptz,
  lease_epoch bigint NOT NULL DEFAULT 0,
  next_wake_at timestamptz NOT NULL DEFAULT now(),
  cancel_requested boolean NOT NULL DEFAULT false,
  result_text text,
  error text,
  unresolved_effects jsonb NOT NULL DEFAULT '[]'::jsonb,
  tool_count integer NOT NULL DEFAULT 0,
  token_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_claim ON runs(status, next_wake_at, lease_until, created_at);
CREATE INDEX runs_conversation ON runs(conversation_id, created_at DESC);
ALTER TABLE bot_execution_slots ADD CONSTRAINT slot_active_run_fk
  FOREIGN KEY (active_run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation ON messages(conversation_id, created_at, id);

CREATE TABLE run_inputs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  message_id uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  client_request_id uuid NOT NULL,
  sequence integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, client_request_id),
  UNIQUE(run_id, sequence)
);

CREATE TABLE run_events (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id, sequence)
);

CREATE TABLE model_steps (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  input_revision integer NOT NULL,
  model_profile_id uuid REFERENCES model_profiles(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('started', 'completed', 'interrupted', 'obsolete')),
  input_snapshot jsonb NOT NULL,
  output_snapshot jsonb,
  usage_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(run_id, ordinal)
);

CREATE TABLE tool_calls (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES model_steps(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL UNIQUE,
  name text NOT NULL,
  args jsonb NOT NULL,
  args_hash text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'proposed', 'waiting_approval', 'authorized', 'dispatching',
    'succeeded', 'failed', 'unknown'
  )),
  replay_policy text NOT NULL CHECK (replay_policy IN (
    'idempotent', 'reconcile_before_retry', 'manual_only'
  )),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_calls_run ON tool_calls(run_id, created_at);

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  call_id uuid NOT NULL UNIQUE REFERENCES tool_calls(id) ON DELETE CASCADE,
  target text NOT NULL,
  args_hash text NOT NULL,
  context_version integer NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_owner ON approvals(owner_id, status, created_at DESC);

CREATE TABLE memory_entries (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('preference', 'fact', 'summary')),
  content text NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'accepted', 'deleted')),
  revision integer NOT NULL DEFAULT 1,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_read ON memory_entries(owner_id, bot_id, status, updated_at DESC);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  title text NOT NULL,
  mime_type text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_path text NOT NULL,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_run ON artifacts(run_id, created_at DESC);
