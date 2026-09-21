package main

import (
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

const opencodeConversationHandoff = "opencode_conversation_fork"

// opencodeSessionIDPattern matches opencode session ids (e.g. "ses_...").
var opencodeSessionIDPattern = regexp.MustCompile(`^ses_[A-Za-z0-9]+$`)

// opencodeAdapter forks the current opencode conversation. opencode does not yet
// expose the active session id to its Bash tool subprocesses, so the exact fork
// (OPENCODE_SESSION_ID -> `--session`) is unavailable until that lands. In the
// meantime the adapter resolves the most recently active session in the opencode
// process's working directory and forks it with `--session <id> --fork`, which
// renders a full TUI. `opencode --continue --fork` is only a last resort: its
// "dummy" placeholder session id trips a schema check and degrades the forked TUI.
var opencodeAdapter = harnessAdapter{
	Binary:  "opencode",
	Handoff: opencodeConversationHandoff,
	Display: "opencode conversation",
	Detect: func(environment []string) bool {
		return environmentValue(environment, "OPENCODE") == "1"
	},
	SessionID: func(environment []string) string {
		sessionID := environmentValue(environment, "OPENCODE_SESSION_ID")
		if opencodeSessionIDPattern.MatchString(sessionID) {
			return sessionID
		}
		return ""
	},
	Rewrite: func(binary, sessionID string) ([]string, []string, string) {
		stripEnv := []string{"OPENCODE", "OPENCODE_PID", "AGENT"}
		if sessionID != "" {
			return []string{binary, "--session", sessionID, "--fork"}, stripEnv, ""
		}
		dir := opencodeProcessCwd()
		id, count, ok := opencodeLatestSession(dir)
		if ok && id != "" {
			return []string{binary, "--session", id, "--fork"}, stripEnv, opencodeForkCaveat(count, true)
		}
		return []string{binary, "--continue", "--fork"}, stripEnv, opencodeForkCaveat(0, false)
	},
}

// opencodeForkCaveat returns an operator note for the best-guess fork. It is empty
// when the working directory has exactly one session (so the pick is unambiguous)
// and a warning otherwise.
func opencodeForkCaveat(count int, ok bool) string {
	const warning = "most recent session in this project; with multiple concurrent opencode sessions this may not be the one you are in"
	if ok && count == 1 {
		return ""
	}
	return warning
}

// opencodeProcessCwd returns the working directory of the running opencode process
// (OPENCODE_PID), which is the project directory its sessions are stored under. It
// is empty when the pid is unset or its cwd cannot be resolved (e.g. no lsof).
var opencodeProcessCwd = func() string {
	pid := os.Getenv("OPENCODE_PID")
	if pid == "" {
		return ""
	}
	out, err := exec.Command("lsof", "-a", "-p", pid, "-d", "cwd", "-Fn").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "n") {
			return strings.TrimSpace(strings.TrimPrefix(line, "n"))
		}
	}
	return ""
}

// opencodeLatestSession returns the most recently updated session id in dir and the
// total number of sessions in dir, by shelling out to `opencode db`. ok is false
// when dir is empty or the lookup fails. It is a var so tests can substitute a
// fixed result.
var opencodeLatestSession = func(dir string) (string, int, bool) {
	if dir == "" {
		return "", 0, false
	}
	opencode, err := exec.LookPath("opencode")
	if err != nil {
		return "", 0, false
	}
	query := "SELECT id, (SELECT count(*) FROM session s2 WHERE s2.directory = s1.directory) FROM session s1 WHERE s1.directory = '" +
		strings.ReplaceAll(dir, "'", "''") + "' ORDER BY s1.time_updated DESC LIMIT 1;"
	out, err := exec.Command(opencode, "db", query).Output()
	if err != nil {
		return "", 0, false
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		fields := strings.Fields(lines[i])
		if len(fields) >= 2 && opencodeSessionIDPattern.MatchString(fields[0]) {
			if n, err := strconv.Atoi(fields[1]); err == nil {
				return fields[0], n, true
			}
		}
	}
	return "", 0, false
}
