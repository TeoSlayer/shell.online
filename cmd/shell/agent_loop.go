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
	"shell.online/internal/stats"
)

// agentPollInterval is how often the machine asks for queued work.
const agentPollInterval = 2 * time.Second

// maxRefreshBackoff caps the wait between refusals to renew this machine's
// token. Long enough that a revoked token is not a stream of requests, short
// enough that a machine comes back within a minute of being fixed.
const maxRefreshBackoff = 60 * time.Second

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
	// interval overrides how often work is asked for. Zero means
	// agentPollInterval, which is what everything but a test uses: the
	// alternative is a test that waits out real seconds, and one of those
	// under -race on an emulated architecture is a test that fails for
	// reasons that have nothing to do with the code.
	interval time.Duration
}

func (loop *agentLoop) pollInterval() time.Duration {
	if loop.interval > 0 {
		return loop.interval
	}
	return agentPollInterval
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

	/*
	 * Before taking any work: report the sessions this machine left open when
	 * it last stopped. A reboot or a power cut kills the process without it
	 * getting to close its session, and the browser has no way to tell that
	 * apart from a machine that is briefly off the network -- so those rows sat
	 * in "Write", offered as live, until the relay expired them. Starting up is
	 * the moment the machine knows better, and this is where it says so.
	 */
	reclaimAbandonedSessions(ctx, client, loop.credentials.AccessToken, loop.report)

	// Detected once per run, not once per poll. Which agent tools are on PATH
	// does not change while the daemon is up in any way worth a filesystem
	// search every two seconds, and restarting re-detects -- the same
	// granularity the agent key above already has.
	harnesses := installedHarnesses()

	poll := loop.pollInterval()
	/* Grows while renewal keeps being refused, so a dead token is quiet. */
	refreshBackoff := poll
	/* When renewal may be tried again. Zero means now. */
	var renewNotBefore time.Time
	/*
	 * Set when the service has refused this machine's token. The expiry it
	 * was handed is a claim about a clock, and this is what actually
	 * happened, so it renews on this whatever the clock says.
	 */
	refused := false
	/* Said once, not every time the wait elapses. */
	signInRetired := false

	for {
		now := time.Now()
		if (loop.credentials.Expired(now) || refused) && !now.Before(renewNotBefore) {
			refreshed, refreshErr := client.Refresh(ctx, loop.credentials)
			switch {
			case refreshErr != nil:
				if ctx.Err() != nil {
					return nil
				}
				/*
				 * Credentials are re-read from disk first, because a login in
				 * another terminal has written working ones and this process
				 * would otherwise never look.
				 */
				if reloaded, loadErr := account.Load(loop.credentialsPath); loadErr == nil &&
					reloaded.RefreshToken != loop.credentials.RefreshToken {
					loop.credentials = reloaded
					refreshBackoff = poll
					renewNotBefore = time.Time{}
					refused = false
					signInRetired = false
					continue
				}
				/*
				 * Otherwise the wait between renewals grows: a revoked token
				 * will be refused in exactly the same way in two seconds, and
				 * asking that often for as long as the machine is up earns a
				 * rate limit that then hides the real recovery.
				 *
				 * The poll below still happens. Renewal starts a minute
				 * before the token expires, so a refusal here usually means a
				 * network blip with a token that is still perfectly good --
				 * and this loop is the only thing that keeps the machine
				 * showing as online. Standing down from that for up to a
				 * minute over a renewal that was not needed yet is how a
				 * machine came to be reported offline while nothing was wrong
				 * with it. If the token really is dead the poll says so, and
				 * says it in a way the clock cannot argue with.
				 */
				fmt.Fprintf(loop.report, "shell: could not renew this machine's token: %v\n", refreshErr)
				/*
				 * A refusal, as opposed to a failure to reach the service, is
				 * the end of these credentials: signing in again on this
				 * machine retires whatever the previous login was handed. Say
				 * so once, because from outside it looks like the machine has
				 * gone quiet for no reason.
				 */
				if account.Unauthorized(refreshErr) && !signInRetired {
					signInRetired = true
					fmt.Fprintln(loop.report,
						"shell: this machine's sign-in is no longer accepted. Run 'shell auth' to link it again.")
				}
				renewNotBefore = now.Add(refreshBackoff)
				refreshBackoff = min(refreshBackoff*2, maxRefreshBackoff)
			default:
				refreshBackoff = poll
				renewNotBefore = time.Time{}
				refused = false
				signInRetired = false
				loop.credentials = refreshed
				if saveErr := account.Save(loop.credentialsPath, loop.credentials); saveErr != nil {
					fmt.Fprintf(loop.report, "shell: could not store the renewed token: %v\n", saveErr)
				}
			}
		}

		commands, pollErr := client.PollCommands(ctx, loop.credentials.AccessToken, agentKey.PublicKey(), harnesses)
		switch {
		case pollErr != nil:
			if ctx.Err() != nil {
				return nil
			}
			if account.Unauthorized(pollErr) && !refused {
				/* Renew at once: this is news, and the backoff has not earned a wait yet. */
				refused = true
				renewNotBefore = time.Time{}
			}
			fmt.Fprintf(loop.report, "shell: %v\n", pollErr)
		default:
			/*
			 * The service is reachable and this token is good, so whatever
			 * made a renewal fail earlier is over. Without this a single blip
			 * left the machine renewing on a minute's delay for the rest of
			 * its life.
			 */
			refreshBackoff = poll
			renewNotBefore = time.Time{}
			refused = false
		}
		for _, command := range commands {
			gather := func(ctx context.Context, run account.GatheredStats) error {
				return client.ReportStats(ctx, loop.credentials.AccessToken, run)
			}
			runErr := performAgentCommand(ctx, loop.self, agentKey, command, loop.report, gather)
			if finishErr := client.FinishCommand(ctx, loop.credentials.AccessToken, command.ID, runErr); finishErr != nil {
				fmt.Fprintf(loop.report, "shell: could not report a command as done: %v\n", finishErr)
			}
		}

		if loop.onPoll != nil {
			if err := loop.onPoll(); err != nil {
				return err
			}
		}
		/*
		 * Slow down only once both halves have failed: the service has
		 * refused this token and renewing it did not work either. There is
		 * nothing for a poll to discover every two seconds in that state, and
		 * a machine that is signed out would otherwise ask for as long as it
		 * stayed up. Any other state polls at the normal interval, because
		 * that poll is what keeps the machine showing as online.
		 */
		wait := poll
		if refused && time.Now().Before(renewNotBefore) {
			wait = refreshBackoff
		}
		if !sleepOrDone(ctx, wait) {
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
	// gather sends what a statistics run found. A parameter rather than a
	// client, so a test can watch what a probe reports without a server, and so
	// that this function keeps having one job: carry out a command.
	gather func(context.Context, account.GatheredStats) error,
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
		// `--` keeps a server-supplied command from becoming shell.online's own
		// flags. The opted-in service may choose what program runs, but it may
		// not silently weaken E2EE or widen file sharing on the wrapper itself.
		arguments := append([]string{"--"}, browserCommandArguments(command.Command)...)
		launch := exec.CommandContext(ctx, self, arguments...)
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
		// What was asked for, so the session records that rather than the
		// shell wrapper above. Without it every browser-started session is
		// published as `sh -c "..."` and reads as a plain terminal process.
		launch.Env = append(launch.Env, sessionCommandEnvironment+"="+command.Command)
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

	case "probe":
		// The browser asked this machine to gather statistics for the game.
		//
		// The command carries no arguments at all, and that is the point: one
		// that could name a directory or a repository would be a way to ask
		// somebody's machine to go and look somewhere on a browser's behalf.
		// What is read is decided here, on the machine, by internal/stats.
		fmt.Fprintf(report, "  gather statistics\n")
		if gather == nil {
			return errors.New("nowhere to report statistics")
		}
		// Everything this reads is decided on this machine. What leaves is
		// counts; see internal/stats for why the shape has nowhere to put
		// anything else.
		found := stats.Collect(ctx, stats.Options{})
		return gather(ctx, account.GatheredStats{
			// Named after the command, so a report that was sent and whose
			// reply was lost costs nothing when it is sent again.
			ID:           "run_" + command.ID,
			Tokens:       found.Tokens,
			PullRequests: found.PullRequests,
			Commits:      found.Commits,
			Insertions:   found.Insertions,
			Deletions:    found.Deletions,
			Error:        found.Error,
		})

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
