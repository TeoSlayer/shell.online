// Actual React menus in an isolated browser. No auth, sessions, or game renderer.
// Bundle in memory; the only disk output is Chrome's disposable profile.
// Current-game pause menu only (no workshop/camera): native dialog inertness,
// real Tab trapping, focus restoration, Escape nested-pane handling, held
// gamepad pause/confirm edges, and native settings controls.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { launchChromeTransport } from "./lib/browser-transport.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = `
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { PauseMenu } from "./src/game/ui/PauseMenu";
import { GameShellContext } from "./src/game/state/context";
import { DEFAULT_OPTIONS } from "./src/game/state/options";
import { useGamepadActions } from "./src/game/engine/use-gamepad";

window.menuTest = {
  buttons: Array.from({ length: 16 }, () => ({ pressed: false })),
  transitions: [], escapedKeys: [], options: DEFAULT_OPTIONS,
};
Object.defineProperty(navigator, "getGamepads", {
  value: () => [{ id: "Synthetic Xbox", buttons: menuTest.buttons, axes: [0, 0] }],
});
function Fixture() {
  const [paused, setPaused] = useState(false);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  menuTest.options = options;
  const change = (next) => {
    menuTest.transitions.push(next);
    // Bound a regression which repeatedly mounts menus on one held press.
    if (menuTest.transitions.length > 16) menuTest.buttons.forEach((b) => b.pressed = false);
    setPaused(next);
  };
  useEffect(() => {
    const onKey = (event) => {
      menuTest.escapedKeys.push(event.key);
      // Same outer Escape/pause behavior as GameRoute; dialog events must not escape.
      if (event.key !== "Escape" || paused) return;
      event.preventDefault();
      change(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [paused]);
  useGamepadActions((action) => { if (action === "pause") change(true); }, !paused);
  return <GameShellContext.Provider value={{
    options, setOptions, reducedMotion: false, device: "keyboard", paused, setPaused: change,
  }}><div className="keep">
    <button id="opener" onClick={() => change(true)}>Open menu</button>
    <button id="background">Background control</button>
    {paused && <PauseMenu
      onResume={() => change(false)} purse={{ marks: 0, owned: [] }}
      characterClass="terminal" wearing="" livery="" shopOpen={false}
      elixir={0} garrison={3} onBuy={() => {}} onWear={() => {}} onTravel={() => {}}
      gathering={false} onGathering={() => {}}
      earned={{ sessions: 0, days: 0, machines: 0, mended: 0, made: 0 }} counted={false}
    />}
  </div></GameShellContext.Provider>;
}
createRoot(document.getElementById("root")).render(<MemoryRouter><Fixture /></MemoryRouter>);
`;

const bundle = await build({
  stdin: { contents: fixture, resolveDir: join(root, "app"), loader: "tsx" },
  bundle: true, write: false, outfile: "fixture.js", format: "iife", platform: "browser", jsx: "automatic",
  define: {
    "import.meta.env": "{}",
    __SHELL_ONLINE_VERSION__: '"menu-regression"',
    "process.env.NODE_ENV": '"development"',
  },
  logLevel: "silent",
});
const css = await readFile(join(root, "app/src/styles/game.css"), "utf8") +
  (bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "");
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(bundle.outputFiles.find((file) => file.path.endsWith(".js")).text);
  } else if (req.url === "/") {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  } else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const profile = await mkdtemp(join(tmpdir(), "shell-game-menu-test-"));
let browser;
let keyboardSocket;
const pending = new Map();

try {
  browser = await launchChromeTransport({ profile });
  await browser.setViewport({ width: 1920, height: 1080, dpr: 1, mobile: false });
  await browser.navigate(`http://127.0.0.1:${server.address().port}/`);
  const until = async (check, label) => {
    const expires = Date.now() + 10_000;
    while (Date.now() < expires) {
      if (await check()) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${label}`);
  };
  await until(() => browser.evaluate('Boolean(document.getElementById("opener"))'), "fixture mount");

  // Dispatch real browser key events; synthetic DOM events do not perform Tab's default action.
  const port = browser.debuggingPort;
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  keyboardSocket = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
  await new Promise((done, reject) => { keyboardSocket.onopen = done; keyboardSocket.onerror = reject; });
  let id = 0;
  keyboardSocket.onmessage = ({ data }) => {
    const reply = JSON.parse(data);
    const request = pending.get(reply.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(reply.id);
    if (reply.error) request.reject(new Error("Keyboard CDP command failed"));
    else request.resolve();
  };
  const dispatch = (params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Keyboard CDP timeout")); }, 5000);
    pending.set(requestId, { resolve, reject, timer });
    keyboardSocket.send(JSON.stringify({ id: requestId, method: "Input.dispatchKeyEvent", params }));
  });
  const key = async (key, code, virtualKey, modifiers = 0) => {
    for (const type of ["keyDown", "keyUp"]) {
      const text = type === "keyDown" ? (key === "Enter" ? "\r" : key.length === 1 ? key : undefined) : undefined;
      await dispatch({ type, key, code, windowsVirtualKeyCode: virtualKey, modifiers, text });
    }
    await delay(50);
  };
  const open = async () => {
    await browser.evaluate('document.getElementById("opener").focus(); document.getElementById("opener").click()');
    await until(() => browser.evaluate('Boolean(document.querySelector("dialog[open]"))'), "menu open");
  };
  const title = () => browser.evaluate('document.querySelector("dialog[open]")?.getAttribute("aria-label") ?? null');
  const press = async (button, heldMs = 80) => {
    await browser.call((index) => { menuTest.buttons[index].pressed = true; }, button);
    await delay(heldMs);
    await browser.call((index) => { menuTest.buttons[index].pressed = false; }, button);
    await delay(50);
  };
  const chooseOptions = async () => {
    await browser.call(() => {
      const item = document.querySelectorAll("[role=menuitem]")[6];
      item.focus();
      item.click();
    });
    await until(async () => await title() === "Options", "options open");
  };

  await open();
  for (const modifiers of [0, 0, 8]) {
    await key("Tab", "Tab", 9, modifiers);
    assert.equal(await browser.evaluate('Boolean(document.activeElement.closest("dialog[open]"))'), true, "Tab must remain in the modal");
  }
  await key("Escape", "Escape", 27);
  assert.equal(await title(), null, "Escape must close root once without reopening");
  assert.deepEqual(await browser.evaluate("menuTest.transitions"), [true, false]);
  assert.equal(await browser.evaluate("document.activeElement.id"), "opener", "close must restore the actual opener");

  await open();
  await chooseOptions();
  assert.equal(await browser.evaluate("document.activeElement.type"), "range", "pane entry must focus its first control");
  await key("ArrowRight", "ArrowRight", 39);
  assert.equal(await browser.evaluate("menuTest.options.safeZone"), 6, "native slider keys must still work");
  assert.deepEqual(await browser.evaluate("menuTest.escapedKeys"), [], "dialog keys must not reach canvas shortcuts");
  await key("Escape", "Escape", 27);
  assert.equal(await title(), "Paused", "Escape in a pane must go back one level");
  assert.equal(await browser.evaluate('document.activeElement.querySelector(".keep-menu-label")?.textContent'), "Options", "return must restore the root selection");
  await key("Escape", "Escape", 27);
  assert.equal(await title(), null);

  await browser.evaluate("menuTest.transitions = []");
  await press(9, 200);
  assert.equal(await title(), "Paused", "one held Start must open and stay open");
  assert.deepEqual(await browser.evaluate("menuTest.transitions"), [true]);
  await press(9, 200);
  assert.equal(await title(), null, "a fresh held Start must close and stay closed");
  assert.deepEqual(await browser.evaluate("menuTest.transitions"), [true, false]);

  await open();
  await browser.evaluate('document.querySelectorAll("[role=menuitem]")[6].focus()');
  await press(0, 150);
  assert.equal(await title(), "Options", "held confirm must enter a pane only once");
  await press(15);
  assert.equal(await browser.evaluate("menuTest.options.safeZone"), 7, "gamepad right must adjust the focused slider");
  await press(1, 150);
  assert.equal(await title(), "Paused", "gamepad cancel must go back once and not close the parent");
  await chooseOptions();
  await browser.evaluate('document.querySelector(".keep-options > button").focus()');
  await press(0, 150);
  assert.equal(await title(), "Paused", "held confirm on Back must not activate the remounted menu");

  await browser.call(() => {
    const nested = document.createElement("dialog");
    nested.id = "nested";
    const button = document.createElement("button");
    button.textContent = "Nested close";
    nested.append(button);
    document.querySelector("dialog[open]").append(nested);
    nested.showModal();
  });
  await key("Escape", "Escape", 27);
  assert.equal(await title(), "Paused", "Escape must close only the topmost native dialog");
  assert.equal(await browser.evaluate('document.getElementById("nested").open'), false);
  await browser.evaluate('document.getElementById("nested").remove()');
  await key("Escape", "Escape", 27);
  assert.equal(await title(), null);

  console.log("Game menu browser regressions passed: native dialog inertness, real Tab trapping, focus restoration, Escape nested-pane handling, held gamepad pause/confirm edges, native settings controls.");
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  keyboardSocket?.close();
  await browser?.close();
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
