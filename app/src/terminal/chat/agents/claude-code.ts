/**
 * Claude Code.
 *
 * The shape of the screen is `boxed-agent.ts`, which every coding agent this
 * product runs shares. What belongs here is the one thing that is this
 * program's alone: the name it writes on its own header, which is what says
 * the screen is its and not another agent's drawn with the same characters.
 */

import { BoxedAgent } from "./boxed-agent";

export { dedent, strip, unwrap } from "./boxed-agent";

export class ClaudeCodeAdapter extends BoxedAgent {
  constructor() {
    super({ id: "claude-code", title: "Claude Code", signature: /\bclaude code\b/iu, confident: true });
  }
}
