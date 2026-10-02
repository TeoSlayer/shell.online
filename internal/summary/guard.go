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
	domainPattern = regexp.MustCompile(`(?i)\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|ai|app|dev|xyz|me|info|biz|ru|cn|tk|top|online|site|link|click|ly|gl|gg|uk|de|fr|ws|page|live|shop|store|support|help|login|cloud|club|us|to|gd|ms|lol|icu|vip|work|tech|su|ga|cf|ml|gq|pw|fun|space|website|news|one|cyou|buzz|rest|bar|xin|cam|bond|sbs|life|world|today|pro)\b(?:[/:?#][^\s<>"']*)?`)
	// The last label must be alphabetic, so package specifiers such as
	// vite@6.0.0 are not mistaken for addresses.
	emailPattern = regexp.MustCompile(`(?i)[^\s@]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b`)
	// Link schemes that need no "//"; a following non-space keeps prose such
	// as "file: main.go" intact.
	schemePattern  = regexp.MustCompile(`(?i)\b(?:data|javascript|vbscript|file|mailto|tel|sms):\S`)
	ipPattern      = regexp.MustCompile(`\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b`)
	entityPattern  = regexp.MustCompile(`(?i)&[a-z]+;|&#`)
	refLinkPattern = regexp.MustCompile(`\[[^\]]*\]\s*\[`)
	imagePattern   = regexp.MustCompile(`!\[([^\]\n]{0,200})\]\([^)\n]*\)`)
	linkPattern    = regexp.MustCompile(`\[([^\]\n]{0,200})\]\([^)\n]*\)`)
	refPattern     = regexp.MustCompile(`(?m)^\s*\[[^\]\n]{1,100}\]:\s*\S+.*$`)
	tagPattern     = regexp.MustCompile(`</?[A-Za-z!][^>\n]{0,500}>`)
	fencePattern   = regexp.MustCompile("`{3,}[^\\n]*")
	// Links disguised so a person can still type them: evil[.]com, hxxps://,
	// "evil dot com" and punycode.
	defangedPattern = regexp.MustCompile(`(?i)\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}|\[\s*dot\s*\]|\(\s*dot\s*\)|\bhxxps?\b|\[:\]//|\b[a-z0-9-]+\s+dot\s+[a-z]{2,}\b|\bxn--[a-z0-9-]*`)
	tokenPattern    = regexp.MustCompile(`[\p{L}\p{N}.-]+`)
	spacePattern    = regexp.MustCompile(`[ \t]+`)
	blankPattern    = regexp.MustCompile(`\n{3,}`)
)

// fold maps the characters people use to disguise links onto ASCII before
// matching: full-width forms (U+FF01–U+FF5E) and dot, colon, slash and at
// look-alikes. Kept identical to the enclave guard and the browser opener.
func fold(text string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 0xFF01 && r <= 0xFF5E:
			return r - 0xFEE0
		case r == 0x3002 || r == 0xFF61 || r == 0xFE52 || r == 0x2024 || r == 0x2E33 || r == 0x00B7 || r == 0x0701 || r == 0x0702:
			return '.'
		case r == 0xA789 || r == 0x2236 || r == 0xFE55:
			return ':'
		case r == 0x2215 || r == 0x2044 || r == 0x29F8:
			return '/'
		case r == 0xFE6B:
			return '@'
		}
		return r
	}, text)
}

// lookalikeToken reports a dotted token (label.label) containing a non-ASCII
// letter, such as "shell-online.cоm" with a Cyrillic "о".
func lookalikeToken(token string) bool {
	nonASCII := false
	for _, r := range token {
		if r > unicode.MaxASCII && unicode.IsLetter(r) {
			nonASCII = true
			break
		}
	}
	if !nonASCII {
		return false
	}
	parts := strings.Split(strings.Trim(token, ".-"), ".")
	letters := 0
	for _, part := range parts {
		if strings.IndexFunc(part, unicode.IsLetter) >= 0 {
			letters++
		}
	}
	return len(parts) >= 2 && letters >= 2
}

func hasLookalikeDomain(text string) bool {
	for _, token := range tokenPattern.FindAllString(text, -1) {
		if lookalikeToken(token) {
			return true
		}
	}
	return false
}

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
	folded := fold(value)
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
	case urlPattern.MatchString(folded) || domainPattern.MatchString(folded) || defangedPattern.MatchString(folded) || hasLookalikeDomain(folded):
		return errors.New("link")
	case schemePattern.MatchString(folded):
		return errors.New("link")
	case emailPattern.MatchString(folded):
		return errors.New("e-mail address")
	case ipPattern.MatchString(folded):
		return errors.New("IP address")
	case entityPattern.MatchString(folded):
		return errors.New("HTML entity")
	case refLinkPattern.MatchString(folded):
		return errors.New("markdown reference link")
	case strings.Contains(folded, "](") || strings.Contains(folded, "!["):
		return errors.New("markdown link")
	case strings.ContainsRune(folded, '`'):
		return errors.New("code markup")
	case tagPattern.MatchString(folded):
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
	value = fold(value)
	value = fencePattern.ReplaceAllString(value, "")
	value = imagePattern.ReplaceAllString(value, "$1")
	value = linkPattern.ReplaceAllString(value, "$1")
	value = refPattern.ReplaceAllString(value, "")
	value = tagPattern.ReplaceAllString(value, "")
	value = defangedPattern.ReplaceAllString(value, "(link removed)")
	value = urlPattern.ReplaceAllString(value, "(link removed)")
	value = tokenPattern.ReplaceAllStringFunc(value, func(token string) string {
		if lookalikeToken(token) {
			return "(link removed)"
		}
		return token
	})
	value = schemePattern.ReplaceAllString(value, "(link removed)")
	value = emailPattern.ReplaceAllString(value, "(address removed)")
	value = ipPattern.ReplaceAllString(value, "(address removed)")
	value = entityPattern.ReplaceAllString(value, "")
	value = refLinkPattern.ReplaceAllStringFunc(value, func(match string) string {
		return strings.TrimRight(match[:len(match)-1], " \t\n") + "; ["
	})
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
