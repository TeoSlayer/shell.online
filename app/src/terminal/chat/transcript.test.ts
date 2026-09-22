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
  it("gets one live card rather than a message per repaint", () => {
    const transcript = new Transcript();
    transcript.submitted("vim notes.md", 1000);
    transcript.screenOpened("vim notes.md", 1010);
    transcript.screenPainted([plainLine("first frame")], 1020);
    transcript.screenPainted([plainLine("second frame")], 1030);

    const cards = transcript.messages.filter((message) => message.kind === "screen");
    expect(cards).toHaveLength(1);
    expect(cards[0].live).toBe(true);
    expect(cards[0].lines.map((line) => line.text)).toEqual(["second frame"]);
  });

  it("keeps the frame it exited on, and is not closed by a pause", () => {
    const transcript = new Transcript();
    transcript.screenOpened("top", 1000);
    transcript.screenPainted([plainLine("last frame")], 1010);
    expect(transcript.settle(9999)).toBe(false);

    transcript.screenClosed(null, 1020);
    const card = transcript.messages.find((message) => message.kind === "screen");
    expect(card?.live).toBe(false);
    expect(card?.lines.map((line) => line.text)).toEqual(["last frame"]);
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
