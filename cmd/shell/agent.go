package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"shell.online/internal/account"
)

// runAgent runs the poll loop in the foreground.
//
// The daemon does this already on a machine that agreed to it at login, so
// this is for the person who would rather see it: it prints what it will
// allow, and stops with the terminal it was started in. It does not take the
// daemon's lock, because it is not the daemon -- if one is running, that one
// keeps the browser's key and this would only take work away from it.
func runAgent(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("shell agent", flag.ContinueOnError)
	flags.SetOutput(stderr)
	shellPath := flags.String("shell", "", "path to the shell binary the agent launches (default: this one)")
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: shell agent")
		fmt.Fprintln(stderr, "Watches for browser-started sessions in this terminal.")
		fmt.Fprintln(stderr, "A machine that agreed to this at login already does it in the background.")
	}
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() > 0 {
		fmt.Fprintln(stderr, "shell: agent takes no positional arguments")
		return 2
	}

	path, err := account.DefaultPath()
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}
	credentials, err := account.Load(path)
	if errors.Is(err, account.ErrNotLinked) {
		fmt.Fprintln(stderr, "shell: not signed in. Run 'shell login' first.")
		return 1
	}
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}

	self, err := shellBinaryPath(*shellPath)
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}

	// Two pollers on one machine would take turns claiming work, and only one
	// of them holds the key the browser sealed the password to. Say so rather
	// than start a second and let sessions fail at random.
	if daemonAnswering() {
		fmt.Fprintln(stderr, "shell: the background daemon is already watching for this account.")
		fmt.Fprintln(stderr, "Stop it with 'shell daemon stop' to watch here instead.")
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	printAgentCard(stdout, credentials)
	loop := &agentLoop{
		credentialsPath: path,
		credentials:     credentials,
		self:            self,
		report:          stdout,
	}
	if err := loop.run(ctx); err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}

	fmt.Fprintln(stdout, "\n  Agent stopped. Sessions it started keep running.")
	return 0
}

func printAgentCard(writer io.Writer, credentials account.Credentials) {
	color := sessionOutputUsesColor(writer)
	brand := styleSessionText(color, "38;5;111", "shell.online")
	spark := styleSessionText(color, "38;5;183", "✦")
	label := func(value string) string {
		return styleSessionText(color, "2", fmt.Sprintf("%-10s", value))
	}
	value := func(text string) string { return styleSessionText(color, "38;5;153", text) }

	fmt.Fprintf(writer, "\n  %s  %s\n\n", brand, spark)
	fmt.Fprintf(writer, "  %s %s\n", label("Agent"), value("listening for this account"))
	fmt.Fprintf(writer, "  %s %s\n", label("Account"), credentials.Email)
	fmt.Fprintf(writer, "  %s %s\n", label("Allows"),
		"your signed-in browser to start and stop sessions here")
	fmt.Fprintf(writer, "  %s %s\n\n", label("Stop"), value("Ctrl-C"))
}
