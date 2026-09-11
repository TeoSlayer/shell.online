import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "../auth/AuthProvider";
import { fetchSessions, fetchVault, saveVault, shareSessionKeys, type VaultRecord } from "../lib/api";
import {
  createVault,
  fingerprint,
  isVaultShare,
  openFromAccount,
  openVault,
  parseRecoveryKey,
  sealToAccount,
  VaultError,
  type OpenedVault,
  type SealedShare,
  type VaultBundle,
} from "../lib/vault-crypto";
import { clearLocalVault, loadLocalVault, saveLocalVault } from "../lib/vault-store";
import { openSealed } from "../lib/keypair";
import { openTeamKeyShare, sealTeamKeyShare, type TeamKeyContext } from "../lib/team-crypto";

/**
 * The signed-in person's session vault, and what is open in this browser.
 *
 * "setup" means the account has no vault yet; "locked" means it has one this
 * browser has not opened; "unlocked" means a key that opens it is held here.
 * Everything that reads or seals a session password goes through this, so
 * there is one place that decides which key is used for what.
 */
export type VaultStatus = "loading" | "setup" | "locked" | "unlocked" | "error";

/** A vault made in this browser and not yet handed to the service. */
export interface PreparedVault {
  bundle: VaultBundle;
  recoveryKey: string;
  opened: OpenedVault;
  /** The version a reset replaces. Absent when setting up the first vault. */
  replaces?: number;
}

interface VaultValue {
  status: VaultStatus;
  error: string;
  /**
   * The vault's public key as this browser verified it when unlocking, not as
   * the service last described it. This is what is handed to the CLI.
   */
  publicKey: string | null;
  /** A short form of the public key, for comparing with what the CLI prints. */
  fingerprint: string;
  /** False when this browser could not keep the unlocked vault, as in a private window. */
  remembered: boolean;
  /** The version on the service, when there is a vault at all. */
  version: number | null;
  prepare(reset: boolean): Promise<PreparedVault>;
  commit(prepared: PreparedVault): Promise<void>;
  unlock(recoveryKey: string): Promise<void>;
  retry(): void;
  /** Opens a password sealed to this person: to their vault, or to this browser's old key. */
  openShare(sessionId: string, share: SealedShare | undefined): Promise<string | null>;
  /** Seals a password to a colleague's vault. Null when they have none. */
  sealTo(
    recipient: { uid: string; accountKey?: string },
    sessionId: string,
    password: string,
  ): Promise<SealedShare | null>;
  /** Seals a password to this person's own vault and stores it. False when it could not. */
  keep(sessionId: string, password: string): Promise<boolean>;
  /** The signed-in person, whose vault this is. */
  uid: string;
  /** When this vault was made, from the service's record. */
  createdAt: number | null;
  /** Locks the vault in this browser. The vault itself is untouched. */
  lock(): Promise<void>;
  /**
   * Seals the team audit key's private half to a teammate, with this vault's
   * own key, so they can tell who sent it. Null while locked.
   */
  sealTeamKey(
    recipient: { uid: string; accountKey: string },
    team: TeamKeyContext,
    pkcs8: Uint8Array<ArrayBuffer>,
  ): Promise<string | null>;
  /** Opens a team audit key share sealed to this vault by the teammate it names. */
  openTeamKey(
    share: { senderUid: string; sealed: string },
    senderAccountKey: string,
    team: TeamKeyContext,
  ): Promise<Uint8Array<ArrayBuffer> | null>;
}

