package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"shell.online/internal/account"
)

// daemonDialTimeout bounds a check for an already-running daemon. This runs
// before every command, so it has to be short enough not to be felt.
const daemonDialTimeout = 250 * time.Millisecond

// errDaemonAlreadyRunning reports that another process holds the daemon lock.
var errDaemonAlreadyRunning = errors.New("a daemon is already running")

// The daemon is what makes a signed-in machine reachable from the browser
// without anybody sitting in front of a terminal. It exists because the rest
// of shell.online has no long-lived process: a session is its own background
// process serving its own socket, and when the last one exits nothing of this
// account's is running -- which is exactly when the browser needs something
// here to ask.
//
// Exactly one may run per machine. The browser seals a session password to a
// single public key held on the device record, and queued work goes to
// whichever poller claims it first; two of them would hand a command to a
// process that cannot open the password that came with it. The control socket
// is the lock: binding it is what makes a daemon the daemon.

// runDaemonCommand dispatches `shell daemon` and its two verbs.
//
// Someone who wants to know whether their machine is reachable, or to stop it
// being reachable right now, should not have to find a process id.
func runDaemonCommand(arguments []string, stdout, stderr io.Writer) int {
	if len(arguments) > 0 {
		switch arguments[0] {
		case "status":
			if daemonAnswering() {
				fmt.Fprintln(stdout, "Running. Your browser can start sessions on this machine.")
				return 0
			}
			fmt.Fprintln(stdout, "Not running. Sessions can only be started from this terminal.")
			return 1
		case "stop":
			if !daemonAnswering() {
				fmt.Fprintln(stdout, "Not running.")
				return 0
			}
			stopDaemon()
			// Stopping is for right now. The next shell command starts it
			// again, because consent is what decides whether it may run, and
			// stopping is not withdrawing consent. 'shell login
			// --no-remote-start' is.
			fmt.Fprintln(stdout, "Stopped. Sessions it started keep running.")
			return 0
		case "start":
			return startDaemonCommand(stdout, stderr)
		}
	}
	return runDaemon(arguments, stdout, stderr)
}

// startDaemonCommand turns this machine on for browser-started sessions.
//
// It asks for consent if it does not already have it, so someone who said no
// at login, or who was never asked because they signed in from a script, can
// change their mind without going through the browser again. Granting it here
// is no weaker than granting it at login: both are a decision made by someone
// who already has this account's credentials on this machine.
func startDaemonCommand(stdout, stderr io.Writer) int {
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

	if !credentials.RemoteStart {
		if !interactiveTerminal(stderr) {
			fmt.Fprintln(stderr, "shell: this machine does not accept sessions started from the browser.")
			fmt.Fprintln(stderr, "Run 'shell login --allow-remote-start' to change that.")
			return 1
		}
		if !askRemoteStart(os.Stdin, stderr, credentials.Email) {
			fmt.Fprintln(stdout, "Left as publish-only.")
			return 1
		}
		credentials.RemoteStart = true
		if err := account.Save(path, credentials); err != nil {
			fmt.Fprintf(stderr, "shell: %v\n", err)
			return 1
		}
	}

	if daemonAnswering() {
		fmt.Fprintln(stdout, "Already running.")
		return 0
	}
	ensureDaemon()
	// Started detached, so there is nothing to wait on but the socket.
	for attempt := 0; attempt < 40; attempt++ {
		if daemonAnswering() {
			fmt.Fprintln(stdout, "Running. Your browser can start sessions on this machine.")
			return 0
		}
		time.Sleep(50 * time.Millisecond)
	}
	fmt.Fprintln(stderr, "shell: the daemon did not come up. Try 'shell daemon --foreground' to see why.")
	return 1
}

