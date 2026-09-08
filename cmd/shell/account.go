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
	"time"

	"shell.online/internal/account"
)

// productionAppURL serves both halves of the account: the browser screen that
// approves a login, and the API the CLI then talks to.
//
// One host, because they are one deployment. An earlier split pointed the CLI
// at accounts.shell.online, which never existed, and the approval screen at
// shell.online, which serves the marketing site and answered /cli/authorize
// with its own index page. Either would have failed on the first release that
// carried `shell login`.
const productionAppURL = "https://app.shell.online"

// Local development addresses, used when SHELL_ONLINE_LOCAL is set.
const (
	localAccountsURL = "http://127.0.0.1:8787"
	localWebURL      = "http://localhost:5173"
	localServerURL   = "http://127.0.0.1:8788"
)

// developingLocally reports whether to talk to a local stack.
//
// Every service defaults to production, so forgetting one variable silently
// aims a command at the real thing. One switch sets the whole set, and each
// address can still be overridden on its own.
func developingLocally() bool {
	value := os.Getenv("SHELL_ONLINE_LOCAL")
	return value == "1" || value == "true"
}

// defaultAccountsURL is the accounts service that issues CLI tokens.
func defaultAccountsURL() string {
	if configured := os.Getenv("SHELL_ONLINE_ACCOUNTS"); configured != "" {
		return configured
	}
	if developingLocally() {
		return localAccountsURL
	}
	return productionAppURL
}

// defaultWebURL hosts the browser screen that approves a CLI login.
func defaultWebURL() string {
	if configured := os.Getenv("SHELL_ONLINE_WEB"); configured != "" {
		return configured
	}
	if developingLocally() {
		return localWebURL
	}
	return productionAppURL
}

// runAccountCommand handles the account subcommands. The second return value
// reports whether the arguments belonged to this group at all.
func runAccountCommand(arguments []string, stdout, stderr io.Writer) (int, bool) {
	if len(arguments) == 0 {
		return 0, false
	}
	switch arguments[0] {
	case "login":
		return runLogin(arguments[1:], stdout, stderr), true
	case "logout":
		return runLogout(arguments[1:], stdout, stderr), true
	case "whoami":
		return runWhoami(arguments[1:], stdout, stderr), true
	default:
		return 0, false
	}
}

func runLogin(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("shell login", flag.ContinueOnError)
	flags.SetOutput(stderr)
	accountsURL := flags.String("accounts", defaultAccountsURL(), "accounts service URL")
	webURL := flags.String("web", defaultWebURL(), "web app that approves the login")
	label := flags.String("label", "", "name for this machine in your account")
	noBrowser := flags.Bool("no-browser", false, "print the sign-in URL instead of opening a browser")
	allowRemote := flags.Bool("allow-remote-start", false, "let your signed-in browser start sessions on this machine")
	denyRemote := flags.Bool("no-remote-start", false, "keep this machine publish-only")
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: shell login [--label <name>] [--no-browser] [--allow-remote-start]")
		fmt.Fprintln(stderr, "Opens a browser to link this machine to your shell.online account.")
	}
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() > 0 {
		fmt.Fprintln(stderr, "shell: login takes no positional arguments")
		return 2
	}
	if *allowRemote && *denyRemote {
		fmt.Fprintln(stderr, "shell: --allow-remote-start and --no-remote-start cannot be used together")
		return 2
	}

	path, err := account.DefaultPath()
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}

	// Ctrl-C during the browser wait should stop cleanly, not leave a listener.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *accountsURL != productionAppURL || *webURL != productionAppURL {
		// Anything other than production is worth stating plainly, so a stray
		// environment variable is caught before a browser opens.
		fmt.Fprintf(stderr, "\n  Approving at %s\n  Tokens from  %s\n", *webURL, *accountsURL)
	}

	// Loaded before the browser opens so a grant can be carried forward only
	// after the new login proves it is for the same account and service.
	previous, previousErr := account.Load(path)

	// A machine that cannot record an identifier still signs in; it just
	// appears as a new entry in the device list each time, which is what
	// every machine did before identifiers existed.
	machineID, err := account.MachineID(account.MachineIDPath(path))
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
	}

	client := account.NewClient(*accountsURL, "shell/"+version)
	credentials, err := account.Login(ctx, client, account.Options{
		WebURL:    *webURL,
		Label:     *label,
		MachineID: machineID,
		Output:    stderr,
		NoBrowser: *noBrowser,
	})
	if err != nil {
		fmt.Fprintf(stderr, "shell: login failed: %v\n", err)
		return 1
	}
	samePrincipal := previousErr == nil && sameAccount(previous, credentials)
	alreadyGranted := samePrincipal && previous.RemoteStart
	if !samePrincipal {
		// A daemon keeps the credentials it started with in memory. Stop it
		// before replacing the file so an account switch cannot leave the old
		// account polling while the new account appears to own the consent.
		stopDaemon()
	}
	grant, ask := decideRemoteStart(
		alreadyGranted,
		remoteStartFlags{allow: *allowRemote, deny: *denyRemote},
		interactiveTerminal(stderr),
	)
	if ask {
		grant = askRemoteStart(os.Stdin, stderr, credentials.Email)
	}
	credentials.RemoteStart = grant

	if err := account.Save(path, credentials); err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}

	// The daemon is what makes the answer mean anything, so it starts here
	// rather than waiting for the next command.
	if grant {
		/*
		 * Restart rather than ensure. The credentials just written are new,
		 * and a daemon that is already running is holding the previous ones
		 * in memory where nothing will ever replace them.
		 */
		restartDaemon()
	} else {
		stopDaemon()
	}

	printAccountCard(stdout, credentials, resolvedLabel(*label))
	printRemoteStartNote(stdout, grant, ask)
	return 0
}

