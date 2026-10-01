package summary

import (
	"math"
	"regexp"
	"strings"
	"unicode/utf8"
)

// PrepareTail turns raw PTY output into the bounded plain text sent to the
// summarizer: terminal escape sequences and controls are removed, progress
// lines keep only their final state, secret-shaped strings are redacted, and
// the last MaxTailBytes are kept on a line boundary where possible.
//
// Redaction is best-effort minimization, not a guarantee. The enclave redacts
// again; the host does it first so that the least possible leaves the machine.
func PrepareTail(raw []byte) string {
	text := stripTerminal(strings.ToValidUTF8(string(raw), ""))
	text = Redact(text)
	return keepTail(text, MaxTailBytes)
}

// stripTerminal removes ANSI/ECMA-48 sequences (CSI, OSC, DCS, SOS, PM, APC,
// two- and three-byte escapes, and their 8-bit C1 forms), applies carriage
// returns and backspaces the way a terminal would, and drops every other
// control except newline and tab.
func stripTerminal(input string) string {
	var out strings.Builder
	out.Grow(len(input))
	line := []rune{}
	flush := func() {
		out.WriteString(strings.TrimRight(string(line), " \t"))
		line = line[:0]
	}
	runes := []rune(input)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case r == 0x1b:
			i = skipEscape(runes, i)
		case r == 0x9b: // 8-bit CSI
			i = skipCSI(runes, i+1)
		case r == 0x9d || r == 0x90 || r == 0x98 || r == 0x9e || r == 0x9f: // 8-bit OSC, DCS, SOS, PM, APC
			i = skipString(runes, i+1)
		case r == '\n':
			flush()
			out.WriteByte('\n')
		case r == '\r':
			if i+1 < len(runes) && runes[i+1] == '\n' {
				continue
			}
			// A bare carriage return redraws the line: keep what comes after it.
			line = line[:0]
		case r == '\b':
			if len(line) > 0 {
				line = line[:len(line)-1]
			}
		case r == '\t':
			line = append(line, r)
		case unsafeRune(r):
			// Dropped: other controls, bidi overrides, zero-width characters.
		default:
			line = append(line, r)
		}
	}
	flush()
	return blankPattern.ReplaceAllString(out.String(), "\n\n")
}

// skipEscape returns the index of the last rune of the escape sequence that
// starts at runes[i] == ESC.
func skipEscape(runes []rune, i int) int {
	if i+1 >= len(runes) {
		return i
	}
	switch next := runes[i+1]; {
	case next == '[':
		return skipCSI(runes, i+2)
	case next == ']' || next == 'P' || next == 'X' || next == '^' || next == '_':
		return skipString(runes, i+2)
	default:
		// ESC, optional intermediates (0x20–0x2f), one final byte (0x30–0x7e).
		j := i + 1
		for j < len(runes) && runes[j] >= 0x20 && runes[j] <= 0x2f {
			j++
		}
		if j < len(runes) && runes[j] >= 0x30 && runes[j] <= 0x7e {
			return j
		}
		return j - 1
	}
}

// skipCSI skips parameter and intermediate bytes up to and including the final
// byte (0x40–0x7e). An unterminated sequence consumes the rest of the input.
func skipCSI(runes []rune, j int) int {
	for ; j < len(runes); j++ {
		if runes[j] >= 0x40 && runes[j] <= 0x7e {
			return j
		}
		if runes[j] < 0x20 || runes[j] > 0x3f {
			// Malformed: stop at the offending rune so it is processed normally.
			return j - 1
		}
	}
	return len(runes) - 1
}

// skipString skips an OSC/DCS-style string terminated by BEL, ST (ESC \) or
// the 8-bit ST. An unterminated string consumes the rest of the input, so a
// half-received hyperlink or title can never leak through as text.
func skipString(runes []rune, j int) int {
	for ; j < len(runes); j++ {
		switch runes[j] {
		case 0x07, 0x9c:
			return j
		case 0x1b:
			if j+1 < len(runes) && runes[j+1] == '\\' {
				return j + 1
			}
		}
	}
	return len(runes) - 1
}

