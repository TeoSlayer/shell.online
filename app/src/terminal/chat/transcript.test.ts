import { describe, expect, it } from "vitest";
import { IDLE_CLOSE_MS, MAX_LINES_PER_MESSAGE, MAX_MESSAGES, Transcript, plainLine } from "./transcript";

function received(transcript: Transcript) {
  return transcript.messages.filter((message) => message.kind === "received");
}

function texts(transcript: Transcript) {
  return transcript.messages.map((message) =>
    message.kind === "received" ? message.lines.map((line) => line.text).join("\n") : message.text,
  );
}

describe("a command and its answer", () => {
  it("shows what was sent, and what came back, as two messages", () => {
    const transcript = new Transcript();
    transcript.submitted("ls", 1000);
    transcript.output([plainLine("alex@mac ~ % ls"), plainLine("a.txt"), plainLine("b.txt")], 1010);

    expect(transcript.messages.map((message) => message.kind)).toEqual(["sent", "received"]);
    expect(texts(transcript)).toEqual(["ls", "a.txt\nb.txt"]);
  });

  it("drops the echoed line, prompt and all, because the command is already in the thread", () => {
    const transcript = new Transcript();
    transcript.submitted("git status", 1000);
    transcript.output([plainLine("~/work/api on main ❯ git status"), plainLine("nothing to commit")], 1010);

    expect(texts(transcript)).toEqual(["git status", "nothing to commit"]);
  });

  it("keeps a line that merely resembles a command typed long ago", () => {
    const transcript = new Transcript();
    transcript.submitted("ls", 1000);
    /* Forty lines of output go by without the echo ever turning up. */
    transcript.output(Array.from({ length: 41 }, () => plainLine("building")), 1010);
    transcript.output([plainLine("packages to install: ls")], 1020);

    const answer = received(transcript)[0];
    expect(answer.lines.at(-1)?.text).toBe("packages to install: ls");
  });

  it("keeps commands typed ahead of the process in order", () => {
    const transcript = new Transcript();
    transcript.submitted("one", 1000);
    transcript.submitted("two", 1001);
    transcript.output([plainLine("$ one"), plainLine("first"), plainLine("$ two"), plainLine("second")], 1010);

    expect(texts(transcript)).toEqual(["one", "two", "first\nsecond"]);
  });
});

describe("where one answer ends", () => {
  it("keeps adding to the same message while output is still arriving", () => {
    const transcript = new Transcript();
    transcript.submitted("build", 1000);
    transcript.output([plainLine("step 1")], 1010);
    transcript.output([plainLine("step 2")], 1200);

    expect(received(transcript)).toHaveLength(1);
  });

  it("closes the message once the process has gone quiet", () => {
    const transcript = new Transcript();
    transcript.submitted("build", 1000);
    transcript.output([plainLine("done")], 1010);

    expect(transcript.settle(1010 + IDLE_CLOSE_MS - 1)).toBe(false);
    expect(received(transcript)[0].open).toBe(true);
    expect(transcript.settle(1010 + IDLE_CLOSE_MS)).toBe(true);
    expect(received(transcript)[0].open).toBe(false);
  });

  it("starts a new answer for the next command even without a pause", () => {
    const transcript = new Transcript();
    transcript.submitted("one", 1000);
    transcript.output([plainLine("first")], 1010);
    transcript.submitted("two", 1020);
    transcript.output([plainLine("second")], 1030);

    expect(received(transcript)).toHaveLength(2);
  });

  it("takes the shell's own word for it, with the status the command exited with", () => {
    const transcript = new Transcript();
    transcript.submitted("false", 1000);
    transcript.output([plainLine("nope")], 1010);
    transcript.commandFinished(1, 1020);

    const answer = received(transcript)[0];
    expect(answer.open).toBe(false);
    expect(answer.exitCode).toBe(1);
  });

  it("splits an answer too long for one message", () => {
    const transcript = new Transcript();
    transcript.submitted("cat huge", 1000);
    transcript.output(
      Array.from({ length: MAX_LINES_PER_MESSAGE + 10 }, (_, index) => plainLine(`line ${index}`)),
      1010,
    );

    const answers = received(transcript);
    expect(answers).toHaveLength(2);
    expect(answers[0].lines).toHaveLength(MAX_LINES_PER_MESSAGE);
    expect(answers[1].lines).toHaveLength(10);
  });
});

