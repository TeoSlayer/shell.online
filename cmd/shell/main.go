package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"shell.online/internal/api"
	"shell.online/internal/e2ee"
)

var version = "dev"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(arguments []string, stdout, stderr io.Writer) int {
	if exitCode, handled := runSessionCommand(arguments, stdout, stderr); handled {
		return exitCode
	}

	now := time.Now()
	arguments = normalizeAutoCloseArguments(arguments, now)
	flags := flag.NewFlagSet("shell", flag.ContinueOnError)
	flags.SetOutput(stderr)
	server := flags.String("server", defaultServer(), "shell.online service URL")
	jsonOutput := flags.Bool("json", false, "emit the session event as JSON on stderr")
	showVersion := flags.Bool("version", false, "print version and exit")
	foreground := flags.Bool("foreground", false, "stay attached and mirror the process locally")
	readOnly := flags.Bool("read-only", false, "create a view-only link that rejects browser input")
	encrypted := flags.Bool("e2ee", false, "encrypt terminal contents end-to-end; the URL fragment carries the key")
	persistentState := flags.String("persistent", "", "reuse a stable encrypted session identity from this state file")
	autoClose := newAutoCloseFlag()
	flags.Var(autoClose, "auto-close", "close on task exit, or earlier at a duration/date (for example 5m, 2h, tomorrow 09:00)")
	flags.Usage = func() {
		printShellHelp(stderr)
	}

	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if *showVersion {
		fmt.Fprintf(stdout, "shell %s\n", version)
		return 0
	}
	closeDeadline, err := parseCloseDeadline(autoClose.value, now)
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 2
	}
	if !*foreground && !isBackgroundChild() {
		return launchBackgroundProcess(arguments, *jsonOutput, stdout, stderr)
	}

	readyFile, err := openBackgroundReadyFile()
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}
	defer func() {
		if readyFile != nil {
			_ = readyFile.Close()
		}
	}()
	sendBackgroundResult := func(result backgroundLaunchResult) {
		if readyFile == nil {
			return
		}
		_ = json.NewEncoder(readyFile).Encode(result)
		_ = readyFile.Close()
		readyFile = nil
	}

	command := flags.Args()
	if len(command) == 0 {
		defaultShell := os.Getenv("SHELL")
		if defaultShell == "" {
			defaultShell = "/bin/sh"
		}
		command = []string{defaultShell}
	}
	launch := prepareCommandLaunch(command, os.Environ(), !*foreground)
	command = launch.Arguments

	signalContext, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stopSignals()

	var processContext context.Context
	var cancelProcess context.CancelFunc
	if closeDeadline.IsZero() {
		processContext, cancelProcess = context.WithCancel(signalContext)
	} else {
		processContext, cancelProcess = context.WithDeadline(signalContext, closeDeadline)
	}
	defer cancelProcess()

	client := api.NewClient(strings.TrimRight(*server, "/"), "shell/"+version)
	var session api.Session
	if *persistentState != "" {
		if !*encrypted {
			fmt.Fprintln(stderr, "shell: --persistent requires --e2ee")
			return 2
		}
		session, err = preparePersistentSession(
			processContext, client, *persistentState, filepath.Base(command[0]), *readOnly, true,
			os.Getenv("SHELL_ONLINE_E2EE_PASSWORD"),
		)
	} else {
		var frameCipher *e2ee.Cipher
		var encryptionFragment string
		if *encrypted {
			frameCipher, encryptionFragment, err = e2ee.Generate(os.Getenv("SHELL_ONLINE_E2EE_PASSWORD"))
		}
		if err == nil {
			session, err = client.CreateSession(processContext, filepath.Base(command[0]), *readOnly, *encrypted, false)
			session.Cipher = frameCipher
			session.ShareURL += encryptionFragment
		}
	}
	if err != nil {
		sendBackgroundResult(backgroundLaunchResult{OK: false, Error: err.Error()})
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}

	var closesAt *time.Time
	if !closeDeadline.IsZero() {
		deadline := closeDeadline
		closesAt = &deadline
	}
	control, controlError := startLocalSession(localSessionRecord{
		ID:         session.ID,
		ShareURL:   session.ShareURL,
		ReadOnly:   session.ReadOnly,
		Encrypted:  session.Encrypted,
		Persistent: session.Persistent,
		Command:    displayCommand(launch.DisplayArguments),
		PID:        os.Getpid(),
		StartedAt:  now,
		ClosesAt:   closesAt,
	})
	if controlError != nil {
		if isBackgroundChild() {
			sendBackgroundResult(backgroundLaunchResult{OK: false, Error: "local session management: " + controlError.Error()})
			return 1
		}
		fmt.Fprintf(stderr, "shell: local session management unavailable: %v\n", controlError)
	} else {
		defer control.Close()
		go func() {
			select {
			case <-control.StopRequested():
				cancelProcess()
			case <-processContext.Done():
			}
		}()
	}

	if !isBackgroundChild() && *jsonOutput {
		event := map[string]any{
			"type":       "session",
			"session_id": session.ID,
			"share_url":  session.ShareURL,
			"read_only":  session.ReadOnly,
			"encrypted":  session.Encrypted,
			"persistent": session.Persistent,
			"auto_close": "task",
			"expires_at": session.ExpiresAt.Format(time.RFC3339),
			"background": false,
		}
		if closesAt != nil {
			event["auto_close"] = "deadline"
			event["closes_at"] = closesAt.Format(time.RFC3339)
		}
		encoded, _ := json.Marshal(event)
		fmt.Fprintf(stderr, "%s\n", encoded)
	} else if !isBackgroundChild() {
		fmt.Fprintf(stderr, "\n  Share: %s\n", session.ShareURL)
		if session.ReadOnly {
			fmt.Fprintln(stderr, "  Access: view only (browser input is blocked)")
		} else {
			fmt.Fprintln(stderr, "  Access: anyone with this link can view and type")
		}
		if session.Encrypted {
			fmt.Fprintln(stderr, "  Privacy: end-to-end encrypted; keep the complete URL private")
		}
		if session.Persistent {
			fmt.Fprintln(stderr, "  Persistence: stable link; reconnects from the saved state file")
		}
		if closesAt == nil {
			fmt.Fprintln(stderr, "  Closes: when the task exits")
		} else {
			fmt.Fprintf(stderr, "  Closes: %s (or when the task exits)\n", closesAt.Format(time.RFC3339))
		}
		fmt.Fprintln(stderr)
	}

	var onStarted func()
	if isBackgroundChild() {
		onStarted = func() {
			sendBackgroundResult(backgroundLaunchResult{
				OK:         true,
				ID:         session.ID,
				ShareURL:   session.ShareURL,
				ReadOnly:   session.ReadOnly,
				Encrypted:  session.Encrypted,
				Persistent: session.Persistent,
				ExpiresAt:  session.ExpiresAt,
				ClosesAt:   closesAt,
				Handoff:    launch.Handoff,
			})
		}
	}
	exitCode, err := runSharedProcess(
		processContext,
		session,
		command,
		launch.Environment,
		stdout,
		stderr,
		onStarted,
		control,
	)
	if readyFile != nil {
		startupError := "task ended before startup completed"
		if err != nil {
			startupError = err.Error()
		}
		sendBackgroundResult(backgroundLaunchResult{OK: false, Error: startupError})
	}
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		if exitCode == 0 {
			return 1
		}
	}
	return exitCode
}

func defaultServer() string {
	if configured := os.Getenv("SHELL_ONLINE_SERVER"); configured != "" {
		return configured
	}
	return "https://shell.online"
}
