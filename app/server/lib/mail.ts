/**
 * Sending an invitation by email.
 *
 * An invite is a link, and a link somebody has to be told about by hand is an
 * invite that mostly does not get accepted. So the service sends it.
 *
 * No mail library: both providers below are one HTTPS POST, and a dependency
 * that exists to build a JSON body is a dependency to keep patched for
 * nothing. With nothing configured the message is logged instead, which is
 * what a developer wants and what keeps an unconfigured deployment from
 * failing an invite that is otherwise perfectly good.
 */

export interface Message {
  to: string;
  subject: string;
  html: string;
  /** Plain text alternative, for clients that will not render HTML. */
  text: string;
}

export interface Mailer {
  send(message: Message): Promise<void>;
}

export interface MailConfig {
  /**
   * Which provider's API shape to speak. SendGrid nests the recipient inside
   * personalizations and the body inside content, so it cannot share a request
   * builder with the flat providers.
   */
  provider?: "sendgrid" | "json";
  /** Where to POST the message. Absent means nothing is sent. */
  apiUrl?: string;
  apiKey?: string;
  /** The From address. Required alongside apiUrl. */
  from?: string;
}

/* SendGrid's only send endpoint, so the deployment need not supply it. */
export const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";

/**
 * Splits "Name <address@example.com>" into the parts SendGrid wants.
 *
 * Every other provider takes the whole string; SendGrid takes an object and
 * rejects the combined form, so the From has to be pulled apart here rather
 * than configured twice.
 */
export function parseAddress(value: string): { email: string; name?: string } {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!match) return { email: value.trim() };
  const name = match[1].replace(/^"|"$/g, "").trim();
  return name ? { email: match[2].trim(), name } : { email: match[2].trim() };
}

/**
 * Logs what would have been sent.
 *
 * The link is in the log on purpose: locally there is no inbox to check, and
 * an invite you cannot open is not testable.
 */
export function logMailer(log: (message: string) => void = console.log): Mailer {
  return {
    async send(message) {
      log(`mail: would send "${message.subject}" to ${message.to}\n${message.text}`);
    },
  };
}

/**
 * SendGrid.
 *
 * It answers a successful send with 202 and an empty body, and a rejection
 * with a JSON `errors` array that names the field it disliked -- almost always
 * an unverified sender. That message is worth surfacing: without it the only
 * symptom is an invitation nobody receives.
 */
export function sendgridMailer(
  config: { apiKey: string; from: string },
  fetcher = fetch,
): Mailer {
  const from = parseAddress(config.from);
  return {
    async send(message) {
      const response = await fetcher(SENDGRID_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }] }],
          from,
          subject: message.subject,
          /* Plain text first: RFC 2046 says the richest alternative goes last. */
          content: [
            { type: "text/plain", value: message.text },
            { type: "text/html", value: message.html },
          ],
          /*
           * Both trackers off, per message, whatever the account defaults are.
           *
           * Click tracking rewrites every href to a redirector, so the URL a
           * reader sees in the body stops matching the URL the link actually
           * goes to. That mismatch is one of the oldest phishing signatures
           * there is, and filters weigh it accordingly. An invitation is a
           * link somebody is being asked to trust; it should go where it says
           * it goes. Open tracking adds a hidden pixel, for a metric nobody
           * here reads.
           */
          tracking_settings: {
            click_tracking: { enable: false, enable_text: false },
            open_tracking: { enable: false },
          },
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`sendgrid returned ${response.status}: ${detail.slice(0, 300)}`);
      }
    },
  };
}

/** Posts the message as a flat JSON body, which Resend and Postmark accept. */
export function httpMailer(config: { apiUrl: string; apiKey: string; from: string }, fetcher = fetch): Mailer {
  return {
    async send(message) {
      const response = await fetcher(config.apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          from: config.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });
      if (!response.ok) {
        /*
         * The body usually says which field the provider disliked, and
         * without it the only symptom is an invite nobody receives.
         */
        const detail = await response.text().catch(() => "");
        throw new Error(`mail provider returned ${response.status}: ${detail.slice(0, 200)}`);
      }
    },
  };
}

export function createMailer(config: MailConfig, log?: (message: string) => void): Mailer {
  if (config.provider === "sendgrid") {
    /* SendGrid supplies its own URL, so a key and a sender are enough. */
    if (config.apiKey && config.from) {
      return sendgridMailer({ apiKey: config.apiKey, from: config.from });
    }
    return logMailer(log);
  }
  if (config.apiUrl && config.apiKey && config.from) {
    return httpMailer({ apiUrl: config.apiUrl, apiKey: config.apiKey, from: config.from });
  }
  return logMailer(log);
}

/* ---- The invitation itself ---- */

export interface Invitation {
  to: string;
  /** Who is inviting them, for the sentence that explains why this arrived. */
  inviterName: string;
  organizationName: string;
  /** The full https URL that accepts the invite. */
  joinUrl: string;
  /** When the link stops working, as a millisecond epoch. */
  expiresAt: number;
}

