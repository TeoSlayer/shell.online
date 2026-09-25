package summary

import (
	"errors"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The output guard. A summary is shown to a person as a trusted-looking card,
// but its text comes from terminal output or an agent transcript, either of
// which an attacker may have written into. So a summary may carry prose and
// nothing that acts: no links, no addresses, no markup. CleanText rewrites
// agent-sourced text into that shape; CheckText is the strict gate every
// summary passes before it is sealed, whoever wrote it.

var (
	// scheme://… and www.… anywhere, including inside words.
	urlPattern = regexp.MustCompile(`(?i)(?:\b[a-z][a-z0-9+.-]{1,31}://|\bwww\.)[^\s<>"']*`)
	// Bare domains on TLDs that are common in links but rare as file
	// extensions (so main.go, deploy.sh and parser.cc survive).
	domainPattern = regexp.MustCompile(`(?i)\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|dev|app|ai|co|xyz|info|biz|ru|cn|online|site|link|gg|top|club|us|uk|ly|tk|zip|mov|click|live|shop)\b(?:[/:?#][^\s<>"']*)?`)
	emailPattern  = regexp.MustCompile(`(?i)\b[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b`)
	imagePattern  = regexp.MustCompile(`!\[([^\]\n]{0,200})\]\([^)\n]*\)`)
	linkPattern   = regexp.MustCompile(`\[([^\]\n]{0,200})\]\([^)\n]*\)`)
	refPattern    = regexp.MustCompile(`(?m)^\s*\[[^\]\n]{1,100}\]:\s*\S+.*$`)
	tagPattern    = regexp.MustCompile(`</?[A-Za-z!][^>\n]{0,500}>`)
	fencePattern  = regexp.MustCompile("`{3,}[^\\n]*")
	spacePattern  = regexp.MustCompile(`[ \t]+`)
	blankPattern  = regexp.MustCompile(`\n{3,}`)
)

// ErrUnsafeText is returned by CheckText; the message says which rule failed
// without echoing the text.
var ErrUnsafeText = errors.New("unsafe summary text")

// unsafeRune reports runes never allowed in shown text: controls, format
// characters (bidi overrides, zero-width joiners and the like), surrogates and
// noncharacters.
func unsafeRune(r rune) bool {
	return r == utf8.RuneError || unicode.IsControl(r) || unicode.Is(unicode.Cf, r) ||
		unicode.Is(unicode.Co, r) || unicode.Is(unicode.Cs, r) || (r >= 0xfdd0 && r <= 0xfdef) || r&0xfffe == 0xfffe
}

func hasUnsafeRune(value string, multiline bool) bool {
	for _, r := range value {
		if multiline && (r == '\n' || r == '\t') {
			continue
		}
		if unsafeRune(r) {
			return true
		}
	}
	return false
}

// CheckText is the strict gate. It never rewrites: text that fails is refused.
func CheckText(value string, maxRunes int, multiline bool) error {
	switch {
	case value == "" || strings.TrimSpace(value) == "":
		return errors.New("empty")
	case !utf8.ValidString(value):
		return errors.New("invalid UTF-8")
	case utf8.RuneCountInString(value) > maxRunes:
		return errors.New("too long")
	case strings.ContainsRune(value, '\t'):
		return errors.New("tab")
	case hasUnsafeRune(value, multiline):
		return errors.New("control or format character")
	case urlPattern.MatchString(value) || domainPattern.MatchString(value):
		return errors.New("link")
	case emailPattern.MatchString(value):
		return errors.New("e-mail address")
	case strings.Contains(value, "](") || strings.Contains(value, "!["):
		return errors.New("markdown link")
	case strings.ContainsRune(value, '`'):
		return errors.New("code markup")
	case tagPattern.MatchString(value):
		return errors.New("markup tag")
	}
	return nil
}

// CleanText turns agent-authored text into guard-passing plain text: markup is
// reduced to its words, links and addresses are replaced by placeholders, and
// the result is truncated on a rune boundary. It may return "".
func CleanText(value string, maxRunes int, multiline bool) string {
	value = strings.ToValidUTF8(value, "")
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
	value = strings.Map(func(r rune) rune {
		if r == '\n' {
			if multiline {
				return r
			}
			return ' '
		}
		if r == '\t' {
			return ' '
		}
		if unsafeRune(r) {
			return -1
		}
		return r
	}, value)
	value = fencePattern.ReplaceAllString(value, "")
	value = imagePattern.ReplaceAllString(value, "$1")
	value = linkPattern.ReplaceAllString(value, "$1")
	value = refPattern.ReplaceAllString(value, "")
	value = tagPattern.ReplaceAllString(value, "")
	value = urlPattern.ReplaceAllString(value, "(link removed)")
	value = emailPattern.ReplaceAllString(value, "(address removed)")
	value = domainPattern.ReplaceAllString(value, "(link removed)")
	value = strings.NewReplacer("`", "", "](", "] (", "![", "[", "<", "‹", ">", "›").Replace(value)

	lines := strings.Split(value, "\n")
	for i, line := range lines {
		line = strings.TrimSpace(spacePattern.ReplaceAllString(line, " "))
		// Leading Markdown list, heading and quote markers carry no meaning in plain text.
		line = strings.TrimLeft(line, "#›")
		lines[i] = strings.TrimSpace(line)
	}
	value = strings.TrimSpace(blankPattern.ReplaceAllString(strings.Join(lines, "\n"), "\n\n"))
	return truncateRunes(value, maxRunes)
}

func truncateRunes(value string, maxRunes int) string {
	if utf8.RuneCountInString(value) <= maxRunes {
		return value
	}
	runes := []rune(value)
	if maxRunes <= 1 {
		return string(runes[:maxRunes])
	}
	return strings.TrimSpace(string(runes[:maxRunes-1])) + "…"
}
