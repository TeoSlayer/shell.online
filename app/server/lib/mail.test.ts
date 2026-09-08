import { describe, expect, it, vi } from "vitest";
import {
  SENDGRID_URL,
  createMailer,
  httpMailer,
  invitationMessage,
  logMailer,
  parseAddress,
  sendgridMailer,
} from "./mail";

const INVITATION = {
  to: "bruno@example.com",
  inviterName: "Ana Ruiz",
  organizationName: "Vulture Labs",
  joinUrl: "https://app.shell.online/join/inv_0123456789abcdef0123456789abcdef",
  expiresAt: Date.parse("2026-09-14T00:00:00Z"),
};

const NOW = Date.parse("2026-09-07T00:00:00Z");

describe("invitationMessage", () => {
  it("names who is inviting and what they are inviting you to", () => {
    const message = invitationMessage(INVITATION, NOW);
    expect(message.subject).toContain("Ana Ruiz");
    expect(message.subject).toContain("Vulture Labs");
    expect(message.to).toBe("bruno@example.com");
  });

  it("carries the link on the button and again in the open", () => {
    const message = invitationMessage(INVITATION, NOW);
    /*
     * A button and a plain link, because a mail client that strips the styled
     * anchor still has to leave something a person can paste.
     */
    expect(message.html).toMatch(/Join Vulture Labs<\/a>/);
    expect(message.html.match(new RegExp(INVITATION.joinUrl, "g"))?.length).toBeGreaterThanOrEqual(2);
    expect(message.text).toContain(INVITATION.joinUrl);
  });

  it("says how long the link lasts", () => {
    expect(invitationMessage(INVITATION, NOW).text).toContain("7 days");
    const tomorrow = { ...INVITATION, expiresAt: NOW + 24 * 60 * 60 * 1000 };
    expect(invitationMessage(tomorrow, NOW).text).toContain("one more day");
    expect(invitationMessage({ ...INVITATION, expiresAt: NOW - 1 }, NOW).text).toContain("expired");
  });

  /*
   * Every value in this message came from a person. One of them containing a
   * bracket must not be able to close a tag in mail the service sends out on
   * their behalf.
   */
  it("escapes names that contain markup", () => {
    const message = invitationMessage(
      {
        ...INVITATION,
        inviterName: `<script>alert(1)</script>`,
        organizationName: `Ben & Jerry's <b>`,
      },
      NOW,
    );
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.html).toContain("Ben &amp; Jerry&#39;s");
  });

  it("styles itself inline, since a mail client loads no stylesheet", () => {
    const message = invitationMessage(INVITATION, NOW);
    expect(message.html).not.toContain("<style");
    expect(message.html).not.toContain("<link");
    /* The landing page's paper and ink block, from web/landing.css. */
    expect(message.html).toContain("#f3f1e9");
    expect(message.html).toContain("#1d201b");
  });

  /*
   * The em-dash is the house tell. It is banned in everything the project
   * ships, and an email is read in more places than a page is.
   */
  it("contains no em-dashes", () => {
    const message = invitationMessage(INVITATION, NOW);
    expect(message.html).not.toMatch(/[\u2013\u2014]/);
    expect(message.text).not.toMatch(/[\u2013\u2014]/);
    expect(message.subject).not.toMatch(/[\u2013\u2014]/);
  });

  /*
   * The preheader is the preview line a client shows beside the subject. It
   * must repeat what the message already says: hidden text that differs from
   * the visible body is what filters look for, so padding it with keywords
   * would cost deliverability rather than buy it.
   */
  it("hides only text the message already shows", () => {
    const message = invitationMessage(INVITATION, NOW);
    const hidden = message.html.match(/<div style="display:none[^"]*">([^<]*)<\/div>/)?.[1] ?? "";
    expect(hidden).toContain("Ana Ruiz");
    expect(hidden).toContain("Vulture Labs");
    /* Every word of it appears again where a reader can see it. */
    const visible = message.html.slice(message.html.indexOf("</div>"));
    for (const word of ["Ana Ruiz", "Vulture Labs"]) expect(visible).toContain(word);
  });

  it("declares itself light, so a client does not invert it", () => {
    expect(invitationMessage(INVITATION, NOW).html).toContain('name="color-scheme" content="light"');
  });

  it("offers a plain text alternative", () => {
    const message = invitationMessage(INVITATION, NOW);
    expect(message.text).not.toContain("<");
    expect(message.text).toContain("Ana Ruiz");
  });
});

