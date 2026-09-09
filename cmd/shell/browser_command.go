package main

import (
	"strings"
	"unicode"
)

/*
 * Characters whose meaning only a shell can give: pipes, redirects,
 * substitution, globbing, job control.
 *
 * A line carrying any of them has no argv that means the same thing, so it
 * goes to a shell. A line carrying none of them does, and running that argv
 * directly is what keeps `claude` a session that reads as Claude Code rather
 * than as a shell that happens to have started one.
 */
const shellMetacharacters = "|&;<>()$`\\*?[]{}~#!\n\r"

/*
 * splitCommandLine turns a browser-entered command line into an argv.
 *
 * Quoting is honoured, so `--message "one two"` stays one argument. It
 * reports false when the line needs a shell, or when its quotes do not close:
 * an unbalanced quote is a mistake, and a shell gives a better account of it
 * than a guess here would.
 */
func splitCommandLine(command string) ([]string, bool) {
	if strings.ContainsAny(command, shellMetacharacters) {
		return nil, false
	}

	var arguments []string
	var current strings.Builder
	var quote rune
	started := false

	for _, char := range command {
		switch {
		case quote != 0:
			if char == quote {
				quote = 0
				continue
			}
			current.WriteRune(char)
		case char == '\'' || char == '"':
			quote = char
			started = true
		case unicode.IsSpace(char):
			if started {
				arguments = append(arguments, current.String())
				current.Reset()
				started = false
			}
		default:
			current.WriteRune(char)
			started = true
		}
	}

	if quote != 0 {
		return nil, false
	}
	if started {
		arguments = append(arguments, current.String())
	}
	if len(arguments) == 0 {
		return nil, false
	}
	return arguments, true
}
