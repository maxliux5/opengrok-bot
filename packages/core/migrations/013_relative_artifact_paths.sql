UPDATE artifacts
SET storage_path = regexp_replace(storage_path, '^.*/artifacts/', '')
WHERE storage_path LIKE '/%/artifacts/%';
