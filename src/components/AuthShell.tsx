import { lazy, Suspense, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Wordmark } from "./Wordmark";

/*
 * xterm.js is a third of the bundle and the stage is hidden below 940px, so it
 * loads after the form is interactive rather than blocking it.
 */
const SessionPreview = lazy(() =>
  import("./SessionPreview").then((module) => ({ default: module.SessionPreview })),
);

interface AuthShellProps {
  title: string;
  dek: ReactNode;
  headLink: { to: string; label: string };
  children: ReactNode;
  foot?: ReactNode;
  legal?: ReactNode;
}

export function AuthShell({
  title,
  dek,
  headLink,
  children,
  foot,
  legal,
}: AuthShellProps) {
  return (
    <div className="auth">
      <div className="auth-side">
        <header className="auth-head">
          <Wordmark />
          <Link className="auth-head-link" to={headLink.to}>
            {headLink.label}
          </Link>
        </header>

        <div className="auth-body">
          <h1 className="auth-title rise rise-1">{title}</h1>
          <p className="auth-dek rise rise-2">{dek}</p>
          <div className="auth-form rise rise-3">{children}</div>
          {foot && <p className="auth-foot">{foot}</p>}
          {legal && <p className="auth-legal">{legal}</p>}
        </div>
      </div>

      <aside className="stage">
        <Suspense fallback={<div className="stage-panel" aria-hidden="true" />}>
          <SessionPreview />
        </Suspense>
      </aside>
    </div>
  );
}
