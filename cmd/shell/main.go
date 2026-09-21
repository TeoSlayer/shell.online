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

	"shell.online/internal/account"
	"shell.online/internal/api"
	"shell.online/internal/e2ee"
)

var version = "dev"

// wantsDaemonRunning reports whether this command should bring the daemon up.
//
// The commands that decide the daemon's own fate are excluded: login starts it
// once it knows the answer, logout stops it, and daemon is it.
func wantsDaemonRunning(arguments []string) bool {
	if len(arguments) == 0 {
		return false
	}
	switch arguments[0] {
	case "daemon", "service", "auth", "login", "logout", "agent", "help", "--help", "-h", "--version":
		return false
	default:
		return true
	}
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(arguments []string, stdout, stderr io.Writer) int {
	// A machine that agreed to remote starts should be reachable whenever its
	// owner is using the tool, so any command is enough to bring the daemon
	// back after a reboot. It costs a failed connect when there is nothing
	// there, and does nothing at all unless someone has agreed to it.
	if wantsDaemonRunning(arguments) {
		ensureDaemon()
	}

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
	shareFiles := flags.Bool("files", false, "share files under the session working directory on demand")
	filesRoot := flags.String("files-root", "", "share files under this directory on demand (implies --files)")
	sessionNameFlag := flags.String("name", "", "label this session in shell ls and the web app")
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
	// A name given here wins over one handed down by a browser-started launch.
	//
	// Only the one typed here is checked. The other was chosen in the browser
	// and this process is carrying it, so it is cleaned rather than refused:
	// a name that cannot be printed is not a reason for the session somebody
	// asked for never to start.
	sessionName := strings.TrimSpace(*sessionNameFlag)
	if err = validateSessionName(sessionName); err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 2
	}
	if sessionName == "" {
		sessionName = sanitizeSessionName(sessionNameFromEnvironment())
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
	if !encrypted && (*shareFiles || *filesRoot != "") {
		fmt.Fprintln(stderr, "shell: --files and --files-root require end-to-end encryption")
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
		command = []string{defaultShellCommand()}
	}
	launch := prepareCommandLaunch(command, os.Environ(), !*foreground)
	command = launch.Arguments
	fileService, err := openSharedFileService(*shareFiles, *filesRoot)
	if err != nil {
		sendBackgroundResult(backgroundLaunchResult{OK: false, Error: err.Error()})
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}
	if fileService != nil {
		defer fileService.Close()
	}

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
				session, err = client.CreateSession(signalContext, filepath.Base(command[0]), *readOnly, encrypted, false, true)
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
		ID:              session.ID,
		Name:            sessionName,
		ShareURL:        session.ShareURL,
		ReadOnly:        session.ReadOnly,
		Encrypted:       session.Encrypted,
		Password:        password,
		Persistent:      session.Persistent,
		PersistentState: *persistentState,
		Command:         displayCommand(launch.DisplayArguments),
		PID:             os.Getpid(),
		StartedAt:       processStartedAt,
		ClosesAt:        closesAt,
	})
	if controlError != nil {
		if isBackgroundChild() {
			sendBackgroundResult(backgroundLaunchResult{OK: false, Error: "local session management: " + controlError.Error()})
			return 1
		}
		fmt.Fprintf(stderr, "shell: local session management unavailable: %v\n", controlError)
	} else {
		defer control.Close()
		wireMcpControl(control, client, session, processContext)
		go func() {
			select {
			case <-control.StopRequested():
				cancelProcess()
			case <-processContext.Done():
			}
		}()
	}

	// Publish to the linked account, if this machine has one. Nothing below is
	// fatal: sharing a terminal must not depend on the accounts service.
	link := openSessionLink(signalContext, stderr)
	publishedSession := account.SessionInput{
		ID:         session.ID,
		ShareURL:   session.ShareURL,
		Name:       sessionName,
		Command:    displayCommand(launch.DisplayArguments),
		ReadOnly:   session.ReadOnly,
		Encrypted:  session.Encrypted,
		Persistent: session.Persistent,
		StartedAt:  processStartedAt.UnixMilli(),
	}
	announceSession := func() {
		sharedFilesRoot := ""
		if fileService != nil {
			sharedFilesRoot = fileService.display
		}
		vault := link.Register(signalContext, publishedSession, password)
		if isBackgroundChild() {
			sendBackgroundResult(backgroundLaunchResult{
				OK:             true,
				ID:             session.ID,
				Name:           sessionName,
				ShareURL:       session.ShareURL,
				ReadOnly:       session.ReadOnly,
				Encrypted:      session.Encrypted,
				Password:       password,
				Vault:          vault,
				Persistent:     session.Persistent,
				Files:          sharedFilesRoot,
				ExpiresAt:      session.ExpiresAt,
				ClosesAt:       closesAt,
				Handoff:        launch.Handoff,
				HandoffDisplay: launch.HandoffDisplay,
				HandoffNote:    launch.HandoffNote,
			})
			return
		}
		if *jsonOutput {
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
			if sessionName != "" {
				event["name"] = sessionName
			}
			if password != "" {
				event["e2ee_password"] = password
				event["vault"] = vault
			}
			if closesAt != nil {
				event["auto_close"] = "deadline"
				event["closes_at"] = closesAt.Format(time.RFC3339)
			}
			if sharedFilesRoot != "" {
				event["files"] = sharedFilesRoot
			}
			encoded, _ := json.Marshal(event)
			fmt.Fprintf(stderr, "%s\n", encoded)
			return
		}
		printSessionCard(stderr, backgroundLaunchResult{
			OK: true, ID: session.ID, Name: sessionName, ShareURL: session.ShareURL, ReadOnly: session.ReadOnly,
			Encrypted: session.Encrypted, Password: password, Persistent: session.Persistent,
			Vault: vault, Files: sharedFilesRoot,
			ExpiresAt: session.ExpiresAt, ClosesAt: closesAt, Handoff: launch.Handoff,
		}, false)
	}
	var onConnected, onStarted func()
	if isBackgroundChild() {
		onStarted = announceSession
	} else {
		onConnected = announceSession
	}
	exitCode, err := runSharedProcess(
		processContext,
		session,
		command,
		launch.Environment,
		stdout,
		stderr,
		onConnected,
		onStarted,
		control,
		password,
		*persistentState,
		func(shareURL, rotatedPassword string) {
			if link == nil {
				return
			}
			rotated := publishedSession
			rotated.ShareURL = shareURL
			rotated.CredentialRotation = true
			_ = link.Register(context.Background(), rotated, rotatedPassword)
		},
		fileService,
	)
	// The share is over once the process is; mark it closed in the account.
	link.Close(&exitCode)

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
	if developingLocally() {
		return localServerURL
	}
	return "https://shell.online"
}