/**
 * Escapes text for HTML.
 *
 * Every value below comes from a person: an organization name, a display name,
 * an address. One of them containing a bracket must not be able to close a tag
 * in a message the service sends on their behalf.
 */
function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function expiryPhrase(expiresAt: number, now: number): string {
  const days = Math.round((expiresAt - now) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "This link has expired.";
  if (days === 1) return "This link works for one more day.";
  return `This link works for ${days} days.`;
}

/*
 * The landing page's palette, from web/landing.css. Repeated rather than
 * imported: this string is rendered by a mail client, which never loads a
 * stylesheet and in many cases strips <style> entirely, so every rule has to
 * travel inline on the element it applies to.
 *
 * The site's primary control is a dark ink block with a lime prompt, not a
 * coloured button, so the call to action here is that block. An invitation
 * that looks like the site it leads to is doing part of the work of proving
 * it is genuine.
 */
const PAPER = "#f3f1e9";
const INK = "#191b18";
const INK_BLOCK = "#1d201b";
const INK_BORDER = "#22241f";
const ON_INK = "#f4f5ed";
const ACID = "#c8ff4d";
const LINE = "#d5d3ca";
const MUTED = "#686c63";
const QUIET = "#343831";

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Consolas, monospace";

export function invitationMessage(invitation: Invitation, now = Date.now()): Message {
  const organization = escape(invitation.organizationName);
  const inviter = escape(invitation.inviterName);
  const url = escape(invitation.joinUrl);
  const expiry = expiryPhrase(invitation.expiresAt, now);

  const subject = `${invitation.inviterName} invited you to ${invitation.organizationName} on shell.online`;

  /*
   * Table layout, because a mail client is not a browser: flexbox and grid are
   * unreliable across Outlook and older clients, and a centred table is the
   * one thing that has always worked.
   *
   * The hidden div is preheader text, which every client uses for the preview
   * line beside the subject. It repeats what the message says rather than
   * padding it with keywords: text a reader cannot see but a filter can is
   * exactly what filters score against, so the only safe hidden text is the
   * kind that is genuinely shown, just somewhere else.
   */
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};color:${INK};font-family:${FONT};-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${inviter} invited you to ${organization}. ${escape(expiry)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;">

          <tr>
            <td style="padding:0 4px 26px;">
              <span style="font-size:15px;font-weight:600;letter-spacing:-0.03em;color:${INK};">shell<span style="color:${MUTED};">.online</span></span>
            </td>
          </tr>

          <tr>
            <td style="padding:34px 34px 0;background:#ffffff;border:1px solid ${LINE};border-top-left-radius:12px;border-top-right-radius:12px;">
              <h1 style="margin:0;font-size:27px;line-height:1.15;font-weight:500;letter-spacing:-0.04em;color:${INK};">Join ${organization}.</h1>
              <p style="margin:16px 0 0;font-size:15px;line-height:1.62;color:${QUIET};">
                ${inviter} invited you to their team on shell.online, where terminal sessions and the agents running in them are shared as browser links.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:28px 34px 0;background:#ffffff;border-left:1px solid ${LINE};border-right:1px solid ${LINE};">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="border-radius:10px;background:${INK_BLOCK};border:1px solid ${INK_BORDER};">
                    <a href="${url}" style="display:inline-block;padding:15px 26px;font-size:14px;font-weight:540;color:${ON_INK};text-decoration:none;border-radius:10px;"><span style="color:${ACID};font-family:${MONO};">&rsaquo;</span>&nbsp;&nbsp;Join ${organization}</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 34px 30px;background:#ffffff;border-left:1px solid ${LINE};border-right:1px solid ${LINE};border-bottom:1px solid ${LINE};border-bottom-left-radius:12px;border-bottom-right-radius:12px;">
              <p style="margin:0;padding-top:22px;border-top:1px solid ${LINE};font-size:12.5px;line-height:1.6;color:${MUTED};">
                Or paste this into your browser:
              </p>
              <p style="margin:7px 0 0;font-size:12.5px;line-height:1.5;word-break:break-all;font-family:${MONO};">
                <a href="${url}" style="color:${QUIET};text-decoration:underline;">${url}</a>
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:22px 4px 0;">
              <p style="margin:0;font-size:12px;line-height:1.65;color:${MUTED};">
                ${escape(expiry)} If you were not expecting this, ignore it. Nothing happens until you open the link.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `${invitation.inviterName} invited you to join ${invitation.organizationName} on shell.online,`,
    "where terminal sessions and the agents running in them are shared as browser links.",
    "",
    "Join:",
    invitation.joinUrl,
    "",
    `${expiry} If you were not expecting this, ignore it. Nothing happens until you open the link.`,
  ].join("\n");

  return { to: invitation.to, subject, html, text };
}
