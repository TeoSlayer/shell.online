import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost";
  busy?: boolean;
  busyLabel?: string;
  children: ReactNode;
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