describe("output nobody asked for", () => {
  it("becomes a message of its own, because a server logging is still the session talking", () => {
    const transcript = new Transcript();
    transcript.output([plainLine("listening on :8080")], 1000);

    expect(texts(transcript)).toEqual(["listening on :8080"]);
  });

  /*
   * It lands at the cursor, and between commands the cursor is halfway along
   * the prompt. The terminal shows the prompt and the log line on one row;
   * the conversation takes the prompt back off.
   */
  it("loses the prompt it was written on top of", () => {
    const transcript = new Transcript();
    transcript.setPrompt("~/work/api \u276f ");
    transcript.output([plainLine("~/work/api \u276f listening on :8080")], 1000);

    expect(texts(transcript)).toEqual(["listening on :8080"]);
  });

  it("keeps a line that merely starts the way the prompt does", () => {
    const transcript = new Transcript();
    transcript.setPrompt("~/work/api \u276f ");
    transcript.output([plainLine("~/work/api is where the build ran")], 1000);

    expect(texts(transcript)).toEqual(["~/work/api is where the build ran"]);
  });

  it("keeps the colour of what is left after the prompt comes off", () => {
    const transcript = new Transcript();
    transcript.setPrompt("$ ");
    transcript.output(
      [{ text: "$ fatal", runs: [{ text: "$ " }, { text: "fatal", fg: "#b3261e" }] }],
      1000,
    );

    const answer = received(transcript)[0];
    expect(answer.lines[0].text).toBe("fatal");
    expect(answer.lines[0].runs).toEqual([{ text: "fatal", fg: "#b3261e" }]);
  });
});

describe("an interrupted command", () => {
  it("records the interruption and what was abandoned with it", () => {
    const transcript = new Transcript();
    transcript.interrupted("sleep 900", 1000);

    expect(transcript.messages[0].kind).toBe("notice");
    expect(transcript.messages[0].text).toBe("Interrupted — sleep 900");
  });

  it("stops looking for the echo of a command that was never run", () => {
    const transcript = new Transcript();
    transcript.submitted("slow", 1000);
    transcript.interrupted("", 1001);
    transcript.output([plainLine("slow")], 1002);

    expect(texts(transcript).at(-1)).toBe("slow");
  });
});

