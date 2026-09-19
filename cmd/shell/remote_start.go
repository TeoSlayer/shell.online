package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"
)

// Letting a browser start processes here is a real capability, so it is asked
// for rather than assumed. The question is separated from the asking so the
// rule can be tested without a terminal.

// remoteStartFlags are the two ways to answer without being asked.
type remoteStartFlags struct {
	allow bool
	deny  bool
}

// decideRemoteStart returns whether the machine accepts remote starts, and
// whether the person has to be asked to find out.
//
// Asked once per account on this machine: the first interactive login, and
// again if a different account signs in, because consent belongs to a
// principal rather than to a laptop. After that the answer stands.
//
// It used to be asked on every login, on the reasoning that somebody who
// missed the question once would otherwise have no way back to it. The
// reasoning was right and the remedy was wrong -- a question re-put at every
// sign-in is one people learn to dismiss, and it made routine re-logins a
// consent decision. What that reasoning actually needs is a way back, and
// there are three that do not interrupt anyone: --allow-remote-start,
// --no-remote-start, and the line printed after every login saying which way
// it currently stands and how to change it. See printRemoteStartNote.
//
// A previous answer is still the default when the question is put, so
// returning stays one keystroke.
//
// Without a terminal, the answer stands as it was. A script cannot consent for
// anyone, and it must not revoke on their behalf either: a machine that was
// reachable before a scripted login should still be reachable after it.
func decideRemoteStart(alreadyGranted, alreadyAsked bool, flags remoteStartFlags, interactive bool) (grant, ask bool) {
	switch {
	case flags.deny:
		return false, false
	case flags.allow:
		return true, false
	case !interactive:
		return alreadyGranted, false
	case alreadyAsked:
		return alreadyGranted, false
	default:
		return alreadyGranted, true
	}
}

// remoteStartSettled reports whether the question can be considered answered
// for this account on this machine.
//
// Putting it and having it answered by a flag both count. Carrying a previous
// answer through a scripted login does not: nobody decided anything there, and
// closing the question on their behalf would mean the person who next sits
// down at the machine is never asked at all.
func remoteStartSettled(alreadyAsked, asked bool, flags remoteStartFlags) bool {
	return alreadyAsked || asked || flags.allow || flags.deny
}

// askRemoteStart puts the question, and reads one line back.
//
// The current answer is the default, so enter keeps whatever is already true.
// That is safe in the direction that matters: the default is only yes for a
// machine that has already agreed, so nobody grants this by hitting enter
// without reading, and nobody loses a working machine by doing the same.
func askRemoteStart(lines <-chan string, output io.Writer, email string, current bool) bool {
	color := sessionOutputUsesColor(output)
	dim := func(text string) string { return styleSessionText(color, "2", text) }

	fmt.Fprintf(output, "\n  %s\n", styleSessionText(color, "38;5;153", "Start sessions from the browser?"))
	fmt.Fprintf(output, "  %s\n", dim("Anyone signed in to "+email+" could start processes on this"))
	fmt.Fprintf(output, "  %s\n", dim("machine, as you, without touching this terminal."))
	fmt.Fprintf(output, "  %s\n\n", dim("You can say no and still publish sessions with 'shell <command>'."))
	choices := "[y/N]"
	if current {
		choices = "[Y/n]"
	}
	fmt.Fprintf(output, "  Allow it? %s ", dim(choices))

	line, ok := <-lines
	if !ok {
		/* The terminal closed rather than answered. */
		fmt.Fprintln(output)
		return current
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true
	case "n", "no":
		return false
	default:
		/* Enter, or anything unrecognised, leaves it as it stands. */
		return current
	}
}

// interactiveTerminal reports whether there is a person at both ends to ask.
func interactiveTerminal(output io.Writer) bool {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return false
	}
	file, ok := output.(*os.File)
	if !ok {
		return false
	}
	return term.IsTerminal(int(file.Fd()))
}
