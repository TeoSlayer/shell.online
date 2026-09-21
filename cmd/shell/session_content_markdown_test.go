package main

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestOpenCodeMarkdownPreservesLayout(t *testing.T) {
	got := cleanOpenCodeMarkdown("## Work\r\n\r\n- first\n\tcode\x1b\u202e", 600)
	if got != "## Work\n\n- first\n\tcode" {
		t.Fatalf("unexpected layout %q", got)
	}
	if utf8.RuneCountInString(cleanOpenCodeMarkdown(strings.Repeat("界", 601), 600)) != 600 {
		t.Fatal("rune limit lost")
	}
}
