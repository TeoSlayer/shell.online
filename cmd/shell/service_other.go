//go:build !darwin && !linux

package main

import "errors"

// No service installer here yet. The daemon still starts whenever a shell
// command runs, so a machine is reachable as soon as its owner uses the tool;
// what is missing is surviving a restart untouched.
//
// Saying so plainly beats shipping an installer nobody has run: a Windows
// scheduled task or a BSD rc script that has never been tested would fail in
// ways this codebase could not describe.

var errServiceUnsupported = errors.New(
	"installing a background service is not supported on this platform yet.\n" +
		"The daemon still starts whenever you run a shell command")

func serviceInstalled() (string, bool) { return "", false }

func installService(string, map[string]string) (string, error) {
	return "", errServiceUnsupported
}

func uninstallService() (bool, error) { return false, errServiceUnsupported }
