// P03: real-browser rendering of the session page — grid, agent chip, and the full-grant-lifetime
// server-decryption disclosure, including the transitions that update an OPEN page without
// navigation.
//
// Drives headless Chrome over the DevTools Protocol (the page gates its WebSocket connect behind
// the E2EE password form, so --dump-dom alone never connects):
//   1. load the share URL, wait for the encryption gate, enter the session password, submit
//   2. wait for the WebSocket to connect (status leaves "Offline")
//   3. verify: grid (xterm cells), agent chip ("Agent: <label>"), disclosure badge ("E2EE · MCP"
//      + "server-side decryption authorized")
//   4. revoke + RELOAD (the original check): the badge reverts to plain E2EE and the chip is gone
//   5. NO-NAVIGATION revocation: mint a fresh grant, verify the chip + badge appear via the
//      presence broadcast (no reload), then revoke and verify they revert on the SAME open page
//   6. GRANT EXPIRY: mint a short-TTL grant, let it EXPIRE (no revoke, no reload), verify the
//      disclosure reverts — proving the badge is grant-lifetime, independent of revocation
//   7. ACTIVITY-LEASE EXPIRY: mint a long-TTL grant with ONE MCP call, let the 60s activity lease
//      lapse (no revoke, no reload, no further MCP calls), verify the agent chip drops while the
//      badge stays "E2EE · MCP" — proving the chip is activity-based, not grant-lifetime
//
// Usage: node scripts/staging-harness/browser-disclosure.mjs
// Requires Google Chrome (override with SHELL_CHROME_BIN). Cleans up its session in a finally.

import { spawn } from "node:child_process";
import { createSession, grant, revokeAll, cleanupSession, mcpCall, buildCli, redact } from "./lib.mjs";
import { browserFunctionParams, SUBMIT_PASSWORD, GRANT_APPEARED } from "./browser-functions.mjs";

const CHROME =
  process.env.SHELL_CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Chrome {
  constructor() {
    this.proc = null;
    this.ws = null;
    this.nextId = 1;
    this.handlers = [];
  }
  async start(port) {
    this.proc = spawn(
      CHROME,
      ["--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/shell-harness-chrome", "--window-size=1200,800", "about:blank"],
      { stdio: "ignore" },
    );
    await sleep(2500);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = targets.find((t) => t.type === "page");
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      for (const h of this.handlers) h(msg);
    };
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error("chrome ws error"));
    });
    this.send("Page.enable");
    this.send("Runtime.enable");
  }
  send(method, params = {}) {
    this.ws.send(JSON.stringify({ id: this.nextId++, method, params }));
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const handler = (msg) => {
        if (msg.id === id) {
          this.handlers = this.handlers.filter((h) => h !== handler);
          if (msg.error || msg.result?.exceptionDetails) reject(new Error("Chrome command failed"));
          else resolve(msg.result);
        }
      };
      this.handlers.push(handler);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    return (await this.request("Runtime.evaluate", { expression, returnByValue: true }))?.result?.value;
  }
  async callFunction(functionDeclaration, ...values) {
    const global = await this.request("Runtime.evaluate", { expression: "globalThis" });
    if (!global?.result?.objectId) throw new Error("Chrome context unavailable");
    const result = await this.request("Runtime.callFunctionOn",
      browserFunctionParams(global.result.objectId, functionDeclaration, values));
    return result?.result?.value;
  }
  async waitFor(expression, { timeoutMs = 30000, intervalMs = 500 } = {}) {
    const start = Date.now();
    for (;;) {
      const value = typeof expression === "function" ? await expression() : await this.eval(expression);
      if (value) return value;
      if (Date.now() - start > timeoutMs) return null;
      await sleep(intervalMs);
    }
  }
  stop() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.proc?.kill();
  }
}

const DOM_STATE = `JSON.stringify({
  status: document.querySelector('.status')?.textContent,
  grid: !!document.querySelector('.xterm-rows'),
  agent: document.querySelector('.presence-agent')?.textContent ?? null,
  badge: document.getElementById('session-encryption')?.textContent ?? null,
  badgeTitle: document.getElementById('session-encryption')?.title ?? null,
})`;

