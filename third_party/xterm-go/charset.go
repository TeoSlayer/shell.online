package xterm

// Ported from xterm.js src/common/services/CharsetService.ts and src/common/data/Charsets.ts.

// CHARSETS maps charset designator characters to their Charset tables.
// nil means the default (US ASCII) charset.
var CHARSETS = map[byte]Charset{
	'B': nil, // US (default)
}

// CharsetDECSpecialGraphics is the DEC Special Character and Line Drawing Set.
// Reference: http://vt100.net/docs/vt102-ug/table5-13.html
var CharsetDECSpecialGraphics = Charset{
	'`': '\u25c6', // ◆
	'a': '\u2592', // ▒
	'b': '\u2409', // ␉
	'c': '\u240c', // ␌
	'd': '\u240d', // ␍
	'e': '\u240a', // ␊
	'f': '\u00b0', // °
	'g': '\u00b1', // ±
	'h': '\u2424', // ␤
	'i': '\u240b', // ␋
	'j': '\u2518', // ┘
	'k': '\u2510', // ┐
	'l': '\u250c', // ┌
	'm': '\u2514', // └
	'n': '\u253c', // ┼
	'o': '\u23ba', // ⎺
	'p': '\u23bb', // ⎻
	'q': '\u2500', // ─
	'r': '\u23bc', // ⎼
	's': '\u23bd', // ⎽
	't': '\u251c', // ├
	'u': '\u2524', // ┤
	'v': '\u2534', // ┴
	'w': '\u252c', // ┬
	'x': '\u2502', // │
	'y': '\u2264', // ≤
	'z': '\u2265', // ≥
	'{': '\u03c0', // π
	'|': '\u2260', // ≠
	'}': '\u00a3', // £
	'~': '\u00b7', // ·
}

// CharsetBritish is the British character set (ESC (A).
var CharsetBritish = Charset{
	'#': '\u00a3', // £
}

// CharsetDutch is the Dutch character set (ESC (4).
var CharsetDutch = Charset{
	'#':  '\u00a3', // £
	'@':  '\u00be', // ¾
	'[':  'i',      // ij (approximation: first char)
	'\\': '\u00bd', // ½
	']':  '|',
	'{':  '\u00a8', // ¨
	'|':  'f',
	'}':  '\u00bc', // ¼
	'~':  '\u00b4', // ´
}

// CharsetFinnish is the Finnish character set (ESC (C or ESC (5).
var CharsetFinnish = Charset{
	'[':  '\u00c4', // Ä
	'\\': '\u00d6', // Ö
	']':  '\u00c5', // Å
	'^':  '\u00dc', // Ü
	'`':  '\u00e9', // é
	'{':  '\u00e4', // ä
	'|':  '\u00f6', // ö
	'}':  '\u00e5', // å
	'~':  '\u00fc', // ü
}

// CharsetFrench is the French character set (ESC (R).
var CharsetFrench = Charset{
	'#':  '\u00a3', // £
	'@':  '\u00e0', // à
	'[':  '\u00b0', // °
	'\\': '\u00e7', // ç
	']':  '\u00a7', // §
	'{':  '\u00e9', // é
	'|':  '\u00f9', // ù
	'}':  '\u00e8', // è
	'~':  '\u00a8', // ¨
}

// CharsetFrenchCanadian is the French Canadian character set (ESC (Q).
var CharsetFrenchCanadian = Charset{
	'@':  '\u00e0', // à
	'[':  '\u00e2', // â
	'\\': '\u00e7', // ç
	']':  '\u00ea', // ê
	'^':  '\u00ee', // î
	'`':  '\u00f4', // ô
	'{':  '\u00e9', // é
	'|':  '\u00f9', // ù
	'}':  '\u00e8', // è
	'~':  '\u00fb', // û
}

// CharsetGerman is the German character set (ESC (K).
var CharsetGerman = Charset{
	'@':  '\u00a7', // §
	'[':  '\u00c4', // Ä
	'\\': '\u00d6', // Ö
	']':  '\u00dc', // Ü
	'{':  '\u00e4', // ä
	'|':  '\u00f6', // ö
	'}':  '\u00fc', // ü
	'~':  '\u00df', // ß
}

// CharsetItalian is the Italian character set (ESC (Y).
var CharsetItalian = Charset{
	'#':  '\u00a3', // £
	'@':  '\u00a7', // §
	'[':  '\u00b0', // °
	'\\': '\u00e7', // ç
	']':  '\u00e9', // é
	'`':  '\u00f9', // ù
	'{':  '\u00e0', // à
	'|':  '\u00f2', // ò
	'}':  '\u00e8', // è
	'~':  '\u00ec', // ì
}

