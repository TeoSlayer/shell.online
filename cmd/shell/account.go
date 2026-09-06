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

// defaultAccountsURL is the accounts service that issues CLI tokens.
func defaultAccountsURL() string {
	if configured := os.Getenv("SHELL_ONLINE_ACCOUNTS"); configured != "" {
		return configured
	}
	return "https://accounts.shell.online"
}

// defaultWebURL hosts the browser screen that approves a CLI login.
func defaultWebURL() string {
	if configured := os.Getenv("SHELL_ONLINE_WEB"); configured != "" {
		return configured
	}
	return "https://shell.online"
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
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: shell login [--label <name>] [--no-browser]")
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

	path, err := account.DefaultPath()
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}

	// Ctrl-C during the browser wait should stop cleanly, not leave a listener.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client := account.NewClient(*accountsURL, "shell/"+version)
	credentials, err := account.Login(ctx, client, account.Options{
		WebURL:    *webURL,
		Label:     *label,
		Output:    stderr,
		NoBrowser: *noBrowser,
	})
	if err != nil {
		fmt.Fprintf(stderr, "shell: login failed: %v\n", err)
		return 1
	}
	if err := account.Save(path, credentials); err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}

	printAccountCard(stdout, credentials, resolvedLabel(*label))
	return 0
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
