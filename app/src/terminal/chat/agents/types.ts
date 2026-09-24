/**
 * Reading an agent's own interface as a conversation.
 *
 * The chat renderer was built for a shell: lines go in, lines come back, and
 * the two are cut into messages. Almost no session on this product is a
 * shell. They are coding agents, and an agent does not print lines -- it
 * takes the alternate screen and draws an interface on it, which the renderer
 * could only mirror as a grid. On a phone that is unreadable and not for a
 * reason a stylesheet can fix: the session's grid is eighty columns wide and
 * shared with every other viewer, so it cannot be reflowed, and eighty
 * columns in a phone's width is under five pixels a character.
 *
 * The only way to put an agent on a phone is to stop showing it as a grid,
 * which means reading it. That is what an adapter does: it recognises one
 * agent's interface and turns the frames of it into the utterances it was
 * drawing.
 *
 * This is a reading, and it is worth being plain about what that costs. An
 * adapter knows the shape of one program's screen at the versions it was
 * written against, and the program's next release can change that shape
 * without telling anybody. So an adapter is expected to be wrong eventually,
 * and the design assumes it: `matches` is a gate rather than a guess, an
 * adapter that recognises nothing yields nothing, and a session whose agent
 * has no adapter is handed to the terminal renderer instead of being read
 * badly. The renderer menu on the pane is the way back for a person who can
 * see it has gone wrong.
 */

import type { TranscriptLine } from "../transcript";

export type UtteranceKind = "sent" | "received" | "tool";

export interface AgentUtterance {
  kind: UtteranceKind;
  /** "sent" and "tool" say their heading in one string. */
  text: string;
  /** What the program wrote, or what a tool call reported. */
  lines: TranscriptLine[];
  /** Whether the spacing in those lines is carrying meaning. */
  preformatted?: boolean;
  /**
   * Whether the agent is still writing this one.
   *
   * A paragraph is given out while it is still growing, not held until it
   * ends, so that watching an agent work looks like watching it work rather
   * than like nothing happening followed by three paragraphs at once. The
   * same paragraph is given again each frame, with the lines it has by then,
   * and again once more with `open` false when it ends -- so a reader can
   * treat every one of them as "this is the paragraph now".
   */
  open?: boolean;
}

export interface AgentAdapter {
  /** Matches a session kind id where there is one; see session-kinds.ts. */
  readonly id: string;
  /** What to call it in the conversation. */
  readonly title: string;
  /**
   * Whether this was written against a captured frame of the program's own
   * screen, or against the shape its family of programs share. Said out loud
   * in the conversation, because a reading built on a shape is a reading
   * somebody should be able to distrust on sight. See known.ts.
   */
  readonly confident: boolean;

  /**
   * Whether this adapter recognises the program drawing this screen.
   *
   * Asked of the whole frame rather than of a session's declared kind,
   * because what is running inside a session is not always what it was
   * started as: a person opens a shell and runs an agent in it, and the
   * session still says "Terminal process".
   *
   * `title` is what the program set the window title to, which is the most
   * reliable thing on offer: a header scrolls away, and a title does not.
   */
  matches(frame: readonly string[], title?: string): boolean;

  /**
   * The utterances this frame added. Stateful: it is given every frame and
   * decides what is new, so it must be `reset` when the program exits.
   */
  read(frame: readonly TranscriptLine[]): AgentUtterance[];

  /**
   * What is left once the screen has gone quiet.
   *
   * An adapter holds back the row a program looks to be part-way through
   * writing, because a half-drawn line shown as a message is worse than a
   * line that arrives a moment late. The row a program *finished* on looks
   * exactly the same, so the caller says when nothing further is coming.
   */
  flush(): AgentUtterance[];

  /** Preview an idle tail without treating a network pause as a message boundary. */
  settle(): AgentUtterance[];

  reset(): void;
}
