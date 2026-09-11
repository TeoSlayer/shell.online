-- Accounts deleted in the last two hours.
--
-- A browser still signed in to an account that has just been deleted holds a
-- Firebase ID token that verifies for up to an hour. Any request it makes in
-- that time finds no membership, and without this the service would create a
-- new team for a person who asked to be removed. Only the uid is kept, and
-- only as long as such a token can live, with slack; purging drops it after.
CREATE TABLE IF NOT EXISTS deleted_accounts (
  uid         TEXT   PRIMARY KEY,
  deleted_at  BIGINT NOT NULL
);
