-- Whether the account that did the thing was one of ours.
--
-- The statistics dashboard reports what customers did, and until now it could
-- not: app_events counted a machine linked by an end-to-end test exactly the
-- same as one linked by a customer, and the team's own accounts do far more in
-- the app than anybody else. Splitting the count by who did it is the only way
-- the totals can be read as product signal.
--
-- Rows written before this column existed cannot be split any more, so they
-- are attributed to us: the column arrives defaulting to TRUE, which backfills
-- what is already here, and then defaults to FALSE for everything written
-- afterwards. That way the change can only ever understate what customers did,
-- never overstate it, and no row is thrown away to get there.
ALTER TABLE app_events ADD COLUMN IF NOT EXISTS internal BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE app_events ALTER COLUMN internal SET DEFAULT FALSE;

-- (event, day) is no longer unique: the same kind on the same day now lands in
-- one row for us and one for everyone else.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index index_
    JOIN pg_class table_ ON table_.oid = index_.indrelid
    WHERE table_.relname = 'app_events' AND index_.indisprimary AND index_.indnatts = 3
  ) THEN
    ALTER TABLE app_events DROP CONSTRAINT IF EXISTS app_events_pkey;
    ALTER TABLE app_events ADD PRIMARY KEY (event, day, internal);
  END IF;
END $$;