// Mint a grant, make one MCP call (activity), and wait for the chip + badge to appear on the
// ALREADY-CONNECTED page (via the presence broadcast — no navigation). The presence chip is a LIST
// (one per active agent), and a previous grant's chip can linger (the chip is activity-based), so
// look for THIS grant's label among all chips rather than the first chip.
async function showGrant(chrome, sessionId, label, ttl, secrets) {
  const bearer = await grant(sessionId, label, "observe", ttl);
  secrets.push(bearer);
  await mcpCall(bearer, "shell_status", {});
  const appeared = await chrome.waitFor(
    () => chrome.callFunction(GRANT_APPEARED, label),
    { timeoutMs: 20000 },
  );
  return { bearer, appeared };
}

async function main() {
  buildCli();
  const session = await createSession();
  // The COMPLETE secret registry for this run: the session's creds + every bearer minted. Every
  // output boundary (check details, cleanup errors) redacts with this full set.
  const secrets = [];
  if (session.share_url) secrets.push(session.share_url);
  if (session.e2ee_password) secrets.push(session.e2ee_password);
  const chrome = new Chrome();
  const results = [];
  const cleanupErrors = [];
  let cleanupFailed = false; // verified: the session is still LIVE (credentials still authorize)
  let cleanupUncertain = false; // ambiguous: could not confirm the credentials stopped authorizing
  let verifyBearer = null; // the first grant minted; used to VERIFY cleanup (creds no longer authorize)
  const check = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${redact(detail, secrets)}` : ""}`);
  };
  const readState = async () => JSON.parse((await chrome.eval(DOM_STATE)) ?? "{}");
  try {
    await chrome.start(9441);
    const bearer = await grant(session.session_id, "browser-disc", "observe", 300);
    secrets.push(bearer);
    verifyBearer = bearer;
    // The agent chip is activity-based (a live activity lease), not just grant-lifetime: make an
    // MCP call so the grant has a recent activity and shows as an active controller.
    await mcpCall(bearer, "shell_status", {});
    await sleep(1500);

    // --- 1. load, connect, verify the live-grant disclosure -----------------------------------
    chrome.send("Page.navigate", { url: session.share_url });
    const gateReady = await chrome.waitFor(`!!document.getElementById('encryption-password')`, { timeoutMs: 20000 });
    check("encryption gate appears for the E2EE link", !!gateReady);
    if (gateReady) {
      await chrome.callFunction(SUBMIT_PASSWORD, session.e2ee_password);
    }
    const connected = await chrome.waitFor(
      `!['Offline','Connecting'].includes(document.querySelector('.status')?.textContent ?? '')`,
      { timeoutMs: 30000 },
    );
    check("browser connects (status leaves Offline)", !!connected, `status=${connected ?? "timeout"}`);

    const live = await chrome.waitFor(
      `!!document.querySelector('.presence-agent') && (document.getElementById('session-encryption')?.textContent ?? '').includes('MCP')`,
      { timeoutMs: 20000 },
    );
    const st = await readState();
    check("grid: xterm rendered", st.grid === true);
    check("agent chip: Agent: browser-disc", st.agent === "Agent: browser-disc", `agent=${st.agent}`);
    check("disclosure: badge claims MCP decryption", st.badge === "E2EE · MCP", `badge=${st.badge}`);
    check(
      "disclosure: title says server-side decryption authorized",
      (st.badgeTitle ?? "").includes("server-side decryption authorized"),
    );
    void live;

    // --- 2. revoke + RELOAD (the original check): the disclosure reverts ----------------------
    await revokeAll(session.session_id);
    chrome.send("Page.navigate", { url: session.share_url });
    await chrome.waitFor(`!!document.getElementById('encryption-password')`, { timeoutMs: 20000 });
    await chrome.callFunction(SUBMIT_PASSWORD, session.e2ee_password);
    await chrome.waitFor(
      `!['Offline','Connecting'].includes(document.querySelector('.status')?.textContent ?? '')`,
      { timeoutMs: 30000 },
    );
    await sleep(3000);
    const afterReload = await readState();
    check("after revoke+reload: badge reverts to plain E2EE", afterReload.badge === "E2EE", `badge=${afterReload.badge}`);
    check("after revoke+reload: no MCP decryption claim", !(afterReload.badgeTitle ?? "").includes("server-side decryption authorized"));
    check("after revoke+reload: agent chip gone", afterReload.agent === null, `agent=${afterReload.agent}`);

    // --- 3. NO-NAVIGATION revocation: the open page updates via the presence broadcast --------
    // The page is still connected (from the reload). Mint a fresh grant; the chip + badge must
    // appear WITHOUT a reload, then revert WITHOUT a reload after revocation.
    const ng = await showGrant(chrome, session.session_id, "browser-ng", 300, secrets);
    const ngLive = await readState();
    check("no-nav: fresh grant shows chip + MCP badge (no reload)", ng.appeared && ngLive.badge === "E2EE · MCP", `badge=${ngLive.badge} agent=${ngLive.agent}`);
    await revokeAll(session.session_id);
    const ngReverted = await chrome.waitFor(
      `(document.getElementById('session-encryption')?.textContent ?? '') === 'E2EE' && !document.querySelector('.presence-agent')`,
      { timeoutMs: 20000 },
    );
    const ngAfter = await readState();
    check("no-nav: revocation reverts badge + chip on the OPEN page (no reload)", !!ngReverted, `badge=${ngAfter.badge} agent=${ngAfter.agent}`);

    // --- 4. GRANT EXPIRY: the disclosure reverts when the grant lapses (no revoke, no reload) -
    const ex = await showGrant(chrome, session.session_id, "browser-exp", 12, secrets);
    const exLive = await readState();
    check("expiry: short-TTL grant shows MCP badge", ex.appeared && exLive.badge === "E2EE · MCP", `badge=${exLive.badge}`);
    // Let the 12s grant EXPIRE (no revoke). The disclosure must revert on expiry alone.
    const exReverted = await chrome.waitFor(
      `(document.getElementById('session-encryption')?.textContent ?? '') === 'E2EE'`,
      { timeoutMs: 30000 },
    );
    const exAfter = await readState();
    check("expiry: badge reverts to plain E2EE when the grant lapses (no revoke/reload)", !!exReverted, `badge=${exAfter.badge}`);

    // --- 5. ACTIVITY-LEASE EXPIRY: the chip is activity-based, not grant-lifetime -------------
    // A long-TTL grant with ONE MCP call: the chip shows now, but must drop when the 60s activity
    // lease lapses (no revoke, no reload, no further MCP calls) while the badge stays MCP.
    const al = await showGrant(chrome, session.session_id, "browser-lease", 300, secrets);
    check("lease: active grant shows the agent chip", al.appeared === true);
    // Wait out the 60s activity lease (plus margin). The "browser-lease" chip must drop (a previous
    // grant's chip may linger, so look for this label specifically); the badge stays MCP.
    const leaseDropped = await chrome.waitFor(
      `!Array.from(document.querySelectorAll('.presence-agent')).some(el => el.textContent === 'Agent: browser-lease') && (document.getElementById('session-encryption')?.textContent ?? '').includes('MCP')`,
      { timeoutMs: 80000 },
    );
    const alAfter = await readState();
    check("lease: chip drops after the activity lease lapses (badge stays MCP)", !!leaseDropped, `badge=${alAfter.badge}`);
  } finally {
    chrome.stop();
    // Cleanup is bounded + VERIFIED: revoke + kill (bounded retries), then verify the credentials
    // no longer authorize. A timeout is NOT assumed to mean the revocation failed or succeeded —
    // the verification probe decides, and an ambiguous result is reported as uncertain.
    const res = await cleanupSession(session.session_id, { verifyBearer });
    for (const n of res.notes) cleanupErrors.push(n);
    if (!res.verified) {
      if (res.notes.some((n) => n.includes("still LIVE"))) cleanupFailed = true;
      else cleanupUncertain = true;
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser-disclosure checks passed`);
  if (cleanupErrors.length > 0) {
    for (const e of cleanupErrors) console.log(`  cleanup: ${redact(e, secrets)}`);
  }
  if (cleanupFailed) {
    console.log("  cleanup: FAILED — session still LIVE (credentials still authorize)");
    process.exitCode = 1;
  } else if (cleanupUncertain) {
    // Not a confirmed failure, but not a clean pass either: the revocation outcome is uncertain.
    console.log("  cleanup: UNCERTAIN — could not verify the credentials stopped authorizing");
    process.exitCode = 1;
  }
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`browser-disclosure error: ${redact(err?.stack ?? err)}`);
  process.exitCode = 1;
});
