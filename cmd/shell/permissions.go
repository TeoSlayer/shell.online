package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"shell.online/internal/account"
)

// permissionsTimeout bounds shell permissions: one request, plus a token
// refresh.
const permissionsTimeout = 15 * time.Second

// permissionsNotActiveNote is printed after a saved change. The switches are
// consent, stored on the account's session record, and this build does not
// act on them yet, so the output should not imply it does.
const permissionsNotActiveNote = "Permission saved; these switches are consent and are not acted on in this build yet."

// The switch flags, in the order they are shown.
var permissionFlags = []struct {
	flag  string
	key   string
	label string
}{
	{"mcp-team-access", account.AutomationMcpTeamAccess, "MCP team access"},
	{"daily-briefing", account.AutomationDailyBriefing, "Daily briefing"},
	{"briefing-team-access", account.AutomationBriefingTeamAccess, "Briefing team access"},
}

func permissionsUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage: shell permissions <session-id> [flags]")
	fmt.Fprintln(writer, "       shell permissions <session-id> --mcp-team-access=true|false")
	fmt.Fprintln(writer, "              [--daily-briefing=true|false] [--briefing-team-access=true|false]")
	fmt.Fprintln(writer, "Reads a session's automation permissions, or updates the ones named.")
	fmt.Fprintln(writer, "A switch that is not named is left exactly as it is.")
}

// parsePermissionArguments reads the session id and the switch flags in any
// order.
//
// The id is parsed by hand rather than with flag.FlagSet because a session id
// may begin with a hyphen, and flag parsing would read it as an option: the
// same reason shell kill parses its arguments itself.
func parsePermissionArguments(
	arguments []string,
) (sessionID string, changes map[string]bool, err error) {
	changes = map[string]bool{}
	for i := 0; i < len(arguments); i++ {
		arg := arguments[i]
		if arg == "-h" || arg == "--help" {
			return "", nil, errHelp
		}
		var name, value string
		if strings.HasPrefix(arg, "--") {
			equal := strings.IndexByte(arg, '=')
			if equal >= 0 {
				name, value = arg[:equal], arg[equal+1:]
			} else if i+1 < len(arguments) {
				name, value = arg, arguments[i+1]
				i++
			} else {
				return "", nil, fmt.Errorf("%s needs a value: true or false", arg)
			}
		} else {
			if sessionID != "" {
				return "", nil, fmt.Errorf("unexpected argument %q", arg)
			}
			sessionID = arg
			continue
		}
		key := nameToKey(name)
		if key == "" {
			return "", nil, fmt.Errorf("unknown flag %q", name)
		}
		/*
		 * Last-one-wins would quietly save a different value than the caller
		 * typed; for a consent switch the duplicate must be an error instead.
		 */
		if _, duplicate := changes[key]; duplicate {
			return "", nil, fmt.Errorf("%s given more than once", name)
		}
		switch value {
		case "true":
			changes[key] = true
		case "false":
			changes[key] = false
		default:
			return "", nil, fmt.Errorf("%s must be true or false", name)
		}
	}
	if sessionID == "" {
		return "", nil, fmt.Errorf("give a session id")
	}
	return sessionID, changes, nil
}

func nameToKey(name string) string {
	for _, entry := range permissionFlags {
		if name == "--"+entry.flag {
			return entry.key
		}
	}
	return ""
}

var errHelp = errors.New("help")

// runPermissions handles shell permissions <session-id> [flags].
func runPermissions(arguments []string, stdout, stderr io.Writer) int {
	sessionID, changes, err := parsePermissionArguments(arguments)
	if err != nil {
		if err == errHelp {
			permissionsUsage(stdout)
			return 0
		}
		fmt.Fprintf(stderr, "shell: %v\n", err)
		permissionsUsage(stderr)
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), permissionsTimeout)
	defer cancel()
	client, credentials, err := linkedAccountClient(ctx, stderr)
	if errors.Is(err, account.ErrNotLinked) {
		fmt.Fprintln(stderr, "shell: shell permissions reads the permissions on your account's sessions, and this machine is not signed in.")
		fmt.Fprintln(stderr, "Run 'shell auth' to link it.")
		return 1
	}
	if err != nil {
		fmt.Fprintf(stderr, "shell: %v\n", err)
		return 1
	}

	if len(changes) == 0 {
		current, err := client.GetSessionAutomation(ctx, credentials.AccessToken, sessionID)
		if err != nil {
			fmt.Fprintf(stderr, "shell: read permissions: %v\n", err)
			return 1
		}
		printPermissions(stdout, sessionID, current)
		return 0
	}

	updated, err := client.SetSessionAutomation(ctx, credentials.AccessToken, sessionID, changes)
	if err != nil {
		fmt.Fprintf(stderr, "shell: save permissions: %v\n", err)
		return 1
	}
	for _, entry := range permissionFlags {
		if _, touched := changes[entry.key]; !touched {
			continue
		}
		state := "off"
		if updated.SwitchValue(entry.key) {
			state = "on"
		}
		fmt.Fprintf(stdout, "%s: %s\n", entry.label, state)
	}
	fmt.Fprintln(stdout, permissionsNotActiveNote)
	return 0
}

func printPermissions(writer io.Writer, sessionID string, current account.SessionAutomation) {
	fmt.Fprintf(writer, "Permissions for %s:\n", shortSessionID(sessionID))
	for _, entry := range permissionFlags {
		state := "off"
		if current.SwitchValue(entry.key) {
			state = "on"
		}
		fmt.Fprintf(writer, "  %-20s %s\n", entry.label, state)
	}
}
