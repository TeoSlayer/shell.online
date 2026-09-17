import { CLASS_LORE, WORLD } from "../lore/world";
import { nextUnlock, type Standing } from "../state/progress";
import type { Actor } from "../world/sim";
import { sessionBreakdown } from "./session-breakdown";

/**
 * What the player needs to know without opening anything.
 *
 * Four things, and nothing else: who they are and how far along, what they can
 * spend, what the stat-gathering has cost, and who is on the field. Everything
 * else lives behind the pause menu, because a heads-up display is screen space
 * borrowed from the thing it is displaying over.
 *
 * All of it is DOM rather than canvas. It does not move with the world, it has
 * to be readable by a screen reader, and it has to be reachable with a pad —
 * three things the canvas is bad at and the document is good at.
 */

export interface HudProps {
  standing: Standing;
  marks: number;
  /** Tokens the stat-gathering has spent. See the elixir vial below. */
  elixir: number;
  /** Whether any stat-gathering has been agreed to at all. */
  gathering: boolean;
  characterClass: string;
  wrights: Actor[];
  /** True when the field is showing a stand-in garrison, not real sessions. */
  demo: boolean;
  /**
   * Whether the service has told us what has been earned.
   *
   * Unreachable is not nothing earned, and a bar reading zero because a
   * request failed is a bar telling somebody their week did not count.
   */
  counted: boolean;
  /** The uncapped number of active sessions; the canvas may draw fewer. */
  sessionTotal: number;
  /** Says whether the map is live, loading, or an explicitly labelled preview. */
  dataState: string;
  onOpenRoster: () => void;
  /** Opens the gathering: the notice when it is off, the bill when it is on. */
  onOpenGathering: () => void;
}

/** The real work represented by the figures currently drawn on the field. */
/** A bar with its numbers beside it, never colour alone. */
function Meter({
  label,
  value,
  of,
  tone,
  detail,
}: {
  label: string;
  value: number;
  of: number;
  tone: "xp" | "elixir";
  detail?: string;
}) {
  const fraction = of > 0 ? Math.min(1, Math.max(0, value / of)) : 0;
  return (
    <div className={`keep-meter is-${tone}`}>
      <div className="keep-meter-head">
        <span className="keep-meter-label">{label}</span>
        <span className="keep-meter-value">
          {value.toLocaleString()}
          {of > 0 && <span className="keep-meter-of"> / {of.toLocaleString()}</span>}
        </span>
      </div>
      <div
        className="keep-meter-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={of || 1}
        aria-valuenow={value}
        aria-label={label}
      >
        <span className="keep-meter-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      {detail && <p className="keep-meter-detail">{detail}</p>}
    </div>
  );
}

/**
 * How full the vial looks, which is not how many tokens there are.
 *
 * Logarithmic, because the range this has to cover is absurd. A light week is
 * a few hundred thousand tokens and a heavy one is hundreds of millions -- a
 * real machine reported eighty-three million for three days of ordinary work.
 * On the linear scale this used to have, which filled at a million, that pinned
 * the vial at the top on the first run and it never said anything again.
 *
 * A decade of tokens is a fifth of the vial: a hundred thousand is a third
 * full, ten million is two thirds, a billion is the top. The exact number is
 * printed beside it, which is where precision belongs; this is for the glance.
 */
function vialFill(tokens: number): number {
  if (tokens <= 0) return 0;
  const decades = Math.log10(tokens) / 9;
  return Math.min(100, Math.max(4, decades * 100));
}

/**
 * The elixir vial: what the stat-gathering has spent, in tokens.
 *
 * On the HUD rather than in a settings page because it is the one number in
 * this game that costs real money. Somebody playing with a resource gauge
 * should see at a glance that the gauge is their own spend, and clicking it
 * says where every drop went.
 */
function Elixir({ tokens, gathering }: { tokens: number; gathering: boolean }) {
  return (
    <div className="keep-elixir">
      <span className="keep-vial" aria-hidden="true">
        <span
          className="keep-vial-fill"
          style={{ height: `${vialFill(tokens)}%` }}
        />
      </span>
      <span className="keep-elixir-text">
        <span className="keep-elixir-label">{WORLD.essence}</span>
        <span className="keep-elixir-value">
          {gathering ? `${tokens.toLocaleString()} tokens` : "not gathering"}
        </span>
      </span>
    </div>
  );
}

