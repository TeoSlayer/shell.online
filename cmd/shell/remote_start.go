package main

import (
	"bufio"
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
// Asked on every interactive login, including when the answer is already yes.
// The capability is the difference between a machine that appears in a browser
// and one that does not, and it used to be settable only by remembering a flag
// nobody had heard of: agreement was remembered and never raised again, so
// somebody who missed the question once had no way to find it. Asking every
// time is what makes --allow-remote-start a shortcut rather than the only
// route, and it is the only moment anyone is in a position to change their
// mind.
//
// The previous answer becomes the default, so returning stays one keystroke
// and nobody is re-deciding something they already settled.
//
// Without a terminal, the answer stands as it was. A script cannot consent for
// anyone, and it must not revoke on their behalf either: a machine that was
// reachable before a scripted login should still be reachable after it.
func decideRemoteStart(alreadyGranted bool, flags remoteStartFlags, interactive bool) (grant, ask bool) {
	switch {
	case flags.deny:
		return false, false
	case flags.allow:
		return true, false
	case !interactive:
		return alreadyGranted, false
	default:
		return alreadyGranted, true
	}
}

// askRemoteStart puts the question, and reads one line back.
//
// The current answer is the default, so enter keeps whatever is already true.
// That is safe in the direction that matters: the default is only yes for a
// machine that has already agreed, so nobody grants this by hitting enter
// without reading, and nobody loses a working machine by doing the same.
func askRemoteStart(input io.Reader, output io.Writer, email string, current bool) bool {
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

	line, err := bufio.NewReader(input).ReadString('\n')
	if err != nil && line == "" {
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
