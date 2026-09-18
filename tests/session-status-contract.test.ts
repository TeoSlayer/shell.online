/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/*
 * GET /api/sessions/:id on the relay is the only thing that can say when a
 * machine was last there, and the accounts app is the only thing that reads
 * it. Everything downstream -- whether a session that stopped answering is
 * still offered as something to type into -- hangs off that one field, and the
 * two sides are in different packages with no shared type between them. A
 * rename on either side would be silent: the app would go on parsing a key
 * nobody sends and quietly never call a machine gone again.
 */
describe("the relay's session status contract", () => {
  it("is read under the same name the relay writes it", async () => {
    const relay = await readFile(join(root, "worker/index.ts"), "utf8");
    const app = await readFile(join(root, "app/server/lib/session-liveness.ts"), "utf8");

    expect(relay).toContain("host_last_seen_at: this.meta.hostLastSeenAt");
    expect(app).toContain("body.host_last_seen_at");
  });

  /*
   * How long a machine may be away before its sessions are called over is
   * decided twice -- once in the browser, once in `shell ls` -- because the two
   * share no code. They must be the same number, or the same session reads as
   * finished in one and running in the other.
   */
  it("gives the browser and the CLI the same patience with an absent machine", async () => {
    const browser = await readFile(join(root, "app/src/lib/session-liveness.ts"), "utf8");
    const cli = await readFile(join(root, "cmd/shell/account_sessions.go"), "utf8");

    expect(browser).toContain("export const HOST_GONE_MS = 10 * 60_000;");
    expect(cli).toContain("const hostGoneAfter = 10 * time.Minute");
  });
});