describe("httpMailer", () => {
  it("posts the message the way the common providers accept it", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const mailer = httpMailer(
      { apiUrl: "https://api.example.com/emails", apiKey: "secret", from: "shell.online <no-reply@shell.online>" },
      fetcher as unknown as typeof fetch,
    );
    await mailer.send({ to: "b@example.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi" });

    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.example.com/emails");
    expect(options.headers.authorization).toBe("Bearer secret");
    const body = JSON.parse(options.body);
    expect(body.to).toEqual(["b@example.com"]);
    expect(body.from).toContain("no-reply@shell.online");
  });

  /*
   * The provider's body usually names the field it disliked. Without it the
   * only symptom is an invitation nobody ever receives.
   */
  it("reports what the provider said when it refuses", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(`{"message":"from address is not verified"}`, { status: 422 }),
    );
    const mailer = httpMailer(
      { apiUrl: "https://api.example.com/emails", apiKey: "secret", from: "x@example.com" },
      fetcher as unknown as typeof fetch,
    );
    await expect(
      mailer.send({ to: "b@example.com", subject: "Hi", html: "", text: "" }),
    ).rejects.toThrow(/422.*not verified/);
  });
});

describe("createMailer", () => {
  it("logs when nothing is configured, link included", async () => {
    const lines: string[] = [];
    const mailer = createMailer({}, (line) => lines.push(line));
    await mailer.send(invitationMessage(INVITATION, NOW));
    /* Locally there is no inbox to check, so the link has to be in the log. */
    expect(lines.join("\n")).toContain(INVITATION.joinUrl);
  });

  it("needs all three settings before it will send for real", () => {
    const partial = createMailer({ apiUrl: "https://api.example.com/emails", apiKey: "k" });
    /* Same shape as the logging one, so a missing From cannot send nowhere. */
    expect(partial).not.toBe(null);
    expect(createMailer({}).send).toBeTypeOf("function");
  });
});

describe("logMailer", () => {
  it("does not throw when there is nowhere to send", async () => {
    await expect(logMailer(() => {}).send(invitationMessage(INVITATION, NOW))).resolves.toBeUndefined();
  });
});

describe("sendgridMailer", () => {
  it("sends the shape SendGrid accepts, not the flat one", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 202 }));
    const mailer = sendgridMailer(
      { apiKey: "SG.key", from: "shell.online <no-reply@shell.online>" },
      fetcher as unknown as typeof fetch,
    );
    await mailer.send(invitationMessage(INVITATION, NOW));

    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe(SENDGRID_URL);
    expect(options.headers.authorization).toBe("Bearer SG.key");
    const body = JSON.parse(options.body);
    /* Nested, which is the whole reason this cannot share a builder. */
    expect(body.personalizations[0].to[0].email).toBe("bruno@example.com");
    expect(body.from).toEqual({ email: "no-reply@shell.online", name: "shell.online" });
    /* Plain text first: RFC 2046 puts the richest alternative last. */
    expect(body.content[0].type).toBe("text/plain");
    expect(body.content[1].type).toBe("text/html");
  });

  it("treats 202 as sent, since that is what SendGrid returns", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 202 }));
    const mailer = sendgridMailer({ apiKey: "k", from: "a@b.c" }, fetcher as unknown as typeof fetch);
    await expect(mailer.send(invitationMessage(INVITATION, NOW))).resolves.toBeUndefined();
  });

  /* Almost always an unverified sender, and worth reading in the log. */
  it("surfaces what SendGrid objected to", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(`{"errors":[{"message":"The from address does not match a verified Sender Identity"}]}`, {
        status: 403,
      }),
    );
    const mailer = sendgridMailer({ apiKey: "k", from: "a@b.c" }, fetcher as unknown as typeof fetch);
    await expect(mailer.send(invitationMessage(INVITATION, NOW))).rejects.toThrow(
      /403.*verified Sender Identity/,
    );
  });
});

describe("parseAddress", () => {
  it("splits a display name from the address", () => {
    expect(parseAddress("shell.online <no-reply@shell.online>")).toEqual({
      email: "no-reply@shell.online",
      name: "shell.online",
    });
  });

  it("passes a bare address through", () => {
    expect(parseAddress("no-reply@shell.online")).toEqual({ email: "no-reply@shell.online" });
  });

  it("strips quotes some clients put round the name", () => {
    expect(parseAddress('"shell.online" <no-reply@shell.online>').name).toBe("shell.online");
  });
});

describe("what SendGrid is told not to do", () => {
  /*
   * Click tracking rewrites the href to a redirector while the body still
   * shows the real URL. A reader who checks where a link goes finds it goes
   * somewhere else, which is what phishing looks like and what filters score.
   */
  it("turns off link rewriting and the tracking pixel", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 202 }));
    const mailer = sendgridMailer({ apiKey: "k", from: "a@b.c" }, fetcher as unknown as typeof fetch);
    await mailer.send(invitationMessage(INVITATION, NOW));

    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.tracking_settings.click_tracking.enable).toBe(false);
    expect(body.tracking_settings.open_tracking.enable).toBe(false);
  });

  it("keeps the href and the visible URL identical", () => {
    const message = invitationMessage(INVITATION, NOW);
    const hrefs = [...message.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(hrefs)).toEqual(new Set([INVITATION.joinUrl]));
  });
});
