package main

import "testing"

func TestBrowserCommandKeepsTheOriginalCommandLineWhole(t *testing.T) {
	line := `python train.py --name "red fox" --message 'one two'`
	arguments := browserCommandArguments(line)
	if len(arguments) < 3 {
		t.Fatalf("browser command arguments = %#v", arguments)
	}
	if arguments[len(arguments)-1] != line {
		t.Fatalf("quoted command was rewritten: %#v", arguments)
	}
}
