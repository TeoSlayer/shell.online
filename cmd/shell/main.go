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
	var err error
	arguments, err = normalizeAutoCloseArguments(arguments, now)
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 2
	}
	flags := flag.NewFlagSet("shell", flag.ContinueOnError)
	flags.SetOutput(stderr)
	server := flags.String("server", defaultServer(), "shell.online service URL")
	jsonOutput := flags.Bool("json", false, "emit the session event as JSON on stderr")
	showVersion := flags.Bool("version", false, "print version and exit")
	foreground := flags.Bool("foreground", false, "stay attached and mirror the process locally")
	readOnly := flags.Bool("read-only", false, "create a view-only link that rejects browser input")
	e2eeFlag := flags.Bool("e2ee", false, "compatibility flag; E2EE is enabled by default")
	noE2EE := flags.Bool("no-e2ee", false, "disable payload E2EE and rely on transport encryption only")
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
	if *e2eeFlag && *noE2EE {
		fmt.Fprintln(stderr, "shell: --e2ee and --no-e2ee cannot be used together")
		return 2
	}
	parsedCloseDeadline, err := parseCloseDeadline(autoClose.value, now)
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 2
	}
	password := os.Getenv("SHELL_ONLINE_E2EE_PASSWORD")
	encrypted := !*noE2EE
	if !encrypted && password != "" {
		fmt.Fprintln(stderr, "shell: SHELL_ONLINE_E2EE_PASSWORD cannot be used with --no-e2ee")
		return 2
	}
	if !encrypted && *persistentState != "" {
		fmt.Fprintln(stderr, "shell: --persistent cannot be used with --no-e2ee")
		return 2
	}
	if password != "" {
		if err = e2ee.ValidateBrowserPassword(password); err != nil {
			fmt.Fprintf(stderr, "shell: SHELL_ONLINE_E2EE_PASSWORD: %v\n", err)
			return 2
		}
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

	client := api.NewClient(strings.TrimRight(*server, "/"), "shell/"+version)
	var session api.Session
	if *persistentState != "" {
		session, password, err = preparePersistentSession(
			signalContext, client, *persistentState, filepath.Base(command[0]), *readOnly, true, password,
		)
	} else {
		if encrypted && password == "" {
			password, err = e2ee.GenerateBrowserPassword()
		}
		if err == nil {
			var frameCipher *e2ee.Cipher
			var encryptionFragment string
			if encrypted {
				frameCipher, encryptionFragment, err = e2ee.Generate(password)
			}
			if err == nil {
				session, err = client.CreateSession(signalContext, filepath.Base(command[0]), *readOnly, encrypted, false)
			}
			session.Cipher = frameCipher
			session.ShareURL += encryptionFragment
		}
	}
	if err != nil {
		sendBackgroundResult(backgroundLaunchResult{OK: false, Error: err.Error()})
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}

	processStartedAt := time.Now()
	closeDeadline := processCloseDeadline(autoClose.value, parsedCloseDeadline, processStartedAt)
	closeDeadline = boundedCloseDeadline(closeDeadline, session.ExpiresAt)
	if !closeDeadline.IsZero() && !closeDeadline.After(processStartedAt) {
		err = fmt.Errorf("auto-close deadline elapsed before the process could start")
		sendBackgroundResult(backgroundLaunchResult{OK: false, Error: err.Error()})
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}

	var processContext context.Context
	var cancelProcess context.CancelFunc
	if closeDeadline.IsZero() {
		processContext, cancelProcess = context.WithCancel(signalContext)
	} else {
		processContext, cancelProcess = context.WithDeadline(signalContext, closeDeadline)
	}
	defer cancelProcess()

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
		Password:   password,
		Persistent: session.Persistent,
		Command:    displayCommand(launch.DisplayArguments),
		PID:        os.Getpid(),
		StartedAt:  processStartedAt,
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
		if password != "" {
			event["e2ee_password"] = password
		}
		if closesAt != nil {
			event["auto_close"] = "deadline"
			event["closes_at"] = closesAt.Format(time.RFC3339)
		}
		encoded, _ := json.Marshal(event)
		fmt.Fprintf(stderr, "%s\n", encoded)
	} else if !isBackgroundChild() {
		printSessionCard(stderr, backgroundLaunchResult{
			OK: true, ID: session.ID, ShareURL: session.ShareURL, ReadOnly: session.ReadOnly,
			Encrypted: session.Encrypted, Password: password, Persistent: session.Persistent,
			ExpiresAt: session.ExpiresAt, ClosesAt: closesAt, Handoff: launch.Handoff,
		}, false)
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
				Password:   password,
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
		startupError := fmt.Sprintf("task exited before its share became usable (exit code %d); no link was printed", exitCode)
		var reportedExitCode *int
		if err != nil {
			startupError = err.Error()
		} else {
			reportedExitCode = &exitCode
		}
		sendBackgroundResult(backgroundLaunchResult{OK: false, Error: startupError, ExitCode: reportedExitCode})
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
