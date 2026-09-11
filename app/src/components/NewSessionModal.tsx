import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X, Warning } from "@phosphor-icons/react";
import { Button } from "./Button";
import { Alert } from "./Alert";
import {
  SESSION_KINDS,
  sessionName,
  type FieldValues,
  type SessionKind,
} from "../lib/session-kinds";
import type { Device, Member } from "../lib/api";
import { Avatar } from "./Avatar";
import { displayName } from "../lib/people";
import { shareCandidates } from "../lib/session-share";
import { machineOnline } from "../lib/agent";
import { harnessMissing } from "../lib/harnesses";

interface NewSessionModalProps {
  devices: Device[];
  /** The team, so the password can be sealed to the people chosen here. */
  members: Member[];
  you: Member | null;
  onClose(): void;
  onStart(input: {
    deviceId: string;
    command: string;
    name: string;
    share: string[];
  }): Promise<void>;
}

export function NewSessionModal({
  devices,
  members,
  you,
  onClose,
  onStart,
}: NewSessionModalProps) {
  const [kind, setKind] = useState<SessionKind>(SESSION_KINDS[0]);
  const [values, setValues] = useState<FieldValues>({});
  const [machine, setMachine] = useState(devices[0]?.id ?? "");
  const [share, setShare] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const firstField = useRef<HTMLInputElement | HTMLSelectElement>(null);

  /*
   * Nobody, until somebody is ticked.
   *
   * The password used to be sealed to the whole team the moment a session
   * started, so every colleague could open every session and nobody was asked.
   * Starting from nobody makes the answer something chosen rather than
   * something discovered later.
   */
  const { reachable: colleagues, unreachable } = shareCandidates(members, you);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    /* Restoring the literal earlier value, not "", so a nested open is safe. */
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  /*
   * Focus the first field rather than the dialog. Focusing the dialog left the
   * caret on a div, so the first thing typed went nowhere until you clicked a
   * second time.
   */
  useEffect(() => {
    const frame = requestAnimationFrame(() => firstField.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [kind.id]);

  function choose(next: SessionKind) {
    setKind(next);
    /* Fields are per-kind, so carrying values across would build nonsense. */
    setValues({});
    setError("");
  }

  const command = kind.build(values);
  const chosenMachine = devices.find((device) => device.id === machine);
  const machineReady = chosenMachine ? machineOnline(chosenMachine) : false;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!command || !machine) return;
    setBusy(true);
    setError("");
    try {
      await onStart({
        deviceId: machine,
        command,
        name: sessionName(values, command),
        share: [...share],
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start that session.");
      setBusy(false);
    }
  }

  return createPortal(
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="New session">
        <header className="sheet-head">
          <h2>New session</h2>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <X size={17} weight="bold" />
          </button>
        </header>

        <div className="sheet-body">
          <div className="kind-grid" role="radiogroup" aria-label="What to run">
            {SESSION_KINDS.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="radio"
                aria-checked={candidate.id === kind.id}
                className={candidate.id === kind.id ? "kind is-active" : "kind"}
                onClick={() => choose(candidate)}
              >
                <img src={candidate.icon} alt="" className="kind-icon" />
                <span className="kind-title">{candidate.title}</span>
                <span className="kind-blurb">{candidate.blurb}</span>
              </button>
            ))}
          </div>

          <form className="sheet-form" onSubmit={handleSubmit}>
            {kind.fields.map((field, index) => (
              <div key={field.name} className="sheet-field">
                {field.kind === "toggle" ? (
                  <label className="sheet-toggle">
                    <span className="sheet-toggle-text">
                      <b>{field.label}</b>
                      {field.help && <em>{field.help}</em>}
                    </span>
                    <input
                      type="checkbox"
                      className="switch"
                      role="switch"
                      checked={values[field.name] === true}
                      onChange={(event) =>
                        setValues((current) => ({ ...current, [field.name]: event.target.checked }))
                      }
                    />
                  </label>
                ) : (
                  <>
                    <label htmlFor={`f-${field.name}`}>{field.label}</label>
                    {field.kind === "select" ? (
                      <select
                        id={`f-${field.name}`}
                        ref={index === 0 ? (firstField as React.RefObject<HTMLSelectElement>) : undefined}
                        value={String(values[field.name] ?? "")}
                        onChange={(event) =>
                          setValues((current) => ({ ...current, [field.name]: event.target.value }))
                        }
                      >
                        {field.options?.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={`f-${field.name}`}
                        ref={index === 0 ? (firstField as React.RefObject<HTMLInputElement>) : undefined}
                        type="text"
                        value={String(values[field.name] ?? "")}
                        placeholder={field.placeholder}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) =>
                          setValues((current) => ({ ...current, [field.name]: event.target.value }))
                        }
                      />
                    )}
                    {field.help && <p className="sheet-help">{field.help}</p>}
                  </>
                )}
              </div>
            ))}

            {devices.length > 1 && (
              <div className="sheet-field">
                <label htmlFor="f-machine">Machine</label>
                <select
                  id="f-machine"
                  value={machine}
                  onChange={(event) => setMachine(event.target.value)}
                >
                  {devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.label}
                      {/* An <option> cannot hold the status badge markup. */}
                      {machineOnline(device) ? "" : " — offline"}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {chosenMachine && harnessMissing(kind.id, chosenMachine) && (
              <p className="sheet-note">
                <Warning size={14} weight="fill" />
                <span>
                  {kind.title} was not found on <b>{chosenMachine.label}</b>. The
                  command will still be sent, and will fail there if the tool is
                  not installed.
                </span>
              </p>
            )}

            {chosenMachine && machineReady && !chosenMachine.agentPublicKey && (
              <p className="sheet-note">
                <Warning size={14} weight="fill" />
                <span>
                  <b>{chosenMachine.label}</b> is running an older build that
                  cannot receive a password, so a session started there could
                  never be opened here. Update shell on that machine, then try
                  again.
                </span>
              </p>
            )}

            {chosenMachine && !machineReady && (
              <p className="sheet-note">
                <Warning size={14} weight="fill" />
                <span>
                  <b>{chosenMachine.label}</b> is not reachable. Sign in there
                  with <code>shell login</code> and allow browser-started
                  sessions, and this will light up.
                </span>
              </p>
            )}

            {/*
              * Who gets the password. Nothing is typed: the password is
              * generated here and sealed to each person ticked, so the choice
              * is a list of colleagues rather than a secret to invent and pass
              * around by hand.
              */}
            {colleagues.length > 0 && (
              <fieldset className="share-list">
                <legend>Who can open it</legend>
                {colleagues.map((member) => (
                  <label key={member.uid} className="share-person">
                    <input
                      type="checkbox"
                      checked={share.has(member.uid)}
                      onChange={(event) =>
                        setShare((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(member.uid);
                          else next.delete(member.uid);
                          return next;
                        })
                      }
                    />
                    <Avatar person={member} size="xs" />
                    <span className="share-name">{displayName(member)}</span>
                  </label>
                ))}
                <p className="sheet-help">
                  {share.size === 0
                    ? "Only you will be able to open this session. You can add people to it afterwards."
                    : "They can open it without being told anything. You can add more people afterwards."}
                </p>
              </fieldset>
            )}

            {unreachable.length > 0 && (
              <p className="sheet-note">
                <Warning size={14} weight="fill" />
                <span>
                  {unreachable.length === 1
                    ? `${displayName(unreachable[0])} has not opened the app in a browser yet, so there is nowhere to send a password. They will appear here once they have.`
                    : `${unreachable.length} people have not opened the app in a browser yet, so there is nowhere to send them a password.`}
                </span>
              </p>
            )}

            {error && <Alert tone="error">{error}</Alert>}

            {/* The exact command, so nothing runs on a machine unseen. */}
            <div className="sheet-preview">
              <span aria-hidden="true">$</span>
              <code>{command || "nothing to run yet"}</code>
            </div>

            <div className="sheet-actions">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                busy={busy}
                busyLabel="Starting"
                disabled={!command || !machine || !machineReady || !chosenMachine?.agentPublicKey}
              >
                Start session
              </Button>
            </div>

            {devices.length === 0 && (
              <p className="sheet-help">
                No linked machine is available. Run <code>shell login</code> on one.
              </p>
            )}
          </form>
        </div>
      </div>
    </div>,
    document.body,
  );
}
