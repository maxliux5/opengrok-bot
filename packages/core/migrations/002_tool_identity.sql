ALTER TABLE tool_calls ADD COLUMN ordinal integer NOT NULL DEFAULT 0;
ALTER TABLE tool_calls ADD CONSTRAINT tool_calls_step_ordinal UNIQUE(step_id, ordinal);
ALTER TABLE memory_entries ADD COLUMN operation_id uuid UNIQUE;
