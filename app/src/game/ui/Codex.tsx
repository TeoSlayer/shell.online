import { GARRISONS } from "../world/marches";
import { CLASS_LORE, FOE_LORE, WORLD } from "../lore/world";

/**
 * The Chronicle: what everything in the keep is, and what it is a name for.
 *
 * Every entry does the same two things — says the fictional name, then says
 * plainly what it corresponds to in the product. That second half is the whole
 * point. Lore that only describes a fiction is a thing to be skipped; lore
 * that quietly teaches somebody that a wright is a session and the Prompt is
 * the shell process is doing a job.
 *
 * Read-only, and reached from the pause menu. Nothing here is a mechanic and
 * nothing here can be missed by not reading it.
 */
export function Codex({ onBack }: { onBack: () => void }) {
  return (
    <div className="keep-codex">
      <section className="keep-codex-section">
        <h3>The Marches</h3>
        <dl className="keep-codex-list">
          <div>
            {/* Capitalised here: these are headings, not mid-sentence mentions. */}
            <dt>The Prompt</dt>
            <dd>
              The amber light in the hall. While it burns, the machine is up — it is the
              shell process, and it goes out the way a process does.
            </dd>
          </div>
          <div>
            <dt>A wright</dt>
            <dd>
              One session. Your machine sent it to do a piece of work, and it is on the
              field for as long as that work is running.
            </dd>
          </div>
          <div>
            <dt>An outpost</dt>
            <dd>A linked machine. The garrison musters from whichever ones are awake.</dd>
          </div>
          <div>
            <dt>Elixir</dt>
            <dd>
              Tokens spent gathering your statistics. It is the one figure in the keep
              that is real money, which is why it has a vessel of its own.
            </dd>
          </div>
        </dl>
      </section>

      <section className="keep-codex-section">
        <h3>The garrison</h3>
        <dl className="keep-codex-list">
          {Object.entries(CLASS_LORE).map(([kind, lore]) => (
            <div key={kind}>
              <dt>{lore.title}</dt>
              <dd>
                <em>{lore.motto}</em> {lore.note} Mustered from a <code>{kind}</code>{" "}
                session.
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="keep-codex-section">
        <h3>{WORLD.foe}</h3>
        <p className="keep-codex-intro">
          They come when a session is working on a fault, and not otherwise. A keep whose
          sessions are all building things is a quiet keep.
        </p>
        <dl className="keep-codex-list">
          {FOE_LORE.map((foe) => (
            <div key={foe.id}>
              <dt>{foe.name}</dt>
              <dd>{foe.note}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="keep-codex-section">
        <h3>The holdings</h3>
        <p className="keep-codex-intro">
          Every one of these is somewhere on the map, with its name and its purpose on a
          board outside it. This is the index, not the source: the Marches are meant to be
          walked.
        </p>
        <dl className="keep-codex-list">
          {GARRISONS.map((garrison) => (
            <div key={garrison.id}>
              <dt>{garrison.name}</dt>
              <dd>
                <em>{garrison.purpose}</em> {garrison.truth}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <button type="button" className="keep-button" onClick={onBack}>
        Back
      </button>
    </div>
  );
}
