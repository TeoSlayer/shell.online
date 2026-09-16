import type React from "react";
import { kindById } from "../../lib/session-kinds";
import { CLASS_LORE } from "../lore/world";
import { Mark } from "./Mark";
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
  field,
  now,
  onClose,
  onOpenSession,
  cardRef,
}: {
  actor: Actor;
  /** Everybody on the field, for "whose company is this". */
  field: Actor[];
  now: number;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
  /**
   * The card's own element, which the scene moves.
   *
   * It follows the figure it is about, sixty times a second, so its position is
   * written straight onto the node rather than held in React state -- a card
   * that re-rendered the route at frame rate to move one box would be paying a
   * component tree for an arithmetic problem.
   */
  cardRef?: React.Ref<HTMLElement>;
}) {
  const lore = CLASS_LORE[actor.kind] ?? CLASS_LORE.terminal;
  const posting = garrisonById(actor.home);
  const work = WORK_WORDS[actor.work];
  const icon = kindById(actor.kind)?.icon;
  /*
   * Everybody on the field is handed in rather than looked up from a store,
   * because the card is about one figure and this is the only thing it needs
   * the rest of them for.
   */
  const company = field.filter(
    (one) => one.role === "soldier" && one.heroUid === actor.heroUid,
  );
  const captain = field.find(
    (one) => one.role === "hero" && one.heroUid === actor.heroUid,
  );

  return (
    <aside
      className="keep-panel keep-wright"
      role="dialog"
      aria-label={`${actor.name}, a wright`}
      ref={cardRef}
    >
      <header className="keep-wright-head">
        {/*
          * The harness's own mark, which is the same mark the session list uses
          * and the same one over this figure's head on the map. A letter in a
          * box would be a third way of saying the same thing.
          */}
        <span className="keep-wright-sigil" aria-hidden="true">
          {icon ? <img src={icon} alt="" /> : lore.title.slice(0, 1)}
        </span>
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
        {/*
          * Every fact carries a mark as well as a word.
          *
          * The mark is the faster read and the word is the unambiguous one, and
          * a card skimmed at a glance wants the first while a card actually
          * read wants the second. Never the mark on its own: a glyph nobody has
          * been taught is decoration.
          */}
        <div>
          <dt><Mark name="work" />Doing</dt>
          <dd>
            {work.title}
            <span className="keep-wright-note">{work.note}</span>
          </dd>
        </div>
        {/*
          * Who they are with. Different for the two, because they are different
          * kinds of thing: a hero commands a company, a soldier belongs to one.
          * "Posted to: the field" was what this said for a hero, which is a
          * sentence that tells nobody anything.
          */}
        {actor.role === "hero" ? (
          <div>
            <dt><Mark name="company" />Company</dt>
            <dd>
              {company.length === 1 ? "1 soldier" : `${company.length} soldiers`}
              <span className="keep-wright-note">
                {company.length === 0
                  ? "Nothing running under this name."
                  : `${company.filter((one) => one.work === "bug").length} mending · ` +
                    `${company.filter((one) => one.work === "feature").length} making`}
              </span>
            </dd>
          </div>
        ) : (
          <div>
            <dt><Mark name="company" />Serves</dt>
            <dd>
              {captain?.name ?? "nobody"}
              {posting && <span className="keep-wright-note">{posting.truth}</span>}
            </dd>
          </div>
        )}
        {actor.session && (
          <>
            <div>
              <dt><Mark name="machine" />Machine</dt>
              <dd>{actor.session.host}</dd>
            </div>
            <div>
              <dt><Mark name="running" />Running</dt>
              <dd className="keep-wright-command">
                <code>{actor.session.command}</code>
              </dd>
            </div>
            <div>
              <dt><Mark name="elapsed" />On the field</dt>
              <dd>{since(actor.session.startedAt, now)}</dd>
            </div>
          </>
        )}
        <div>
          <dt><Mark name="condition" />Condition</dt>
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
