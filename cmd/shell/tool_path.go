package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

/*
 * What the daemon can find, and why it could not.
 *
 * The daemon looks for agent tools on PATH and reports what it finds, and the
 * browser will not offer to start what nobody reported. That worked for as
 * long as the daemon was started by hand from a terminal, because it inherited
 * the PATH of whoever ran it.
 *
 * It is not started from a terminal any more. Agreeing to browser-started
 * sessions installs it as a user service -- a LaunchAgent on macOS, a systemd
 * user unit on Linux -- and launchd hands a service `/usr/bin:/bin:/usr/sbin:
 * /sbin` and nothing else. Every tool anybody actually uses lives somewhere
 * else: `~/.local/bin`, Homebrew, a version manager's shims. So a machine with
 * Claude Code installed reported no Claude Code, the browser said it was not
 * installed, and it was telling the truth about what it had been told.
 *
 * The same PATH is inherited by the sessions the daemon launches, so this is
 * not only a labelling problem: a session started anyway would have failed
 * with "command not found" for the same reason.
 *
 * The fix is to ask the login shell what PATH a terminal would have, and to
 * use that. Running the user's own rc files is exactly what opening a terminal
 * does, it is their own shell and their own files, and it is the only way to
 * see a version manager -- nvm is a function defined in `.zshrc`, not a
 * directory anybody can guess. Where the probe cannot run or says nothing
 * useful, a short list of the places tools are conventionally installed is
 * appended instead, which is a guess but a much better one than four system
 * directories.
 */

/** How long the login shell gets. It is reading rc files, not compiling. */
const loginShellTimeout = 5 * time.Second

/*
 * Wrapped in markers rather than read as "the last line".
 *
 * An interactive shell prints whatever the rc files print -- version notices,
 * a message of the day, a version manager announcing itself. The markers mean
 * the answer is found rather than guessed at, and a noisy shell costs nothing.
 */
const pathMarkerStart = "<<<shell-online-path:"
const pathMarkerEnd = ":shell-online-path>>>"

var loginShellScript = "printf '%s%s%s' '" + pathMarkerStart + "' \"$PATH\" '" + pathMarkerEnd + "'"

/** Pulls the PATH out of whatever the login shell printed, markers and all. */
func pathBetweenMarkers(output string) string {
	start := strings.Index(output, pathMarkerStart)
	if start < 0 {
		return ""
	}
	rest := output[start+len(pathMarkerStart):]
	end := strings.Index(rest, pathMarkerEnd)
	if end < 0 {
		return ""
	}
	return normalisePathList(strings.TrimSpace(rest[:end]))
}

/**
 * Turns what a shell printed into a PATH this program can read.
 *
 * Every POSIX shell holds PATH as one colon-separated string. fish holds it as
 * a list, and printing a list prints it space-separated -- so a fish user's
 * answer arrives as "/usr/bin /bin /opt/homebrew/bin", which as a PATH is one
 * directory with spaces in its name and no tools in it. Recognised by what it
 * is rather than by asking which shell printed it: a PATH with no separator
 * and spaces between things that look like absolute paths is a list.
 *
 * A directory can legitimately contain a space, so this only applies when
 * there is no colon at all. The alternative reading -- one directory named
 * "/usr/bin /bin /opt/homebrew/bin" -- is one nobody has.
 */
func normalisePathList(raw string) string {
	if raw == "" || strings.Contains(raw, ":") {
		return raw
	}
	fields := strings.Fields(raw)
	if len(fields) < 2 {
		return raw
	}
	for _, field := range fields {
		if !strings.HasPrefix(field, "/") {
			return raw
		}
	}
	return strings.Join(fields, ":")
}

/**
 * The places tools are conventionally installed, when the shell cannot say.
 *
 * Only directories that exist are offered, so this adds nothing to a machine
 * that does not have them. `exists` is a parameter because a test should be
 * able to describe a machine rather than depend on the one it runs on.
 */
func commonToolDirs(home string, exists func(string) bool) []string {
	if home == "" {
		return nil
	}
	candidates := []string{
		filepath.Join(home, ".local", "bin"),
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/local/sbin",
		filepath.Join(home, "bin"),
		filepath.Join(home, ".bun", "bin"),
		filepath.Join(home, ".cargo", "bin"),
		filepath.Join(home, "go", "bin"),
		filepath.Join(home, ".volta", "bin"),
	}
	/*
	 * And whichever node a version manager has been pointed at, because two of
	 * the four harnesses are npm packages and that is where they land. The
	 * alias is read rather than the directory listing sorted: `default` is the
	 * version the user chose, and a lexical sort would prefer v9 to v22.
	 */
	candidates = append(candidates, nvmDefaultBin(home, exists)...)

	found := make([]string, 0, len(candidates))
	for _, dir := range candidates {
		if exists(dir) {
			found = append(found, dir)
		}
	}
	return found
}

func nvmDefaultBin(home string, exists func(string) bool) []string {
	alias, err := os.ReadFile(filepath.Join(home, ".nvm", "alias", "default"))
	if err != nil {
		return nil
	}
	version := strings.TrimSpace(string(alias))
	if version == "" {
		return nil
	}
	if !strings.HasPrefix(version, "v") {
		version = "v" + version
	}
	dir := filepath.Join(home, ".nvm", "versions", "node", version, "bin")
	if !exists(dir) {
		return nil
	}
	return []string{dir}
}

/**
 * The PATH the daemon should use: the terminal's, then its own, then the
 * conventional places.
 *
 * The login shell's order comes first because it is the user's own intent
 * about which of two identically named tools wins, and a daemon that resolves
 * a different `claude` from the one their terminal resolves is a worse bug
 * than the one this fixes. Nothing is dropped: whatever the service was given
 * still follows, so a machine where the probe fails is never worse off.
 */
func mergePath(current, discovered string, extras []string) string {
	seen := make(map[string]bool)
	merged := make([]string, 0, 16)
	add := func(list []string) {
		for _, entry := range list {
			entry = strings.TrimSpace(entry)
			if entry == "" || seen[entry] {
				continue
			}
			seen[entry] = true
			merged = append(merged, entry)
		}
	}
	add(filepath.SplitList(discovered))
	add(filepath.SplitList(current))
	add(extras)
	return strings.Join(merged, string(os.PathListSeparator))
}

/**
 * Gives this process the PATH a terminal on this machine would have.
 *
 * Called once, as the daemon starts. Everything downstream reads the process
 * environment -- `exec.LookPath` for detection, `os.Environ()` for the
 * sessions that get launched -- so setting it here fixes both without either
 * of them knowing this happened.
 */
func applyToolPath(report io.Writer) {
	ctx, cancel := context.WithTimeout(context.Background(), loginShellTimeout)
	defer cancel()

	before := os.Getenv("PATH")
	discovered, err := probeLoginShellPath(ctx)
	if err != nil && report != nil {
		fmt.Fprintf(report, "  path   could not ask the login shell: %v\n", err)
	}

	home, _ := os.UserHomeDir()
	merged := mergePath(before, discovered, commonToolDirs(home, directoryExists))
	if merged == before {
		return
	}
	if err := os.Setenv("PATH", merged); err != nil {
		if report != nil {
			fmt.Fprintf(report, "  path   could not be set: %v\n", err)
		}
		return
	}
	if report != nil {
		fmt.Fprintf(report, "  path   %s\n", merged)
	}
}

func directoryExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
