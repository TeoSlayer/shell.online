import { describe, expect, test, vi } from "vitest";
import { Opcode } from "../shared/protocol";
import { RelayFileClient } from "../web/relay-files";
import * as analytics from "../web/posthog";

const control = (value: unknown) => {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(body.length + 2);
  frame[0] = Opcode.FileResponse;
  frame[1] = 1;
  frame.set(body, 2);
  return frame;
};

describe("relay-backed files", () => {
  test.each(["complete", "body_cancel", "abort", "error"])("records actual transfer settlement, not successful metadata: %s", async (mode) => {
    const ends: Array<{ operation: string; outcomes: string[] }> = [];
    const spy = vi.spyOn(analytics, "beginProductOperation").mockImplementation(operation => {
      const row = { operation, outcomes: [] as string[] }; ends.push(row);
      return outcome => { row.outcomes.push(outcome); };
    });
    const sent: Uint8Array[] = [], client = new RelayFileClient(frame => sent.push(frame));
    const take = () => JSON.parse(new TextDecoder().decode(sent.shift()!.subarray(1)));
    try {
      client.probe(); client.handle(control({ id: take().id, type: "capabilities", root: "PRIVATE_ROOT" }));
      const abort = new AbortController();
      const resource = client.resolve("PRIVATE_FILE", { purpose: "download", signal: abort.signal });
      const id = take().id;
      client.handle(control({ id, type: "meta", name: "PRIVATE_NAME", size: 0, mimeType: "text/plain", token: "PRIVATE_TOKEN" }));
      const file = await resource;
      expect(ends).toEqual([{ operation: "file_download", outcomes: [] }]);
      if (mode === "body_cancel") await file!.body.cancel();
      else if (mode === "abort") abort.abort();
      else if (mode === "error") client.handle(control({ id, type: "error", message: "PRIVATE_ERROR" }));
      else {
        const chunk = new Uint8Array(15), view = new DataView(chunk.buffer);
        chunk[0] = Opcode.FileResponse; chunk[1] = 2; chunk[14] = 1; view.setUint32(2, id);
        client.handle(chunk); client.handle(chunk);
      }
      expect(ends[0].outcomes).toEqual([mode === "complete" ? "ok" : mode === "error" ? "failed" : "cancelled"]);
      expect(JSON.stringify(ends)).not.toContain("PRIVATE_");
      client.reset(); expect(ends[0].outcomes).toHaveLength(1);
    } finally { client.dispose(); spy.mockRestore(); }
  });
  test("stays invisible until the opted-in CLI answers", async () => {
    const sent: Uint8Array[] = [];
    const client = new RelayFileClient((frame) => sent.push(frame));
    const states: boolean[] = [];
    client.onAvailability((available) => states.push(available));
    client.probe();
    expect(client.available).toBe(false);
    const request = JSON.parse(new TextDecoder().decode(sent[0].subarray(1)));
    client.handle(control({ id: request.id, type: "capabilities", version: 1, root: "project" }));
    expect(client.available).toBe(true);
    expect(client.root).toBe("project");
    expect(states).toEqual([false, true]);
  });

  test("lists a directory and streams a requested file with pull backpressure", async () => {
    const sent: Uint8Array[] = [];
    const client = new RelayFileClient((frame) => sent.push(frame));
    client.probe();
    const probe = JSON.parse(new TextDecoder().decode(sent.shift()!.subarray(1)));
    client.handle(control({ id: probe.id, type: "capabilities", version: 1, root: "project" }));

    const listing = client.list("");
    const listRequest = JSON.parse(new TextDecoder().decode(sent.shift()!.subarray(1)));
    client.handle(control({ id: listRequest.id, type: "list", path: "", entries: [{ path: "a.txt", name: "a.txt", kind: "file", size: 2 }] }));
    await expect(listing).resolves.toEqual([{ path: "a.txt", name: "a.txt", kind: "file", size: 2 }]);

    const abort = new AbortController();
    const resolved = client.resolve("a.txt", { purpose: "preview", signal: abort.signal });
    const read = JSON.parse(new TextDecoder().decode(sent.shift()!.subarray(1)));
    client.handle(control({ id: read.id, type: "meta", name: "a.txt", mimeType: "text/plain", size: 2, token: "abc" }));
    const resource = await resolved;
    expect(resource?.name).toBe("a.txt");
    const chunk = new Uint8Array(17);
    chunk[0] = Opcode.FileResponse;
    chunk[1] = 2;
    const view = new DataView(chunk.buffer);
    view.setUint32(2, read.id);
    view.setBigUint64(6, 0n);
    chunk[14] = 1;
    chunk.set(new TextEncoder().encode("ok"), 15);
    client.handle(chunk);
    expect(await new Response(resource!.body).text()).toBe("ok");
  });

  test("does not treat terminal text as access before opt-in", () => {
    const client = new RelayFileClient(vi.fn());
    expect(client.fileLinks.canResolve({ path: "secrets.txt" })).toBe(false);
  });
});
