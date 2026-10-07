CREATE TABLE routines (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name text NOT NULL,
  time_zone text NOT NULL,
  local_time text NOT NULL,
  input_text text NOT NULL,
  deliverable text NOT NULL CHECK (deliverable IN ('answer','report')),
  budget_json jsonb NOT NULL,
  skill_id uuid REFERENCES skills(id) ON DELETE SET NULL,
  skill_version integer,
  status text NOT NULL CHECK (status IN ('active','paused')) DEFAULT 'active',
  next_fire_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (skill_id,skill_version) REFERENCES skill_versions(skill_id,version),
  CHECK ((skill_id IS NULL) = (skill_version IS NULL))
);
CREATE INDEX routines_due ON routines(next_fire_at,id) WHERE status='active';
CREATE INDEX routines_owner ON routines(owner_id,updated_at DESC);

CREATE TABLE routine_occurrences (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  routine_id uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  routine_name text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('scheduled','manual')),
  manual_request_id uuid,
  request_id uuid NOT NULL UNIQUE,
  conversation_id uuid NOT NULL UNIQUE,
  run_id uuid UNIQUE REFERENCES runs(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('pending','submitted','failed')) DEFAULT 'pending',
  input_text text NOT NULL,
  deliverable text NOT NULL CHECK (deliverable IN ('answer','report')),
  budget_json jsonb NOT NULL,
  skill_id uuid,
  skill_version integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,manual_request_id),
  FOREIGN KEY (skill_id,skill_version) REFERENCES skill_versions(skill_id,version),
  CHECK ((skill_id IS NULL) = (skill_version IS NULL))
);
CREATE INDEX routine_occurrences_pending ON routine_occurrences(created_at,id) WHERE status='pending';
CREATE INDEX routine_occurrences_history ON routine_occurrences(routine_id,scheduled_at DESC);
CREATE UNIQUE INDEX routine_occurrences_scheduled ON routine_occurrences(routine_id,scheduled_at)
  WHERE trigger='scheduled';
