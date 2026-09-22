import { Component, type ErrorInfo, type ReactNode } from "react";
import { Alert } from "./Alert";

/**
 * Keeps a page that threw inside the page.
 *
 * Without one of these, a component that throws unmounts the whole tree: the
 * rail, the top bar and -- on a phone, where the rail is the navigation --
 * every way off the broken page. The screen went blank and the bottom bar went
 * with it, so the failure of one card took the application with it.
 *
 * So this sits inside the shell rather than around it. Whatever threw is
 * replaced by a sentence and a way to try again; the chrome around it, and the
 * bar the phone navigates with, never moves.
 */
export class PageError extends Component<
  { children: ReactNode },
  { message: string }
> {
  state = { message: "" };

  static getDerivedStateFromError(error: unknown): { message: string } {
    return {
      message:
        error instanceof Error && error.message
          ? error.message
          : "Something on this page stopped working.",
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    /* The browser console is where the stack is useful; this is not a report. */
    console.error("Page failed to render", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.message) return this.props.children;
    return (
      <div className="page-failed">
        <Alert tone="error">
          <span>{this.state.message}</span>
          <span className="alert-actions">
            <button
              type="button"
              className="inline-retry"
              onClick={() => this.setState({ message: "" })}
            >
              Try again
            </button>
          </span>
        </Alert>
      </div>
    );
  }
}
