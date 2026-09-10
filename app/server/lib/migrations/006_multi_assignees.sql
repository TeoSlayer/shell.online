-- Responsibility can be shared. Keep assignee_uid populated as the first
-- assignee so a previous Worker remains safe to roll back to.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS assignee_uids TEXT[];

UPDATE sessions
SET assignee_uids = CASE
  WHEN assignee_uid IS NULL THEN '{}'
  ELSE ARRAY[assignee_uid]
END
WHERE assignee_uids IS NULL;

ALTER TABLE sessions ALTER COLUMN assignee_uids SET DEFAULT '{}';
ALTER TABLE sessions ALTER COLUMN assignee_uids SET NOT NULL;
