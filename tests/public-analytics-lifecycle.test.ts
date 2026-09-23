import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("initAnalytics automatic public-page analytics", () => {
  let cookies: CookieJar;
  let dom: ReturnType<typeof makeDom>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    cookies = new Map();
    dom = installDom("https://shell.online/", cookies);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("initializes automatically on fresh visit without prior cookies", async () => {
    const { initAnalytics } = await import("../web/analytics");
    initAnalytics();

    const dataLayer = dom.window.dataLayer as unknown[];
    expect(dataLayer).toBeDefined();
    expect(dataLayer.length).toBe(4);
  });

  it("queues standard Arguments commands in correct order", async () => {
    const { initAnalytics } = await import("../web/analytics");
    initAnalytics();

    const dataLayer = dom.window.dataLayer as unknown[];
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
    const { initAnalytics } = await import("../web/analytics");
    initAnalytics();
    initAnalytics();

    const dataLayer = dom.window.dataLayer as unknown[];
    const configs = dataLayer.filter((e) => (e as IArguments)[0] === "config");
    const pageViews = dataLayer.filter((e) => (e as IArguments)[0] === "event" && (e as IArguments)[1] === "page_view");
    expect(configs.length).toBe(1);
    expect(pageViews.length).toBe(1);
  });

  it("does not render any banner, dialog, or preferences DOM controls", async () => {
    const { initAnalytics } = await import("../web/analytics");
    initAnalytics();

    expect(dom.bodyChildren.length).toBe(0);
  });

  it("does not write any consent or preferences cookie", async () => {
    const { initAnalytics } = await import("../web/analytics");
    initAnalytics();

    expect(cookies.has("shell_analytics_consent")).toBe(false);
  });

  it("does not emit analytics_storage granted (no fake consent)", async () => {
    const { initAnalytics } = await import("../web/analytics");
    initAnalytics();

    const dataLayer = dom.window.dataLayer as unknown[];
    const consentCmd = (dataLayer[0] as IArguments);
    const consentState = consentCmd[2] as Record<string, string>;
    expect(consentState).not.toHaveProperty("analytics_storage");
    expect(consentState.ad_storage).toBe("denied");
    expect(consentState.ad_user_data).toBe("denied");
    expect(consentState.ad_personalization).toBe("denied");
  });

  it("stays off when legacy explicit decline cookie exists", async () => {
    cookies.set("shell_analytics_consent", "declined");
    const { initAnalytics } = await import("../web/analytics");
    initAnalytics();

    expect(dom.window.dataLayer).toBeUndefined();
  });

  it("honors the shared opt-out for GA and first-party events even with an older granted cookie", async () => {
    cookies.set("shell_analytics_consent", "granted");
    cookies.set("shell_analytics_opt_out", "1");
    const { initAnalytics, trackPublicEvent } = await import("../web/analytics");
    initAnalytics(); trackPublicEvent("copy", "install");
    expect(dom.window.dataLayer).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops explicit public action events if opt-out is set after initialization", async () => {
    const { initAnalytics, trackPublicEvent } = await import("../web/analytics");
    initAnalytics();
    const count = (dom.window.dataLayer as unknown[]).length;
    vi.mocked(fetch).mockClear();
    cookies.set("shell_analytics_opt_out", "1");
    trackPublicEvent("copy", "install");
    expect((dom.window.dataLayer as unknown[]).length).toBe(count);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stays off when GPC is set", async () => {
    Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
    const { initAnalytics } = await import("../web/analytics");
    initAnalytics();
    Object.defineProperty(navigator, "globalPrivacyControl", { value: undefined, configurable: true });

    expect(dom.window.dataLayer).toBeUndefined();
  });

  it("stays off when existing ga-disable flag is true", async () => {
    dom.window["ga-disable-G-101HMD03VD"] = true;
    const { initAnalytics } = await import("../web/analytics");
    initAnalytics();

    expect(dom.window.dataLayer).toBeUndefined();
  });

  it("does not load on private session paths", async () => {
    vi.resetModules();
    cookies = new Map();
    dom = installDom("https://shell.online/s/abcdefghijklmnopqrstuvwxyz012345/", cookies);
    const { initAnalytics } = await import("../web/analytics");
    initAnalytics();

    expect(dom.window.dataLayer).toBeUndefined();
  });

  it("loads on a supported campaign URL with a canonical location", async () => {
    vi.resetModules();
    cookies = new Map();
    dom = installDom("https://shell.online/?ref=google", cookies);
    const { initAnalytics } = await import("../web/analytics");
    initAnalytics();

    expect(dom.window.dataLayer).toBeDefined();
    const config = (dom.window.dataLayer as IArguments[])[2][2];
    expect(config.page_location).toBe("https://shell.online/");
    expect(config.campaign_source).toBe("google");
  });

  it("does not load on URLs with fragments", async () => {
    vi.resetModules();
    cookies = new Map();
    dom = installDom("https://shell.online/#e2ee=secret", cookies);
    const { initAnalytics } = await import("../web/analytics");
    initAnalytics();

    expect(dom.window.dataLayer).toBeUndefined();
  });

  it("does not load on other hosts", async () => {
    vi.resetModules();
    cookies = new Map();
    dom = installDom("https://app.shell.online/", cookies);
    const { initAnalytics } = await import("../web/analytics");
    initAnalytics();

    expect(dom.window.dataLayer).toBeUndefined();
  });

  it("script element has referrerPolicy no-referrer and correct src", async () => {
    const { initAnalytics } = await import("../web/analytics");
    initAnalytics();

    expect(dom.headChildren.length).toBe(1);
    const script = dom.headChildren[0] as { tagName: string; referrerPolicy: string; src: string };
    expect(script.tagName).toBe("script");
    expect(script.referrerPolicy).toBe("no-referrer");
    expect(script.src).toBe("https://www.googletagmanager.com/gtag/js?id=G-101HMD03VD");
  });
});
