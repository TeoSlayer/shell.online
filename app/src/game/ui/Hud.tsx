import { CLASS_LORE, WORLD } from "../lore/world";
import { nextUnlock, type Standing } from "../state/progress";
import type { Actor } from "../world/sim";

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
  onOpenRoster: () => void;
}

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
 * The elixir vial: what the stat-gathering has spent, in tokens.
 *
 * It is here rather than buried in a settings page because it is the one
 * number in this game that costs real money. Somebody playing with a resource
 * gauge should be able to see at a glance that the gauge is their own spend,
 * and clicking it says where every drop went.
 */
function Elixir({ tokens, gathering }: { tokens: number; gathering: boolean }) {
  return (
    <div className="keep-elixir" title={gathering ? undefined : "Not gathering yet"}>
      <span className="keep-vial" aria-hidden="true">
        <span
          className="keep-vial-fill"
          /* Full at a million tokens; it is a feel, and the number is beside it. */
          style={{ height: `${Math.min(100, (tokens / 1_000_000) * 100)}%` }}
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
  onOpenRoster,
}: HudProps) {
  const lore = CLASS_LORE[characterClass] ?? CLASS_LORE.terminal;
  const unlock = nextUnlock(standing.level);
  const fighting = wrights.filter((wright) => wright.work === "bug").length;
  const building = wrights.filter((wright) => wright.work === "feature").length;

  return (
    <div className="keep-hud-bar">
      <div className="keep-panel keep-standing">
        <div className="keep-standing-head">
          <span className="keep-sigil" aria-hidden="true">
            {lore.title.slice(0, 1)}
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
          detail={unlock ? `${unlock.name} at level ${unlock.level}` : "Nothing left to unlock"}
        />
      </div>

      <div className="keep-panel keep-purse">
        <span className="keep-coin" aria-hidden="true">◈</span>
        <span className="keep-purse-text">
          <span className="keep-purse-value">{marks.toLocaleString()}</span>
          <span className="keep-purse-label">{WORLD.coin}</span>
        </span>
      </div>

      <div className="keep-panel keep-elixir-panel">
        <Elixir tokens={elixir} gathering={gathering} />
      </div>

      <button type="button" className="keep-panel keep-roster-button" onClick={onOpenRoster}>
        <span className="keep-roster-count">{wrights.length}</span>
        <span className="keep-roster-text">
          <span className="keep-roster-label">{demo ? "Example garrison" : "On the field"}</span>
          {/*
            * Counts with words, not two coloured dots. The same information has
            * to survive a screenshot and a palette somebody cannot separate.
            */}
          <span className="keep-roster-detail">
            {fighting} fighting · {building} building
          </span>
        </span>
      </button>
    </div>
  );
}