export function Hud({
  standing,
  marks,
  elixir,
  gathering,
  characterClass,
  wrights,
  demo,
  counted,
  sessionTotal,
  dataState,
  onOpenRoster,
  onOpenGathering,
}: HudProps) {
  const lore = CLASS_LORE[characterClass] ?? CLASS_LORE.terminal;
  const unlock = nextUnlock(standing.level);
  const { fixing, building, waiting } = sessionBreakdown(wrights);

  /*
   * Corners rather than a bar.
   *
   * A strip across the top was one panel wide enough to reach from edge to edge
   * and tall enough to hold three rows, and what it mostly did was cover the
   * map. Everything on it is glanced at rather than read, and things that are
   * glanced at belong at the edges of the eye, not across the middle of what
   * you are looking at.
   *
   * So: who you are, top left, because it is the only thing here you might read
   * a whole sentence of. What you have, bottom left, where money lives in every
   * game anybody has played. Who is out, bottom right, next to the key prompt.
   * The top right is left for the pause button, which was already there.
   */
  return (
    <>
      <div className="keep-corner is-top-left">
        <div className="keep-panel keep-standing">
          <div className="keep-operational-head">
            <span className="keep-operational-value">{sessionTotal.toLocaleString()}</span>
            <span className="keep-operational-label">
              {demo ? "example sessions" : sessionTotal === 1 ? "active session" : "active sessions"}
            </span>
          </div>
          <p className="keep-operational-breakdown">
            {fixing} fixing · {building} building · {waiting} waiting
          </p>
          <span className={`keep-data-state${demo ? " is-preview" : " is-live"}`}>
            {dataState}
          </span>
          <div className="keep-standing-divider" />
          <div className="keep-standing-head">
            <span className="keep-crest" aria-hidden="true">
              <span className="keep-crest-letter">{lore.title.slice(0, 1)}</span>
            </span>
            <span className="keep-standing-text">
              <span className="keep-standing-class">{lore.title}</span>
              <span className="keep-standing-level">Level {standing.level}</span>
            </span>
          </div>
          <Meter
            label="Experience"
            value={standing.into}
            of={standing.needed}
            tone="xp"
            detail={
              counted
                ? unlock
                  ? `${unlock.name} at level ${unlock.level}`
                  : "Nothing left to unlock"
                : "An example standing — the service did not answer"
            }
          />
        </div>
      </div>

      <div className="keep-corner is-bottom-left">
        <div className="keep-panel keep-purse">
          <span className="keep-coin" aria-hidden="true">◈</span>
          <span className="keep-purse-text">
            <span className="keep-purse-value">{marks.toLocaleString()}</span>
            <span className="keep-purse-label">{WORLD.coin}</span>
          </span>
        </div>

        {/*
          * The vial is a way in, not an ornament. A figure that stands for
          * money somebody's machine has spent should be one press from the
          * account of what spent it -- and while it is off, one press from the
          * notice explaining what turning it on would read.
          */}
        <button
          type="button"
          className="keep-panel keep-elixir-panel"
          onClick={onOpenGathering}
          title={gathering ? "What the gathering has cost" : "Nothing is being read. What this is"}
        >
          <Elixir tokens={elixir} gathering={gathering} />
        </button>
      </div>

      <div className="keep-corner is-bottom-right">
        <button type="button" className="keep-panel keep-roster-button" onClick={onOpenRoster}>
          <span className="keep-roster-count">{wrights.length}</span>
          <span className="keep-roster-text">
            <span className="keep-roster-label">{demo ? "Example map" : "Session map"}</span>
            {/*
              * Counts with words, not two coloured dots. The same information
              * has to survive a screenshot and a palette somebody cannot
              * separate.
              */}
            <span className="keep-roster-detail">
              {fixing} fixing · {building} building · {waiting} waiting
            </span>
          </span>
        </button>
      </div>
    </>
  );
}
