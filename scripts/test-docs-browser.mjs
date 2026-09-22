// Local-only browser gate. No accounts, model calls or production analytics.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchChromeTransport } from "./lib/browser-transport.mjs";

const origin = new URL(process.env.DOCS_TEST_URL ?? "http://127.0.0.1:5178/");
assert(
  ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname),
  "Local fixture required",
);
assert(
  origin.pathname === "/" &&
    !origin.search &&
    !origin.hash &&
    !origin.username &&
    !origin.password,
);
const source = JSON.parse(
  await readFile(new URL("../docs/content.json", import.meta.url), "utf8"),
);
const pages = Object.entries(source.pages);
const profile = await mkdtemp(join(tmpdir(), "shell-docs-gate-"));
let browser;
const until = async (fn, label) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await browser.evaluate(fn)) return;
    await delay(40);
  }
  throw new Error(`Timed out: ${label}`);
};
try {
  browser = await launchChromeTransport({ profile });
  for (const [kind, page] of pages) {
    const url = new URL(`/${kind}/`, origin);
    const html = await (await fetch(url)).text();
    assert(
      html.includes(page.title.replaceAll("&", "&amp;")),
      `${kind}: static title`,
    );
    assert(
      html.includes('id="section-1"'),
      `${kind}: content before JavaScript`,
    );
    assert(!html.includes("user-scalable=no"), "Allow browser zoom");
    for (const width of [320, 390, 768, 1440]) {
      await browser.navigate("about:blank");
      await until(
        "location.href === 'about:blank' && !document.querySelector('.guide')",
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
        "document.readyState === 'complete' && !!document.querySelector('.guide-section') && document.fonts.status === 'loaded'",
        "guide ready",
      );
      const state = await browser.call(() => {
        const visible = (n) => n.getClientRects().length > 0;
        return {
          width: innerWidth,
          overflow: document.documentElement.scrollWidth > innerWidth,
          title: document.querySelector("h1").textContent,
          sections: document.querySelectorAll(".guide-section").length,
          targets: [
            ...document.querySelectorAll(
              "[data-doc-copy],#docs-search,.docs-version-select,.guide-mobile-nav summary",
            ),
          ]
            .filter(visible)
            .every((n) => n.getBoundingClientRect().height >= 44),
          badAnchors: [
            ...document.querySelectorAll('.guide a[href^="#section-"]'),
          ].filter((a) => !document.getElementById(a.hash.slice(1))).length,
          heavy: performance
            .getEntriesByType("resource")
            .some((r) => /\/web\/main\.|mermaid|xterm/.test(r.name)),
          marketing: performance
            .getEntriesByType("resource")
            .some((r) =>
              /googletagmanager|google-analytics|\/api\/events/.test(r.name),
            ),
          jsBytes: performance
            .getEntriesByType("resource")
            .filter(
              (r) =>
                r.name.startsWith(location.origin) && r.name.endsWith(".js"),
            )
            .reduce((sum, r) => sum + r.encodedBodySize, 0),
          built: !!document.querySelector('script[src^="/assets/"]'),
        };
      });
      assert.equal(state.width, width);
      assert.equal(state.overflow, false, `${kind} at ${width}px overflows`);
      assert.equal(state.title, page.title);
      assert.equal(state.sections, page.cards.length);
      assert(state.targets, `${kind}: 44px controls`);
      assert.equal(state.badAnchors, 0);
      assert.equal(
        state.heavy,
        false,
        "Docs must not load the terminal runtime",
      );
      assert.equal(
        state.marketing,
        false,
        "Local tests must not send analytics",
      );
      if (state.built)
        assert(state.jsBytes < 100000, "Docs scripts under 100KB uncompressed");
      if (
        kind === "docs" &&
        process.env.DOCS_SCREENSHOT_DIR &&
        [390, 1440].includes(width)
      ) {
        const folder = resolve(process.env.DOCS_SCREENSHOT_DIR);
        assert(
          !folder.startsWith(resolve(import.meta.dirname, "..") + "/"),
          "Screenshots outside repository",
        );
        await writeFile(
          join(folder, `docs-${width}.png`),
          Buffer.from(await browser.screenshot(), "base64"),
        );
      }
    }
    console.log(
      `PASS ${kind}: static HTML, 4 viewport widths, touch targets, lightweight runtime`,
    );
  }
  await browser.navigate(new URL("/docs/", origin).href);
  await until(
    "!!document.querySelector('#docs-search') && document.readyState==='complete'",
    "interaction document",
  );
  // Wait for listeners, not just the server-rendered markup.
  await until(
    "(() => { const i=document.querySelector('#docs-search');i.value='password';i.dispatchEvent(new Event('input'));return !!document.querySelector('#docs-search-results a'); })()",
    "search wired",
  );
  const result = await browser.call(async () => {
    const input = document.querySelector("#docs-search");
    const results = document.querySelector("#docs-search-results");
    const searchLinks = [...results.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    const keyboard = results.contains(document.activeElement);
    document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    const escaped = results.hidden && document.activeElement === input;
    input.value = "<img src=x onerror=alert(1)>";
    input.dispatchEvent(new Event("input"));
    const noInjection =
      results.querySelectorAll("img,script").length === 0 &&
      results.textContent.includes("No matching guide");
    const copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (v) => copied.push(v) },
    });
    const buttons = [...document.querySelectorAll("[data-doc-copy]")];
    for (const b of buttons) {
      b.click();
      await new Promise((r) => setTimeout(r, 5));
    }
    const commands = buttons.map(
      (b) => b.closest(".guide-code").querySelector("code").textContent,
    );
    const success = document.querySelector(".guide-copy-status").textContent;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error("fixture");
        },
      },
    });
    buttons[0].click();
    await new Promise((r) => setTimeout(r, 10));
    return {
      searchLinks,
      keyboard,
      escaped,
      noInjection,
      copied,
      commands,
      success,
      failure: document.querySelector(".guide-copy-status").textContent,
    };
  });
  assert(result.searchLinks.length > 0 && result.searchLinks.length <= 8);
  assert(result.searchLinks.every((p) => /^\/[\w-]+\/#section-\d+$/.test(p)));
  assert(result.keyboard && result.escaped && result.noInjection);
  assert.deepEqual(result.copied, result.commands);
  assert(
    result.copied.some((c) => c.includes("<ID>")),
    "Placeholders preserved on copy",
  );
  assert.match(result.success, /copied/i);
  assert.match(result.failure, /select|copy/i);
  await browser.setViewport({ width: 390, height: 900, dpr: 1, mobile: true });
  const mobile = await browser.call(() => {
    document.querySelector(".guide-mobile-nav").open = true;
    document.querySelector(".guide-mobile-toc").open = true;
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      links: document.querySelectorAll(".guide-mobile-nav a").length,
      current: document.querySelectorAll(
        ".guide-mobile-nav [aria-current=page]",
      ).length,
    };
  });
  assert(!mobile.overflow);
  assert.equal(mobile.links, pages.length);
  assert.equal(mobile.current, 1);
  console.log(
    "PASS local search, keyboard navigation, escaped query, all command copies, clipboard failure and mobile menu",
  );
} finally {
  await browser?.close();
  await rm(profile, { recursive: true, force: true });
}
