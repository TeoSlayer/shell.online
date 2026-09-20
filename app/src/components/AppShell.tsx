import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import {
  Terminal, Desktop, User, UsersThree, ClockCounterClockwise, SignOut, Copy, Check, Warning, ChatCircleDots,
  GameController,
} from "@phosphor-icons/react";
import { Inbox } from "./Inbox";
import { Avatar } from "./Avatar";
import { Wordmark } from "./Wordmark";
import { useAuth } from "../auth/AuthProvider";
import { useFeedback } from "../feedback/context";
import { COPY_FAILED, useCopy } from "../lib/clipboard";

const NAV = [
  { to: "/sessions", label: "Sessions", Icon: Terminal },
  { to: "/machines", label: "Machines", Icon: Desktop },
  { to: "/audit", label: "Audit log", Icon: ClockCounterClockwise },
  { to: "/team", label: "Team", Icon: UsersThree },
  { to: "/account", label: "Account", Icon: User },
] as const;

/* The command a new machine needs. Shown once, in the sidebar, not per page. */
const LINK_COMMAND = "shell auth";

export function LinkHint({ className = "rail-hint" }: { className?: string }) {
  const { state, copy } = useCopy();
  const copied = state === "copied";
  return (
    <div className={className}>
      <p>Link a machine</p>
      <button
        type="button"
        className="rail-command"
        onClick={() => void copy(LINK_COMMAND)}
        aria-label={copied ? "Command copied" : `Copy ${LINK_COMMAND}`}
      >
        <code>
          <span aria-hidden="true">$</span> {LINK_COMMAND}
        </code>
        {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
      </button>
      {state === "failed" && (
        <p className="rail-command-failed" role="status">
          <Warning size={13} weight="fill" />
          {COPY_FAILED}
        </p>
      )}
    </div>
  );
}

/*
 * A tooltip is not worth a flash. Hovering across a row of controls on the way
 * somewhere else should not leave a trail of labels behind it, so the label
 * waits to see whether the pointer meant to stop.
 */
const TOOLTIP_DELAY_MS = 300;

/**
 * The way into the game skin.
 *
 * Deliberately the last thing in the bar: it is a different way to look at the
 * same product rather than another destination within it, and putting it in the
 * rail with Sessions and Machines would have said otherwise.
 *
 * Pointing at it fetches the game's chunk. The click then has nothing to wait
 * for, while somebody who never points at it never downloads it -- which is the
 * whole reason the game is a separate chunk in the first place.
 */
function LaunchGame() {
  const [hinting, setHinting] = useState(false);
  const timer = useRef(0);
  const warmed = useRef(false);

  const warm = () => {
    if (warmed.current) return;
    warmed.current = true;
    /*
     * The same specifier App.tsx lazily imports, so this warms that chunk
     * rather than fetching a second copy of it. A failure here is not worth
     * reporting: the click will simply load it the ordinary way.
     */
    void import("../game/GameRoute").catch(() => {
      warmed.current = false;
    });
  };

  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHinting(true), TOOLTIP_DELAY_MS);
  };

  const hide = () => {
    window.clearTimeout(timer.current);
    setHinting(false);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <div className="launch-game">
      <Link
        to="/game"
        className="launch-game-button"
        /*
         * The accessible name is on the control itself. The tooltip below is
         * decoration for people using a pointer; it is not what a screen reader
         * or a keyboard user has to rely on.
         */
        aria-label="Launch Game"
        onMouseEnter={() => {
          warm();
          show();
        }}
        onMouseLeave={hide}
        onFocus={() => {
          warm();
          setHinting(true);
        }}
        onBlur={hide}
      >
        <GameController size={20} weight="fill" />
      </Link>
      {hinting && (
        <span className="launch-game-hint" role="presentation">
          Launch Game
        </span>
      )}
    </div>
  );
}

function AccountMenu() {
  const { user, signOutUser } = useAuth();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const feedback = useFeedback();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const email = user?.email ?? "";
  /* The rail is narrow, so the chip leads with whichever label is shorter. */
  const label = user?.displayName || email;
  /* The same avatar a colleague sees, so you recognise yourself in a list. */
  const self = { uid: user?.uid ?? "", name: user?.displayName ?? undefined, email };

  return (
    <div className="account-menu" ref={wrapper}>
      <button
        type="button"
        className="account-chip"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Avatar person={self} size="sm" />
        <span className="account-email">{label}</span>
      </button>

      {open && (
        <div className="account-pop" role="menu">
          <p className="account-pop-name">{user?.displayName || "Signed in"}</p>
          <p className="account-pop-email">{email}</p>
          <Link to="/account" role="menuitem" onClick={() => setOpen(false)}>
            <User size={16} />
            Account
          </Link>
          {/* Always one click away, from the rail and from the phone's top bar alike. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              feedback.open({ surface: "account-menu" });
            }}
          >
            <ChatCircleDots size={16} />
            Send feedback
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              setOpen(false);
              await signOutUser();
              navigate("/login", { replace: true });
            }}
          >
            <SignOut size={16} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

interface AppShellProps {
  title: string;
  /* Sits at the right of the page header, for counts or page-level actions. */
  aside?: ReactNode;
  children: ReactNode;
}

export function AppShell({ title, aside, children }: AppShellProps) {
  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-head">
          <Wordmark />
        </div>

        <nav className="rail-nav">
          {NAV.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => (isActive ? "rail-link is-active" : "rail-link")}
            >
              {/*
               * The icon is wrapped so the bottom bar can mark the current
               * page with a shape the same size on every item. Left to the
               * link itself the mark took the width of the word inside it,
               * and "Sessions" and "Team" were highlighted differently.
               */}
              <span className="rail-icon">
                <Icon size={19} />
              </span>
              <span className="rail-label">{label}</span>
            </NavLink>
          ))}
        </nav>

        <LinkHint />

        <div className="rail-foot">
          <AccountMenu />
        </div>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          <div className="topbar-inner">
            <div className="topbar-heading">
              {/*
                * Shown only where the rail is not: see .topbar-mark. A span
                * rather than a link, because Wordmark is already one and an
                * anchor inside an anchor is invalid; React said so on every
                * render of a phone-width page.
                */}
              <span className="topbar-mark">
                <Wordmark />
              </span>
              {/*
                * The title is hidden on a phone, not removed: the bottom bar
                * already names the page it has marked, so the heading was the
                * same word twice, and it was crowding a row that now also
                * carries the wordmark and the account menu. Screen readers
                * keep it.
                */}
              <h1 className="topbar-title">{title}</h1>
            </div>
            <div className="topbar-right">
              {aside}
              <Inbox />
              {/*
                * On a phone the rail is a strip of destinations along the
                * bottom and its foot is gone, taking the account menu with it.
                * Signing out was then only reachable from the Account page.
                */}
              <span className="topbar-account">
                <AccountMenu />
              </span>
              {/* Last in the bar, on purpose: see LaunchGame. */}
              <LaunchGame />
            </div>
          </div>
        </header>

        <div className="shell-content">{children}</div>
      </div>
    </div>
  );
}
