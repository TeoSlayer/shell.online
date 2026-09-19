import { createContext, useContext } from "react";
import type { InputDevice } from "../engine/input";
import { DEFAULT_OPTIONS, type GameOptions } from "./options";

/**
 * The few things every screen in the keep needs to draw itself correctly:
 * what the player is holding, how big they want the interface, and whether
 * they want it to move.
 *
 * Deliberately small. Game state proper (heroes, the base, the purse) is
 * fetched and owned separately; this is presentation, and presentation is
 * needed by the boot screen before there is any game state at all.
 */
export interface GameShell {
  options: GameOptions;
  setOptions: (next: GameOptions) => void;
  /** Resolved against the OS setting, so callers do not repeat that decision. */
  reducedMotion: boolean;
  device: InputDevice;
  paused: boolean;
  setPaused: (paused: boolean) => void;
}

export const GameShellContext = createContext<GameShell>({
  options: DEFAULT_OPTIONS,
  setOptions: () => {},
  reducedMotion: false,
  device: "keyboard",
  paused: false,
  setPaused: () => {},
});

export function useGameShell(): GameShell {
  return useContext(GameShellContext);
}
