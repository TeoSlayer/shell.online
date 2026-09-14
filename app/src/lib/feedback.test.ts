import { describe, expect, it } from "vitest";
import { APP_VERSION, describeBrowser, routeForFeedback, trimContext } from "./feedback";

describe("describeBrowser", () => {
  it("names the browser and the system, in that order", () => {
    expect(
      describeBrowser(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome 129 on macOS");
  });

  it("tells Edge from the Chrome it is built on", () => {
    expect(
      describeBrowser(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
      ),
    ).toBe("Edge 129 on Windows");
  });

  it("tells Safari from the Safari token every WebKit browser carries", () => {
    expect(
      describeBrowser(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari 17 on iOS");
  });

  it("says so when it does not know", () => {
    expect(describeBrowser("curl/8.4.0")).toBe("Unknown browser");
  });
});

describe("routeForFeedback", () => {
  it("keeps the path and drops what could name a session or carry a key", () => {
    expect(routeForFeedback("/sessions?open=s1#k3y")).toBe("/sessions");
    expect(routeForFeedback("/account")).toBe("/account");
    expect(routeForFeedback("")).toBe("/");
  });
});

describe("trimContext", () => {
  it("keeps only facts with something in them", () => {
    expect(trimContext({ host: " laptop ", empty: "  ", missing: undefined })).toEqual({ host: "laptop" });
    expect(trimContext()).toEqual({});
  });
});

describe("APP_VERSION", () => {
  it("has a value wherever nothing stamped one", () => {
    expect(APP_VERSION).toBe("dev");
  });
});
