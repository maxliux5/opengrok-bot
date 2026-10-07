ALTER TABLE approvals ADD COLUMN preview_artifact_id uuid REFERENCES artifacts(id);
ALTER TABLE approvals ADD COLUMN preview_width integer;
ALTER TABLE approvals ADD COLUMN preview_height integer;
