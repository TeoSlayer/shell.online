package summary

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestStripTerminal(t *testing.T) {
	cases := map[string]string{
		"\x1b[1;31mred\x1b[0m text":                        "red text",
		"\x1b]8;;https://evil.example\x07link\x1b]8;;\x07": "link",
		"\x1b]0;window title\x1b\\after":                   "after",
		"\x1bP+q544e\x1b\\x":                               "x",
		"\x1b(Bplain\x1b=":                                 "plain",
		"50%\r75%\r100% done\n":                            "100% done\n",
		"abc\b\bX":                                         "aX",
		"crlf\r\nline":                                     "crlf\nline",
		"\u009b31mc1\u009dtitle\u009cafter":                "c1after",
		"bidi\u202eevil\u200bzw\x07bell":                   "bidievilzwbell",
		"a\n\n\n\n\nb":                                     "a\n\nb",
		"trailing   \nspace\t":                             "trailing\nspace",
		"unterminated \x1b]8;;https://evil":                "unterminated",
		"tab\tkept":                                        "tab\tkept",
	}
	for input, want := range cases {
		if got := stripTerminal(input); got != want {
			t.Errorf("stripTerminal(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestRedact(t *testing.T) {
	secrets := []string{
		"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
		"-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
		"Authorization: Bearer abc.def.ghi-jkl-mno",
		"curl -H 'x-api-key: 0123456789abcdef'",
		"AKIAIOSFODNN7EXAMPLE",
		"AIzaSyA-1234567890abcdefghijklmnopqrstu",
		"ghp_" + strings.Repeat("a1B2", 9),
		"github_pat_" + strings.Repeat("A1_b", 8),
		"xoxb-123456789012-abcdefghij",
		"sk_live_" + strings.Repeat("4eC3", 6),
		"sk-ant-api03-" + strings.Repeat("Ab3_", 10),
		"sk-proj-" + strings.Repeat("Zx9", 10),
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
		"DATABASE_PASSWORD=hunter2hunter2",
		`"client_secret": "s3cr3t-value"`,
		"postgres://admin:pa55w0rd@db.internal:5432/app",
		"token=Zm9vYmFyYmF6cXV4",
		"NVbBQ7kR2xLp9WmZ4tYc8HsJ3dFg6AeUqK5vN1oT",
	}
	for _, secret := range secrets {
		out := Redact("before " + secret + " after")
		if !strings.Contains(out, redacted) {
			t.Errorf("not redacted: %q -> %q", secret, out)
		}
		for _, fragment := range []string{"hunter2", "pa55w0rd", "s3cr3t", "EXAMPLE", "b3BlbnNzaC1rZXkt", "MIIEvQ"} {
			if strings.Contains(secret, fragment) && strings.Contains(out, fragment) {
				t.Errorf("fragment %q survived in %q", fragment, out)
			}
		}
	}
	for _, safe := range []string{
		"commit 3f9a2c1b8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b merged",
		"sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
		"npm run build finished in 12.3s",
		"/Users/someone/projects/shell.online/cmd/shell/main.go:42",
	} {
		if out := Redact(safe); out != safe {
			t.Errorf("over-redacted %q -> %q", safe, out)
		}
	}
}

func TestPrepareTailBoundsAndBoundaries(t *testing.T) {
	var raw strings.Builder
	for i := 0; i < 4000; i++ {
		raw.WriteString("línea número ")
		raw.WriteString(strings.Repeat("é", i%7))
		raw.WriteString("\n")
	}
	tail := PrepareTail([]byte(raw.String()))
	if len(tail) > MaxTailBytes || !utf8.ValidString(tail) {
		t.Fatalf("tail is %d bytes, valid=%v", len(tail), utf8.ValidString(tail))
	}
	if !strings.HasPrefix(tail, "línea") {
		t.Errorf("tail does not start on a line boundary: %q", tail[:20])
	}
	if PrepareTail([]byte("\xff\xfeinvalid\x1b[0m")) != "invalid" {
		t.Error("invalid UTF-8 and escapes not removed")
	}
}

func TestRedactLabel(t *testing.T) {
	got := RedactLabel("psql postgres://u:secretpw@h/db\n--password=hunter22 " + strings.Repeat("x", 200))
	if strings.Contains(got, "secretpw") || strings.Contains(got, "hunter22") || strings.Contains(got, "\n") || utf8.RuneCountInString(got) > MaxLabelRunes {
		t.Fatalf("label not cleaned: %q", got)
	}
}
