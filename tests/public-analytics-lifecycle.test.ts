import { beforeEach, describe, expect, it, vi } from "vitest";

type CookieJar = Map<string, string>;

function makeDom(url: string, cookies: CookieJar) {
  const headChildren: Record<string, unknown>[] = [];
  const bodyChildren: Record<string, unknown>[] = [];

  const document: Record<string, unknown> = {
    get cookie(): string {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(value: string) {
      const eq = value.indexOf("=");
      if (eq === -1) return;
      const name = value.slice(0, eq).trim();
      const rest = value.slice(eq + 1);
      const maxAge = /Max-Age=(\d+)/.exec(rest);
      if (maxAge && Number(maxAge[1]) === 0) {
        cookies.delete(name);
      } else {
        cookies.set(name, rest.split(";")[0].trim());
      }
    },
    createElement: (tag: string) => ({
      tagName: tag,
      async: false,
      referrerPolicy: "",
      src: "",
      id: "",
      type: "",
      textContent: "",
      style: { cssText: "" },
      setAttribute: () => {},
      addEventListener: () => {},
    }),
    head: { appendChild: (el: unknown) => { headChildren.push(el as Record<string, unknown>); } },
    body: { appendChild: (el: unknown) => { bodyChildren.push(el as Record<string, unknown>); } },
    getElementById: (id: string) => bodyChildren.find((el) => el.id === id) ?? null,
  };

  const window: Record<string, unknown> = {
    location: { href: url },
    dataLayer: undefined,
    gtag: undefined,
  };

  return { document, window, headChildren, bodyChildren, cookies };
}

function installDom(url: string, cookies: CookieJar) {
  const dom = makeDom(url, cookies);
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  return dom;
}

describe("loadGtag / acceptAnalytics / withdrawAnalytics lifecycle", () => {
  let cookies: CookieJar;
  let dom: ReturnType<typeof makeDom>;

  beforeEach(() => {
    vi.resetModules();
    cookies = new Map();
    dom = installDom("https://shell.online/", cookies);
  });

  it("loadGtag queues standard Arguments commands in correct order", async () => {
    cookies.set("shell_analytics_consent", "accepted");
    const { loadGtag } = await import("../web/analytics");
    loadGtag();

    const dataLayer = dom.window.dataLayer as unknown[];
    expect(dataLayer).toBeDefined();
    expect(dataLayer.length).toBe(4);

    for (const entry of dataLayer) {
      expect(Object.prototype.toString.call(entry)).toBe("[object Arguments]");
    }

    const [cmd0, cmd1, cmd2, cmd3] = dataLayer as IArguments[];
    expect(cmd0[0]).toBe("consent");
    expect(cmd0[1]).toBe("default");
    expect(cmd1[0]).toBe("js");
    expect(cmd2[0]).toBe("config");
    expect(cmd2[1]).toBe("G-101HMD03VD");
    expect(cmd3[0]).toBe("event");
    expect(cmd3[1]).toBe("page_view");
  });

  it("sends exactly one config and one page_view (idempotent)", async () => {
    cookies.set("shell_analytics_consent", "accepted");
    const { loadGtag } = await import("../web/analytics");
    loadGtag();
    loadGtag();

    const dataLayer = dom.window.dataLayer as unknown[];
    const configs = dataLayer.filter((e) => (e as IArguments)[0] === "config");
    const pageViews = dataLayer.filter((e) => (e as IArguments)[0] === "event" && (e as IArguments)[1] === "page_view");
    expect(configs.length).toBe(1);
    expect(pageViews.length).toBe(1);
  });

  it("sets ga-disable flag to false on load", async () => {
    cookies.set("shell_analytics_consent", "accepted");
    const { loadGtag } = await import("../web/analytics");
    loadGtag();

    expect(dom.window["ga-disable-G-101HMD03VD"]).toBe(false);
  });

  it("withdraw sets ga-disable true and sends consent denial", async () => {
    cookies.set("shell_analytics_consent", "accepted");
    const { loadGtag, withdrawAnalytics } = await import("../web/analytics");
    loadGtag();
    withdrawAnalytics();

    expect(dom.window["ga-disable-G-101HMD03VD"]).toBe(true);

    const dataLayer = dom.window.dataLayer as unknown[];
    const updates = dataLayer.filter((e) => (e as IArguments)[0] === "consent" && (e as IArguments)[1] === "update") as IArguments[];
    expect(updates.length).toBe(1);
    const consentState = updates[0][2] as Record<string, string>;
    expect(consentState.analytics_storage).toBe("denied");
    expect(consentState.ad_storage).toBe("denied");
  });

  it("withdraw removes only shell_public_ga cookies, preserves consent and unrelated", async () => {
    cookies.set("shell_analytics_consent", "accepted");
    cookies.set("shell_public_ga", "ABC123");
    cookies.set("shell_public_ga0", "XYZ789");
    cookies.set("unrelated_cookie", "value");
    cookies.set("session_token", "secret");

    const { loadGtag, withdrawAnalytics } = await import("../web/analytics");
    loadGtag();
    withdrawAnalytics();

    expect(cookies.has("shell_public_ga")).toBe(false);
    expect(cookies.has("shell_public_ga0")).toBe(false);
    expect(cookies.get("shell_analytics_consent")).toBe("declined");
    expect(cookies.get("unrelated_cookie")).toBe("value");
    expect(cookies.get("session_token")).toBe("secret");
  });

  it("accept after withdraw re-enables and sends consent granted", async () => {
    cookies.set("shell_analytics_consent", "accepted");
    const { loadGtag, withdrawAnalytics, acceptAnalytics } = await import("../web/analytics");
    loadGtag();
    withdrawAnalytics();
    acceptAnalytics();

    expect(dom.window["ga-disable-G-101HMD03VD"]).toBe(false);
    expect(cookies.get("shell_analytics_consent")).toBe("accepted");

    const dataLayer = dom.window.dataLayer as unknown[];
    const updates = dataLayer.filter((e) => (e as IArguments)[0] === "consent" && (e as IArguments)[1] === "update") as IArguments[];
    expect(updates.length).toBe(2);
    expect((updates[1][2] as Record<string, string>).analytics_storage).toBe("granted");
  });

  it("does not load gtag on private session paths even with saved accept", async () => {
    vi.resetModules();
    cookies = new Map([["shell_analytics_consent", "accepted"]]);
    dom = installDom("https://shell.online/s/abcdefghijklmnopqrstuvwxyz012345/", cookies);
    const { loadGtag } = await import("../web/analytics");
    loadGtag();

    expect(dom.window.dataLayer).toBeUndefined();
  });

  it("does not load gtag on URLs with query strings", async () => {
    vi.resetModules();
    cookies = new Map([["shell_analytics_consent", "accepted"]]);
    dom = installDom("https://shell.online/?ref=google", cookies);
    const { loadGtag } = await import("../web/analytics");
    loadGtag();

    expect(dom.window.dataLayer).toBeUndefined();
  });

  it("does not load gtag on URLs with fragments", async () => {
    vi.resetModules();
    cookies = new Map([["shell_analytics_consent", "accepted"]]);
    dom = installDom("https://shell.online/#e2ee=secret", cookies);
    const { loadGtag } = await import("../web/analytics");
    loadGtag();

    expect(dom.window.dataLayer).toBeUndefined();
  });

  it("does not load gtag on other hosts even with saved accept", async () => {
    vi.resetModules();
    cookies = new Map([["shell_analytics_consent", "accepted"]]);
    dom = installDom("https://app.shell.online/", cookies);
    const { loadGtag } = await import("../web/analytics");
    loadGtag();

    expect(dom.window.dataLayer).toBeUndefined();
  });

  it("acceptAnalytics fails closed when cookie readback returns empty", async () => {
    vi.resetModules();
    cookies = new Map();
    dom = installDom("https://shell.online/", cookies);
    // Override cookie getter to always return empty (simulates blocked cookies)
    Object.defineProperty(dom.document, "cookie", {
      get: () => "",
      set: (_v: string) => {},
      configurable: true,
    });
    const { acceptAnalytics } = await import("../web/analytics");
    acceptAnalytics();

    expect(dom.window["ga-disable-G-101HMD03VD"]).toBeUndefined();
    expect(dom.window.dataLayer).toBeUndefined();
  });

  it("script element has referrerPolicy no-referrer and correct src", async () => {
    cookies.set("shell_analytics_consent", "accepted");
    const { loadGtag } = await import("../web/analytics");
    loadGtag();

    expect(dom.headChildren.length).toBe(1);
    const script = dom.headChildren[0] as { tagName: string; referrerPolicy: string; src: string };
    expect(script.tagName).toBe("script");
    expect(script.referrerPolicy).toBe("no-referrer");
    expect(script.src).toBe("https://www.googletagmanager.com/gtag/js?id=G-101HMD03VD");
  });
});
