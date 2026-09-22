// Local-only visual/interaction gate. Start Vite first; no production traffic,
// accounts, model calls, or analytics events are involved.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchChromeTransport } from "./lib/browser-transport.mjs";

const url = new URL(process.env.LANDING_TEST_URL ?? "http://127.0.0.1:5178/");
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
  "Local fixture required",
);
assert(
  url.pathname === "/" &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password,
);
const html = await (await fetch(url)).text();
assert(
  html.includes("Leave your desk."),
  "The outcome must be in HTML, before JavaScript",
);
assert(
  html.includes("curl -fsSL https://shell.online/install | sh"),
  "No-JS install path",
);
assert(html.includes("Muse Code"), "Static agent logos");
const profile = await mkdtemp(join(tmpdir(), "shell-landing-test-"));
let browser;
const until = async (condition, label) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await browser.evaluate(condition)) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
};
try {
  browser = await launchChromeTransport({ profile });
  for (const width of [320, 375, 390, 430, 768, 1440]) {
    await browser.navigate("about:blank");
    await until(
      "location.href === 'about:blank' && !document.querySelector('h1')",
      "fresh document",
    );
    await browser.setViewport({
      width,
      height: 900,
      dpr: 1,
      mobile: width < 650,
    });
    await browser.navigate(url.href);
    await until(
      "document.readyState === 'complete' && !!document.querySelector('.home-hero') && document.fonts.status === 'loaded'",
      "landing loaded",
    );
    await until(
      "(() => { document.querySelector('[data-platform=windows]').click(); return document.querySelector('#install-command').textContent.includes('install.ps1'); })()",
      "interactive setup",
    );
    const state = await browser.call(async () => {
      for (const img of document.images) {
        img.loading = "eager";
        await img.decode();
      }
      const interactive = [
        ...document.querySelectorAll(
          ".agent-picker button,.platform-picker button,.proof-switch button,[data-copy],.home-actions .button,.setup-love .button",
        ),
      ].filter((n) => n.getClientRects().length > 0);
      return {
        width: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        brands: document.querySelectorAll(".agent-brand-grid .brand-mark")
          .length,
        platforms: document.querySelectorAll(".platform-brands .brand-mark")
          .length,
        clippedBrands: [...document.querySelectorAll(".brand-mark")].filter(
          (n) => n.scrollWidth > n.clientWidth + 1,
        ).length,
        smallControls: interactive.filter(
          (n) => n.getBoundingClientRect().height < 44,
        ).length,
        heavyRuntime: performance
          .getEntriesByType("resource")
          .some(
            (r) =>
              /\/web\/main\.|mermaid|xterm/.test(r.name) ||
              (r.name.endsWith(".js") && r.encodedBodySize > 150_000),
          ),
        built: !!document.querySelector('script[src^="/assets/"]'),
        scriptBytes: performance
          .getEntriesByType("resource")
          .filter(
            (r) => r.name.startsWith(location.origin) && r.name.endsWith(".js"),
          )
          .reduce((sum, r) => sum + r.encodedBodySize, 0),
      };
    });
    assert.equal(state.width, width);
    assert.equal(state.overflow, false);
    assert.equal(state.clippedBrands, 0);
    assert.equal(state.smallControls, 0, "At least 44px primary touch targets");
    assert.equal(state.brands, 20);
    assert.equal(state.platforms, 8);
    const expanded = await browser.call(() => {
      document.querySelector(".agent-extras").open = true;
      const buttons = [...document.querySelectorAll("[data-agent]")];
      const result = {
        count: buttons.length,
        overflow: document.documentElement.scrollWidth > innerWidth,
        small: buttons.filter((b) => b.getBoundingClientRect().height < 44)
          .length,
      };
      document.querySelector(".agent-extras").open = false;
      return result;
    });
    assert.equal(expanded.count, 20);
    assert.equal(expanded.overflow, false);
    assert.equal(expanded.small, 0);
    const source = await browser.call(() => {
      document.querySelector(".source-install").open = true;
      const result = {
        overflow: document.documentElement.scrollWidth > innerWidth,
        height: document
          .querySelector("[data-copy=source_build]")
          .getBoundingClientRect().height,
      };
      document.querySelector(".source-install").open = false;
      return result;
    });
    assert(!source.overflow, "Expanded source build must not overflow");
    assert(source.height >= 44);
    assert.equal(
      state.heavyRuntime,
      false,
      "Do not load the terminal runtime to show the landing page",
    );
    if (state.built)
      assert(
        state.scriptBytes < 35_000,
        "Built landing scripts must stay under 35KB uncompressed",
      );
    console.log(
      `PASS ${width}px: layout, logos, touch targets, lightweight entry`,
    );
  }
  const interaction = await browser.call(async () => {
    const result = {};
    result.platforms = [...document.querySelectorAll("[data-platform]")].map(
      (button) => {
        button.click();
        return {
          platform: button.dataset.platform,
          command: document.querySelector("#install-command").textContent,
          selected: document.querySelectorAll(
            "[data-platform][aria-pressed=true]",
          ).length,
        };
      },
    );
    document.querySelector("[data-platform=macos]").click();
    result.unix = document.querySelector("#install-command").textContent;
    document.querySelector("[data-platform=windows]").click();
    result.windows = document.querySelector("#install-command").textContent;
    result.agents = [];
    for (const agent of ["codex", "claude", "opencode"]) {
      document.querySelector(`[data-agent=${agent}]`).click();
      result.agents.push(document.querySelector("#run-command").textContent);
    }
    document.querySelector(".agent-extras").open = true;
    result.allAgents = [
      ...document.querySelectorAll("[data-agent]:not([data-agent=other])"),
    ].map((button) => {
      button.click();
      return {
        command: document.querySelector("#run-command").textContent,
        expected: button.querySelector("code").textContent,
      };
    });
    document.querySelector("[data-agent=other]").click();
    result.emptyCustomDisabled =
      document.querySelector("[data-copy=run]").disabled;
    const input = document.querySelector("#custom-agent-command");
    input.value = "npm run dev";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    result.customCommand = document.querySelector("#run-command").textContent;
    result.customDisabled = document.querySelector("[data-copy=run]").disabled;
    const copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => copied.push(value) },
    });
    document.querySelector("[data-copy=install]").click();
    await new Promise((r) => setTimeout(r, 30));
    document.querySelector("[data-copy=run]").click();
    await new Promise((r) => setTimeout(r, 30));
    result.copied = [...copied];
    document.querySelector(".source-install").open = true;
    const sourceCopies = [];
    for (const platform of ["macos", "windows"]) {
      document.querySelector(`[data-platform=${platform}]`).click();
      document.querySelector("[data-copy=source_build]").click();
      await new Promise((r) => setTimeout(r, 10));
      sourceCopies.push(copied.at(-1));
    }
    result.sourceCopies = sourceCopies;
    document.querySelector("[data-agent=opencode]").click();
    result.customHidden = document.querySelector(".custom-agent").hidden;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("fixture denied");
        },
      },
    });
    document.querySelector("[data-copy=run]").click();
    await new Promise((r) => setTimeout(r, 30));
    result.failure = document.querySelector(".copy-feedback").textContent;
    document.querySelector("[data-proof=complete]").click();
    await document.querySelector("#proof-image").decode();
    await new Promise((r) => setTimeout(r, 50));
    result.proof = document.querySelector("#proof-image").src;
    result.proofBottom = document.querySelector(".proof-window").scrollTop > 0;
    result.proofSelected = document
      .querySelector("[data-proof=complete]")
      .getAttribute("aria-pressed");
    document.querySelector("[data-proof=working]").click();
    await document.querySelector("#proof-image").decode();
    await new Promise((r) => setTimeout(r, 50));
    result.proofTop = document.querySelector(".proof-window").scrollTop;
    result.marketing = performance
      .getEntriesByType("resource")
      .filter((r) =>
        /google-analytics|googletagmanager|\/api\/events/.test(r.name),
      ).length;
    return result;
  });
  assert.equal(
    interaction.unix,
    "curl -fsSL https://shell.online/install | sh",
  );
  assert.equal(
    interaction.windows,
    "irm https://shell.online/install.ps1 | iex",
  );
  assert.equal(interaction.platforms.length, 8);
  for (const platform of interaction.platforms) {
    assert.equal(platform.selected, 1);
    assert.equal(
      platform.command,
      platform.platform === "windows" ? interaction.windows : interaction.unix,
    );
  }
  assert.deepEqual(interaction.agents, [
    "shell codex",
    "shell claude",
    "shell opencode",
  ]);
  assert.equal(interaction.allAgents.length, 19);
  for (const agent of interaction.allAgents)
    assert.equal(agent.command, agent.expected);
  assert.equal(interaction.emptyCustomDisabled, true);
  assert.equal(interaction.customDisabled, false);
  assert.equal(interaction.customHidden, true);
  assert.equal(interaction.customCommand, "shell npm run dev");
  assert.deepEqual(interaction.copied, [
    interaction.windows,
    "shell npm run dev",
  ]);
  assert.match(interaction.failure, /Could not copy/);
  assert(interaction.sourceCopies[0].includes("./shell --version"));
  assert(interaction.sourceCopies[1].includes(".\\shell.exe --version"));
  for (const recipe of interaction.sourceCopies) {
    assert(recipe.includes("git clone --depth 1 --branch v"));
    assert(recipe.includes("go build -buildvcs=false -trimpath"));
  }
  assert.match(interaction.proof, /codex-complete-mobile\.png$/);
  assert.equal(interaction.proofSelected, "true");
  assert.equal(interaction.proofBottom, true);
  assert.equal(interaction.proofTop, 0);
  assert.equal(
    interaction.marketing,
    0,
    "Local previews must not send marketing traffic",
  );
  console.log(
    "PASS install/agent selection, copy success/failure, screenshot toggle, local tracking isolation",
  );
} finally {
  await browser?.close();
  // This is the exact temporary profile created above, never a user profile.
  await rm(profile, { recursive: true, force: true });
}
