CREATE TABLE skills (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skills_owner ON skills(owner_id, updated_at DESC);

CREATE TABLE skill_versions (
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  summary text NOT NULL,
  input_guide text NOT NULL,
  steps jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
  verification text NOT NULL,
  required_capabilities jsonb NOT NULL CHECK (jsonb_typeof(required_capabilities) = 'array'),
  source_run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(skill_id, version)
);

CREATE TABLE bot_skills (
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  bound_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(bot_id, skill_id)
);
CREATE INDEX bot_skills_skill ON bot_skills(skill_id);

CREATE TABLE run_skill_versions (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id, skill_id),
  FOREIGN KEY (skill_id, version) REFERENCES skill_versions(skill_id, version) ON DELETE RESTRICT
);
