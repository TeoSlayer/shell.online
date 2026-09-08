/**
 * Sending an invitation by email.
 *
 * An invite is a link, and a link somebody has to be told about by hand is an
 * invite that mostly does not get accepted. So the service sends it.
 *
 * There is no mail dependency and no vendor in here. A mailer posts one JSON
 * body to a URL, which is the shape Resend, Postmark and Mailgun all accept,
 * so the deployment picks the provider and this file does not have an opinion.
 * With nothing configured the message is logged instead, which is what a
 * developer wants and what keeps an unconfigured deployment from failing an
 * invite that is otherwise perfectly good.
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
  /** Where to POST the message. Absent means nothing is sent. */
  apiUrl?: string;
  apiKey?: string;
  /** The From address. Required alongside apiUrl. */
  from?: string;
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

/** Posts the message as JSON, the way the common providers accept it. */
export function httpMailer(config: Required<MailConfig>, fetcher = fetch): Mailer {
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
 * The app's own palette, from src/styles/tokens.css. Repeated rather than
 * imported: this string is rendered by a mail client, which never loads the
 * stylesheet and in many cases strips <style> entirely, so every rule has to
 * travel inline on the element it applies to.
 */
const PAPER = "#f3f1e9";
const WHITE = "#fcfbf7";
const INK = "#191b18";
const MUTED = "#686c63";
const LINE = "#d7d5cc";
const BLUE = "#4267f5";

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

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
   */
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};color:${INK};font-family:${FONT};-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Join ${organization} on shell.online. ${escape(expiry)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:${WHITE};border:1px solid ${LINE};border-radius:14px;">
          <tr>
            <td style="padding:30px 32px 0;">
              <div style="font-size:15px;font-weight:600;letter-spacing:-0.03em;color:${INK};">shell<span style="color:${MUTED};">.online</span></div>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 0;">
              <h1 style="margin:0;font-size:23px;line-height:1.25;font-weight:500;letter-spacing:-0.035em;color:${INK};">You have been invited to ${organization}.</h1>
              <p style="margin:14px 0 0;font-size:15px;line-height:1.6;color:${MUTED};">
                ${inviter} invited you to join <strong style="color:${INK};font-weight:500;">${organization}</strong> on shell.online, where the team shares live terminal sessions and the agents running in them.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="border-radius:10px;background:${BLUE};">
                    <a href="${url}" style="display:inline-block;padding:13px 30px;font-size:15px;font-weight:500;color:#ffffff;text-decoration:none;border-radius:10px;">Join</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 0;">
              <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED};">
                If the button does not work, paste this into your browser:
              </p>
              <p style="margin:6px 0 0;font-size:13px;line-height:1.5;word-break:break-all;">
                <a href="${url}" style="color:${BLUE};text-decoration:underline;">${url}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 30px;">
              <p style="margin:0;padding-top:18px;border-top:1px solid ${LINE};font-size:12px;line-height:1.6;color:${MUTED};">
                ${escape(expiry)} If you were not expecting this, you can ignore it — nothing happens until you open the link.
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
    `${invitation.inviterName} invited you to join ${invitation.organizationName} on shell.online.`,
    "",
    "Join:",
    invitation.joinUrl,
    "",
    `${expiry} If you were not expecting this, you can ignore it - nothing happens until you open the link.`,
  ].join("\n");

  return { to: invitation.to, subject, html, text };
}
