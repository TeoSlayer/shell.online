import {useEffect, useState} from "react";
import {request, type SessionRecord} from "./api";
import {useVault} from "../vault/VaultProvider";
import type {SessionSummary} from "./session-summary-crypto";

type Envelope = {generation:string;observedAt:number;senderPublicKey:string;sealed:string};

export function summaryEligible(session: SessionRecord, uid: string): boolean {
  return !!uid && (session.ownerUid ?? session.uid) === uid && session.summariesEnabled === true;
}

/*
 * Reads summaries the host or the attested summarizer already published. It
 * never asks for one to be generated: hovering a row must not cause work, cost
 * or a request that reveals what someone looked at. Decryption is scoped to
 * this mounted page and the unlocked owner vault; nothing is persisted.
 */
export function useSessionSummaries(sessions: readonly SessionRecord[] | null) {
  const vault = useVault();
  const eligible = (sessions ?? []).filter(s => summaryEligible(s, vault.uid)).slice(0, 32);
  const scope = JSON.stringify([vault.uid, vault.status, vault.version, vault.publicKey,
    eligible.map(s => [s.id, s.shareUrl])]);
  const [result, setResult] = useState<{scope:string;values:Record<string,SessionSummary>}>({scope:"",values:{}});
  useEffect(() => {
    if (vault.status !== "unlocked" || !eligible.length) { setResult({scope,values:{}}); return; }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const ids = eligible.map(s=>s.id);
    const update = async () => {
      const values: Record<string,SessionSummary> = {};
      for(let offset=0; offset<ids.length && !disposed; offset+=4) {
        await Promise.all(ids.slice(offset,offset+4).map(async id => {
          try {
            const envelope=await request<Envelope>(`/api/sessions/${encodeURIComponent(id)}/summary`,{signal:abort.signal});
            const summary=await vault.openSummary(id,envelope);
            if(summary&&!disposed) values[id]=summary;
          } catch { /* Unavailable, revoked, locked or rejected by the guard: show nothing. */ }
        }));
      }
      if (!disposed) { setResult({scope,values}); timer=setTimeout(update,60_000); }
    };
    void update();
    return () => { disposed=true; abort.abort(); if(timer)clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, vault.openSummary]);
  return result.scope === scope && vault.status === "unlocked" ? result.values : {};
}