const VaultContext = createContext<VaultValue | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const uid = user?.uid ?? "";
  const [status, setStatus] = useState<VaultStatus>("loading");
  const [error, setError] = useState("");
  const [remote, setRemote] = useState<VaultRecord | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [print, setPrint] = useState("");
  const [remembered, setRemembered] = useState(true);
  const [attempt, setAttempt] = useState(0);
  /*
   * Read by the callbacks below rather than closed over, so that unlocking
   * does not hand every consumer new functions and tear down what they built
   * with the old ones, such as an open terminal.
   */
  const opened = useRef<OpenedVault | null>(null);

  const becomeUnlocked = useCallback(async (next: OpenedVault, kept: boolean) => {
    opened.current = next;
    setPublicKey(next.publicKey);
    setPrint(await fingerprint(next.publicKey));
    setRemembered(kept);
    setError("");
    setStatus("unlocked");
  }, []);

  useEffect(() => {
    opened.current = null;
    setPublicKey(null);
    if (!uid) {
      setStatus("loading");
      setRemote(null);
      return;
    }
    let live = true;
    setStatus("loading");
    void (async () => {
      try {
        const [{ vault }, local] = await Promise.all([fetchVault(), loadLocalVault(uid)]);
        if (!live) return;
        setRemote(vault);
        if (!vault) {
          if (local) await clearLocalVault(uid);
          setStatus("setup");
          return;
        }
        /*
         * Only a key this browser unlocked itself counts, and only for the
         * vault as it stands now. A reset elsewhere replaces the key pair, and
         * sealing to a stale one would make passwords nobody can open.
         */
        if (local && local.publicKey === vault.publicKey && local.version === vault.version) {
          await becomeUnlocked({ publicKey: local.publicKey, privateKey: local.privateKey }, true);
          return;
        }
        setStatus("locked");
      } catch (caught) {
        if (!live) return;
        setError(caught instanceof Error ? caught.message : "Could not reach your vault.");
        setStatus("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [uid, attempt, becomeUnlocked]);

  const prepare = useCallback(
    async (reset: boolean): Promise<PreparedVault> => {
      const made = await createVault(uid);
      return { ...made, replaces: reset && remote ? remote.version : undefined };
    },
    [uid, remote],
  );

  const commit = useCallback(
    async (prepared: PreparedVault) => {
      const previous = opened.current;
      let vault: VaultRecord | null;
      try {
        vault = (await saveVault(prepared.bundle, prepared.replaces)).vault;
      } catch (caught) {
        /*
         * Setting up is create-only on the service, so of two windows setting
         * up at once the second is refused. Rather than leave it at a dead
         * end, look again: in this browser the one that won is already
         * unlocked, and anywhere else it asks for that window's key.
         */
        const winner = prepared.replaces === undefined
          ? await fetchVault().then((result) => result.vault, () => null)
          : null;
        if (winner) {
          setAttempt((value) => value + 1);
          throw new VaultError(
            "damaged",
            "A vault was set up for this account in another window. Use the recovery key shown there.",
          );
        }
        throw caught;
      }
      /* The service answers with what it stored; it must be what was sent. */
      if (!vault || vault.publicKey !== prepared.bundle.publicKey) {
        throw new VaultError("damaged", "The vault that was saved is not the one made here. Reload and try again.");
      }
      setRemote(vault);
      const kept = await saveLocalVault({
        uid,
        publicKey: vault.publicKey,
        version: vault.version,
        privateKey: prepared.opened.privateKey,
      });
      await becomeUnlocked(prepared.opened, kept);

      /*
       * A reset made from a browser that still held the old vault can carry
       * the passwords of running sessions across: it opens each with the old
       * key and seals it to the new one. From anywhere else they are gone,
       * which is what losing a recovery key has to mean.
       */
      if (previous && prepared.replaces !== undefined) {
        await carryOver(uid, previous, prepared.opened);
      }
    },
    [uid, becomeUnlocked],
  );

  const unlock = useCallback(
    async (text: string) => {
      if (!remote) throw new VaultError("damaged", "There is no vault to unlock. Reload and try again.");
      const recovery = parseRecoveryKey(text);
      if (!recovery) {
        throw new VaultError(
          "wrong-recovery-key",
          "A recovery key is 32 letters and digits, in eight groups of four.",
        );
      }
      try {
        const next = await openVault(uid, remote, recovery);
        const kept = await saveLocalVault({
          uid,
          publicKey: next.publicKey,
          version: remote.version,
          privateKey: next.privateKey,
        });
        await becomeUnlocked(next, kept);
      } finally {
        recovery.fill(0);
      }
    },
    [uid, remote, becomeUnlocked],
  );

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const openShare = useCallback(
    async (sessionId: string, share: SealedShare | undefined) => {
      if (!share) return null;
      if (isVaultShare(share.sealed)) {
        const key = opened.current;
        return key ? openFromAccount(key.privateKey, sessionId, uid, share) : null;
      }
      /* Shared before the vault existed, to the key this browser had then. */
      return openSealed(share.senderPublicKey, share.sealed);
    },
    [uid],
  );

  const sealTo = useCallback(
    async (recipient: { uid: string; accountKey?: string }, sessionId: string, password: string) => {
      if (!recipient.accountKey) return null;
      return sealToAccount(recipient.accountKey, sessionId, recipient.uid, password);
    },
    [],
  );

  const keep = useCallback(
    async (sessionId: string, password: string) => {
      /* The key this browser verified when it unlocked, not one fetched since. */
      const key = opened.current;
      if (!key) return false;
      try {
        const share = await sealToAccount(key.publicKey, sessionId, uid, password);
        await shareSessionKeys(sessionId, [
          { uid, sender_public_key: share.senderPublicKey, sealed: share.sealed },
        ]);
        return true;
      } catch {
        return false;
      }
    },
    [uid],
  );

  const lock = useCallback(async () => {
    await clearLocalVault(uid);
    opened.current = null;
    setPublicKey(null);
    setStatus(remote ? "locked" : "setup");
  }, [uid, remote]);

  /*
   * The team audit key is sealed with this vault's own key rather than a
   * throwaway one, so whoever opens it can tell it came from this person.
   * See team-crypto.ts for why that matters.
   */
  const sealTeamKey = useCallback(
    async (recipient: { uid: string; accountKey: string }, team: TeamKeyContext, pkcs8: Uint8Array<ArrayBuffer>) => {
      const key = opened.current;
      if (!key) return null;
      return sealTeamKeyShare(
        key.privateKey,
        recipient.accountKey,
        { ...team, senderUid: uid, recipientUid: recipient.uid },
        pkcs8,
      );
    },
    [uid],
  );

  const openTeamKey = useCallback(
    async (share: { senderUid: string; sealed: string }, senderAccountKey: string, team: TeamKeyContext) => {
      const key = opened.current;
      if (!key) return null;
      return openTeamKeyShare(
        key.privateKey,
        senderAccountKey,
        { ...team, senderUid: share.senderUid, recipientUid: uid },
        share.sealed,
      );
    },
    [uid],
  );

  const value = useMemo<VaultValue>(
    () => ({
      status,
      error,
      publicKey,
      fingerprint: print,
      remembered,
      version: remote?.version ?? null,
      prepare,
      commit,
      unlock,
      retry,
      openShare,
      sealTo,
      keep,
      uid,
      createdAt: remote?.createdAt ?? null,
      lock,
      sealTeamKey,
      openTeamKey,
    }),
    [
      status, error, publicKey, print, remembered, remote, prepare, commit, unlock, retry,
      openShare, sealTo, keep, uid, lock, sealTeamKey, openTeamKey,
    ],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

async function carryOver(uid: string, previous: OpenedVault, next: OpenedVault): Promise<void> {
  try {
    const { sessions } = await fetchSessions();
    /* Finished sessions too: a persistent one comes back under the same password. */
    for (const session of sessions) {
      if (!session.keyShare) continue;
      const password = await openFromAccount(previous.privateKey, session.id, uid, session.keyShare);
      if (!password) continue;
      const share = await sealToAccount(next.publicKey, session.id, uid, password);
      await shareSessionKeys(session.id, [
        { uid, sender_public_key: share.senderPublicKey, sealed: share.sealed },
      ]);
    }
  } catch {
    /* Best effort. A session missed here still opens with `shell sessions`. */
  }
}

export function useVault(): VaultValue {
  const value = useContext(VaultContext);
  if (!value) throw new Error("useVault must be used inside a VaultProvider.");
  return value;
}