const redacted = "[redacted]"

type redaction struct {
	pattern     *regexp.Regexp
	replacement string
}

// Ordered: whole private key blocks first, so nothing inside them is matched
// piecemeal by the later rules.
var redactions = []redaction{
	{regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|\z)`), redacted},
	{regexp.MustCompile(`(?i)\b(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)(\s*[:=]\s*)[^\n]+`), "${1}${2}" + redacted},
	{regexp.MustCompile(`(?i)\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{12,}`), "${1} " + redacted},
	{regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]{1,31}://)[^\s/@:]+:[^\s/@]+@`), "${1}" + redacted + "@"},
	{regexp.MustCompile(`\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b`), redacted},
	{regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{35}\b`), redacted},
	{regexp.MustCompile(`\bya29\.[0-9A-Za-z_-]{20,}`), redacted},
	{regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b`), redacted},
	{regexp.MustCompile(`\bglpat-[A-Za-z0-9_-]{20,}\b`), redacted},
	{regexp.MustCompile(`\bxox[abposr]-[A-Za-z0-9-]{10,}`), redacted},
	// Slack incoming-webhook secrets are the path after /services/ (team, bot, token).
	{regexp.MustCompile(`\bservices/T[A-Z0-9]{6,}/B[A-Z0-9]{6,}/[A-Za-z0-9]{16,}`), "services/" + redacted},
	{regexp.MustCompile(`\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b`), redacted},
	{regexp.MustCompile(`\bwhsec_[A-Za-z0-9]{16,}\b`), redacted},
	{regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{20,}`), redacted},
	{regexp.MustCompile(`\bnpm_[A-Za-z0-9]{36}\b`), redacted},
	{regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`), redacted},
	{regexp.MustCompile(`(?i)\b([A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)s?[A-Za-z0-9_.-]*"?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)`), "${1}" + redacted},
}

var candidateToken = regexp.MustCompile(`[A-Za-z0-9+/_=-]{32,}`)

// Redact replaces secret-shaped strings with [redacted].
func Redact(text string) string {
	for _, rule := range redactions {
		text = rule.pattern.ReplaceAllString(text, rule.replacement)
	}
	return candidateToken.ReplaceAllStringFunc(text, func(token string) string {
		if highEntropy(token) {
			return redacted
		}
		return token
	})
}

// highEntropy flags long mixed tokens that look random. Hex digests (git
// hashes, checksums) top out at 4 bits per character and are kept.
func highEntropy(token string) bool {
	var lower, upper, digit bool
	counts := map[rune]int{}
	for _, r := range token {
		counts[r]++
		switch {
		case r >= 'a' && r <= 'z':
			lower = true
		case r >= 'A' && r <= 'Z':
			upper = true
		case r >= '0' && r <= '9':
			digit = true
		}
	}
	if !digit || !(lower && upper) {
		return false
	}
	entropy := 0.0
	length := float64(utf8.RuneCountInString(token))
	for _, count := range counts {
		p := float64(count) / length
		entropy -= p * math.Log2(p)
	}
	return entropy >= 4.2
}

// keepTail returns the last limit bytes of text, starting on a line boundary
// when one is close enough and never splitting a UTF-8 sequence.
func keepTail(text string, limit int) string {
	text = strings.Trim(text, "\n")
	if len(text) <= limit {
		return text
	}
	start := len(text) - limit
	for start < len(text) && !utf8.RuneStart(text[start]) {
		start++
	}
	tail := text[start:]
	if newline := strings.IndexByte(tail, '\n'); newline >= 0 && newline < 512 {
		tail = tail[newline+1:]
	}
	return tail
}

// RedactLabel prepares a command line for use as a request label.
func RedactLabel(label string) string {
	label = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return ' '
		}
		if unsafeRune(r) {
			return -1
		}
		return r
	}, strings.ToValidUTF8(label, ""))
	label = strings.Join(strings.Fields(Redact(label)), " ")
	runes := []rune(label)
	if len(runes) > MaxLabelRunes {
		label = string(runes[:MaxLabelRunes])
	}
	return label
}
