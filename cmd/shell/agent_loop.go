package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"shell.online/internal/account"
)

// agentPollInterval is how often the machine asks for queued work.
const agentPollInterval = 2 * time.Second

// agentLoop asks the accounts service for work and carries it out.
//
// Two things run this: the daemon, which is how a signed-in machine is
// reachable from the browser at all, and `shell agent`, which does the same in
// the foreground for anyone who would rather watch it. They share the loop so
// there is one description of what a browser is allowed to make this machine
// do, not two that drift.
type agentLoop struct {
	// credentialsPath is where a refreshed token is written back.
	credentialsPath string
	credentials     account.Credentials
	// self is the shell binary to launch sessions with.
	self string
	// report receives one line per command carried out, and every failure.
	report io.Writer
	// onPoll runs after each successful poll. The daemon uses it to notice
	// that the person has signed out or withdrawn consent.
	onPoll func() error
}

// run polls until the context ends or onPoll asks it to stop.
func (loop *agentLoop) run(ctx context.Context) error {
	// One key per run. Stopping ends the ability to open anything a browser
	// sealed to this machine, and starting again re-keys.
	agentKey, err := account.NewAgentKey()
	if err != nil {
		return err
	}
	client := account.NewClient(loop.credentials.Server, "shell/"+version)
	// Detected once per run, not once per poll. Which agent tools are on PATH
	// does not change while the daemon is up in any way worth a filesystem
	// search every two seconds, and restarting re-detects -- the same
	// granularity the agent key above already has.
	harnesses := installedHarnesses()

	for {
		if loop.credentials.Expired(time.Now()) {
			refreshed, refreshErr := client.Refresh(ctx, loop.credentials)
			if refreshErr != nil {
				if ctx.Err() != nil {
					return nil
				}
				fmt.Fprintf(loop.report, "shell: could not renew this machine's token: %v\n", refreshErr)
				if !sleepOrDone(ctx, agentPollInterval) {
					return nil
				}
				continue
			}
			loop.credentials = refreshed
			if saveErr := account.Save(loop.credentialsPath, loop.credentials); saveErr != nil {
				fmt.Fprintf(loop.report, "shell: could not store the renewed token: %v\n", saveErr)
			}
		}

		commands, pollErr := client.PollCommands(ctx, loop.credentials.AccessToken, agentKey.PublicKey(), harnesses)
		if pollErr != nil {
			if ctx.Err() != nil {
				return nil
			}
			fmt.Fprintf(loop.report, "shell: %v\n", pollErr)
		}
		for _, command := range commands {
			runErr := performAgentCommand(ctx, loop.self, agentKey, command, loop.report)
			if finishErr := client.FinishCommand(ctx, loop.credentials.AccessToken, command.ID, runErr); finishErr != nil {
				fmt.Fprintf(loop.report, "shell: could not report a command as done: %v\n", finishErr)
			}
		}

		if loop.onPoll != nil {
			if err := loop.onPoll(); err != nil {
				return err
			}
		}
		if !sleepOrDone(ctx, agentPollInterval) {
			return nil
		}
	}
}

// performAgentCommand carries out one queued instruction.
func performAgentCommand(
	ctx context.Context,
	self string,
	agentKey *account.AgentKey,
	command account.AgentCommand,
	report io.Writer,
) error {
	switch command.Kind {
	case "start":
		if strings.TrimSpace(command.Command) == "" {
			return errors.New("empty command")
		}
		fmt.Fprintf(report, "  start  %s\n", command.Command)
		// The browser supplies a command line rather than an argv. Give that
		// complete line to the platform shell so quoting and escapes keep their
		// normal meaning, then wrap that shell through the usual CLI path.
		launch := exec.CommandContext(ctx, self, browserCommandArguments(command.Command)...)
		launch.Env = os.Environ()
		if command.Name != "" {
			// The launched shell reads this when it publishes the session, so
			// the name chosen in the browser survives to the session list.
			launch.Env = append(launch.Env, sessionNameEnvironment+"="+command.Name)
		}
		// The browser that asked for this session chose its password and kept
		// a copy, so it can open the terminal without prompting anyone.
		if command.SealedPassword != "" {
			password, openErr := agentKey.Open(command.SenderPublicKey, command.SealedPassword)
			if openErr != nil {
				return fmt.Errorf("read the sealed password: %w", openErr)
			}
			launch.Env = append(launch.Env, "SHELL_ONLINE_E2EE_PASSWORD="+password)
		}
		launch.Env = append(launch.Env, sessionOriginEnvironment+"="+command.ID)
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
		fmt.Fprintf(report, "  stop   %s\n", shortSessionID(command.SessionID))
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

// shellBinaryPath is the binary the loop launches sessions with.
func shellBinaryPath(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	self, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("locate this binary: %w", err)
	}
	return self, nil
}
