package main

import (
	"reflect"
	"testing"
)

func TestBrowserCommandRunsAPlainCommandWithoutAShell(t *testing.T) {
	arguments := browserCommandArguments("claude --dangerously-skip-permissions")
	want := []string{"claude", "--dangerously-skip-permissions"}
	if !reflect.DeepEqual(arguments, want) {
		t.Fatalf("browser command arguments = %#v, want %#v", arguments, want)
	}
}

func TestBrowserCommandKeepsQuotedArgumentsWhole(t *testing.T) {
	arguments := browserCommandArguments(`python train.py --name "red fox" --message 'one two'`)
	want := []string{"python", "train.py", "--name", "red fox", "--message", "one two"}
	if !reflect.DeepEqual(arguments, want) {
		t.Fatalf("browser command arguments = %#v, want %#v", arguments, want)
	}
}

// A line a shell has to interpret reaches the shell whole: splitting it would
// change what it does.
func TestBrowserCommandHandsShellSyntaxToAShell(t *testing.T) {
	for _, line := range []string{
		"tail -f log | grep error",
		"make build && make test",
		"echo $HOME",
		"ls *.go",
		`echo "unbalanced`,
	} {
		arguments := browserCommandArguments(line)
		if arguments[len(arguments)-1] != line {
			t.Fatalf("%q was rewritten: %#v", line, arguments)
		}
		if len(arguments) < 3 {
			t.Fatalf("%q did not reach a shell: %#v", line, arguments)
		}
	}
}

func TestSplitCommandLineRejectsAnEmptyLine(t *testing.T) {
	if _, ok := splitCommandLine("   "); ok {
		t.Fatal("an empty line has no argv")
	}
}
