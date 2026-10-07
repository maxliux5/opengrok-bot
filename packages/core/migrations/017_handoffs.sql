ALTER TABLE runs ADD COLUMN parent_run_id uuid REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN root_run_id uuid REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN delegation_depth integer NOT NULL DEFAULT 0 CHECK (delegation_depth BETWEEN 0 AND 2);
ALTER TABLE runs ADD COLUMN delegation_operation_id uuid UNIQUE;
ALTER TABLE runs ADD COLUMN delegation_args_hash text;
ALTER TABLE runs ADD COLUMN delegation_source text CHECK (delegation_source IN ('user', 'agent'));
ALTER TABLE runs ADD COLUMN handoff_task text;
ALTER TABLE runs ADD COLUMN handoff_acceptance text;
CREATE INDEX runs_parent ON runs(parent_run_id, created_at, id);
CREATE INDEX runs_root ON runs(root_run_id, created_at, id);

CREATE TABLE run_handoff_artifacts (
  child_run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  PRIMARY KEY (child_run_id, artifact_id)
);
