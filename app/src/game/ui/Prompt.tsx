import { promptFor, type GameAction } from "../engine/input";
import { useGameShell } from "../state/context";

/**
 * "Press <button> to <verb>", with the button the player actually has.
 *
 * The only place in the game allowed to name a physical button. Everything
 * else asks for an action and lets this resolve it, which is what keeps the
 * prompts right when somebody swaps a keyboard for a pad mid-session.
 */
export function Prompt({ action, verb }: { action: GameAction; verb: string }) {
  const { device } = useGameShell();
  const button = promptFor(action, device);
  const sentence = device === "touch" ? `${button} to ${verb}` : `Press ${button} to ${verb}`;

  return (
    /*
     * The whole thing is one label to a screen reader. Read as separate nodes
     * it came out as "Press", "Enter", "to muster", which is three
     * announcements for one instruction.
     */
    <span className="keep-prompt" aria-label={sentence}>
      <kbd className="keep-key" aria-hidden="true">{button}</kbd>
      <span aria-hidden="true">{verb}</span>
    </span>
  );
}
