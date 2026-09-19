import { useGameShell } from "../state/context";
import {
  SAFE_ZONE_RANGE,
  UI_SCALE_RANGE,
  type ColourSetting,
  type MotionSetting,
} from "../state/options";

const MOTION_CHOICES: { value: MotionSetting; label: string; detail: string }[] = [
  { value: "system", label: "Match my system", detail: "Follows the setting on this device" },
  { value: "full", label: "Full", detail: "Shake, drift and particles" },
  { value: "reduced", label: "Reduced", detail: "Still frames, no shake, no particles" },
];

const COLOUR_CHOICES: { value: ColourSetting; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "deuteranopia", label: "Deuteranopia" },
  { value: "protanopia", label: "Protanopia" },
  { value: "tritanopia", label: "Tritanopia" },
];

/**
 * The settings that decide whether the game is playable at all on a given
 * screen, for a given person.
 *
 * Grouped with the reason above each one rather than a bare label. "Safe area"
 * means nothing to somebody whose television is eating their health bar; "if
 * the corners of the board are cut off, raise this" tells them what to do.
 */
export function OptionsPanel({ onBack }: { onBack: () => void }) {
  const { options, setOptions } = useGameShell();

  return (
    <div className="keep-options">
      <fieldset className="keep-option-group">
        <legend>Safe area</legend>
        <p className="keep-option-why">
          Televisions crop the edges of the picture. If the corners of the frame below are cut
          off, raise this until all four are visible.
        </p>
        <div className="keep-slider">
          <input
            type="range"
            min={SAFE_ZONE_RANGE.min}
            max={SAFE_ZONE_RANGE.max}
            step={1}
            value={options.safeZone}
            aria-label="Safe area inset, percent"
            onChange={(event) => setOptions({ ...options, safeZone: Number(event.target.value) })}
          />
          <output>{options.safeZone}%</output>
        </div>
        {/*
          * A calibration target, not decoration. It sits exactly on the inset
          * the slider sets, so "can you see all four corners" is a question
          * somebody can answer by looking rather than by guessing at a number.
          */}
        <div className="keep-safe-test" aria-hidden="true">
          <span className="keep-safe-corner is-tl" />
          <span className="keep-safe-corner is-tr" />
          <span className="keep-safe-corner is-bl" />
          <span className="keep-safe-corner is-br" />
        </div>
      </fieldset>

      <fieldset className="keep-option-group">
        <legend>Interface size</legend>
        <p className="keep-option-why">
          Larger for a television across the room, smaller for a monitor at arm’s length.
        </p>
        <div className="keep-slider">
          <input
            type="range"
            min={UI_SCALE_RANGE.min}
            max={UI_SCALE_RANGE.max}
            step={25}
            value={options.uiScale}
            aria-label="Interface size, percent"
            onChange={(event) => setOptions({ ...options, uiScale: Number(event.target.value) })}
          />
          <output>{options.uiScale}%</output>
        </div>
      </fieldset>

      <fieldset className="keep-option-group">
        <legend>Motion</legend>
        <p className="keep-option-why">
          Drifting and shaking can cause nausea. Reduced keeps everything readable and still.
        </p>
        <div className="keep-choices">
          {MOTION_CHOICES.map((choice) => (
            <label key={choice.value} className="keep-choice">
              <input
                type="radio"
                name="keep-motion"
                value={choice.value}
                checked={options.motion === choice.value}
                onChange={() => setOptions({ ...options, motion: choice.value })}
              />
              <span className="keep-choice-text">
                <span className="keep-choice-label">{choice.label}</span>
                <span className="keep-choice-detail">{choice.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="keep-option-group">
        <legend>Colour</legend>
        <p className="keep-option-why">
          Every state in the keep carries an icon and a word as well as a colour. These palettes
          widen the gaps between the colours themselves.
        </p>
        <div className="keep-choices is-inline">
          {COLOUR_CHOICES.map((choice) => (
            <label key={choice.value} className="keep-choice">
              <input
                type="radio"
                name="keep-colour"
                value={choice.value}
                checked={options.colour === choice.value}
                onChange={() => setOptions({ ...options, colour: choice.value })}
              />
              <span className="keep-choice-text">
                <span className="keep-choice-label">{choice.label}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <button type="button" className="keep-button" onClick={onBack}>
        Back
      </button>
    </div>
  );
}