// runDaemon polls for browser-queued work until told to stop.
func runDaemon(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("shell daemon", flag.ContinueOnError)
	flags.SetOutput(stderr)
	shellPath := flags.String("shell", "", "path to the shell binary the daemon launches (default: this one)")
	foreground := flags.Bool("foreground", false, "run here instead of reporting to the log")
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: shell daemon [--foreground]")
		fmt.Fprintln(stderr, "Runs the background service that lets your browser start sessions here.")
		fmt.Fprintln(stderr, "Started for you by 'shell login'; you do not normally run this.")
	}
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() > 0 {
		fmt.Fprintln(stderr, "shell: daemon takes no positional arguments")
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
	if !credentials.RemoteStart {
		fmt.Fprintln(stderr, "shell: this machine does not accept sessions started from the browser.")
		fmt.Fprintln(stderr, "Run 'shell login --allow-remote-start' to change that.")
		return 1
	}

	self, err := shellBinaryPath(*shellPath)
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}

	// A daemon already holding the lock is the answer, not an error: whatever
	// asked for one wanted one running, and there is.
	lock, err := acquireDaemonLock()
	if errors.Is(err, errDaemonAlreadyRunning) {
		fmt.Fprintln(stderr, "shell: the daemon is already running")
		return 0
	}
	if err != nil {
		fmt.Fprintf(stderr, "shell: could not start the daemon: %v\n", err)
		return 1
	}
	defer lock.release()

	// On Windows the pipe is the lock, so the same condition can surface here
	// instead of above.
	listener, err := listenDaemonControl()
	if errors.Is(err, errDaemonAlreadyRunning) {
		fmt.Fprintln(stderr, "shell: the daemon is already running")
		return 0
	}
	if err != nil {
		fmt.Fprintf(stderr, "shell: could not start the daemon: %v\n", err)
		return 1
	}
	defer func() {
		_ = listener.Close()
		cleanupDaemonControl()
	}()

	report := io.Writer(io.Discard)
	if *foreground {
		report = stderr
		fmt.Fprintf(stdout, "\n  Daemon listening for %s. Stop with Ctrl-C.\n\n", credentials.Email)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	go serveDaemonControl(listener, cancel)

	loop := &agentLoop{
		credentialsPath: path,
		credentials:     credentials,
		self:            self,
		report:          report,
		// Signing out, or withdrawing consent, has to stop this without
		// needing to find the process. Both are visible in the file it
		// already reads, so it checks after every poll.
		onPoll: func() error {
			current, loadErr := account.Load(path)
			if errors.Is(loadErr, account.ErrNotLinked) {
				return errors.New("signed out")
			}
			if loadErr == nil {
				if !sameAccount(credentials, current) {
					return errors.New("linked account changed")
				}
				if !current.RemoteStart {
					return errors.New("remote start withdrawn")
				}
			}
			return nil
		},
	}
	if err := loop.run(ctx); err != nil {
		fmt.Fprintf(report, "shell: daemon stopping: %v\n", err)
	}
	return 0
}

// serveDaemonControl answers `ping` and `stop` for other shell commands.
func serveDaemonControl(listener net.Listener, stop func()) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		go func() {
			defer connection.Close()
			_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
			var request struct {
				Command string `json:"command"`
			}
			if err := json.NewDecoder(io.LimitReader(connection, 4*1024)).Decode(&request); err != nil {
				return
			}
			response := localControlResponse{OK: true, PID: os.Getpid()}
			switch request.Command {
			case "ping":
			case "stop":
				defer stop()
			default:
				response = localControlResponse{OK: false, Error: "unknown command"}
			}
			_ = json.NewEncoder(connection).Encode(response)
		}()
	}
}

// askDaemon sends one control command and reports what came back.
func askDaemon(command string) (localControlResponse, error) {
	connection, err := dialDaemonControl(daemonDialTimeout)
	if err != nil {
		return localControlResponse{}, err
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
	if err := json.NewEncoder(connection).Encode(map[string]string{"command": command}); err != nil {
		return localControlResponse{}, err
	}
	var response localControlResponse
	if err := json.NewDecoder(io.LimitReader(connection, 4*1024)).Decode(&response); err != nil {
		return localControlResponse{}, err
	}
	return response, nil
}

// daemonAnswering reports whether a daemon is running and responding.
func daemonAnswering() bool {
	response, err := askDaemon("ping")
	return err == nil && response.OK
}

// stopDaemon asks a running daemon to exit. A daemon that is not there is
// already stopped, which is not a failure.
func stopDaemon() {
	_, _ = askDaemon("stop")
}

// ensureDaemon starts the daemon when this machine should have one running.
//
// Called before every command, so it must be cheap and silent. A machine that
// is not signed in, or whose owner did not agree to remote starts, gets
// nothing: this is the one place that decides a background process may exist,
// and it says no by default.
func ensureDaemon() {
	path, err := account.DefaultPath()
	if err != nil {
		return
	}
	credentials, err := account.Load(path)
	if err != nil || !credentials.RemoteStart {
		return
	}
	if daemonAnswering() {
		return
	}
	self, err := os.Executable()
	if err != nil {
		return
	}
	startDetachedDaemon(self)
}

// restartDaemon replaces a running daemon, and starts one if none is running.
//
// For after a login, and only after a login. A daemon holds the credentials it
// started with in memory and never reads the file again, so a fresh login
// leaves the running one stale by definition: it goes on presenting the tokens
// it already had, and once those stop working it presents them every couple of
// seconds for as long as the machine is up.
//
// That is what "shell login does nothing" looks like from outside. The login
// succeeds, writes working credentials, and the machine still reports itself
// offline because the process doing the polling never looks at them. Found on
// a machine that had been refusing to renew for eight and a half hours across
// several logins.
//
// ensureDaemon above deliberately does not do this. It runs on every ordinary
// command, and restarting there would re-key the agent on each one, which
// throws away the key a browser has already sealed a session password to.
func restartDaemon() {
	path, err := account.DefaultPath()
	if err != nil {
		return
	}
	credentials, err := account.Load(path)
	if err != nil || !credentials.RemoteStart {
		return
	}
	if daemonAnswering() {
		stopDaemon()
	}
	self, err := os.Executable()
	if err != nil {
		return
	}
	startDetachedDaemon(self)
}