// sameAccount is deliberately stricter than matching an email address. The
// provider UID is the identity, and the server is part of its authority: a
// development account and a production account with the same UID are not the
// same principal for remote-start consent.
func sameAccount(previous, next account.Credentials) bool {
	return previous.UID != "" && previous.UID == next.UID && previous.Server == next.Server
}

// printRemoteStartNote says what this machine will and will not do.
//
// Printed on every login, not only the one that asked: a decision made months
// ago still governs what a browser can do here, and it should not take reading
// a config file to find out which way it went.
func printRemoteStartNote(writer io.Writer, granted, asked bool) {
	color := sessionOutputUsesColor(writer)
	dim := func(text string) string { return styleSessionText(color, "2", text) }
	if granted {
		fmt.Fprintf(writer, "  %s\n\n", dim("Your browser can start sessions here. Turn it off with 'shell logout'."))
		return
	}
	if asked {
		fmt.Fprintf(writer, "  %s\n\n", dim("Left as publish-only. Sessions you start with 'shell <command>' still appear."))
		return
	}
	fmt.Fprintf(writer, "  %s\n\n", dim("Publish-only. Run 'shell login --allow-remote-start' to start sessions from the browser."))
}

func runLogout(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("shell logout", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: shell logout")
		fmt.Fprintln(stderr, "Unlinks this machine and revokes its token.")
	}
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}

	path, err := account.DefaultPath()
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}
	// Stopped first: it is the thing acting on these credentials, and leaving
	// it polling with a revoked token would only generate failures.
	stopDaemon()

	credentials, err := account.Load(path)
	if errors.Is(err, account.ErrNotLinked) {
		fmt.Fprintln(stdout, "Not signed in.")
		return 0
	}
	if err != nil {
		// A corrupt file still needs clearing, so report and carry on.
		fmt.Fprintf(stderr, "shell: %v\n", err)
		if clearErr := account.Clear(path); clearErr != nil {
			fmt.Fprintf(stderr, "shell: %v\n", clearErr)
			return 1
		}
		fmt.Fprintln(stdout, "Signed out.")
		return 0
	}

	// Revoking is best-effort: the local credentials go either way, so a
	// service that is down cannot leave this machine stuck signed in.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client := account.NewClient(credentials.Server, "shell/"+version)
	if err := client.Revoke(ctx, credentials); err != nil {
		fmt.Fprintf(stderr, "shell: could not revoke remotely (%v); clearing local credentials\n", err)
	}
	if err := account.Clear(path); err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "Signed out of %s.\n", credentials.Email)
	return 0
}

func runWhoami(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("shell whoami", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: shell whoami")
		fmt.Fprintln(stderr, "Shows which account this machine is linked to.")
	}
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}

	path, err := account.DefaultPath()
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}
	credentials, err := account.Load(path)
	if errors.Is(err, account.ErrNotLinked) {
		fmt.Fprintln(stdout, "Not signed in. Run 'shell login' to link this machine.")
		return 1
	}
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}
	printAccountCard(stdout, credentials, "")
	return 0
}

// printAccountCard mirrors printSessionCard so both read as one product.
func printAccountCard(writer io.Writer, credentials account.Credentials, label string) {
	color := sessionOutputUsesColor(writer)
	brand := styleSessionText(color, "38;5;111", "shell.online")
	spark := styleSessionText(color, "38;5;183", "✦")
	name := func(value string) string {
		return styleSessionText(color, "2", fmt.Sprintf("%-10s", value))
	}
	value := func(text string) string { return styleSessionText(color, "38;5;153", text) }

	fmt.Fprintf(writer, "\n  %s  %s\n\n", brand, spark)
	fmt.Fprintf(writer, "  %s %s\n", name("Signed in"), value(credentials.Email))
	if label != "" {
		fmt.Fprintf(writer, "  %s %s\n", name("Device"), label)
	}
	if credentials.Name != "" {
		fmt.Fprintf(writer, "  %s %s\n", name("Account"), credentials.Name)
	}
	fmt.Fprintln(writer)
}

func resolvedLabel(label string) string {
	if label != "" {
		return label
	}
	host, err := os.Hostname()
	if err != nil || host == "" {
		return "shell cli"
	}
	return host
}
