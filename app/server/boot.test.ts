import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

/**
 * The process itself: configuration refused at boot, the three things it
 * serves, and a shutdown that drains.
 *
 * Everything else is tested by calling a function. This is the only place that
 * runs `server/index.ts` the way a container does, which is where a mistake in
 * wiring -- a store never opened, an upgrade handler never attached, a signal
 * never handled -- would otherwise be found by deploying it.
 */
const appDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Started {
  child: ChildProcess;
  output: () => string;
}

const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) stop(child);
});

/*
 * The whole group, not just the child. tsx runs the server in a process of its
 * own, so signalling only the one that was spawned leaves the server alive and
 * still holding the port -- which the next test then cannot bind.
 */
function stop(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function start(env: Record<string, string>): Started {
  const child = spawn(join(appDirectory, "node_modules", ".bin", "tsx"), ["server/index.ts"], {
    cwd: appDirectory,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  running.push(child);
  let text = "";
  child.stdout?.on("data", (chunk) => (text += chunk));
  child.stderr?.on("data", (chunk) => (text += chunk));
  return { child, output: () => text };
}

/** Waits for the line the server prints once it is listening. */
async function listening(started: Started, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (started.output().includes("accounts: listening on ")) return;
    if (started.child.exitCode !== null) {
      throw new Error(`exited ${started.child.exitCode}: ${started.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`never listened: ${started.output()}`);
}

async function exited(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("did not exit");
}

function clientDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "shell-client-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>shell.online</title>");
  return root;
}

/*
 * A port per test, since these bind for real and a listener is not always
 * released the instant the process that held it goes away.
 */
async function claimPort(): Promise<{ port: string; base: string }> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("could not reserve a test port");
  const port = String(address.port);
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return { port, base: `http://127.0.0.1:${port}` };
}

describe("booting the service", () => {
  it("refuses to start without a project whose tokens it can verify", async () => {
    const { port: PORT } = await claimPort();
    const started = start({ PORT, FIREBASE_PROJECT_ID: "", VITE_FIREBASE_PROJECT_ID: "" });
    expect(await exited(started.child)).toBe(1);
    expect(started.output()).toContain("FIREBASE_PROJECT_ID");
  }, 30_000);

  it("refuses the file store in production rather than running on it", async () => {
    const { port: PORT } = await claimPort();
    const started = start({
      PORT,
      NODE_ENV: "production",
      FIREBASE_PROJECT_ID: "p",
      DATABASE_URL: "",
    });
    expect(await exited(started.child)).toBe(1);
    expect(started.output()).toContain("DATABASE_URL");
  }, 30_000);

  it("serves the client, the API and a health check from one port", async () => {
    const { port: PORT, base: BASE } = await claimPort();
    const root = clientDirectory();
    const started = start({
      PORT,
      FIREBASE_PROJECT_ID: "test-firebase-project",
      ACCOUNTS_DATA: join(mkdtempSync(join(tmpdir(), "shell-data-")), "accounts.json"),
      CLIENT_DIR: root,
      RELAY_URL: "http://127.0.0.1:1",
      WEB_ORIGIN: BASE,
    });
    await listening(started);

    expect((await fetch(`${BASE}/api/health`)).status).toBe(200);
    expect((await fetch(`${BASE}/api/ready`)).status).toBe(200);

    /* The client, and a route only its router knows about. */
    expect(await (await fetch(`${BASE}/`)).text()).toContain("shell.online");
    expect(await (await fetch(`${BASE}/sessions/abc`)).text()).toContain("shell.online");

    /* The API is still the API, and still guarded. */
    expect((await fetch(`${BASE}/api/sessions`)).status).toBe(401);

    /* Relay forwarding is wired; nothing is listening on port 1. */
    expect((await fetch(`${BASE}/relay/api/health`)).status).toBe(502);
  }, 40_000);

  /*
   * A process that cannot bind must say so and fail. Logging and carrying on
   * leaves a container answering nothing while every probe calls it healthy.
   */
  it("fails loudly when its port is taken", async () => {
    const { port: PORT, base: BASE } = await claimPort();
    const environment = {
      PORT,
      FIREBASE_PROJECT_ID: "test-firebase-project",
      ACCOUNTS_DATA: join(mkdtempSync(join(tmpdir(), "shell-data-")), "accounts.json"),
    };
    const first = start(environment);
    await listening(first);

    const second = start(environment);
    expect(await exited(second.child)).toBe(1);
    expect(second.output()).toContain("already in use");
    /* The one that got there first is untouched. */
    expect((await fetch(`${BASE}/api/health`)).status).toBe(200);
  }, 40_000);

  it("stops serving on SIGTERM and exits cleanly", async () => {
    const { port: PORT, base: BASE } = await claimPort();
    const started = start({
      PORT,
      FIREBASE_PROJECT_ID: "test-firebase-project",
      ACCOUNTS_DATA: join(mkdtempSync(join(tmpdir(), "shell-data-")), "accounts.json"),
    });
    await listening(started);
    expect((await fetch(`${BASE}/api/health`)).status).toBe(200);

    /* The server itself, not the group: this is the signal a container sends. */
    started.child.kill("SIGTERM");
    expect(await exited(started.child)).toBe(0);
    await expect(fetch(`${BASE}/api/health`)).rejects.toThrow();
  }, 40_000);
});
