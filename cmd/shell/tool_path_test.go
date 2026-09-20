package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/**
 * The PATH a service is given, and the PATH a person has.
 *
 * Every test here is about one machine: the one where Claude Code is installed
 * in ~/.local/bin, the daemon runs under launchd with four system directories,
 * and the browser therefore said Claude Code was not installed.
 */

func TestMergePathPutsTheTerminalsOrderFirst(t *testing.T) {
	/*
	 * Which of two identically named tools wins is the user's own decision,
	 * expressed in their shell. A daemon that resolved a different `claude`
	 * from their terminal would be a worse bug than the one this fixes.
	 */
	merged := mergePath("/usr/bin:/bin", "/home/ada/.local/bin:/usr/bin", nil)
	want := "/home/ada/.local/bin:/usr/bin:/bin"
	if merged != want {
		t.Fatalf("merged = %q, want %q", merged, want)
	}
}

func TestMergePathKeepsWhatTheServiceWasGiven(t *testing.T) {
	/* A machine where the probe fails must never end up worse off. */
	merged := mergePath("/usr/bin:/bin:/usr/sbin:/sbin", "", nil)
	if merged != "/usr/bin:/bin:/usr/sbin:/sbin" {
		t.Fatalf("merged = %q", merged)
	}
}

func TestMergePathDoesNotRepeatADirectory(t *testing.T) {
	merged := mergePath("/usr/bin:/bin", "/usr/bin", []string{"/bin", "/opt/homebrew/bin"})
	if strings.Count(merged, "/usr/bin") != 1 || strings.Count(merged, "/bin:") < 1 {
		t.Fatalf("merged = %q", merged)
	}
	if !strings.HasSuffix(merged, "/opt/homebrew/bin") {
		t.Fatalf("the conventional directories come last: %q", merged)
	}
}

func TestMergePathIgnoresEmptyEntries(t *testing.T) {
	/* An empty entry in PATH means the working directory, which a daemon
	 * launching sessions must never search. */
	merged := mergePath("::/usr/bin:", "", nil)
	if merged != "/usr/bin" {
		t.Fatalf("merged = %q", merged)
	}
}

func TestPathBetweenMarkersIgnoresWhateverElseTheShellPrinted(t *testing.T) {
	/*
	 * An interactive shell prints the message of the day, a version manager
	 * announcing itself, whatever somebody put in their rc file. Reading "the
	 * last line" would pick up any of it.
	 */
	output := "Welcome to zsh!\nnvm: now using node v22\n" +
		pathMarkerStart + "/home/ada/.local/bin:/usr/bin" + pathMarkerEnd + "\n"
	if got := pathBetweenMarkers(output); got != "/home/ada/.local/bin:/usr/bin" {
		t.Fatalf("got %q", got)
	}
}

func TestPathBetweenMarkersSaysNothingWhenItWasNotPrinted(t *testing.T) {
	if got := pathBetweenMarkers("command not found: printf\n"); got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}

func TestCommonToolDirsOffersOnlyDirectoriesThatExist(t *testing.T) {
	home := t.TempDir()
	local := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(local, 0o755); err != nil {
		t.Fatal(err)
	}
	exists := func(path string) bool {
		info, err := os.Stat(path)
		return err == nil && info.IsDir()
	}

	dirs := commonToolDirs(home, exists)
	if len(dirs) == 0 || dirs[0] != local {
		t.Fatalf("dirs = %v, want %s first", dirs, local)
	}
	for _, dir := range dirs {
		if !exists(dir) {
			t.Fatalf("%s does not exist and should not have been offered", dir)
		}
	}
}

func TestCommonToolDirsFollowsTheNodeVersionThatWasChosen(t *testing.T) {
	/*
	 * Two of the four harnesses are npm packages, so this is where they are.
	 * The alias is read rather than the directory listing sorted, because a
	 * lexical sort prefers v9 to v22 and the user chose neither by sorting.
	 */
	home := t.TempDir()
	chosen := filepath.Join(home, ".nvm", "versions", "node", "v22.23.2", "bin")
	other := filepath.Join(home, ".nvm", "versions", "node", "v9.11.2", "bin")
	for _, dir := range []string{chosen, other, filepath.Join(home, ".nvm", "alias")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(home, ".nvm", "alias", "default"), []byte("22.23.2\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	dirs := commonToolDirs(home, func(path string) bool {
		info, err := os.Stat(path)
		return err == nil && info.IsDir()
	})
	found := false
	for _, dir := range dirs {
		if dir == chosen {
			found = true
		}
		if dir == other {
			t.Fatalf("offered a version nobody asked for: %s", other)
		}
	}
	if !found {
		t.Fatalf("dirs = %v, want %s", dirs, chosen)
	}
}

func TestCommonToolDirsSurvivesAMachineWithNoHome(t *testing.T) {
	if dirs := commonToolDirs("", func(string) bool { return true }); dirs != nil {
		t.Fatalf("dirs = %v, want none", dirs)
	}
}

/**
 * The bug, end to end: a service PATH, a machine with the tools elsewhere, and
 * the detection that has to see them.
 */
func TestDetectionFindsToolsAServicePathCannotSee(t *testing.T) {
	home := t.TempDir()
	local := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(local, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"claude", "openclaw"} {
		if err := os.WriteFile(filepath.Join(local, tool), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	servicePath := "/usr/bin:/bin:/usr/sbin:/sbin"
	lookIn := func(path string) func(string) (string, error) {
		return func(name string) (string, error) {
			for _, dir := range filepath.SplitList(path) {
				candidate := filepath.Join(dir, name)
				if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
					return candidate, nil
				}
			}
			return "", os.ErrNotExist
		}
	}

	if found := detectHarnesses(lookIn(servicePath)); len(found) != 0 {
		t.Fatalf("the service PATH should find nothing here, found %v", found)
	}

	merged := mergePath(servicePath, "", commonToolDirs(home, directoryExists))
	found := detectHarnesses(lookIn(merged))
	if len(found) != 2 || found[0] != "claude-code" || found[1] != "openclaw" {
		t.Fatalf("found = %v, want claude-code and openclaw", found)
	}
}

func TestPathBetweenMarkersReadsAFishList(t *testing.T) {
	/*
	 * fish holds PATH as a list and prints it space-separated. Read as a PATH
	 * that is one directory with spaces in its name, and a fish user gets the
	 * conventional directories and nothing else.
	 */
	output := pathMarkerStart + "/usr/bin /bin /opt/homebrew/bin" + pathMarkerEnd
	if got := pathBetweenMarkers(output); got != "/usr/bin:/bin:/opt/homebrew/bin" {
		t.Fatalf("got %q", got)
	}
}

func TestPathBetweenMarkersLeavesADirectoryWithASpaceAlone(t *testing.T) {
	/* Unusual, legal, and not a list: there is a separator in it. */
	output := pathMarkerStart + "/usr/bin:/Users/ada/Application Support/bin" + pathMarkerEnd
	if got := pathBetweenMarkers(output); got != "/usr/bin:/Users/ada/Application Support/bin" {
		t.Fatalf("got %q", got)
	}
}
