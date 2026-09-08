import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticFiles } from "./static-files";

let root: string;
let secretDirectory: string;
let server: Server;
let origin: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "shell-static-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(root, "assets", "main-a1b2c3.js"), "console.log(1)");
  writeFileSync(join(root, "favicon.ico"), "icon");
  writeFileSync(join(root, "a file.txt"), "spaces are allowed");

  /* Somewhere outside the root, to prove nothing reaches it. */
  secretDirectory = mkdtempSync(join(tmpdir(), "shell-secret-"));
  writeFileSync(join(secretDirectory, "secret.txt"), "not for the web");
  symlinkSync(join(secretDirectory, "secret.txt"), join(root, "escape.txt"));

  const serve = staticFiles(root);
  server = createServer((request, response) => {
    void serve(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server.close();
});

describe("staticFiles", () => {
  it("serves the entry document", async () => {
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("<title>app</title>");
  });

  it("lets a popup keep its opener, which Google sign-in needs", async () => {
    const response = await fetch(`${origin}/`);
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin-allow-popups");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("caches fingerprinted assets forever and the document never", async () => {
    const asset = await fetch(`${origin}/assets/main-a1b2c3.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    const document = await fetch(`${origin}/index.html`);
    expect(document.headers.get("cache-control")).toBe("no-cache");
  });

  /* The router owns these URLs; only the browser knows they are not files. */
  it("hands an unknown page to the app shell", async () => {
    const response = await fetch(`${origin}/sessions/abc123`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>app</title>");
  });

  /*
   * A missing script answered with HTML is a parse error somewhere unrelated,
   * hours after the deploy that dropped the file.
   */
  it("does not answer a missing asset with the app shell", async () => {
    const response = await fetch(`${origin}/assets/gone-9z9z9z.js`);
    expect(response.status).toBe(404);
  });

  it("finds a file whose name contains a space", async () => {
    expect(await (await fetch(`${origin}/a%20file.txt`)).text()).toBe("spaces are allowed");
  });

  it("refuses to walk out of the root", async () => {
    for (const attempt of [
      "/../secret.txt",
      "/..%2fsecret.txt",
      "/%2e%2e%2fsecret.txt",
      "/assets/../../secret.txt",
      "/....//secret.txt",
    ]) {
      const response = await fetch(`${origin}${attempt}`, { redirect: "manual" });
      expect(await response.text()).not.toContain("not for the web");
    }
  });

  it("refuses a symlink that points out of the root", async () => {
    const response = await fetch(`${origin}/escape.txt`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("not for the web");
  });

  it("answers a HEAD without a body and refuses a write", async () => {
    const head = await fetch(`${origin}/index.html`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await fetch(`${origin}/index.html`, { method: "POST" })).status).toBe(405);
  });
});
