// Synthetic cross-language fixture. Never reads a user's session or terminal.
package main

import (
	"encoding/json"
	"os"
	"shell.online/internal/ringbuffer"
	"strings"
)

func main() {
	type fixture struct {
		Name                          string
		Before, Snapshot, Tail, After []byte
	}
	var fixtures []fixture
	for _, c := range []struct{ name, before, after string }{
		{"incremental-overflow", "\x1b[?1049h\x1b[2J\x1b[H\x1b[48;2;20;30;40mHEADER\x1b[0m\x1b[23;1H\x1b[7mSTATUS\x1b[0m\x1b[?25l" + strings.Repeat("\x1b[12;35H12345678", 40000), "\x1b[12;35HUPDATED!"},
		{"saved-cursor", "\x1b[3;4H\x1b[31m\x1b7\x1b[12;20H\x1b[32mcurrent", "\x1b8RESTORED"},
		{"saved-origin", "\x1b[3;20r\x1b[?6h\x1b[4;5H\x1b7\x1b[?6lcurrent", "\x1b8\x1b[1;1HRESTORED"},
		{"saved-wrap", "\x1b[?7l\x1b7\x1b[?7hcurrent", "\x1b8\x1b[1;79Hlong"},
		{"line-drawing", "\x1b(0lqqk", "xqx\x1b(BASCII"},
		{"saved-charset", "\x1b(0\x1b7\x1b(Bcurrent", "\x1b8lqqk"},
		{"tab-stops", "\x1b[3g\x1b[5G\x1bH\x1b[Hstart", "\r\tTAB"},
		{"split-utf8", "\x1b[3;4H\xe6\x97", "\xa5 next"},
		{"split-sgr", "\x1b[3;4Hplain\x1b[38;2;2;", "3;4mCOLOR"},
		{"origin", "\x1b[3;20r\x1b[?6h\x1b[4;5Hmiddle", "NEXT\n"},
		{"wrap", strings.Repeat("x", 80), "wrapped"},
		{"alt-exit", "\x1b[31mprimary\x1b[?1049h\x1b[32malternate", "\x1b[?1049lMAIN"},
	} {
		b := ringbuffer.NewTerminal(512*1024, 80, 24)
		b.Write([]byte(c.before))
		fixtures = append(fixtures, fixture{c.name, []byte(c.before), b.Snapshot(), b.Bytes(), []byte(c.after)})
	}
	json.NewEncoder(os.Stdout).Encode(fixtures)
}
