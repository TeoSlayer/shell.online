import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Wordmark } from "../components/Wordmark";

/*
 * The section list is the single source for both the contents nav and the
 * headings, so a renamed or reordered section can never leave the two out of
 * step — the numbering below is derived from position, not written by hand.
 */
const SECTIONS = [
  { id: "scope", title: "What these terms cover" },
  { id: "accounts", title: "Your account and your organization" },
  { id: "your-machine", title: "What runs on your machine" },
  { id: "browser-sessions", title: "Starting sessions from the browser" },
  { id: "harness-discovery", title: "Harness discovery" },
  { id: "what-we-receive", title: "What is sent to the service" },
  { id: "audit-log", title: "The audit log" },
  { id: "never-received", title: "What is never sent to the service" },
  { id: "sharing", title: "Share links and session passwords" },
  { id: "acceptable-use", title: "Acceptable use" },
  { id: "no-warranty", title: "No warranty" },
  { id: "liability", title: "Limitation of liability" },
  { id: "termination", title: "Ending your use, and ours" },
  { id: "changes", title: "Changes to these terms" },
  { id: "contact", title: "Contact" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const index = SECTIONS.findIndex((section) => section.id === id);
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

export function Terms() {
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
          <h1>Terms of service</h1>
          <p className="terms-updated">Last updated 7 September 2026</p>
          <p className="terms-lede">
            shell.online shares a terminal process running on your own machine
            through a browser link. These terms describe what the software does
            on your machine, what leaves it, and what we each owe the other.
            They are written to be read, so please read them.
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
          <p>
            shell.online is operated by Pilot Protocol,{" "}
            <a
              href="https://pilotprotocol.network/"
              target="_blank"
              rel="noreferrer"
            >
              pilotprotocol.network
            </a>
            . These terms are the agreement between you and Pilot Protocol for
            the shell.online web app, the accounts service behind it, the relay
            that carries session traffic, and the <code>shell</code>{" "}
            command-line tool.
          </p>
          <p>
            You accept them when you create an account. If you do not accept
            them, do not create one.
          </p>
        </Section>

        <Section id="accounts">
          <p>
            Signing up creates an organization for you, unless you arrived
            through an invite link, in which case you join the organization that
            issued it.
          </p>
          <p>
            An organization is a shared workspace, and it is shared in a strong
            sense. Everyone in your organization can see every member&rsquo;s
            sessions and can read the audit log described in section 7. A
            session can only be edited by its owner and the person it is
            assigned to, but being able to see it is not restricted that way.
          </p>
          <p>
            Anyone signed in to your account can start processes on any machine
            of yours that allowed browser-started sessions. Keep your account
            credentials to yourself, and invite people to your organization only
            when you mean them to see all of this.
          </p>
        </Section>

        <Section id="your-machine">
          <p>
            The <code>shell</code> CLI runs the command you give it in a
            pseudo-terminal on your own machine. The process and the PTY never
            leave it. Nothing about the way shell.online works moves your
            program to our infrastructure.
          </p>
          <p>The CLI writes to two places on your machine.</p>
          <dl className="terms-defs">
            <div>
              <dt>Session state</dt>
              <dd>
                Session control sockets and session records go in a per-user
                directory: <code>/tmp/shell-online-&lt;uid&gt;/</code> on macOS
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
                <code>0600</code>. The file holds an access token, a refresh
                token, your account id, your email address, your display name,
                and a flag recording whether you allowed browser-started
                sessions.
              </dd>
            </div>
          </dl>
          <p>
            When you run <code>shell claude</code>, the CLI reads your{" "}
            <code>CLAUDE_CODE_*</code> environment variables in order to fork
            the current Claude Code conversation into the shared session.
          </p>
        </Section>

        <Section id="browser-sessions">
          <p>
            A background daemon can start and stop terminal sessions on your
            machine at the request of your signed-in browser. It runs only after
            you explicitly agree, once, at <code>shell login</code>. The prompt
            asks &ldquo;Start sessions from the browser?&rdquo; and only an
            explicit yes is recorded. If you decline, you are asked again the
            next time.
          </p>
          <p>
            While the daemon is running it polls the accounts service every two
            seconds, and it can start and stop terminal sessions on that machine
            on request from the signed-in browser. That is the whole point of
            it, and it is worth being clear about what it means: whoever is
            signed in to your account, in any browser, can start a process on
            that machine.
          </p>
          <p>
            <code>shell service install</code> optionally writes a per-user
            service definition — a LaunchAgent on macOS, a systemd user unit on
            Linux — so the daemon survives a restart.
          </p>
        </Section>

        <Section id="harness-discovery">
          <p>
            The daemon is permitted to detect which coding-agent harnesses are
            installed on the machine, so that the web app can offer you the ones
            that are actually available there. It does this by looking for known
            files and directories associated with that tooling.
          </p>
          <p>
            This inspection is local. It reads the presence and version of
            installed agent tooling. It does not read the contents of your
            projects, your source files, or your working directories. The result
            of the inspection — the list of harnesses available on that machine
            — is what may be sent to the service.
          </p>
        </Section>

        <Section id="what-we-receive">
          <p>
            Running a session sends a record of it to the accounts service. What
            that record contains:
          </p>
          <dl className="terms-defs">
            <div>
              <dt>Session metadata</dt>
              <dd>
                The share URL, the command line, the host name of the machine,
                the session name, timings, the read-only, encrypted and
                persistent flags, and the exit code. The command line is stored
                as written, so treat a command line the way you would treat
                anything else your organization can read.
              </dd>
            </div>
            <div>
              <dt>Machine records</dt>
              <dd>
                A label for the machine (its host name), when it was linked,
                when it was last seen, and a public key that the browser uses to
                seal a session password. Of the CLI&rsquo;s tokens we store only
                SHA-256 hashes, never the tokens themselves.
              </dd>
            </div>
            <div>
              <dt>The audit log</dt>
              <dd>
                Every input you commit to a session. This is important enough to
                have its own section — see below.
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

        <Section id="audit-log">
          <div className="terms-callout">
            <p>
              <b>
                Every input you commit to a session is recorded in plaintext on
                our servers.
              </b>{" "}
              Prompts you send to a coding agent and commands you run in a
              terminal are both inputs. Everyone in your organization can read
              that log, and everyone in your organization can export it.
            </p>
          </div>
          <p>
            This is deliberate. The audit log is a feature of the product, not a
            side effect of running it — a team using shell.online is meant to be
            able to see what was asked of a machine and what was typed at it.
          </p>
          <p>
            The practical consequence is that anything you type into a
            shell.online session should be treated as something your whole
            organization will read. Do not paste API keys, passwords, tokens,
            customer data or anything else you would not put in a shared
            document into a prompt or a command line.
          </p>
        </Section>

        <Section id="never-received">
          <p>Three things never reach us.</p>
          <dl className="terms-defs">
            <div>
              <dt>Terminal output</dt>
              <dd>
                It is end-to-end encrypted in the browser and on the machine.
                The relay and the accounts service handle ciphertext only. Your
                inputs are logged, as described above; what your program prints
                back is not readable by us.
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
              <dt>The browser password for a session</dt>
              <dd>It is not sent to us and we cannot recover it for you.</dd>
            </div>
          </dl>
        </Section>

        <Section id="sharing">
          <p>
            A share link plus its password grants whatever access the
            session&rsquo;s read-only flag allows. If that flag is not set,
            whoever holds both can type into a live process on your machine.
          </p>
          <p>
            You are responsible for who you give a link and a password to, and
            for what they do with them. We cannot tell whether the person
            holding them is the person you meant to give them to. Sending a link
            and password is handing over that access; treat it that way, and end
            a session when you no longer want it reachable.
          </p>
        </Section>

        <Section id="acceptable-use">
          <p>Using shell.online, you agree not to:</p>
          <ul className="terms-list">
            <li>use it for anything unlawful;</li>
            <li>
              use it to obtain, or attempt to obtain, unauthorised access to any
              system you do not control or have permission to reach;
            </li>
            <li>
              share a session that grants access to a machine you are not
              entitled to grant access to;
            </li>
            <li>
              interfere with the service, the relay, or anyone else&rsquo;s use
              of either;
            </li>
            <li>
              use it to distribute malware, or to run a process whose purpose is
              to harm someone else&rsquo;s systems or data.
            </li>
          </ul>
          <p>
            You are responsible for what runs on your machines under your
            account, including anything started from a browser signed in to it.
          </p>
        </Section>

        <Section id="no-warranty">
          <p>
            shell.online is provided as it is, without warranty of any kind. We
            do not promise that the service will be available or uninterrupted,
            that a session will connect or stay connected, that a shared link
            will keep working, or that anything stored through the service will
            be preserved.
          </p>
          <p>
            Keep your own copies of work you care about. A terminal session is
            not a backup.
          </p>
        </Section>

        <Section id="liability">
          <p>
            To the fullest extent the law allows, Pilot Protocol is not liable
            for indirect, incidental, special or consequential loss arising out
            of your use of shell.online. That includes lost work, lost data,
            lost profits, and damage caused by someone acting through a share
            link or password you gave out.
          </p>
          <p>
            Nothing in these terms limits liability that cannot be limited by
            law.
          </p>
        </Section>

        <Section id="termination">
          <p>
            You can stop using shell.online whenever you like.{" "}
            <code>shell logout</code> unlinks a machine and revokes its token,
            which also stops its daemon. Deleting the credentials file
            described in section 3 clears the machine but leaves the token
            valid on our side until it expires, so prefer{" "}
            <code>shell logout</code>. To keep a machine linked while refusing
            browser-started sessions, use{" "}
            <code>shell login --no-remote-start</code>, or{" "}
            <code>shell daemon stop</code> to stop one until the next command
            you run there.
          </p>
          <p>
            We may suspend or end access to an account that breaches these
            terms, or where we need to in order to protect the service or the
            people using it. We may also stop offering shell.online. Where we
            can give notice, we will.
          </p>
          <p>
            Ending an account does not by itself undo what other members of your
            organization have already seen or exported, including audit log
            entries.
          </p>
        </Section>

        <Section id="changes">
          <p>
            We may change these terms. The date at the top of this page is when
            they last changed. If you keep using shell.online after a change,
            you accept the new version. If you do not, stop using the service
            and remove your credentials.
          </p>
        </Section>

        <Section id="contact">
          <p>
            Questions about these terms, or about anything described on this
            page, go to{" "}
            <a href="mailto:alex@vulturelabs.io">alex@vulturelabs.io</a>.
          </p>
          <p>
            shell.online is operated by Pilot Protocol,{" "}
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

        <footer className="terms-foot">
          <Link to="/signup">Create an account</Link>
          <span aria-hidden="true">·</span>
          <Link to="/login">Sign in</Link>
        </footer>
      </article>
    </main>
  );
}
