-- A person's session vault.
--
-- Every session password is sealed to one key pair per account, so it outlives
-- the browser that first held it. The public key is what colleagues and the
-- CLI seal to. The private key is kept here only encrypted under a vault key,
-- and the vault key only wrapped under a recovery key this service never
-- receives. None of these columns opens anything by itself.
--
-- `version` counts resets. A reset replaces the key pair outright, and the
-- version is how a write says which vault it means to replace.
CREATE TABLE IF NOT EXISTS account_keys (
  uid                    TEXT    PRIMARY KEY,
  public_key             TEXT    NOT NULL,
  encrypted_private_key  TEXT    NOT NULL,
  recovery_wrap          TEXT    NOT NULL,
  version                INTEGER NOT NULL,
  created_at             BIGINT  NOT NULL,
  updated_at             BIGINT  NOT NULL
);
