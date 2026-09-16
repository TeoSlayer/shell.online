import { CLASS_LORE } from "../lore/world";
import { garrisonById } from "../world/marches";
import type { Actor } from "../world/sim";

/**
 * Everything known about one wright, shown when it is clicked.
 *
 * This is the answer to "the game is non-interactive". The map was a thing you
 * watched; now the figures on it are the sessions in your account and clicking
 * one tells you which, on what machine, running what, since when, and where it
 * has been posted.
 *
 * It is deliberately a panel at the side rather than a modal over the middle.
 * A modal would cover the thing you just clicked, which is the one part of the
 * screen you were looking at.
 */

function since(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

const WORK_WORDS: Record<Actor["work"], { title: string; note: string }> = {
  bug: { title: "Mending", note: "Out against the Unmade." },
  feature: { title: "Making", note: "Raising something that was not there." },
  idle: { title: "Standing to", note: "No fault named, nothing being built." },
};

export function WrightPanel({
  actor,
  now,
  onClose,
  onOpenSession,
}: {
  actor: Actor;
  now: number;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const lore = CLASS_LORE[actor.kind] ?? CLASS_LORE.terminal;
  const posting = garrisonById(actor.home);
  const work = WORK_WORDS[actor.work];

  return (
    <aside className="keep-panel keep-wright" role="dialog" aria-label={`${actor.name}, a wright`}>
      <header className="keep-wright-head">
        <span className="keep-sigil" aria-hidden="true">{lore.title.slice(0, 1)}</span>
        <span className="keep-wright-title">
          <span className="keep-wright-name">{actor.name}</span>
          <span className="keep-wright-class">{lore.title}</span>
        </span>
        <button type="button" className="keep-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <p className="keep-wright-motto">{lore.motto}</p>

      <dl className="keep-wright-facts">
        <div>
          <dt>Doing</dt>
          <dd>
            {work.title}
            <span className="keep-wright-note">{work.note}</span>
          </dd>
        </div>
        <div>
          <dt>Posted to</dt>
          <dd>
            {posting?.name ?? "the field"}
            {posting && <span className="keep-wright-note">{posting.truth}</span>}
          </dd>
        </div>
        {actor.session && (
          <>
            <div>
              <dt>Machine</dt>
              <dd>{actor.session.host}</dd>
            </div>
            <div>
              <dt>Running</dt>
              <dd className="keep-wright-command">
                <code>{actor.session.command}</code>
              </dd>
            </div>
            <div>
              <dt>On the field</dt>
              <dd>{since(actor.session.startedAt, now)}</dd>
            </div>
          </>
        )}
        <div>
          <dt>Condition</dt>
          <dd>
            {/* A figure and a word, never a bar on its own. */}
            {actor.hp} of {actor.maxHp}
            <span className="keep-wright-note">
              {actor.hp >= actor.maxHp ? "Unharmed." : "Has been in it."}
            </span>
          </dd>
        </div>
      </dl>

      {actor.session && onOpenSession && (
        <button
          type="button"
          className="keep-button"
          onClick={() => onOpenSession(actor.session!.id)}
        >
          Open the terminal
        </button>
      )}
    </aside>
  );
}
