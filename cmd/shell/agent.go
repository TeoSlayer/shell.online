package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"shell.online/internal/account"
)

// agentPollInterval is how often the machine asks for queued work.
const agentPollInterval = 2 * time.Second

// runAgent lets the web app start and stop sessions on this machine.
//
// This is opt-in on purpose. Running it means the browser can start processes
// here, so it only ever runs while a person is deliberately running it, prints
// exactly what it will do, and stops with the terminal it was started in.
func runAgent(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("shell agent", flag.ContinueOnError)
	flags.SetOutput(stderr)
	shellPath := flags.String("shell", "", "path to the shell binary the agent launches (default: this one)")
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: shell agent")
		fmt.Fprintln(stderr, "Lets your signed-in browser start and stop sessions on this machine.")
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

	self := *shellPath
	if self == "" {
		self, err = os.Executable()
		if err != nil {
			fmt.Fprintf(stderr, "shell: locate this binary: %v\n", err)
			return 1
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client := account.NewClient(credentials.Server, "shell/"+version)
	printAgentCard(stdout, credentials)

	for {
		if credentials.Expired(time.Now()) {
			refreshed, refreshErr := client.Refresh(ctx, credentials)
			if refreshErr != nil {
				if ctx.Err() != nil {
					break
				}
				fmt.Fprintf(stderr, "shell: could not renew this machine's token: %v\n", refreshErr)
				if !sleepOrDone(ctx, agentPollInterval) {
					break
				}
				continue
			}
			credentials = refreshed
			if saveErr := account.Save(path, credentials); saveErr != nil {
				fmt.Fprintf(stderr, "shell: could not store the renewed token: %v\n", saveErr)
			}
		}

		commands, pollErr := client.PollCommands(ctx, credentials.AccessToken)
		if pollErr != nil {
			if ctx.Err() != nil {
				break
			}
			fmt.Fprintf(stderr, "shell: %v\n", pollErr)
		}
		for _, command := range commands {
			runErr := performAgentCommand(ctx, self, command, stdout, stderr)
			if finishErr := client.FinishCommand(ctx, credentials.AccessToken, command.ID, runErr); finishErr != nil {
				fmt.Fprintf(stderr, "shell: could not report a command as done: %v\n", finishErr)
			}
		}

		if !sleepOrDone(ctx, agentPollInterval) {
			break
		}
	}

	fmt.Fprintln(stdout, "\n  Agent stopped. Sessions it started keep running.")
	return 0
}

// performAgentCommand carries out one queued instruction.
func performAgentCommand(
	ctx context.Context, self string, command account.AgentCommand, stdout, stderr io.Writer,
) error {
	switch command.Kind {
	case "start":
		fields := strings.Fields(command.Command)
		if len(fields) == 0 {
			return errors.New("empty command")
		}
		fmt.Fprintf(stdout, "  start  %s\n", command.Command)
		// Launched exactly as a person would launch it, so it backgrounds
		// itself and publishes through the usual path.
		launch := exec.CommandContext(ctx, self, fields...)
		launch.Env = os.Environ()
		if command.Name != "" {
			// The launched shell reads this when it publishes the session, so
			// the name chosen in the browser survives to the session list.
			launch.Env = append(launch.Env, sessionNameEnvironment+"="+command.Name)
		}
		launch.Stdout = io.Discard
		launch.Stderr = io.Discard
		if err := launch.Run(); err != nil {
			return fmt.Errorf("start %q: %w", command.Command, err)
		}
		return nil

	case "kill":
		if command.SessionID == "" {
			return errors.New("no session to stop")
		}
		fmt.Fprintf(stdout, "  stop   %s\n", shortSessionID(command.SessionID))
		launch := exec.CommandContext(ctx, self, "kill", shortSessionID(command.SessionID))
		launch.Env = os.Environ()
		launch.Stdout = io.Discard
		launch.Stderr = io.Discard
		if err := launch.Run(); err != nil {
			return fmt.Errorf("stop %s: %w", shortSessionID(command.SessionID), err)
		}
		return nil

	default:
		return fmt.Errorf("unknown command %q", command.Kind)
	}
}

// sleepOrDone waits, and reports false when the context ended first.
func sleepOrDone(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
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
