import { useState } from "react";
import { CLASS_LORE, OPENING, WORLD } from "../lore/world";
import { Menu, type MenuItem } from "./Menu";
import { Prompt } from "./Prompt";

/**
 * The one thing the game asks before it starts.
 *
 * Shown once, on first launch, and never again unless somebody asks to change
 * it. Everything else about the keep is derived from work that already
 * happened; this is the single decision the player actually makes, which is
 * why it gets a screen of its own rather than a dropdown in a settings panel.
 *
 * The opening is three lines. A wall of fiction in front of a game somebody
 * opened out of curiosity is a wall they close.
 */
export function ChooseCharacter({ onChoose }: { onChoose: (kind: string) => void }) {
  const [focused, setFocused] = useState(0);
  const kinds = Object.keys(CLASS_LORE);
  const current = CLASS_LORE[kinds[focused]] ?? CLASS_LORE.terminal;

  const items: MenuItem[] = kinds.map((kind) => ({
    id: kind,
    label: CLASS_LORE[kind].title,
    detail: CLASS_LORE[kind].motto,
    onSelect: () => onChoose(kind),
  }));

  return (
    <div className="keep-curtain" role="presentation">
      <div className="keep-panel keep-panel-heavy keep-opening" role="dialog" aria-modal="true" aria-label="Choose your character">
        <header className="keep-opening-head">
          <h2>{WORLD.era}</h2>
          {OPENING.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </header>

        <div className="keep-opening-choose">
          <h3>Which are you?</h3>
          <Menu
            items={items}
            label="Choose your character"
            onIndexChange={setFocused}
          />
          {/*
            * The description sits beside the list rather than inside each row,
            * so moving through five classes does not reflow the whole panel
            * under the cursor.
            */}
          <aside className="keep-opening-detail" aria-live="polite">
            <p className="keep-opening-title">{current.title}</p>
            <p className="keep-opening-note">{current.note}</p>
          </aside>
        </div>

        <footer className="keep-pause-foot">
          <Prompt action="confirm" verb="take the keep" />
          <span className="keep-build">This can be changed later.</span>
        </footer>
      </div>
    </div>
  );
}
