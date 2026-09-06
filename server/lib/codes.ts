import type { Store } from "./store";
import { CODE_TTL_MS, mintSecret } from "./tokens";
import { verifyChallenge } from "./pkce";

export function issueCode(
  store: Store,
  input: {
    uid: string;
    email: string;
    name: string;
    codeChallenge: string;
    redirectUri: string;
  },
  now = Date.now(),
): string {
  const code = mintSecret("shc");
  store.putCode({ code, ...input, expiresAt: now + CODE_TTL_MS });
  return code;
}

export type CodeExchange =
  | { ok: true; uid: string; email: string; name: string }
  | { ok: false; reason: "unknown" | "replayed" | "expired" | "challenge" | "redirect" };

export function exchangeCode(
  store: Store,
  input: { code: string; verifier: string; redirectUri: string },
  now = Date.now(),
): CodeExchange {
  const taken = store.takeCode(input.code, now);
  if (!taken) return { ok: false, reason: "unknown" };
  if (taken.alreadyConsumed) return { ok: false, reason: "replayed" };

  const { entry } = taken;
  if (entry.expiresAt <= now) return { ok: false, reason: "expired" };
  if (entry.redirectUri !== input.redirectUri) return { ok: false, reason: "redirect" };
  if (!verifyChallenge(input.verifier, entry.codeChallenge)) {
    return { ok: false, reason: "challenge" };
  }
  return { ok: true, uid: entry.uid, email: entry.email, name: entry.name };
}
