import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { usePageTitle } from "../lib/page-title";
import { Wordmark } from "../components/Wordmark";

/*
 * Laid out like the Terms and styled by the same sheet. Every sentence here is
 * a claim about what the code does, so a change to what the service keeps, or
 * for how long, belongs in the same pull request as a change to this page.
 */
const SECTIONS = [
  { id: "who", title: "Who We Are" },
  { id: "what-we-keep", title: "What We Keep" },
  { id: "never-received", title: "What We Never Receive" },
  { id: "use", title: "How We Use It" },
  { id: "team", title: "What Your Team Sees" },
  { id: "providers", title: "Service Providers" },
  { id: "email", title: "Email" },
  { id: "browser", title: "What Your Browser Stores" },
  { id: "analytics", title: "Analytics" },
  { id: "retention", title: "How Long We Keep It" },
  { id: "deletion", title: "Deleting Your Account" },
  { id: "rights", title: "Your Rights" },
  { id: "security", title: "Security" },
  { id: "transfers", title: "Where Data Is Processed" },
  { id: "children", title: "Children" },
  { id: "changes", title: "Changes to This Policy" },
  { id: "contact", title: "Contact" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function numberOf(id: SectionId) {
  return SECTIONS.findIndex((section) => section.id === id) + 1;
}

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const index = numberOf(id) - 1;
  return (
    <section className="terms-section" id={id}>
      <h2>
        <span className="terms-number" aria-hidden="true">
          {index + 1}
        </span>
        {SECTIONS[index].title}
      </h2>
      {children}
    </section>
  );
}

function Ref({ id }: { id: SectionId }) {
  return <a href={`#${id}`}>section {numberOf(id)}</a>;
}

const CONTACT = "founders@pilotprotocol.network";

export function Privacy() {
  usePageTitle("Privacy policy");
  return (
    <main className="terms">
      <header className="terms-head">
        <Wordmark />
        <Link className="terms-head-link" to="/terms">
          Terms of service
        </Link>
      </header>

      <article className="terms-doc">
        <div className="terms-masthead">
          <h1>Privacy Policy</h1>
          <p className="terms-updated">
            Effective: 11 September 2026 · Last updated: 11 September 2026
          </p>
          <p className="terms-lede">
            This policy explains what personal data <b>Vulture Labs, Inc.</b>{" "}
            (&ldquo;we,&rdquo; &ldquo;us&rdquo;) keeps when you use
            shell.online, the <code>shell</code> command-line tool and the
            services behind them (the &ldquo;Services&rdquo;): why we keep it,
            who else handles it, how long it is kept, and how to delete it.
          </p>
          <p className="terms-lede">
            It sits beside the <Link to="/terms">Terms of Service</Link>, which
            describe the same system from the other side. Where the two use the
            same words, they mean the same things.
          </p>
        </div>

        <nav className="terms-toc" aria-labelledby="privacy-toc-title">
          <h2 id="privacy-toc-title">Contents</h2>
          <ol>
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        <Section id="who">
          <p>
            shell.online is operated by Vulture Labs, Inc., a Delaware
            corporation trading as Pilot Protocol. We decide what data the
            Services keep and why, which makes us responsible for it. You can
            reach us at <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
          </p>
          <p>
            You can use the <code>shell</code> CLI without an account. Without
            one, nothing in <Ref id="what-we-keep" /> is kept about you; the
            relay only carries your encrypted terminal traffic.
          </p>
        </Section>

        <Section id="what-we-keep">
          <p>With an account, the Services keep the following.</p>
          <dl className="terms-defs">
            <div>
              <dt>Your account</dt>
              <dd>
                Your email address, your name if you give one, and how you sign
                in: email and password, or Google. Google&rsquo;s Firebase
                Authentication holds the account and your password. We never
                see the password.
              </dd>
            </div>
            <div>
              <dt>Your team</dt>
              <dd>
                Its name, its members&rsquo; names, email addresses and roles,
                and its invitations, including the email address an invitation
                was sent to.
              </dd>
            </div>
            <div>
              <dt>Linked machines</dt>
              <dd>
                For each machine you link with <code>shell login</code>: a
                label, a random machine identifier, when it was linked and last
                seen, the public key used to seal session passwords to it, and
                which coding-agent commands it found on its <code>PATH</code>.
                Of its tokens we store only SHA-256 hashes.
              </dd>
            </div>
            <div>
              <dt>Session records</dt>
              <dd>
                For each session: the share link with its encryption key
                removed, the command line as written, the machine&rsquo;s host
                name, the session name, its flags, when it started and ended,
                and its exit code.
              </dd>
            </div>
            <div>
              <dt>What is typed from a browser</dt>
              <dd>
                Commands, prompts and anything else entered into a session from
                a browser, stored in plaintext, as the Terms describe. What is
                typed in the terminal a session was started from is not sent to
                us.
              </dd>
            </div>
            <div>
              <dt>Collaboration</dt>
              <dd>
                Comments, @mentions, notifications, assignments and handoffs.
              </dd>
            </div>
            <div>
              <dt>Your session vault</dt>
              <dd>
                If you enable it: its public key, its private key encrypted
                under a random vault key, and encrypted wrappers that let your
                password, recovery key or supported passkey unlock that key in
                your browser. The vault is personal, not shared by your team.
              </dd>
            </div>
            <div>
              <dt>Sealed passwords</dt>
              <dd>
                Session passwords sealed to you or to your machines. We store
                and pass them on, but cannot open them.
              </dd>
            </div>
            <div>
              <dt>Browser-started sessions</dt>
              <dd>
                When you start a session from a browser, its command line and a
                sealed password wait for your machine to collect them.
              </dd>
            </div>
          </dl>
        </Section>

        <Section id="never-received">
          <p>
            Terminal output, which is end-to-end encrypted and reaches us only
            as ciphertext. The encryption key in a share link, which browsers
            never send to a server. Session passwords in a form we can read.
            Your vault password, recovery key, passkey secret or unwrapped
            vault key. The contents of your files and
            projects.
          </p>
          <p>
            We use no advertising trackers, and the web app sets no cookies of
            its own.
          </p>
        </Section>

        <Section id="use">
          <ul className="terms-list">
            <li>
              To provide the Services: signing you in, showing your team its
              sessions, relaying terminal traffic, and delivering sealed
              passwords to the machines that need them.
            </li>
            <li>
              To keep them working and safe: limiting how often one network
              address may call the service (the address is held in memory for
              that and not stored), and asking for a recent sign-in before a
              change that cannot be undone.
            </li>
            <li>To send the email described in <Ref id="email" />.</li>
          </ul>
          <p>
            We do not sell personal data, and we do not share it for
            advertising.
          </p>
        </Section>

        <Section id="team">
          <p>
            A team is a shared workspace. Everyone in your team can see every
            member&rsquo;s session records, what was typed into sessions from a
            browser, comments and handoff history, and the names, email
            addresses and roles of the team&rsquo;s members. Anyone you give a
            share link and its password can watch that session, and type into
            it unless it is read-only.
          </p>
        </Section>

        <Section id="providers">
          <p>These companies handle data for us to run the Services:</p>
          <dl className="terms-defs">
            <div>
              <dt>Google</dt>
              <dd>
                Firebase Authentication, for accounts, sign-in, and the emails
                that verify an address or reset a password. Google Cloud, in
                the United States, for the database and the machine that
                connects to it.
              </dd>
            </div>
            <div>
              <dt>Cloudflare</dt>
              <dd>
                Hosts the web app, the service behind it and the relay that
                carries encrypted terminal traffic, and carries the network
                traffic to all three.
              </dd>
            </div>
            <div>
              <dt>Twilio SendGrid</dt>
              <dd>Sends team invitation emails.</dd>
            </div>
          </dl>
          <p>
            Each handles data only to provide its service to us. We do not
            share personal data with anyone else, except where the law
            requires it.
          </p>
        </Section>

        <Section id="email">
          <p>
            Firebase sends the email that verifies your address and the one
            that resets your password. SendGrid sends team invitations. An
            invitation contains the inviter&rsquo;s name, the team&rsquo;s name
            and a link to join, with click and open tracking turned off. We
            send no marketing email.
          </p>
        </Section>

        <Section id="browser">
          <p>The web app keeps these in your browser:</p>
          <dl className="terms-defs">
            <div>
              <dt>Sign-in state</dt>
              <dd>Firebase keeps you signed in using the browser&rsquo;s local storage.</dd>
            </div>
            <div>
              <dt>Your unlocked vault</dt>
              <dd>
                A key held in IndexedDB that script cannot read out, so the
                browser can open session passwords without asking for your
                recovery key every time. Signing out removes it.
              </dd>
            </div>
            <div>
              <dt>Cached session passwords</dt>
              <dd>In local storage, kept apart for each account.</dd>
            </div>
            <div>
              <dt>Tabs and view</dt>
              <dd>
                Which sessions you had open, and whether you use the list or
                the board.
              </dd>
            </div>
            <div>
              <dt>An older key pair</dt>
              <dd>
                A browser used before the vault existed may still hold one in
                local storage.
              </dd>
            </div>
          </dl>
          <p>
            Deleting your account clears the first four from the browser you
            delete it from. Clearing this site&rsquo;s data in your browser
            clears all of them.
          </p>
        </Section>

        <Section id="analytics">
          <p>
            The web app runs no analytics. The shell.online site and the relay
            count events such as page views, installer downloads and sessions
            opened, with a device class, a client name and the referring site.
            They record no IP addresses, session identifiers, URLs, commands,
            terminal content or full user-agent strings.
          </p>
        </Section>

        <Section id="retention">
          <ul className="terms-list">
            <li>
              Account, team, machine and session records: until you delete
              them, or delete your account.
            </li>
            <li>
              The codes that complete <code>shell login</code> expire within
              minutes. A browser-started session&rsquo;s command is deleted ten
              minutes after the machine finishes it.
            </li>
            <li>
              An unlinked machine&rsquo;s token stops working at once. The
              record that it was linked stays until you delete your account.
            </li>
            <li>
              The activity trail, comments and handoffs stay with the team for
              as long as the team exists.
            </li>
            <li>
              When an account is deleted, its user identifier alone is kept for
              two hours, so a browser still signed in to it cannot bring it
              back.
            </li>
            <li>
              The database keeps seven daily backups and seven days of
              transaction logs, so deleted data is gone from backups within
              eight days.
            </li>
            <li>
              The service keeps no request logs of its own. When something
              fails, it writes an error message to our hosting provider&rsquo;s
              logs, which can include details of the request that failed, such
              as the address of an invitation that could not be sent.
            </li>
          </ul>
        </Section>

        <Section id="deletion">
          <p>
            Delete your account from the Account page. You type your email
            address and sign in once more, and then:
          </p>
          <ul className="terms-list">
            <li>your account is removed from Firebase Authentication;</li>
            <li>every machine you linked is unlinked, and its tokens stop working;</li>
            <li>
              your session records, and the session passwords sealed to you,
              are deleted;
            </li>
            <li>your vault, comments and notifications are deleted;</li>
            <li>if nobody else is in your team, the team and everything in it is deleted;</li>
            <li>
              if others are, what you typed into sessions stays in the
              team&rsquo;s activity trail, no longer linked to your email
              address, because it is part of the record of what happened on
              their machines;
            </li>
            <li>
              if you owned the team, ownership passes to its longest-standing
              admin or, if it has none, its longest-standing member;
            </li>
            <li>
              this browser&rsquo;s copies of your vault key, cached passwords
              and open tabs are cleared.
            </li>
          </ul>
          <p>
            Processes on your machines keep running, and share links you gave
            out keep working until those sessions end. Anything a teammate
            already exported, such as an audit CSV, is theirs, and we cannot
            recall it.
          </p>
          <p>
            If you cannot sign in, email{" "}
            <a href={`mailto:${CONTACT}`}>{CONTACT}</a> from the address on the
            account and we will delete it for you.
          </p>
        </Section>

        <Section id="rights">
          <p>
            Depending on where you live, you may have the right to access,
            correct, export or delete your personal data, to object to or
            restrict how we use it, and to complain to a data protection
            authority. Deletion is in the app. For anything else, email{" "}
            <a href={`mailto:${CONTACT}`}>{CONTACT}</a>. We answer within 30
            days, and we will not treat you differently for asking.
          </p>
          <p>
            If you are in the European Economic Area or the United Kingdom: we
            keep account, team and session data because it is needed to provide
            the Services you asked for. We keep the team&rsquo;s activity trail
            and the safeguards described above because a team has a legitimate
            interest in a record of what was done on its machines, and in a
            service that resists abuse.
          </p>
        </Section>

        <Section id="security">
          <p>
            Terminal traffic is end-to-end encrypted between your browser and
            your machine. Traffic to the service uses TLS. Machine tokens are
            stored as hashes, and your vault is encrypted under a key we never
            receive. No system is perfectly secure; if you find a weakness,
            tell us at <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
          </p>
        </Section>

        <Section id="transfers">
          <p>
            The database is in the United States, and Cloudflare handles
            traffic in data centers around the world. If you use the Services
            from outside the United States, your data is transferred to and
            processed there.
          </p>
        </Section>

        <Section id="children">
          <p>
            The Services are not directed at children under 16, and we do not
            knowingly keep data about them. If you believe a child has an
            account, email us and we will delete it.
          </p>
        </Section>

        <Section id="changes">
          <p>
            We will post changes to this page and update the &ldquo;Last
            updated&rdquo; date. For material changes, we will give additional
            notice, by a banner in the app or by email.
          </p>
        </Section>

        <Section id="contact">
          <p>
            Email: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
          </p>
          <p>
            shell.online is operated by Vulture Labs, Inc., a Delaware
            corporation, trading as Pilot Protocol,{" "}
            <a href="https://pilotprotocol.network/" target="_blank" rel="noreferrer">
              pilotprotocol.network
            </a>
            .
          </p>
        </Section>

        <footer className="terms-foot">
          <Link to="/terms">Terms of service</Link>
          <span aria-hidden="true">·</span>
          <Link to="/signup">Create an account</Link>
          <span aria-hidden="true">·</span>
          <Link to="/login">Sign in</Link>
        </footer>
      </article>
    </main>
  );
}
