package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"time"

	"shell.online/internal/stats"
)

// runStats prints what a gathering run would report, and sends nothing.
//
// It exists so that "what does this actually read?" has an answer somebody can
// check rather than a paragraph they have to believe. The browser shows a
// notice before anyone agrees to the gathering; this is the same thing from the
// other side, on the machine, printed by the program that would do the reading.
//
// Nothing here talks to the network. Consent is asked for in the browser and
// enforced by the service, and a command that both gathered and sent would make
// this a way to find out what it reads only by doing it.
func runStats(ctx context.Context, stdout, stderr io.Writer, args []string) int {
	flags := flag.NewFlagSet("stats", flag.ContinueOnError)
	flags.SetOutput(stderr)
	asJSON := flags.Bool("json", false, "print the report as JSON, exactly as it would be sent")
	days := flags.Int("days", 7, "how far back to count")
	dir := flags.String("dir", "", "the repository to read (default: this directory)")
	flags.Usage = func() {
		fmt.Fprintln(stderr, "usage: shell stats [--json] [--days N] [--dir PATH]")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "Prints what a statistics run would report to the game. Sends nothing.")
		flags.PrintDefaults()
	}
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *days < 1 {
		fmt.Fprintln(stderr, "shell: --days must be at least 1")
		return 2
	}

	run := stats.Collect(ctx, stats.Options{
		Dir:   *dir,
		Since: time.Duration(*days) * 24 * time.Hour,
	})

	if *asJSON {
		encoded, err := json.MarshalIndent(run, "", "  ")
		if err != nil {
			fmt.Fprintf(stderr, "shell: %v\n", err)
			return 1
		}
		fmt.Fprintln(stdout, string(encoded))
		return 0
	}

	fmt.Fprintf(stdout, "Over the last %d days, this machine would report:\n\n", *days)
	fmt.Fprintf(stdout, "  %-16s %d\n", "tokens", run.Tokens)
	fmt.Fprintf(stdout, "  %-16s %d\n", "pull requests", run.PullRequests)
	fmt.Fprintf(stdout, "  %-16s %d\n", "commits", run.Commits)
	fmt.Fprintf(stdout, "  %-16s +%d -%d\n", "lines", run.Insertions, run.Deletions)
	if run.Error != "" {
		fmt.Fprintf(stdout, "\n  not read: %s\n", run.Error)
	}
	fmt.Fprintln(stdout, "\nThat is the whole report. No file contents, no diffs, no commit")
	fmt.Fprintln(stdout, "messages, no branch names, and nothing from any terminal session.")
	return 0
}
