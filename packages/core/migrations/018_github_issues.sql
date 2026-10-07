CREATE TABLE github_issue_operations (
  operation_id uuid PRIMARY KEY REFERENCES tool_calls(operation_id) ON DELETE CASCADE,
  call_id uuid NOT NULL UNIQUE REFERENCES tool_calls(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository text NOT NULL,
  args_hash text NOT NULL,
  title text NOT NULL,
  body_sha256 text NOT NULL,
  status text NOT NULL CHECK (status IN ('dispatching', 'unknown', 'succeeded', 'failed')),
  result_json jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_issue_operations_run ON github_issue_operations(run_id, created_at);
