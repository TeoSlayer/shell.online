import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHistory } from "./chat-history";
import { Transcript, plainLine } from "./transcript";

// Only storage scheduling is faked. Real WebCrypto verifies the cache keys and
// ciphertext, and commits can be held independently of request success.
let rows: Map<string, unknown>;
let commits: (() => void)[];
let holdCommits: boolean;
let reads: number;
const caches: ChatHistory[] = [];

function request(result: unknown) {
  const req = { result, onsuccess: null as null | (() => void) };
  queueMicrotask(() => req.onsuccess?.());
  return req;
}

beforeEach(() => {
  rows = new Map(); commits = []; reads = 0; holdCommits = false;
  vi.stubGlobal("indexedDB", {
    open: () => request({
      close() {},
      transaction() {
        const transaction = {
          oncomplete: null as null | (() => void),
          objectStore: () => ({
            get(key: string) { reads++; return request(rows.get(key)); },
            put(row: { sessionId: string }) {
              const saved = structuredClone(row);
              const req = request(row.sessionId);
              const commit = () => { rows.set(row.sessionId, saved); transaction.oncomplete?.(); };
              if (holdCommits) commits.push(commit);
              else queueMicrotask(commit);
              return req;
            },
          }),
        };
        return transaction;
      },
    }),
  });
});
afterEach(() => { for (const cache of caches.splice(0)) cache.dispose(); vi.unstubAllGlobals(); });

function cache(id: string, secret: string | null = null) {
  const value = new ChatHistory(id, secret); caches.push(value); return value;
}
function messages(text: string) {
  const transcript = new Transcript();
  transcript.output([plainLine(text), plainLine("")], 1);
  return transcript.messages;
}

describe("device history across renderer replacement", () => {
  it("waits for an outgoing renderer's transaction to commit before loading", async () => {
    holdCommits = true;
    const before = cache("replace");
    before.save(messages("last answer"));
    const saved = before.flush();
    await vi.waitFor(() => expect(commits).toHaveLength(1));
    const loaded = cache("replace").load();
    // Let all queued request microtasks finish. One Promise.resolve() only
    // reached database-open and could let the old implementation pass by luck.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(reads).toBe(0);
    commits.shift()!();
    await saved;
    expect((await loaded)?.[0].lines[0].text).toBe("last answer");
  });

  it("serializes overlapping writes and captures each snapshot before waiting", async () => {
    holdCommits = true;
    const first = cache("ordered");
    const data = messages("first");
    first.save(data);
    const savingFirst = first.flush();
    data[0].lines[0].text = "mutated after save";
    const second = cache("ordered");
    second.save(messages("second"));
    const savingSecond = second.flush();
    await vi.waitFor(() => expect(commits).toHaveLength(1));
    commits.shift()!();
    await savingFirst;
    expect((rows.get("ordered") as {plain: string}).plain).toContain('"text":"first"');
    await vi.waitFor(() => expect(commits).toHaveLength(1));
    commits.shift()!();
    await savingSecond;
    expect((await second.load())?.[0].lines[0].text).toBe("second");
  });

  it("encrypts history and isolates other sessions and secrets", async () => {
    const first = cache("encrypted", "secret-one");
    first.save(messages("private answer"));
    await first.flush();
    expect((rows.get("encrypted") as {plain?: string}).plain).toBeUndefined();
    expect((await first.load())?.[0].lines[0].text).toBe("private answer");
    expect(await cache("encrypted", "secret-two").load()).toBeNull();
    expect(await cache("different-session", "secret-one").load()).toBeNull();
  });

  it("treats malformed cache data as absent so live output can start", async () => {
    rows.set("broken", {plain: JSON.stringify([{id: 1, lines: null}])});
    expect(await cache("broken").load()).toBeNull();
  });
});
