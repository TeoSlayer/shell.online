import { describe, expect, it } from "vitest";
import { buildRedirect, isValidRedirectUri } from "./redirect";

describe("isValidRedirectUri", () => {
  it("accepts loopback callbacks on an unprivileged port", async () => {
    expect(isValidRedirectUri("http://127.0.0.1:51234/callback")).toBe(true);
    expect(isValidRedirectUri("http://[::1]:51234/callback")).toBe(true);
  });

  it("rejects any host that is not loopback", async () => {
    /* This is the check that stops a crafted link forwarding a live code out. */
    expect(isValidRedirectUri("http://evil.example.com:8080/callback")).toBe(false);
    expect(isValidRedirectUri("http://169.254.169.254:80/callback")).toBe(false);
    expect(isValidRedirectUri("http://127.0.0.1.evil.com:8080/callback")).toBe(false);
    /* A hosts-file entry can point localhost somewhere other than loopback. */
    expect(isValidRedirectUri("http://localhost:8080/callback")).toBe(false);
  });

  it("rejects non-http schemes", async () => {
    expect(isValidRedirectUri("https://127.0.0.1:8080/callback")).toBe(false);
    expect(isValidRedirectUri("file:///callback")).toBe(false);
    expect(isValidRedirectUri("javascript:alert(1)")).toBe(false);
  });

  it("requires an explicit port", async () => {
    expect(isValidRedirectUri("http://127.0.0.1/callback")).toBe(false);
  });

  it("rejects privileged and out-of-range ports", async () => {
    expect(isValidRedirectUri("http://127.0.0.1:80/callback")).toBe(false);
    expect(isValidRedirectUri("http://127.0.0.1:1023/callback")).toBe(false);
    expect(isValidRedirectUri("http://127.0.0.1:70000/callback")).toBe(false);
  });

  it("requires exactly the /callback path", async () => {
    expect(isValidRedirectUri("http://127.0.0.1:8080/")).toBe(false);
    expect(isValidRedirectUri("http://127.0.0.1:8080/callback/extra")).toBe(false);
  });

  it("rejects embedded query, fragment or credentials", async () => {
    expect(isValidRedirectUri("http://127.0.0.1:8080/callback?next=x")).toBe(false);
    expect(isValidRedirectUri("http://127.0.0.1:8080/callback#x")).toBe(false);
    expect(isValidRedirectUri("http://user:pw@127.0.0.1:8080/callback")).toBe(false);
  });

  it("rejects malformed input without throwing", async () => {
    expect(isValidRedirectUri("")).toBe(false);
    expect(isValidRedirectUri("not a url")).toBe(false);
  });
});

describe("buildRedirect", () => {
  it("appends code and state as query parameters", async () => {
    const url = new URL(buildRedirect("http://127.0.0.1:9999/callback", "shc_abc", "st_1"));
    expect(url.origin).toBe("http://127.0.0.1:9999");
    expect(url.pathname).toBe("/callback");
    expect(url.searchParams.get("code")).toBe("shc_abc");
    expect(url.searchParams.get("state")).toBe("st_1");
  });

  it("escapes values rather than concatenating them", async () => {
    const url = new URL(buildRedirect("http://127.0.0.1:9999/callback", "a&b=c", "x y"));
    expect(url.searchParams.get("code")).toBe("a&b=c");
    expect(url.searchParams.get("state")).toBe("x y");
  });
});
