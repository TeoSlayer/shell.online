import { createContext, useContext } from "react";
import type { FeedbackKind } from "../lib/feedback";

export interface FeedbackRequest {
  /** Which control opened the sheet. Recorded with the message. */
  surface: string;
  /** Preselected, so a link under an error opens on "Something broke". */
  kind?: FeedbackKind;
  /** A line above the box that says what this surface is asking about. */
  prompt?: string;
  /** Small facts about the moment, shown in the sheet and sent with it. */
  context?: Record<string, string | undefined>;
}

export interface FeedbackValue {
  open(request: FeedbackRequest): void;
}

/*
 * A no-op by default, so a link rendered somewhere without the provider, such
 * as a test or a preview, is inert rather than an error.
 */
export const FeedbackContext = createContext<FeedbackValue>({ open() {} });

export function useFeedback(): FeedbackValue {
  return useContext(FeedbackContext);
}
