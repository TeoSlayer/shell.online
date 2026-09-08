import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost";
  busy?: boolean;
  busyLabel?: string;
  children: ReactNode;
  /* A plain prop, not forwardRef: React 19 passes it straight through. */
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "primary",
  busy = false,
  busyLabel,
  children,
  disabled,
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={[
        "btn",
        `btn-${variant}`,
        busy ? "btn-busy" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy && <span className="spinner" aria-hidden="true" />}
      {busy && busyLabel ? <span>{busyLabel}</span> : children}
    </button>
  );
}
