import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { usePageTitle } from "../lib/page-title";
import { Wordmark } from "../components/Wordmark";

/*
 * The section list is the single source for both the contents nav and the
 * headings, so a renamed or reordered section can never leave the two out of
 * step — the numbering below is derived from position, not written by hand.
 * Cross-references in the prose go through <Ref>, for the same reason.
 */
const SECTIONS = [
  { id: "scope", title: "Scope of These Terms" },
  { id: "tiers", title: "Service Tiers" },
  { id: "accounts", title: "Accounts and Teams" },
  { id: "your-machine", title: "What Runs on Your Machine" },
  { id: "browser-sessions", title: "Browser-Started Sessions" },
  { id: "harness-discovery", title: "Harness Discovery" },
  { id: "what-we-receive", title: "What Is Sent to the Service" },
  { id: "activity-records", title: "Activity Records" },
  { id: "never-received", title: "What Never Reaches Us" },
  { id: "sharing", title: "Share Links and Session Passwords" },
  { id: "ip", title: "Intellectual Property" },
  { id: "acceptable-use", title: "Acceptable Use" },
  { id: "obligations", title: "User Obligations" },
  { id: "disclaimers", title: "Disclaimers" },
  { id: "liability", title: "Limitation of Liability" },
  { id: "indemnification", title: "Indemnification" },
  { id: "termination", title: "Termination" },
  { id: "law", title: "Governing Law and Dispute Resolution" },
  { id: "changes", title: "Changes to These Terms" },
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

/* A cross-reference that renumbers itself when the section list changes. */
function Ref({ id }: { id: SectionId }) {
  return <a href={`#${id}`}>section {numberOf(id)}</a>;
}

function Tier({
  letter,
  title,
  children,
}: {
  letter: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="terms-tier">
      <h3>
        <span className="terms-letter" aria-hidden="true">
          {letter}
        </span>
        {title}
      </h3>
      {children}
    </div>
  );
}

const CONTACT = "founders@pilotprotocol.network";

export function Terms() {
  usePageTitle("Terms of service");
  return (
    <main className="terms">
      <header className="terms-head">
        <Wordmark />
        <Link className="terms-head-link" to="/signup">
          Create account
        </Link>
      </header>

      <article className="terms-doc">
        <div className="terms-masthead">
          <h1>Terms of Service</h1>
          <p className="terms-updated">
            Effective: 7 September 2026 · Last updated: 11 September 2026
          </p>
          <p className="terms-lede">
            These Terms of Service (&ldquo;Terms&rdquo;) are a binding agreement
            between <b>Vulture Labs, Inc.</b>, a Delaware corporation
            (&ldquo;Vulture Labs,&rdquo; &ldquo;Pilot Protocol,&rdquo;
            &ldquo;we,&rdquo; &ldquo;us,&rdquo; &ldquo;our&rdquo;) and you
            (&ldquo;you,&rdquo; &ldquo;User&rdquo;) governing your use of
            shell.online, the <code>shell</code> command-line tool, and the
            services behind them (together, the &ldquo;Services&rdquo;).
          </p>
          <p className="terms-lede">
            By using the Services, you agree to these Terms. If you do not
            agree, do not use the Services. shell.online shares a terminal
            process running on your own machine through a browser link, and
            these Terms are written to describe plainly what the software does
            on your machine, what leaves it, and what we each owe the other.
            The <Link to="/privacy">Privacy Policy</Link> describes the
            personal data we keep, who else handles it, and for how long.
          </p>
        </div>

        <nav className="terms-toc" aria-labelledby="terms-toc-title">
          <h2 id="terms-toc-title">Contents</h2>
          <ol>
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        <Section id="scope">
          <p>These Terms apply to:</p>
          <dl className="terms-defs">
            <div>
              <dt>shell.online</dt>
              <dd>
                The web app, the marketing site, and any APIs exposed through
                the domain.
              </dd>
            </div>
            <div>
              <dt>The accounts service</dt>
              <dd>
                The service that holds accounts, teams, machine
                records, session metadata and collaboration records.
              </dd>
            </div>
            <div>
              <dt>The relay</dt>
              <dd>
                The server that carries encrypted terminal traffic between a
                browser and a machine running a session.
              </dd>
            </div>
            <div>
              <dt>
                The <code>shell</code> CLI
              </dt>
              <dd>
                The open-source command-line tool and the background daemon it
                installs.
              </dd>
            </div>
          </dl>
          <p>
            <b>What is NOT covered:</b> what happens inside a session is{" "}
            <b>explicitly excluded</b> from these Terms. The commands you run,
            the prompts you give a coding agent, the code it writes, the files
            it touches and the systems you reach from your own machine are
            between you and whoever they affect. We do not intermediate,
            inspect, or control the contents of a terminal session; terminal
            traffic is end-to-end encrypted and we hold ciphertext only, as
            described in <Ref id="never-received" />.
          </p>
        </Section>

        <Section id="tiers">
          <p>The Services are offered under the following tiers:</p>

          <Tier letter="A" title="Open-source CLI">
            <p>
              The <code>shell</code> command-line tool is open source. Source
              code is at{" "}
              <a
                href="https://github.com/TeoSlayer/shell.online"
                target="_blank"
                rel="noreferrer"
              >
                github.com/TeoSlayer/shell.online
              </a>
              , licensed under the{" "}
              <a
                href="https://github.com/TeoSlayer/shell.online/blob/main/LICENSE"
                target="_blank"
                rel="noreferrer"
              >
                MIT License
              </a>
              . You may use, modify and redistribute it under that license. You
              may run the CLI without an account at all; accounts are optional.
            </p>
          </Tier>

          <Tier letter="B" title="Hosted service (free)">
            <p>
              The hosted web app, accounts service and relay are provided free
              of charge, without warranty, on a best-effort basis. Availability,
              limits and features may change or be discontinued without notice.
            </p>
          </Tier>

          <Tier letter="C" title="Paid services">
            <p>
              Where we offer paid services, they are governed by these Terms
              unless a separate written agreement between you and Vulture Labs
              says otherwise. The liability cap in <Ref id="liability" />{" "}
              distinguishes paid Services from free ones. Contact{" "}
              <a href={`mailto:${CONTACT}`}>{CONTACT}</a> for details.
            </p>
          </Tier>
        </Section>

        <Section id="accounts">
          <p>
            Accounts are optional. <code>shell login</code> links a machine to
            your account; <code>shell logout</code> unlinks it and revokes that
            machine&rsquo;s token.
          </p>
          <p>
            Signing up creates a team for you, unless you arrived
            through an invite link, in which case you join the team that
            issued it.
          </p>
          <p>
            A team is a shared workspace, and it is shared in a strong
            sense. <b>Everyone in your team can see every member&rsquo;s
            sessions</b> and can read their comments and handoff history. A
            session has an owner and may have multiple assignees, and
            only they can edit it — but visibility is not restricted that way.
          </p>
          <p>
            Anyone signed in to your account can start processes on any machine
            of yours that allowed browser-started sessions, as described in{" "}
            <Ref id="browser-sessions" />. Keep your account credentials to
            yourself, and invite people to your team only when you mean
            them to see all of this.
          </p>
        </Section>

        <Section id="your-machine">
          <p>
            The <code>shell</code> CLI runs the command you give it in a
            pseudo-terminal on your own machine, and publishes a browser link to
            it. The process and the PTY never leave your machine. Nothing about
            the way shell.online works moves your program to our infrastructure.
          </p>
          <p>The CLI writes to these places on your machine.</p>
          <dl className="terms-defs">
            <div>
              <dt>Session state</dt>
              <dd>
                Session control sockets and session records go in a per-user
                directory: <code>/tmp/shell-online-&lt;uid&gt;</code> on macOS
                and Linux, and the user cache directory on Windows. The
                directory is created with mode <code>0700</code> and the files
                with mode <code>0600</code>.
              </dd>
            </div>
            <div>
              <dt>Account credentials</dt>
              <dd>
                Stored in your operating system&rsquo;s user-config directory
                under <code>shell-online/credentials.json</code>, mode{" "}
                <code>0600</code>.
              </dd>
            </div>
            <div>
              <dt>Machine identifier</dt>
              <dd>
                A random identifier in <code>machine-id</code>, beside the
                credentials file. It survives logout, so signing in again
                updates that machine&rsquo;s entry rather than adding a second
                one.
              </dd>
            </div>
          </dl>
        </Section>

        <Section id="browser-sessions">
          <p>
            A background daemon can start and stop terminal sessions on your
            machine at the request of a signed-in browser. It runs only after
            you explicitly agree, once, at <code>shell login</code>. Only an
            explicit yes is recorded; if you decline, you are asked again the
            next time.
          </p>
          <p>
            While browser-started sessions are allowed, the daemon polls the
            accounts service every two seconds, and{" "}
            <b>
              anyone signed in to that account can start processes on that
              machine
            </b>
            . That is the point of the feature, and it is worth being explicit
            about what it means before you agree to it.
          </p>
          <p>
            You are responsible for what runs on your machines under your
            account, including anything started from a browser signed in to it.
          </p>
        </Section>

        <Section id="harness-discovery">
          <p>
            The daemon detects which coding-agent harnesses are installed on the
            machine by looking up their command names on the system{" "}
            <code>PATH</code>: <code>claude</code>, <code>codex</code>,{" "}
            <code>hermes</code> and <code>openclaw</code>. It does not execute
            them, does not read their configuration, and does not read the
            contents of your projects or your source files. Detection runs once
            per daemon run.
          </p>
          <p>
            The result of that lookup — the list of which of those four commands
            exist on the machine — is sent to the service, so that the web app
            can tell you which harnesses are available on that machine. That
            list is the whole of what harness discovery produces and the whole
            of what it sends.
          </p>
        </Section>

        <Section id="what-we-receive">
          <p>
            Running a session sends a record of it to the accounts service. What
            that record contains, and what else the service keeps:
          </p>
          <dl className="terms-defs">
            <div>
              <dt>Session metadata</dt>
              <dd>
                The share URL, the command line, the host name of the machine,
                the session name, timings, the session flags, and the exit code.
                Every member of your team sees these records and is notified
                when a session starts. The command line is stored as written,
                including any prompt you put on it, so treat a command line the
                way you would treat anything else your team, and we, can read.
              </dd>
            </div>
            <div>
              <dt>Session vault</dt>
              <dd>
                Your vault&rsquo;s public key, your vault&rsquo;s private key
                encrypted under a vault key, and that vault key wrapped under
                your recovery key; and the session passwords saved to your vault
                or shared with you, each sealed to it. We never receive the
                recovery key or anything that opens these records, and we cannot
                recover your vault if you lose your recovery key.
              </dd>
            </div>
            <div>
              <dt>Team audit key</dt>
              <dd>
                Your team&rsquo;s audit public key, and one copy of its private
                key for each member, sealed to that member&rsquo;s vault by a
                teammate. We cannot open these copies.
              </dd>
            </div>
            <div>
              <dt>Audit records</dt>
              <dd>
                For each entry: who made it, in which session, what kind of
                entry it is, and when. What was typed is stored only as
                ciphertext; see <Ref id="activity-records" />.
              </dd>
            </div>
            <div>
              <dt>Machine records</dt>
              <dd>
                A label for the machine, when it was linked, when it was last
                seen, a public key that the browser uses to seal a session
                password, and the harness list described in{" "}
                <Ref id="harness-discovery" />. Of the CLI&rsquo;s tokens we
                store only SHA-256 hashes, never the tokens themselves.
              </dd>
            </div>
            <div>
              <dt>Collaboration records</dt>
              <dd>
                Explicit handoffs, comments, mentions, and notifications. See{" "}
                <Ref id="activity-records" />.
              </dd>
            </div>
            <div>
              <dt>What you write in the app</dt>
              <dd>
                Comments, @mentions and notifications, along with who they were
                addressed to.
              </dd>
            </div>
          </dl>
        </Section>

        <Section id="activity-records">
          <div className="terms-callout">
            <p>
              <b>
                What you type into a session from the browser is recorded, and
                every member of your team can read it.
              </b>{" "}
              Commands, prompts, and anything else entered at the keyboard are
              recorded in your team&rsquo;s audit log as you commit them, and
              can be read and exported by every member of your team. That
              includes anything typed by mistake, such as a password or a key
              pasted into the wrong window.
            </p>
          </div>
          <p>
            The audit log is end-to-end encrypted. Your browser encrypts each
            entry to your team&rsquo;s audit key before sending it, and only
            members of your team hold the key that opens it. We store
            ciphertext and cannot read what was typed. We do see who made each
            entry, in which session, what kind of entry it is, and when; and we
            write some entries ourselves when a session is stopped, removed, or
            handed to someone else, which name the session and the people
            involved.
          </p>
          <p>
            Entries recorded before the audit log was encrypted are encrypted in
            place by the browser of an owner or admin of your team when they
            next use shell.online. Until then those entries are stored readable,
            and database backups taken before then keep them until the backups
            expire.
          </p>
          <p>
            The recording is of what is entered, not of what the session prints
            back. Terminal output stays inside the end-to-end encrypted stream
            and never reaches us.
          </p>
          <p>
            We also retain the collaboration information people deliberately
            create outside the terminal: session ownership and assignment,
            handoffs, comments, mentions, and notifications. Members of the
            team can see those records, and so can we.
          </p>
          <p>
            If this is not what you want for a particular session, do not type
            into it from the browser. A session shared read-only with{" "}
            <code>--read-only</code> accepts no browser input at all, and
            anything typed in the terminal the session was started from is
            never seen by the browser or by us.
          </p>
        </Section>

        <Section id="never-received">
          <p>Four things never reach us in readable form.</p>
          <dl className="terms-defs">
            <div>
              <dt>Terminal output</dt>
              <dd>
                Terminal traffic is end-to-end encrypted in the browser and on
                the machine, and the relay handles ciphertext only, so what
                your program prints is not readable by us.
              </dd>
            </div>
            <div>
              <dt>What you type</dt>
              <dd>
                Input typed into a session from the browser reaches us only as
                ciphertext for your team&rsquo;s audit key, which we do not
                hold. Entries recorded before the audit log was encrypted are
                the exception described in <Ref id="activity-records" />.
              </dd>
            </div>
            <div>
              <dt>The encryption key</dt>
              <dd>
                It lives in the URL fragment. Browsers never send the fragment
                to a server, and it is stripped before any URL is published.
              </dd>
            </div>
            <div>
              <dt>The session password</dt>
              <dd>
                It reaches us only sealed to a machine or to someone&rsquo;s
                session vault, never in the clear, and we cannot recover it for
                you.
              </dd>
            </div>
          </dl>
          <p>
            Because we hold no key and no password, we cannot decrypt a session
            for you, restore one, recover anything a session displayed, or read
            your team&rsquo;s audit log.
          </p>
        </Section>

        <Section id="sharing">
          <p>
            A share link plus its password is a bearer capability: whoever holds
            both gets whatever access the session allows. On a session started
            with <code>--read-only</code>, browser input is rejected
            server-side. On any other session, whoever holds the link and the
            password can type into a live process on your machine.
          </p>
          <p>
            You are responsible for who you give a link and a password to, and
            for what they do with them. We cannot tell whether the person
            holding them is the person you meant to give them to. Sending a link
            and a password is handing over that access; treat it that way, and
            end a session when you no longer want it reachable.
          </p>
        </Section>

        <Section id="ip">
          <dl className="terms-defs">
            <div>
              <dt>
                The <code>shell</code> CLI
              </dt>
              <dd>
                Open source, at{" "}
                <a
                  href="https://github.com/TeoSlayer/shell.online"
                  target="_blank"
                  rel="noreferrer"
                >
                  github.com/TeoSlayer/shell.online
                </a>
                . Licensed under the MIT License, whose text ships with the
                software.
              </dd>
            </div>
            <div>
              <dt>shell.online</dt>
              <dd>
                The web app, branding, documentation (except code samples), and
                the &ldquo;shell.online&rdquo; and &ldquo;Pilot Protocol&rdquo;
                names and logos are proprietary. They are not open-source
                licensed.
              </dd>
            </div>
            <div>
              <dt>Your content</dt>
              <dd>
                You retain ownership of what you run, write and produce through
                the Services. We claim no license or rights over the contents of
                your terminal sessions.
              </dd>
            </div>
          </dl>
        </Section>

        <Section id="acceptable-use">
          <p>Using the Services, you agree not to:</p>
          <ul className="terms-list">
            <li>use them for anything unlawful;</li>
            <li>
              use them to obtain, or attempt to obtain, unauthorised access to
              any system you do not control or have permission to reach;
            </li>
            <li>
              share a session that grants access to a machine you are not
              entitled to grant access to;
            </li>
            <li>
              interfere with the Services, the relay, or anyone else&rsquo;s use
              of either;
            </li>
            <li>
              use them to distribute malware, or to run a process whose purpose
              is to harm someone else&rsquo;s systems or data.
            </li>
          </ul>
          <p>
            Violations may result in immediate suspension of access to the
            hosted Services.
          </p>
        </Section>

        <Section id="obligations">
          <p>You are responsible for:</p>
          <ul className="terms-list">
            <li>
              Maintaining the confidentiality of your account credentials, the
              credentials file on each linked machine, and every share link and
              session password you issue.
            </li>
            <li>
              Everything typed into a session under your account, and everything
              started on a machine you linked — including anything started from
              a browser signed in to that account.
            </li>
            <li>
              Who you invite into your team, given that every member can
              see its shared sessions and collaboration records.
            </li>
            <li>
              Complying with all applicable laws in your jurisdiction when using
              the Services.
            </li>
            <li>
              Ensuring that what you run through a session does not violate the
              rights of third parties.
            </li>
            <li>
              Using a current version of the CLI. We may deprecate and stop
              supporting older versions and protocol revisions.
            </li>
          </ul>
        </Section>

        <Section id="disclaimers">
          <p>
            <b className="terms-caps">
              THE SERVICES ARE PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS
              AVAILABLE,&rdquo; WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
              IMPLIED.
            </b>
          </p>
          <p>
            To the fullest extent permitted by law, Vulture Labs disclaims all
            warranties, including but not limited to:
          </p>
          <ul className="terms-list">
            <li>
              Implied warranties of merchantability, fitness for a particular
              purpose, and non-infringement.
            </li>
            <li>
              Warranties that the Services will be uninterrupted, error-free,
              secure, or available at any particular time — including that a
              session will connect, stay connected, or that a share link will
              keep working.
            </li>
            <li>
              Warranties regarding the accuracy, reliability, or completeness of
              documentation or any content on shell.online, or that anything
              stored through the Services will be preserved.
            </li>
          </ul>
          <p>
            The open-source CLI carries the warranty disclaimer in its own
            license. The web app, the accounts service and the relay carry this
            additional disclaimer. Keep your own copies of work you care about:
            a terminal session is not a backup.
          </p>
        </Section>

        <Section id="liability">
          <p>
            <b className="terms-caps">
              TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, VULTURE LABS
              SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
              CONSEQUENTIAL, OR PUNITIVE DAMAGES
            </b>
            , including but not limited to loss of profits, data, work,
            goodwill, or business interruption, and including damage caused by
            someone acting through a share link or session password you gave
            out, arising out of or related to these Terms or the use of the
            Services, whether based on warranty, contract, tort (including
            negligence), or any other legal theory, even if advised of the
            possibility of such damages.
          </p>
          <p>
            Our total liability for any claim arising under these Terms shall
            not exceed:
          </p>
          <ul className="terms-list">
            <li>
              For paid Services: the fees you paid to Vulture Labs in the twelve
              (12) months preceding the claim.
            </li>
            <li>
              For free/open Services: one United States Dollar (USD $1.00).
            </li>
          </ul>
          <p>
            The free tier is provided without charge; this nominal amount
            reflects the fundamentally cost-free nature of the service and is
            not a penalty.
          </p>
          <p>
            Some jurisdictions do not allow the exclusion or limitation of
            certain warranties or liabilities. In such jurisdictions, our
            liability is limited to the maximum extent permitted by law, and
            nothing in these Terms limits liability that cannot be limited by
            law.
          </p>
        </Section>

        <Section id="indemnification">
          <p>
            You agree to indemnify and hold harmless Vulture Labs, Pilot
            Protocol, and their officers, directors, employees, and agents from
            any claims, damages, liabilities, and expenses (including reasonable
            legal fees) arising from your use of the Services, from what was run
            or typed in a session under your account, from access obtained
            through a share link or session password you issued, from your
            violation of these Terms, or from your violation of any third-party
            rights.
          </p>
        </Section>

        <Section id="termination">
          <p>
            You can stop using the Services whenever you like.{" "}
            <code>shell logout</code> unlinks a machine and revokes its token,
            which also stops its daemon. Deleting the credentials file described
            in <Ref id="your-machine" /> clears the machine but leaves the token
            valid on our side until it expires, so prefer{" "}
            <code>shell logout</code>.
          </p>
          <p>
            You can delete your account from the Account page. The{" "}
            <Link to="/privacy#deletion">Privacy Policy</Link> sets out what
            that removes and what stays with your team.
          </p>
          <p>
            We may suspend or terminate access to an account at any time for
            violation of these Terms, or where we need to in order to protect
            the Services or the people using them. For the free tier, we may
            also discontinue or modify the Services at our discretion. Where we
            can give notice, we will.
          </p>
          <p>
            Ending an account does not by itself undo collaboration records that
            other members of your team have already seen.
          </p>
        </Section>

        <Section id="law">
          <p>
            These Terms are governed by the laws of the{" "}
            <b>State of Delaware, United States</b>, without regard to its
            conflict of laws principles. Any dispute arising under these Terms
            shall be resolved exclusively in the state or federal courts located
            in Delaware.
          </p>
          <p>
            Before initiating formal proceedings, you agree to contact us at{" "}
            <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and attempt to
            resolve the dispute informally for a period of at least thirty (30)
            days.
          </p>
        </Section>

        <Section id="changes">
          <p>
            We will post changes to this page and update the &ldquo;Last
            updated&rdquo; date. For material changes, we will provide
            additional notice (website banner, or email where available).
            Continued use after the effective date of changes constitutes
            acceptance of the revised Terms. If you do not accept them, stop
            using the Services and remove your credentials.
          </p>
        </Section>

        <Section id="contact">
          <p>Questions about these Terms?</p>
          <p>
            Email: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
          </p>
          <p>
            shell.online is operated by Vulture Labs, Inc., a Delaware
            corporation, trading as Pilot Protocol,{" "}
            <a
              href="https://pilotprotocol.network/"
              target="_blank"
              rel="noreferrer"
            >
              pilotprotocol.network
            </a>
            .
          </p>
        </Section>

        <p className="terms-note">
          These Terms were drafted for transparency and operational clarity.
          They do not constitute legal advice. If you are a legal professional
          reviewing this document, please direct feedback to{" "}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>

        <footer className="terms-foot">
          <Link to="/signup">Create an account</Link>
          <span aria-hidden="true">·</span>
          <Link to="/login">Sign in</Link>
          <span aria-hidden="true">·</span>
          <Link to="/privacy">Privacy policy</Link>
        </footer>
      </article>
    </main>
  );
}
