package main

import (
	"testing"
	"time"
)

func TestCompactDuration(t *testing.T) {
	tests := []struct {
		value time.Duration
		want  string
	}{
		{value: -time.Second, want: "now"},
		{value: 500 * time.Millisecond, want: "<1s"},
		{value: 5 * time.Second, want: "5s"},
		{value: 2*time.Hour + 14*time.Minute + 9*time.Second, want: "2h14m"},
		{value: 8*24*time.Hour + 3*time.Hour, want: "8d3h"},
	}
	for _, test := range tests {
		if got := compactDuration(test.value); got != test.want {
			t.Errorf("compactDuration(%v) = %q, want %q", test.value, got, test.want)
		}
	}
}

func TestDisplayCommand(t *testing.T) {
	got := displayCommand([]string{"tool", "plain", "two words", "", `a"b`})
	want := `tool plain "two words" "" "a\"b"`
	if got != want {
		t.Fatalf("displayCommand() = %q, want %q", got, want)
	}
}

func TestTruncateText(t *testing.T) {
	if got := truncateText("a long command", 8); got != "a long …" {
		t.Fatalf("truncateText() = %q", got)
	}
	if got := truncateText("short", 8); got != "short" {
		t.Fatalf("truncateText() changed short text to %q", got)
	}
}
