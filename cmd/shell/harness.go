package main

import (
	"os/exec"
	"sort"
)

// harnessCommands maps each agent harness the web app can build a command for
// to the program that runs it.
//
// The ids are shared with app/src/lib/session-kinds.ts, and the accounts
// service only stores ones it recognises. A harness added on one side and not
// the other is reported and then dropped, so the two lists have to be edited
// together.
var harnessCommands = map[string]string{
	"claude-code": "claude",
	"codex":       "codex",
	"hermes":      "hermes",
	"openclaw":    "openclaw",
}

// detectHarnesses reports which harnesses this machine can run.
//
// Being on PATH is the whole test. The tools are never executed: running an
// agent binary to read a version string, so a browser can render a label, buys
// nothing worth the risk, and several of these take seconds to start.
//
// The lookup is a parameter so a test can describe a machine instead of
// depending on whichever tools the machine running it happens to have.
func detectHarnesses(look func(string) (string, error)) []string {
	found := make([]string, 0, len(harnessCommands))
	for id, command := range harnessCommands {
		path, err := look(command)
		if err != nil || path == "" {
			continue
		}
		found = append(found, id)
	}
	// Map iteration order is deliberately random, and this list is sent on
	// every poll, so sorting is what keeps one machine's report stable.
	sort.Strings(found)
	return found
}

// installedHarnesses reports the harnesses on this machine's PATH.
func installedHarnesses() []string {
	return detectHarnesses(exec.LookPath)
}
