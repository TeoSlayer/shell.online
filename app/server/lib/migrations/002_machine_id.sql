-- A stable identifier for the machine a CLI login came from.
--
-- Without it every `shell login` records another device, so running it three
-- times on one laptop leaves three identical entries in the account's machine
-- list. With it, a repeat login finds the row that machine already has and
-- rotates that one instead.
--
-- Nullable, because rows written before this column existed name no machine,
-- and a CLI that cannot record an identifier still signs in. NULL never equals
-- NULL in a lookup, so both keep the older behaviour of a device per login
-- rather than colliding with each other.
ALTER TABLE cli_tokens ADD COLUMN IF NOT EXISTS machine_id TEXT;

-- The only read is "the live device this account has for this machine", so the
-- index carries both halves of that scope. Partial on the live rows: revoked
-- ones are never a match -- unlinking a machine must not be undone by signing
-- in on it again -- and leaving them out keeps the index the size of the
-- device lists people actually have.
CREATE INDEX IF NOT EXISTS cli_tokens_machine
  ON cli_tokens (uid, machine_id)
  WHERE machine_id IS NOT NULL AND revoked_at IS NULL;
