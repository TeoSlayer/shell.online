import { useId, useState } from "react";
import { Eye, EyeSlash, WarningCircle } from "@phosphor-icons/react";
import { PASSWORD_LABELS, passwordScore } from "../lib/auth-errors";

interface FieldProps {
  label: string;
  type?: "text" | "email" | "password";
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  placeholder?: string;
  note?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  /* Renders a small link on the label row, e.g. "Forgot password". */
  action?: React.ReactNode;
  /* Shows the strength rule under a new-password field. */
  strength?: boolean;
}

export function Field({
  label,
  type = "text",
  value,
  onChange,
  autoComplete,
  placeholder,
  note,
  error,
  disabled,
  required,
  autoFocus,
  action,
  strength,
}: FieldProps) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === "password";
  const inputType = isPassword && revealed ? "text" : type;
  const describedBy = [error ? `${id}-error` : null, note ? `${id}-note` : null]
    .filter(Boolean)
    .join(" ");
  const score = strength ? passwordScore(value) : 0;

  return (
    <div className="field" data-invalid={error ? "true" : "false"}>
      <label className="field-label" htmlFor={id}>
        <span>{label}</span>
        {action}
      </label>

      <div className="field-input-wrap">
        <input
          id={id}
          type={inputType}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
        />
        {isPassword && (
          <button
            type="button"
            className="field-reveal"
            onClick={() => setRevealed((current) => !current)}
            aria-label={revealed ? "Hide password" : "Show password"}
            aria-pressed={revealed}
            tabIndex={-1}
          >
            {revealed ? <EyeSlash size={17} /> : <Eye size={17} />}
          </button>
        )}
      </div>

      {strength && value.length > 0 && (
        <div className="strength" data-score={score}>
          <span className="strength-rule" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span className="strength-label">{PASSWORD_LABELS[score]}</span>
        </div>
      )}

      {note && !error && (
        <p className="field-note" id={`${id}-note`}>
          {note}
        </p>
      )}

      {error && (
        <p className="field-error" id={`${id}-error`}>
          <WarningCircle size={14} weight="bold" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