describe("a full-screen program", () => {
  /*
   * There is no card for one any more, and no kind of message that holds a
   * grid. This renderer used to mirror the alternate screen into the thread,
   * and a grid is the one thing it cannot show: eighty columns will not go on
   * a phone at a size anybody can read, so what arrived in the middle of a
   * conversation was a wall of broken rows. What a program that cannot be
   * read as messages gets is a line saying it is running.
   */
  it("has no kind of its own to be drawn as", () => {
    const transcript = new Transcript();
    transcript.submitted("vim notes.md", 1000);
    transcript.noticed("vim notes.md is running. Switch this session to the terminal renderer to see it.", 1010);

    expect(transcript.messages.map((message) => message.kind)).toEqual(["sent", "notice"]);
    expect(transcript.messages.some((message) => message.lines.length > 1)).toBe(false);
  });

  it("says what is running once, not once a frame", () => {
    const transcript = new Transcript();
    transcript.noticed("top is running. Switch this session to the terminal renderer to see it.", 1000);

    const notices = transcript.messages.filter((message) => message.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain("terminal renderer");
  });
});

describe("a reconnect", () => {
  it("rebuilds the conversation instead of replaying it a message at a time", () => {
    const transcript = new Transcript();
    transcript.submitted("one", 1000);
    transcript.beginReplay();
    expect(transcript.messages).toHaveLength(0);
    expect(transcript.isReplaying).toBe(true);

    transcript.output([plainLine("restored")], 2000);
    transcript.endReplay();
    expect(transcript.isReplaying).toBe(false);
    expect(texts(transcript)).toEqual(["restored"]);
  });
});

describe("a session that runs all day", () => {
  it("keeps the most recent messages and lets the oldest go", () => {
    const transcript = new Transcript();
    for (let index = 0; index < MAX_MESSAGES + 25; index += 1) {
      transcript.submitted(`command ${index}`, 1000 + index);
    }

    expect(transcript.messages).toHaveLength(MAX_MESSAGES);
    expect(transcript.messages[0].text).toBe("command 25");
  });
});

describe("a notice", () => {
  it("closes the answer above it, so it is not read as coming before later lines", () => {
    const transcript = new Transcript();
    transcript.output([plainLine("first")], 1000);
    transcript.noticed("Output scrolled past faster than it could be kept.", 1010, "gap");
    transcript.output([plainLine("second")], 1020);

    expect(transcript.messages.map((message) => message.kind)).toEqual([
      "received",
      "notice",
      "received",
    ]);
    expect(received(transcript)[0].open).toBe(false);
  });
});

describe("the revision", () => {
  it("moves whenever anything changes, so a still conversation costs one comparison", () => {
    const transcript = new Transcript();
    const before = transcript.revision;
    transcript.output([plainLine("x")], 1000);
    expect(transcript.revision).toBeGreaterThan(before);

    const after = transcript.revision;
    expect(transcript.settle(1000)).toBe(false);
    expect(transcript.revision).toBe(after);
  });
});

describe("a command entered somewhere else", () => {
  /*
   * The machine's own keyboard, or another person watching the same session.
   * It arrives as a line written onto the prompt, and it is the whole reason
   * a session driven from the terminal used to read as a monologue.
   */
  it("appears as a message, not as a line of output", () => {
    const transcript = new Transcript();
    transcript.setPrompt("~/work/api ❯ ");
    transcript.expectCommand();
    transcript.output([plainLine("~/work/api ❯ npm test")], 1000);
    transcript.commandStarted();
    transcript.output([plainLine("67 passed")], 1010);

    expect(transcript.messages.map((m) => m.kind)).toEqual(["sent", "received"]);
    expect(transcript.messages[0].text).toBe("npm test");
  });

  it("does not arrive twice when it was this browser that sent it", () => {
    const transcript = new Transcript();
    transcript.setPrompt("$ ");
    transcript.submitted("npm test", 1000);
    transcript.expectCommand();
    transcript.output([plainLine("$ npm test")], 1010);
    transcript.commandStarted();

    expect(transcript.messages.map((m) => m.text)).toEqual(["npm test"]);
  });

  it("stops looking once the command is running, so output is never mistaken for one", () => {
    const transcript = new Transcript();
    transcript.setPrompt("$ ");
    transcript.expectCommand();
    transcript.commandStarted();
    transcript.output([plainLine("$ this is output that landed on the prompt")], 1000);

    expect(transcript.messages.map((m) => m.kind)).toEqual(["received"]);
  });

  it("is not invented from a line that never touched the prompt", () => {
    const transcript = new Transcript();
    transcript.setPrompt("$ ");
    transcript.expectCommand();
    transcript.output([plainLine("listening on :8080")], 1000);

    expect(transcript.messages.map((m) => m.kind)).toEqual(["received"]);
  });
});

describe("a command whose echo never arrives", () => {
  /*
   * The regression this covers: the pending echoes used to be tried oldest
   * first and only oldest, so one command that never echoed -- a password, a
   * line a program read and swallowed -- sat at the head of the queue and
   * every command sent after it was compared against the wrong text. For the
   * forty lines that took to expire, each real echo failed to match and
   * arrived in the conversation as output, so what was typed appeared twice:
   * once as the message, once again inside the answer under it.
   */
  it("does not make the next command appear twice", () => {
    const transcript = new Transcript();
    transcript.submitted("secret", 1000);
    /* The program read it without echoing, and printed nothing about it. */
    transcript.submitted("ls", 1001);
    transcript.output([plainLine("~/work ❯ ls"), plainLine("a.txt")], 1010);

    expect(texts(transcript)).toEqual(["secret", "ls", "a.txt"]);
  });

  it("retires the commands sent before the one that matched", () => {
    const transcript = new Transcript();
    transcript.submitted("one", 1000);
    transcript.submitted("two", 1001);
    transcript.output([plainLine("$ two"), plainLine("output of two")], 1010);
    /* "one" is gone, so a later line that happens to end in it is kept. */
    transcript.output([plainLine("this line mentions one")], 1020);

    expect(texts(transcript)).toEqual(["one", "two", "output of two\nthis line mentions one"]);
  });

  it("matches an echo of a command typed with a trailing space", () => {
    const transcript = new Transcript();
    transcript.submitted("ls ", 1000);
    transcript.output([plainLine("~/work ❯ ls"), plainLine("a.txt")], 1010);

    expect(texts(transcript)).toEqual(["ls ", "a.txt"]);
  });
});

describe("an answer with no blank line in it", () => {
  it("is cut into messages on its own shape rather than arriving as one wall", () => {
    const transcript = new Transcript();
    transcript.submitted("npm test", 1000);
    transcript.output(
      [
        plainLine("$ npm test"),
        plainLine("Ran every suite against the staging cluster."),
        plainLine("Two of them needed a retry before they settled."),
        plainLine("NAME      READY   STATUS"),
        plainLine("api       1/1     Running"),
      ],
      1010,
    );

    expect(texts(transcript)).toEqual([
      "npm test",
      "Ran every suite against the staging cluster.\nTwo of them needed a retry before they settled.",
      "NAME      READY   STATUS\napi       1/1     Running",
    ]);
    expect(received(transcript).map((message) => message.preformatted)).toEqual([false, true]);
  });
});

describe("a prompt read back off an agent's own screen", () => {
  /*
   * An agent draws the conversation it is having, so a prompt sent from this
   * browser turns up on its screen a moment later. It is already in the
   * thread as the message that caused it; without the echo rule it arrives a
   * second time and the conversation stutters.
   */
  it("is not added again when this browser is what sent it", () => {
    const transcript = new Transcript();
    transcript.submitted("refactor the session store", 1000);
    transcript.fromAgent({ kind: "sent", text: "refactor the session store", lines: [] }, 1010);

    expect(texts(transcript)).toEqual(["refactor the session store"]);
  });

  it("is added when somebody typed it on the machine itself", () => {
    const transcript = new Transcript();
    transcript.fromAgent({ kind: "sent", text: "typed on the laptop", lines: [] }, 1010);

    expect(texts(transcript)).toEqual(["typed on the laptop"]);
  });
});

describe("unchanged agent frames", () => {
  const answer = (runs = [{ text: "result", fg: "#ff0000" }]) => ({
    kind: "received" as const, text: "", open: true, preformatted: false,
    lines: [{ text: "result", runs }],
  });

  it("keeps the revision stable for equal content with new object identities", () => {
    const transcript = new Transcript();
    transcript.fromAgent(answer(), 1000);
    const revision = transcript.revision;
    const message = transcript.messages[0];
    transcript.fromAgent(answer(), 1010);
    expect(transcript.revision).toBe(revision);
    expect(transcript.messages[0]).toBe(message);
  });

  it.each([
    { fg: "#00ff00" }, { bg: "#000000" }, { bold: true }, { dim: true },
    { italic: true }, { underline: true },
  ])("publishes a style-only update: %j", (style) => {
    const transcript = new Transcript();
    transcript.fromAgent(answer(), 1000);
    const revision = transcript.revision;
    const runs = [{ text: "result", fg: "#ff0000", ...style }];
    transcript.fromAgent(answer(runs), 1010);
    expect(transcript.messages[0].lines[0].runs).toEqual(runs);
    expect(transcript.revision).toBeGreaterThan(revision);
  });

  it("publishes changed run boundaries even when the plain text is unchanged", () => {
    const transcript = new Transcript();
    transcript.fromAgent(answer(), 1000);
    const runs = [{ text: "re", fg: "#ff0000" }, { text: "sult", fg: "#00ff00" }];
    transcript.fromAgent(answer(runs), 1010);
    expect(transcript.messages[0].lines[0].runs).toEqual(runs);
  });
});
