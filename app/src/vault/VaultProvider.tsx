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
import { openSessionContent, type SessionContent } from "../lib/session-content-crypto";
import { fetchSessions, fetchVault, saveVault, shareSessionKeys, updateVaultUnlocks, type VaultRecord } from "../lib/api";
import {
  addVaultPassword,
  createVault,
  fingerprint,
  isVaultShare,
  openFromAccount,
  openVault,
  openVaultWithPassword,
  parseRecoveryKey,
  sealToAccount,
  VaultError,
  type OpenedVault,
  type SealedShare,
  type VaultBundle,
  vaultUnlockMethods,
} from "../lib/vault-crypto";
import { registerVaultPasskey, unlockVaultWithPasskey } from "../lib/vault-passkey";
import { clearLocalVault, loadLocalVault, saveLocalVault } from "../lib/vault-store";
import { openSealed } from "../lib/keypair";
import { openTeamKeyShare, sealTeamKeyShare, type TeamKeyContext } from "../lib/team-crypto";
import { measureProductOperation } from "../../../web/posthog";

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
  prepare(reset: boolean, password: string): Promise<PreparedVault>;
  commit(prepared: PreparedVault): Promise<void>;
  unlock(recoveryKey: string): Promise<void>;
  unlockWithPassword(password: string): Promise<void>;
  unlockWithPasskey(): Promise<void>;
  setPassword(recoveryKey: string, password: string): Promise<void>;
  addPasskey(password: string, label?: string): Promise<void>;
  unlockMethods: { password: boolean; passkeys: { id: string; label: string }[] };
  retry(): void;
  /** Opens a password sealed to this person: to their vault, or to this browser's old key. */
  openShare(sessionId: string, share: SealedShare | undefined): Promise<string | null>;
  openContent(sessionId: string, envelope: SealedShare & {generation: string; observedAt: number}): Promise<SessionContent | null>;
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

  /*
   * Vault lifecycle guard. The generation bumps on lock, account change, and
   * key replacement. An async continuation captures the generation before its
   * first await and checks it after; a stale continuation never publishes.
   */
  const lifecycle = useRef<{ uid: string; generation: number }>({ uid, generation: 0 });
  const mounted = useRef(true);
  const preparedOwner = useRef(new WeakMap<PreparedVault, { uid: string; generation: number }>());

  /*
   * Render-phase UID boundary: if the account changed since the last render,
   * invalidate synchronously BEFORE children render. A passive effect runs
   * after children commit, which is too late for layout effects.
   */
  if (lifecycle.current.uid !== uid) {
    lifecycle.current = { uid, generation: lifecycle.current.generation + 1 };
    opened.current = null;
    setPublicKey(null);
    setPrint("");
    setRemembered(true);
    setError("");
    setStatus("loading");
    setRemote(null);
  }

  const becomeUnlocked = useCallback(async (next: OpenedVault, kept: boolean, gen?: number) => {
    const myGen = gen ?? lifecycle.current.generation;
    const fp = await fingerprint(next.publicKey);
    /* A lock or account change during the fingerprint await invalidates this. */
    if (lifecycle.current.generation !== myGen) return;
    /* Refuse before any allocation: a stale call must not install the key. */
    if (opened.current?.publicKey !== next.publicKey) {
      lifecycle.current.generation++;
    }
    opened.current = next;
    setPublicKey(next.publicKey);
    setPrint(fp);
    setRemembered(kept);
    setError("");
    setStatus("unlocked");
  }, []);

  /* Unmount: invalidate all pending continuations. */
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifecycle.current.generation++;
      opened.current = null;
    };
  }, []);

  useEffect(() => {
    /*
     * Synchronous invalidation: a new account (or unmount) clears the in-memory
     * key immediately so no in-flight continuation from the previous account
     * can publish. The generation bump makes every pending async check fail.
     */
    lifecycle.current = { uid, generation: lifecycle.current.generation + 1 };
    opened.current = null;
    setPublicKey(null);
    if (!uid) {
      setStatus("loading");
      setRemote(null);
      return;
    }
    let live = true;
    setStatus("loading");
    const gen = lifecycle.current.generation;
    void (async () => {
      try {
        const [{ vault }, local] = await Promise.all([fetchVault(), loadLocalVault(uid)]);
        if (!live || lifecycle.current.generation !== gen) return;
        setRemote(vault);
        if (!vault) {
          if (local) await clearLocalVault(uid);
          if (!live || lifecycle.current.generation !== gen) return;
          setStatus("setup");
          return;
        }
        /*
         * Only a key this browser unlocked itself counts, and only for the
         * vault as it stands now. A reset elsewhere replaces the key pair, and
         * sealing to a stale one would make passwords nobody can open.
         */
        if (local && local.publicKey === vault.publicKey && local.version === vault.version) {
          await becomeUnlocked({ publicKey: local.publicKey, privateKey: local.privateKey }, true, gen);
          return;
        }
        if (!live || lifecycle.current.generation !== gen) return;
        setStatus("locked");
      } catch (caught) {
        if (!live || lifecycle.current.generation !== gen) return;
        setError(caught instanceof Error ? caught.message : "Could not reach your vault.");
        setStatus("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [uid, attempt, becomeUnlocked]);

  const prepare = useCallback(
    async (reset: boolean, password: string): Promise<PreparedVault> => {
      if (!mounted.current || lifecycle.current.uid !== uid) throw new VaultError("damaged", "There is no vault to prepare. Reload and try again.");
      const gen = lifecycle.current.generation;
      const made = await createVault(uid, password);
      if (!mounted.current || lifecycle.current.uid !== uid || lifecycle.current.generation !== gen) throw new VaultError("damaged", "The vault preparation is stale. Try again.");
      const prepared: PreparedVault = { ...made, replaces: reset && remote ? remote.version : undefined };
      preparedOwner.current.set(prepared, { uid, generation: gen });
      return prepared;
    },
    [uid, remote],
  );

  const commit = useCallback(
    async (prepared: PreparedVault) => {
      if (!mounted.current || lifecycle.current.uid !== uid) return;
      const owner = preparedOwner.current.get(prepared);
      if (!owner || owner.uid !== uid || owner.generation !== lifecycle.current.generation) return;
      const previous = opened.current;
      const gen = lifecycle.current.generation;
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
        if (!mounted.current || lifecycle.current.uid !== uid || lifecycle.current.generation !== gen) throw caught;
        const winner = prepared.replaces === undefined
          ? await fetchVault().then((result) => result.vault, () => null)
          : null;
        if (winner) {
          if (!mounted.current || lifecycle.current.uid !== uid || lifecycle.current.generation !== gen) throw caught;
          setAttempt((value) => value + 1);
          throw new VaultError(
            "damaged",
            "A vault was set up for this account in another window. Use the recovery key shown there.",
          );
        }
        throw caught;
      }
      if (!mounted.current || lifecycle.current.generation !== gen) return;
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
      }, () => mounted.current && lifecycle.current.generation === gen);
      if (!mounted.current || lifecycle.current.generation !== gen) return;
      await becomeUnlocked(prepared.opened, kept, gen);

      /*
       * A reset made from a browser that still held the old vault can carry
       * the passwords of running sessions across: it opens each with the old
       * key and seals it to the new one. From anywhere else they are gone,
       * which is what losing a recovery key has to mean.
       * carryOver runs under the POST-install generation (becomeUnlocked
       * bumps on key replacement).
       */
      if (previous && prepared.replaces !== undefined) {
        const postGen = lifecycle.current.generation;
        await carryOver(uid, previous, prepared.opened, () => mounted.current && lifecycle.current.generation === postGen);
      }
    },
    [uid, becomeUnlocked],
  );

  const unlock = useCallback(
    async (text: string) => {
      if (!remote) throw new VaultError("damaged", "There is no vault to unlock. Reload and try again.");
      if (!mounted.current || lifecycle.current.uid !== uid) return;
      const recovery = parseRecoveryKey(text);
      if (!recovery) {
        throw new VaultError(
          "wrong-recovery-key",
          "A recovery key is 32 letters and digits, in eight groups of four.",
        );
      }
      const gen = lifecycle.current.generation;
      try {
        const next = await openVault(uid, remote, recovery);
        if (!mounted.current || lifecycle.current.generation !== gen) return;
        const kept = await saveLocalVault({
          uid,
          publicKey: next.publicKey,
          version: remote.version,
          privateKey: next.privateKey,
        }, () => mounted.current && lifecycle.current.generation === gen);
        if (!mounted.current || lifecycle.current.generation !== gen) return;
        await becomeUnlocked(next, kept, gen);
      } finally {
        recovery.fill(0);
      }
    },
    [uid, remote, becomeUnlocked],
  );

  const keepOpened = useCallback(async (next: OpenedVault, gen?: number) => {
    if (!remote) throw new VaultError("damaged", "There is no vault to unlock. Reload and try again.");
    if (!mounted.current || lifecycle.current.uid !== uid) return;
    const myGen = gen ?? lifecycle.current.generation;
    const kept = await saveLocalVault({
      uid,
      publicKey: next.publicKey,
      version: remote.version,
      privateKey: next.privateKey,
    }, () => mounted.current && lifecycle.current.generation === myGen);
    if (!mounted.current || lifecycle.current.generation !== myGen) return;
    await becomeUnlocked(next, kept, myGen);
  }, [uid, remote, becomeUnlocked]);

  const unlockWithPassword = useCallback(async (password: string) => {
    if (!remote) throw new VaultError("damaged", "There is no vault to unlock. Reload and try again.");
    if (!mounted.current || lifecycle.current.uid !== uid) return;
    const gen = lifecycle.current.generation;
    const next = await openVaultWithPassword(uid, remote, password);
    if (!mounted.current || lifecycle.current.generation !== gen) return;
    await keepOpened(next, gen);
  }, [uid, remote, keepOpened]);

  const unlockWithPasskey = useCallback(async () => {
    if (!remote) throw new VaultError("damaged", "There is no vault to unlock. Reload and try again.");
    if (!mounted.current || lifecycle.current.uid !== uid) return;
    const gen = lifecycle.current.generation;
    const next = await unlockVaultWithPasskey(uid, remote);
    if (!mounted.current || lifecycle.current.generation !== gen) return;
    await keepOpened(next, gen);
  }, [uid, remote, keepOpened]);

  const setPassword = useCallback(async (recoveryKey: string, password: string) => {
    if (!remote) throw new VaultError("damaged", "There is no vault to update. Reload and try again.");
    if (!mounted.current || lifecycle.current.uid !== uid) return;
    const gen = lifecycle.current.generation;
    const recoveryWrap = await addVaultPassword(uid, remote, recoveryKey, password);
    if (!mounted.current || lifecycle.current.generation !== gen) return;
    const saved = (await updateVaultUnlocks(recoveryWrap, remote.version)).vault;
    if (!saved) throw new Error("The vault update did not return a vault.");
    if (!mounted.current || lifecycle.current.generation !== gen) return;
    setRemote(saved);
    const next = await openVaultWithPassword(uid, saved, password);
    if (!mounted.current || lifecycle.current.generation !== gen) return;
    await keepOpened(next, gen);
  }, [uid, remote, keepOpened]);

  const addPasskey = useCallback(async (password: string, label = "Passkey") => {
    if (!remote) throw new VaultError("damaged", "There is no vault to update. Reload and try again.");
    if (!mounted.current || lifecycle.current.uid !== uid) return;
    const gen = lifecycle.current.generation;
    const recoveryWrap = await registerVaultPasskey(uid, user?.email ?? uid, remote, password, label);
    if (!mounted.current || lifecycle.current.generation !== gen) return;
    const saved = (await updateVaultUnlocks(recoveryWrap, remote.version)).vault;
    if (!saved) throw new Error("The vault update did not return a vault.");
    if (!mounted.current || lifecycle.current.generation !== gen) return;
    setRemote(saved);
  }, [uid, user?.email, remote]);

  const retry = useCallback(() => {
    if (!mounted.current || lifecycle.current.uid !== uid) return;
    setAttempt((value) => value + 1);
  }, [uid]);

  const openShare = useCallback(
    async (sessionId: string, share: SealedShare | undefined) => {
      if (!share) return null;
      if (!mounted.current || lifecycle.current.uid !== uid) return null;
      if (isVaultShare(share.sealed)) {
        const key = opened.current;
        if (!key) return null;
        const gen = lifecycle.current.generation;
        const value = await openFromAccount(key.privateKey, sessionId, uid, share);
        /* A lock or account change during the decrypt invalidates the result. */
        return opened.current === key && lifecycle.current.generation === gen ? value : null;
      }
      /* Shared before the vault existed, to the key this browser had then. */
      const gen = lifecycle.current.generation;
      const value = await openSealed(share.senderPublicKey, share.sealed);
      return lifecycle.current.generation === gen ? value : null;
    },
    [uid],
  );

  const openContent = useCallback(async (sessionId: string, envelope: SealedShare & {generation: string; observedAt: number}) => {
    if (!mounted.current || lifecycle.current.uid !== uid) return null;
    const key = opened.current;
    if (!key) return null;
    const gen = lifecycle.current.generation;
    const value = await openSessionContent(key.privateKey, sessionId, uid,
      envelope.generation, envelope.observedAt, envelope);
    return opened.current === key && lifecycle.current.generation === gen ? value : null;
  }, [uid]);

  const sealTo = useCallback(
    async (recipient: { uid: string; accountKey?: string }, sessionId: string, password: string) => {
      if (!recipient.accountKey) return null;
      if (!mounted.current || lifecycle.current.uid !== uid) return null;
      const uidAtEntry = uid;
      const gen = lifecycle.current.generation;
      const result = await sealToAccount(recipient.accountKey, sessionId, recipient.uid, password);
      return lifecycle.current.uid === uidAtEntry && lifecycle.current.generation === gen ? result : null;
    },
    [uid],
  );

  const keep = useCallback(
    async (sessionId: string, password: string) => {
      /* The key this browser verified when it unlocked, not one fetched since. */
      if (!mounted.current || lifecycle.current.uid !== uid) return false;
      const key = opened.current;
      if (!key) return false;
      const gen = lifecycle.current.generation;
      try {
        const share = await sealToAccount(key.publicKey, sessionId, uid, password);
        if (lifecycle.current.generation !== gen || opened.current !== key) return false;
        await shareSessionKeys(sessionId, [
          { uid, sender_public_key: share.senderPublicKey, sealed: share.sealed },
        ]);
        return lifecycle.current.generation === gen && opened.current === key;
      } catch {
        return false;
      }
    },
    [uid],
  );

  const lock = useCallback(async () => {
    if (!mounted.current || lifecycle.current.uid !== uid) return;
    /*
     * Synchronous invalidation first: the in-memory key is gone before any
     * await, so a stale unlock continuation that resolves after this point
     * sees the bumped generation and does not republish.
     */
    lifecycle.current.generation++;
    opened.current = null;
    setPublicKey(null);
    setPrint("");
    setStatus(remote ? "locked" : "setup");
    await clearLocalVault(uid);
  }, [uid, remote]);

  /*
   * The team audit key is sealed with this vault's own key rather than a
   * throwaway one, so whoever opens it can tell it came from this person.
   * See team-crypto.ts for why that matters.
   */
  const sealTeamKey = useCallback(
    async (recipient: { uid: string; accountKey: string }, team: TeamKeyContext, pkcs8: Uint8Array<ArrayBuffer>) => {
      if (!mounted.current || lifecycle.current.uid !== uid) return null;
      const key = opened.current;
      if (!key) return null;
      const gen = lifecycle.current.generation;
      const result = await sealTeamKeyShare(
        key.privateKey,
        recipient.accountKey,
        { ...team, senderUid: uid, recipientUid: recipient.uid },
        pkcs8,
      );
      return lifecycle.current.generation === gen && opened.current === key ? result : null;
    },
    [uid],
  );

  const openTeamKey = useCallback(
    async (share: { senderUid: string; sealed: string }, senderAccountKey: string, team: TeamKeyContext) => {
      if (!mounted.current || lifecycle.current.uid !== uid) return null;
      const key = opened.current;
      if (!key) return null;
      const gen = lifecycle.current.generation;
      const result = await openTeamKeyShare(
        key.privateKey,
        senderAccountKey,
        { ...team, senderUid: share.senderUid, recipientUid: uid },
        share.sealed,
      );
      return lifecycle.current.generation === gen && opened.current === key ? result : null;
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
      commit: (prepared) => measureProductOperation("vault_create", () => commit(prepared)),
      unlock: (key) => measureProductOperation("vault_unlock_recovery", () => unlock(key)),
      unlockWithPassword: (password) => measureProductOperation("vault_unlock_password", () => unlockWithPassword(password)),
      unlockWithPasskey: () => measureProductOperation("vault_unlock_passkey", unlockWithPasskey),
      setPassword: (key, password) => measureProductOperation("vault_password", () => setPassword(key, password)),
      addPasskey: (password, label) => measureProductOperation("vault_passkey", () => addPasskey(password, label)),
      unlockMethods: remote ? vaultUnlockMethods(remote) : { password: false, passkeys: [] },
      retry,
      openShare,
      openContent,
      sealTo,
      keep,
      uid,
      createdAt: remote?.createdAt ?? null,
      lock: () => measureProductOperation("vault_lock", lock),
      sealTeamKey,
      openTeamKey,
    }),
    [
      status, error, publicKey, print, remembered, remote, prepare, commit, unlock,
      unlockWithPassword, unlockWithPasskey, setPassword, addPasskey, retry,
      openShare, openContent, sealTo, keep, uid, lock, sealTeamKey, openTeamKey,
    ],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

async function carryOver(uid: string, previous: OpenedVault, next: OpenedVault, isCurrent?: () => boolean): Promise<void> {
  try {
    const { sessions } = await fetchSessions();
    if (isCurrent && !isCurrent()) return;
    /* Finished sessions too: a persistent one comes back under the same password. */
    for (const session of sessions) {
      if (!session.keyShare) continue;
      const password = await openFromAccount(previous.privateKey, session.id, uid, session.keyShare);
      if (!password) continue;
      const share = await sealToAccount(next.publicKey, session.id, uid, password);
      if (isCurrent && !isCurrent()) return;
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
