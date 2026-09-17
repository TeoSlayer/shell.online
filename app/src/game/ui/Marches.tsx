import { GARRISONS } from "../world/marches";

/**
 * The road book: every holding, what it is for, and a way to go there.
 *
 * This exists because the map got big. On a country you can see all of at once
 * there is nothing to navigate and a list of places would be furniture; on one
 * several screens across there is, and walking from the Keep to the Muster Yard
 * to find out whether anything is happening there is a chore rather than
 * exploration.
 *
 * It is also the second place the lore is written down, and deliberately the
 * lesser one. The sentence here is the same sentence on the board outside the
 * holding, so reading the list is a way of remembering what you have seen
 * rather than a substitute for going and seeing it. What the list adds is the
 * line the board does not carry: what each holding is a rename of.
 */
export function Marches({
  onTravel,
  onBack,
}: {
  onTravel: (id: string) => void;
  onBack: () => void;
}) {
  return (
    <div className="keep-marches">
      <p className="keep-marches-note">
        Ten holdings. The roads all meet at the Keep.
      </p>

      <ul className="keep-marches-list">
        {GARRISONS.map((garrison) => (
          <li key={garrison.id} className="keep-marches-item">
            <span className="keep-marches-text">
              <span className="keep-marches-name">{garrison.name}</span>
              <span className="keep-marches-purpose">{garrison.purpose}</span>
              {/* The part the board outside does not say. */}
              <span className="keep-marches-truth">{garrison.truth}</span>
            </span>
            <button
              type="button"
              className="keep-button"
              onClick={() => onTravel(garrison.id)}
            >
              Ride there
            </button>
          </li>
        ))}
      </ul>

      <button type="button" className="keep-button" onClick={onBack}>
        Back
      </button>
    </div>
  );
}
