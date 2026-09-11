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
import {
  createTeamKey as publishTeamKey,
  dropMyTeamKeyShare,
  fetchPlaintextAudit,
  fetchSessions,
  fetchTeamKey,
  putTeamKeyShares,
  sealAuditEntries,
  type AuditEvent,
} from "../lib/api";
import {
  createTeamKey,
  isAuditEnvelope,
  openAuditText,
  sealAuditText,
  teamPrivateKey,
  type Key,
} from "../lib/team-crypto";
import { fingerprint } from "../lib/vault-crypto";
import { keyTrust, knownKey, trustKey } from "../lib/known-keys";
import { teamKeyRefusal, teamKeyVerdict } from "../lib/team-trust";
import { useVault } from "./VaultProvider";

/**
 * The team audit key, as far as this browser holds it.
 *
 * "waiting" means the team has a key and nobody has sealed a copy to this
 * person yet; any teammate who opens shell.online does so. "ready" means a
 * copy was opened and checked: it came from a teammate whose vault key this
 * browser knows, and it is the private half of the key the team published.
 */
export type TeamKeyStatus = "idle" | "loading" | "waiting" | "ready" | "error";

interface Held {
  orgId: string;
  uid: string;
  version: number;
  publicKey: string;
  privateKey: Key;
}

interface TeamKeyValue {
  status: TeamKeyStatus;
  error: string;
  /** The team key's fingerprint, for comparing between teammates. */
  fingerprint: string;
  /** Who made the team's key. */
  createdBy: string | null;
  /** Seals one entry of typed input to the team key. Waits briefly for the key if it is on its way. */
  sealAudit(entry: { sessionId: string; kind: string; at: number; text: string }): Promise<string>;
  /**
   * The readable text of an audit entry: plain text as it is, sealed text
   * opened here. Null when this browser cannot open it.
   */
  openAudit(event: Pick<AuditEvent, "sessionId" | "kind" | "at" | "actorUid" | "text">): Promise<string | null>;
  refresh(): void;
}

/* How often a browser holding the key looks for teammates who need a copy. */
const REFRESH_MS = 60_000;
/* How long typed input waits for a key that is on its way before it is dropped. */
const WAIT_FOR_KEY_MS = 60_000;
/* History sealed per visit, in batches, so one visit cannot run forever. */
const HISTORY_BATCHES = 20;
const HISTORY_BATCH = 100;

const TeamKeyContext = createContext<TeamKeyValue | null>(null);