// CharsetNorwegianDanish is the Norwegian/Danish character set (ESC (E or ESC (6).
var CharsetNorwegianDanish = Charset{
	'@':  '\u00c4', // Ä
	'[':  '\u00c6', // Æ
	'\\': '\u00d8', // Ø
	']':  '\u00c5', // Å
	'^':  '\u00dc', // Ü
	'`':  '\u00e4', // ä
	'{':  '\u00e6', // æ
	'|':  '\u00f8', // ø
	'}':  '\u00e5', // å
	'~':  '\u00fc', // ü
}

// CharsetSpanish is the Spanish character set (ESC (Z).
var CharsetSpanish = Charset{
	'#':  '\u00a3', // £
	'@':  '\u00a7', // §
	'[':  '\u00a1', // ¡
	'\\': '\u00d1', // Ñ
	']':  '\u00bf', // ¿
	'{':  '\u00b0', // °
	'|':  '\u00f1', // ñ
	'}':  '\u00e7', // ç
}

// CharsetSwedish is the Swedish character set (ESC (H or ESC (7).
var CharsetSwedish = Charset{
	'@':  '\u00c9', // É
	'[':  '\u00c4', // Ä
	'\\': '\u00d6', // Ö
	']':  '\u00c5', // Å
	'^':  '\u00dc', // Ü
	'`':  '\u00e9', // é
	'{':  '\u00e4', // ä
	'|':  '\u00f6', // ö
	'}':  '\u00e5', // å
	'~':  '\u00fc', // ü
}

// CharsetSwiss is the Swiss character set (ESC (=).
var CharsetSwiss = Charset{
	'#':  '\u00f9', // ù
	'@':  '\u00e0', // à
	'[':  '\u00e9', // é
	'\\': '\u00e7', // ç
	']':  '\u00ea', // ê
	'^':  '\u00ee', // î
	'_':  '\u00e8', // è
	'`':  '\u00f4', // ô
	'{':  '\u00e4', // ä
	'|':  '\u00f6', // ö
	'}':  '\u00fc', // ü
	'~':  '\u00fb', // û
}

func init() {
	CHARSETS['0'] = CharsetDECSpecialGraphics
	CHARSETS['A'] = CharsetBritish
	CHARSETS['4'] = CharsetDutch
	CHARSETS['C'] = CharsetFinnish
	CHARSETS['5'] = CharsetFinnish
	CHARSETS['R'] = CharsetFrench
	CHARSETS['Q'] = CharsetFrenchCanadian
	CHARSETS['K'] = CharsetGerman
	CHARSETS['Y'] = CharsetItalian
	CHARSETS['E'] = CharsetNorwegianDanish
	CHARSETS['6'] = CharsetNorwegianDanish
	CHARSETS['Z'] = CharsetSpanish
	CHARSETS['H'] = CharsetSwedish
	CHARSETS['7'] = CharsetSwedish
	CHARSETS['='] = CharsetSwiss
}

// CharsetService manages the active charset state (G0-G3, GL level).
type CharsetService struct {
	Charset  Charset
	GLevel   int
	charsets []Charset
}

// NewCharsetService creates a CharsetService in the default state.
func NewCharsetService() *CharsetService {
	return &CharsetService{
		charsets: make([]Charset, 4),
	}
}

// Charsets returns the G0-G3 charset slots.
func (cs *CharsetService) Charsets() []Charset {
	return cs.charsets
}

// SetgLevel sets the active GL level and updates the active charset.
func (cs *CharsetService) SetgLevel(g int) {
	cs.GLevel = g
	if g >= 0 && g < len(cs.charsets) {
		cs.Charset = cs.charsets[g]
	}
}

// SetgCharset assigns a charset to a G-set slot. If the slot is the active GL level,
// the active charset is updated.
func (cs *CharsetService) SetgCharset(g int, charset Charset) {
	for len(cs.charsets) <= g {
		cs.charsets = append(cs.charsets, nil)
	}
	cs.charsets[g] = charset
	if cs.GLevel == g {
		cs.Charset = charset
	}
}

// Reset clears all charset state to defaults.
func (cs *CharsetService) Reset() {
	cs.Charset = nil
	cs.charsets = make([]Charset, 4)
	cs.GLevel = 0
}
