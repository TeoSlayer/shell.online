import {useEffect, useState} from "react";
import {request, type SessionRecord} from "./api";
import {useVault} from "../vault/VaultProvider";
import type {SessionContent} from "./session-content-crypto";

type Envelope = {generation:string;observedAt:number;senderPublicKey:string;sealed:string};
export function contentEligible(session: SessionRecord, uid: string): boolean {
  return !!uid && (session.ownerUid ?? session.uid) === uid && session.dailyBriefingEnabled === true;
}
export function withSessionContent(session: SessionRecord, content?: SessionContent): SessionRecord {
  if (!content) return session;
  return {...session, suggestedTitle:content.suggestedTitle, description:content.description,
    contentObservedAt:content.observedAt, contentSource:content.source};
}

/** Decryption is scoped to this mounted page and unlocked owner vault. No persistence. */
export function useSessionContents(sessions: readonly SessionRecord[] | null) {
  const vault = useVault();
  const eligible = (sessions ?? []).filter(s => contentEligible(s, vault.uid)).slice(0, 32);
  const scope = JSON.stringify([vault.uid, vault.status, vault.version, vault.publicKey,
    eligible.map(s => [s.id, s.keyShare?.senderPublicKey ?? "", s.keyShare?.sealed ?? "", s.shareUrl])]);
  const [result, setResult] = useState<{scope:string;values:Record<string,SessionContent>}>({scope:"",values:{}});
  useEffect(() => {
    if (vault.status !== "unlocked" || !eligible.length) { setResult({scope,values:{}}); return; }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const ids = eligible.map(s=>s.id);
    const update = async () => {
      const values: Record<string,SessionContent> = {};
      for(let offset=0; offset<ids.length && !disposed; offset+=4) {
        await Promise.all(ids.slice(offset,offset+4).map(async id => {
          try {
            const envelope=await request<Envelope>(`/api/sessions/${encodeURIComponent(id)}/content`,{signal:abort.signal});
            const content=await vault.openContent(id,envelope);
            if(content&&!disposed) values[id]=content;
          } catch { /* Unavailable, revoked, locked, or unsupported: never fall back to plaintext. */ }
        }));
      }
      if (!disposed) { setResult({scope,values}); timer=setTimeout(update,60_000); }
    };
    void update();
    return () => { disposed=true; abort.abort(); if(timer)clearTimeout(timer); };
    // Stable scope includes every permission/key/session input. Polling does not
    // restart merely because the ordinary session list returns new objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, vault.openContent]);
  return result.scope === scope && vault.status === "unlocked" ? result.values : {};
}