export function TeamKeyProvider({ children }: { children: ReactNode }) {
  const vault = useVault();
  const [status, setStatus] = useState<TeamKeyStatus>("idle");
  const [error, setError] = useState("");
  const [print, setPrint] = useState("");
  const [createdBy, setCreatedBy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const held = useRef<Held | null>(null);
  const waiting = useRef<((key: Held) => void)[]>([]);
  /* Read by the refresh loop without restarting it whenever the vault re-renders. */
  const vaultRef = useRef(vault);
  useEffect(() => {
    vaultRef.current = vault;
  }, [vault]);

  useEffect(() => {
    if (vault.status !== "unlocked") {
      held.current = null;
      setStatus("idle");
      return;
    }
    let live = true;

    async function run() {
      const own = vaultRef.current;
      if (!own.publicKey) return;
      let view = await fetchTeamKey();
      const { members } = await fetchSessions();
      if (!live) return;
      const { orgId, uid, role } = view.you;

      /*
       * Whether to believe what the service says about the team's key. A
       * browser that takes "there is none" at face value can be made to
       * generate a key and seal it to whatever public keys the service lists;
       * see team-trust.ts.
       */
      const teamName = `team:${orgId}`;
      const verdict = teamKeyVerdict(knownKey(uid, teamName), view.teamKey?.publicKey ?? null);
      if (verdict === "refuse-missing" || verdict === "refuse-changed") {
        held.current = null;
        if (live) {
          setError(teamKeyRefusal(verdict));
          setStatus("error");
        }
        return;
      }

      /*
       * The first member here with a vault makes the team's key, sealed to
       * everyone who has a vault. Making it is create-only on the service, so
       * of two members doing this at once, one wins and the other reads it.
       */
      if (verdict === "create") {
        const made = await createTeamKey();
        try {
          /*
           * A copy for this person first, from the key this browser checked
           * when it unlocked rather than from the roster: a roster that has
           * not caught up with a vault made a moment ago would otherwise
           * produce a team key its own maker cannot open.
           *
           * Teammates are sealed to only at a key this browser has not seen
           * change, and each is pinned as it is used. Sealing the team's key
           * to a swapped key would hand the whole log to whoever swapped it.
           */
          const recipients = [
            { uid, accountKey: own.publicKey },
            ...members
              .filter(
                (member) =>
                  member.accountKey &&
                  member.uid !== uid &&
                  keyTrust(uid, member.uid, member.accountKey) !== "changed",
              )
              .map((member) => ({ uid: member.uid, accountKey: member.accountKey as string })),
          ];
          const shares: { uid: string; sealed: string }[] = [];
          for (const member of recipients) {
            const sealed = await own.sealTeamKey(member, { orgId, version: 1 }, made.pkcs8);
            if (sealed) shares.push({ uid: member.uid, sealed });
          }
          await publishTeamKey(made.publicKey, shares).catch(() => undefined);
          for (const member of recipients) {
            if (member.uid !== uid) trustKey(uid, member.uid, member.accountKey);
          }
        } finally {
          made.pkcs8.fill(0);
        }
        view = await fetchTeamKey();
      }

      const teamKey = view.teamKey;
      if (!teamKey) throw new Error("The team's audit key could not be set up. Try again in a moment.");
      if (!live) return;
      setCreatedBy(teamKey.createdBy);
      setPrint(await fingerprint(teamKey.publicKey));
      const team = { orgId, version: teamKey.version };

      const share = view.share;
      if (!share || share.version !== teamKey.version) {
        held.current = null;
        if (live) setStatus("waiting");
        return;
      }

      /*
       * Only a copy from a teammate is opened, with the vault key this
       * browser knows for them. A sender who is not in the team, or whose key
       * changed since, is not believed: that is how a made-up team key from
       * the service would arrive.
       */
      const sender = members.find((member) => member.uid === share.senderUid);
      const senderKey = share.senderUid === uid ? own.publicKey : sender?.accountKey;
      const believable =
        Boolean(senderKey) &&
        (share.senderUid === uid || keyTrust(uid, share.senderUid, senderKey ?? "") !== "changed");
      const pkcs8 = believable && senderKey ? await own.openTeamKey(share, senderKey, team) : null;
      try {
        const privateKey = pkcs8 ? await teamPrivateKey(pkcs8, teamKey.publicKey) : null;
        if (!pkcs8 || !privateKey) {
          /*
           * A copy that will not open is dropped, so a teammate can seal a
           * fresh one: after a vault reset it was sealed to a key this person
           * no longer has.
           */
          await dropMyTeamKeyShare().catch(() => undefined);
          held.current = null;
          if (live) setStatus("waiting");
          return;
        }

        if (share.senderUid !== uid && senderKey) {
          trustKey(uid, share.senderUid, senderKey);
          /*
           * Sealed again to this person, by this person, so the copy no
           * longer depends on the teammate who sent it staying in the team:
           * a copy from someone who has left can no longer be checked.
           */
          const mine = await own.sealTeamKey({ uid, accountKey: own.publicKey }, team, pkcs8);
          if (mine) {
            await dropMyTeamKeyShare().catch(() => undefined);
            await putTeamKeyShares(team.version, [{ uid, sealed: mine }]).catch(() => undefined);
          }
        }

        /* Teammates with a vault and no copy get one, sealed by this vault. */
        const needing = view.missing.filter(
          (member) => member.uid !== uid && keyTrust(uid, member.uid, member.accountKey) !== "changed",
        );
        const shares: { uid: string; sealed: string }[] = [];
        for (const member of needing) {
          const sealed = await own.sealTeamKey(member, team, pkcs8);
          if (sealed) shares.push({ uid: member.uid, sealed });
        }
        if (shares.length > 0) {
          await putTeamKeyShares(team.version, shares).catch(() => undefined);
          for (const member of needing) trustKey(uid, member.uid, member.accountKey);
        }

        /*
         * Recorded now that a copy has proved to be the private half of the
         * key the team published. From here on, this browser refuses a
         * different key for this team, and refuses to make a second one; see
         * team-trust.ts.
         */
        trustKey(uid, teamName, teamKey.publicKey);
        const next: Held = { orgId, uid, version: team.version, publicKey: teamKey.publicKey, privateKey };
        held.current = next;
        for (const resolve of waiting.current.splice(0)) resolve(next);
        if (!live) return;
        setError("");
        setStatus("ready");
      } finally {
        pkcs8?.fill(0);
      }

      if (role === "owner" || role === "admin") await sealHistory(held.current);
    }

    if (!held.current) setStatus("loading");
    const tick = () =>
      void run().catch((caught) => {
        if (!live) return;
        setError(caught instanceof Error ? caught.message : "Could not reach the team's audit key.");
        if (!held.current) setStatus("error");
      });
    tick();
    const timer = window.setInterval(tick, REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [vault.status, attempt]);

  const sealAudit = useCallback(
    async (entry: { sessionId: string; kind: string; at: number; text: string }) => {
      const key =
        held.current ??
        (await new Promise<Held>((resolve, reject) => {
          waiting.current.push(resolve);
          window.setTimeout(() => reject(new Error("The team's audit key is not here yet.")), WAIT_FOR_KEY_MS);
        }));
      return sealAuditText(
        key.publicKey,
        key.version,
        { orgId: key.orgId, sessionId: entry.sessionId, kind: entry.kind, at: entry.at, actorUid: key.uid },
        entry.text,
      );
    },
    [],
  );

  const openAudit = useCallback(
    async (event: Pick<AuditEvent, "sessionId" | "kind" | "at" | "actorUid" | "text">) => {
      if (!isAuditEnvelope(event.text)) return event.text;
      const key = held.current;
      if (!key) return null;
      return openAuditText(
        key.privateKey,
        { orgId: key.orgId, sessionId: event.sessionId, kind: event.kind, at: event.at, actorUid: event.actorUid },
        event.text,
      );
    },
    [],
  );

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);

  const value = useMemo<TeamKeyValue>(
    () => ({ status, error, fingerprint: print, createdBy, sealAudit, openAudit, refresh }),
    [status, error, print, createdBy, sealAudit, openAudit, refresh],
  );

  return <TeamKeyContext.Provider value={value}>{children}</TeamKeyContext.Provider>;
}

/**
 * Seals entries recorded before the audit log was encrypted.
 *
 * An owner's or admin's browser does this, a batch at a time, whenever it
 * holds the key. Each entry is bound to the session, person and time the
 * service recorded for it, and the service replaces only entries that are
 * still plain text, so running it again, or from two browsers, changes nothing
 * twice.
 */
async function sealHistory(key: Held | null): Promise<void> {
  if (!key) return;
  try {
    for (let batch = 0; batch < HISTORY_BATCHES; batch += 1) {
      const { events } = await fetchPlaintextAudit(HISTORY_BATCH);
      if (events.length === 0) return;
      const entries: { id: string; text: string }[] = [];
      for (const event of events) {
        entries.push({
          id: event.id,
          text: await sealAuditText(
            key.publicKey,
            key.version,
            { orgId: key.orgId, sessionId: event.sessionId, kind: event.kind, at: event.at, actorUid: event.actorUid },
            event.text,
          ),
        });
      }
      await sealAuditEntries(entries);
      if (events.length < HISTORY_BATCH) return;
    }
  } catch {
    /* Carried on at the next refresh. */
  }
}

export function useTeamKey(): TeamKeyValue {
  const value = useContext(TeamKeyContext);
  if (!value) throw new Error("useTeamKey must be used inside a TeamKeyProvider.");
  return value;
}
