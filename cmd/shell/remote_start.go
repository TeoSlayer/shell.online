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
// Agreement is remembered and never re-asked. A refusal is not: someone who
// said no once may well say yes when they next sign in, and holding them to it
// silently would be worse than asking again. Without a terminal to ask at,
// the answer is no -- a script that is not watching cannot consent for anyone.
func decideRemoteStart(alreadyGranted bool, flags remoteStartFlags, interactive bool) (grant, ask bool) {
	switch {
	case flags.deny:
		return false, false
	case flags.allow:
		return true, false
	case alreadyGranted:
		return true, false
	case !interactive:
		return false, false
	default:
		return false, true
	}
}

// askRemoteStart puts the question, and reads one line back.
//
// Anything but an explicit yes is a no. A person who hits enter without
// reading has not agreed to let a browser run commands on their machine.
func askRemoteStart(input io.Reader, output io.Writer, email string) bool {
	color := sessionOutputUsesColor(output)
	dim := func(text string) string { return styleSessionText(color, "2", text) }

	fmt.Fprintf(output, "\n  %s\n", styleSessionText(color, "38;5;153", "Start sessions from the browser?"))
	fmt.Fprintf(output, "  %s\n", dim("Anyone signed in to "+email+" could start processes on this"))
	fmt.Fprintf(output, "  %s\n", dim("machine, as you, without touching this terminal."))
	fmt.Fprintf(output, "  %s\n\n", dim("You can say no and still publish sessions with 'shell <command>'."))
	fmt.Fprintf(output, "  Allow it? %s ", dim("[y/N]"))

	line, err := bufio.NewReader(input).ReadString('\n')
	if err != nil && line == "" {
		fmt.Fprintln(output)
		return false
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes"
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
