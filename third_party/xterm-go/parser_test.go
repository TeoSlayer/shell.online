package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

// --- TransitionTable tests ---

func TestTransitionTableSetDefault(t *testing.T) {
	t.Parallel()
	tt := NewTransitionTable(256)
	tt.SetDefault(ParserActionPrint, ParserStateGround)
	want := uint16(ParserActionPrint)<<8 | uint16(ParserStateGround)
	for i, v := range tt.table {
		if v != want {
			t.Fatalf("table[%d] = %d, want %d", i, v, want)
		}
	}
}

func TestTransitionTableAdd(t *testing.T) {
	t.Parallel()
	tt := NewTransitionTable(4096)
	tt.SetDefault(ParserActionIgnore, ParserStateGround)
	tt.Add(0x41, ParserStateGround, ParserActionPrint, ParserStateEscape)

	idx := int(ParserStateGround)<<8 | 0x41
	got := tt.table[idx]
	want := uint16(ParserActionPrint)<<8 | uint16(ParserStateEscape)
	if got != want {
		t.Errorf("got %d, want %d", got, want)
	}
}

func TestTransitionTableAddMany(t *testing.T) {
	t.Parallel()
	tt := NewTransitionTable(4096)
	tt.SetDefault(ParserActionIgnore, ParserStateGround)
	codes := []int{0x30, 0x31, 0x32}
	tt.AddMany(codes, ParserStateCSIEntry, ParserActionParam, ParserStateCSIParam)

	want := uint16(ParserActionParam)<<8 | uint16(ParserStateCSIParam)
	for _, c := range codes {
		idx := int(ParserStateCSIEntry)<<8 | c
		if tt.table[idx] != want {
			t.Errorf("table[%d] = %d, want %d", idx, tt.table[idx], want)
		}
	}
}

// --- VT500TransitionTable spot checks ---

func TestVT500Transitions(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Action ParserAction
		Next   ParserState
	}
	type TestCase struct {
		Name  string
		State ParserState
		Code  int
		Want  Expectation
	}
	tests := []TestCase{
		{"ESC enters ESCAPE", ParserStateGround, 0x1b, Expectation{ParserActionClear, ParserStateEscape}},
		{"'[' in ESCAPE enters CSI_ENTRY", ParserStateEscape, 0x5b, Expectation{ParserActionClear, ParserStateCSIEntry}},
		{"']' in ESCAPE enters OSC_STRING", ParserStateEscape, 0x5d, Expectation{ParserActionOSCStart, ParserStateOSCString}},
		{"'P' in ESCAPE enters DCS_ENTRY", ParserStateEscape, 0x50, Expectation{ParserActionClear, ParserStateDCSEntry}},
		{"'_' in ESCAPE enters APC_ENTRY", ParserStateEscape, 0x5f, Expectation{ParserActionClear, ParserStateAPCEntry}},
		{"printable in GROUND prints", ParserStateGround, 0x41, Expectation{ParserActionPrint, ParserStateGround}},
		{"LF in GROUND executes", ParserStateGround, 0x0a, Expectation{ParserActionExecute, ParserStateGround}},
		{"digit in CSI_ENTRY -> CSI_PARAM", ParserStateCSIEntry, 0x30, Expectation{ParserActionParam, ParserStateCSIParam}},
		{"'H' in CSI_PARAM dispatches", ParserStateCSIParam, 0x48, Expectation{ParserActionCSIDispatch, ParserStateGround}},
		{"0x9c in OSC_STRING ends OSC", ParserStateOSCString, 0x9c, Expectation{ParserActionOSCEnd, ParserStateGround}},
		{"0x9c in DCS_PASSTHROUGH unhooks", ParserStateDCSPassthrough, 0x9c, Expectation{ParserActionDCSUnhook, ParserStateGround}},
		{"non-ASCII printable in GROUND prints", ParserStateGround, 0xa0, Expectation{ParserActionPrint, ParserStateGround}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			idx := int(tc.State)<<8 | tc.Code
			val := VT500TransitionTable.table[idx]
			got := Expectation{
				Action: ParserAction(val >> 8),
				Next:   ParserState(val & 0xFF),
			}
			if diff := cmp.Diff(tc.Want, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

// --- Parse: simple text printing ---

func TestParsePrintableText(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Printed string
	}
	var printed string
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {
		printed += utf32ToString(data, start, end)
	})
	data := toUint32("Hello, World!")
	p.Parse(data, len(data))
	got := Expectation{Printed: printed}
	want := Expectation{Printed: "Hello, World!"}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- Parse: C0 controls ---

func TestParseC0Controls(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Codes []uint32
	}
	var codes []uint32
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	for i := byte(0); i < 128; i++ {
		code := i
		p.RegisterExecuteHandler(code, func() {
			codes = append(codes, uint32(code))
		})
	}
	// BEL, BS, LF, CR
	data := []uint32{0x07, 0x08, 0x0a, 0x0d}
	p.Parse(data, len(data))
	got := Expectation{Codes: codes}
	want := Expectation{Codes: []uint32{0x07, 0x08, 0x0a, 0x0d}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- Parse: CSI sequences ---

func TestParseCSISequence(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Called bool
		Params []int32
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	// Register handler for CSI H (cursor position)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'H'}, func(params *Params) bool {
		got.Called = true
		got.Params = make([]int32, params.Length)
		copy(got.Params, params.Params[:params.Length])
		return true
	})
	// \x1b[1;2H
	data := toUint32("\x1b[1;2H")
	p.Parse(data, len(data))
	want := Expectation{Called: true, Params: []int32{1, 2}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestParseCSIWithPrefix(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Called bool
		Ident  string
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	// CSI ? 25 h (DECTCEM - show cursor)
	p.RegisterCsiHandler(FunctionIdentifier{Prefix: '?', Final: 'h'}, func(params *Params) bool {
		got.Called = true
		got.Ident = "?h"
		return true
	})
	data := toUint32("\x1b[?25h")
	p.Parse(data, len(data))
	want := Expectation{Called: true, Ident: "?h"}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestParserRejectsInvalidFunctionIdentifierPrefixes(t *testing.T) {
	t.Parallel()
	type TestCase struct {
		Name string
		Run  func(*EscapeSequenceParser)
	}
	tests := []TestCase{
		{
			Name: "RegisterCsiHandler",
			Run: func(p *EscapeSequenceParser) {
				p.RegisterCsiHandler(FunctionIdentifier{Prefix: '!', Final: 'm'}, func(*Params) bool {
					return true
				})
			},
		},
		{
			Name: "ClearCsiHandler",
			Run: func(p *EscapeSequenceParser) {
				p.ClearCsiHandler(FunctionIdentifier{Prefix: '!', Final: 'm'})
			},
		},
		{
			Name: "RegisterEscHandler",
			Run: func(p *EscapeSequenceParser) {
				p.RegisterEscHandler(FunctionIdentifier{Prefix: '!', Final: '7'}, func() bool {
					return true
				})
			},
		},
		{
			Name: "ClearEscHandler",
			Run: func(p *EscapeSequenceParser) {
				p.ClearEscHandler(FunctionIdentifier{Prefix: '!', Final: '7'})
			},
		},
		{
			Name: "RegisterDcsHandler",
			Run: func(p *EscapeSequenceParser) {
				p.RegisterDcsHandler(FunctionIdentifier{Prefix: '!', Final: 'q'}, NewDcsStringHandler(func(string, *Params) bool {
					return true
				}))
			},
		},
		{
			Name: "ClearDcsHandler",
			Run: func(p *EscapeSequenceParser) {
				p.ClearDcsHandler(FunctionIdentifier{Prefix: '!', Final: 'q'})
			},
		},
		{
			Name: "RegisterApcHandler",
			Run: func(p *EscapeSequenceParser) {
				p.RegisterApcHandler(FunctionIdentifier{Prefix: '!', Final: 'G'}, NewApcStringHandler(func(string) bool {
					return true
				}))
			},
		},
		{
			Name: "ClearApcHandler",
			Run: func(p *EscapeSequenceParser) {
				p.ClearApcHandler(FunctionIdentifier{Prefix: '!', Final: 'G'})
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			defer func() {
				if recover() == nil {
					t.Fatalf("%s should panic for invalid prefix", tc.Name)
				}
			}()
			tc.Run(NewEscapeSequenceParser())
		})
	}
}

func TestParserAllowsValidFunctionIdentifierPrefixes(t *testing.T) {
	t.Parallel()
	p := NewEscapeSequenceParser()
	for _, prefix := range []byte{'<', '=', '>', '?'} {
		p.RegisterCsiHandler(FunctionIdentifier{Prefix: prefix, Final: 'm'}, func(*Params) bool {
			return true
		}).Dispose()
	}
}

// --- Parse: ESC sequences ---

func TestParseESCSequence(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Called bool
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	// ESC D (Index)
	p.RegisterEscHandler(FunctionIdentifier{Final: 'D'}, func() bool {
		got.Called = true
		return true
	})
	data := toUint32("\x1bD")
	p.Parse(data, len(data))
	want := Expectation{Called: true}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- Parse: OSC sequences ---

func TestParseOSCSequence(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Data string
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	// OSC 0 ; title BEL
	p.RegisterOscHandler(0, NewOscStringHandler(func(data string) bool {
		got.Data = data
		return true
	}))
	data := toUint32("\x1b]0;my title\x07")
	p.Parse(data, len(data))
	want := Expectation{Data: "my title"}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- Handler stacking ---

func TestCSIHandlerStacking(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Order []int
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	id := FunctionIdentifier{Final: 'm'}

	// First handler (registered first, called last in chain)
	p.RegisterCsiHandler(id, func(params *Params) bool {
		got.Order = append(got.Order, 1)
		return true
	})
	// Second handler (registered last, called first)
	p.RegisterCsiHandler(id, func(params *Params) bool {
		got.Order = append(got.Order, 2)
		return false // don't consume, let it bubble
	})

	data := toUint32("\x1b[0m")
	p.Parse(data, len(data))
	want := Expectation{Order: []int{2, 1}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCSIHandlerStackingStopBubble(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Order []int
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	id := FunctionIdentifier{Final: 'm'}

	p.RegisterCsiHandler(id, func(params *Params) bool {
		got.Order = append(got.Order, 1)
		return true
	})
	p.RegisterCsiHandler(id, func(params *Params) bool {
		got.Order = append(got.Order, 2)
		return true // consume, stop bubbling
	})

	data := toUint32("\x1b[0m")
	p.Parse(data, len(data))
	// Only handler 2 should be called (it returns true)
	want := Expectation{Order: []int{2}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- CSI fallback ---

func TestCSIFallback(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Ident int
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.SetCsiHandlerFallback(func(ident int, params *Params) {
		got.Ident = ident
	})
	data := toUint32("\x1b[0m")
	p.Parse(data, len(data))
	want := Expectation{Ident: int('m')}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- IdentToString ---

func TestIdentToString(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Result string
	}
	type TestCase struct {
		Name  string
		Ident int
		Want  Expectation
	}
	tests := []TestCase{
		{"single char", int('H'), Expectation{"H"}},
		{"prefix + final", int('?')<<8 | int('h'), Expectation{"?h"}},
		{"intermediate + final", int(' ')<<8 | int('q'), Expectation{" q"}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			got := Expectation{Result: IdentToString(tc.Ident)}
			if diff := cmp.Diff(tc.Want, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

// --- Reset ---

func TestParserReset(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		State   ParserState
		Collect int
	}
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	// Parse partial ESC sequence to change state
	data := toUint32("\x1b[")
	p.Parse(data, len(data))
	// State should be CSI_ENTRY now
	if p.CurrentState() == ParserStateGround {
		t.Fatal("expected non-GROUND state after partial CSI")
	}
	p.Reset()
	got := Expectation{State: p.CurrentState(), Collect: p.collect}
	want := Expectation{State: ParserStateGround, Collect: 0}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- Disposable removes handler ---

func TestDisposableRemovesHandler(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		CallCount int
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	id := FunctionIdentifier{Final: 'H'}
	d := p.RegisterCsiHandler(id, func(params *Params) bool {
		got.CallCount++
		return true
	})
	data := toUint32("\x1b[H")
	p.Parse(data, len(data))
	d.Dispose()
	p.Parse(data, len(data))
	want := Expectation{CallCount: 1}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- Execute fallback ---

func TestExecuteFallback(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Code uint32
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.SetExecuteHandlerFallback(func(code uint32) {
		got.Code = code
	})
	data := []uint32{0x07} // BEL
	p.Parse(data, len(data))
	want := Expectation{Code: 0x07}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- Mixed content ---

func TestParseMixedContent(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Printed  string
		Executed []uint32
		CSICalls int
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {
		got.Printed += utf32ToString(data, start, end)
	})
	p.RegisterExecuteHandler(0x0a, func() {
		got.Executed = append(got.Executed, 0x0a)
	})
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'H'}, func(params *Params) bool {
		got.CSICalls++
		return true
	})
	// "AB\nCD\x1b[1;1HEF"
	data := toUint32("AB\nCD\x1b[1;1HEF")
	p.Parse(data, len(data))
	want := Expectation{
		Printed:  "ABCDEF",
		Executed: []uint32{0x0a},
		CSICalls: 1,
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- Non-ASCII printable ---

func TestParseNonASCIIPrintable(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Printed bool
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {
		got.Printed = true
	})
	data := []uint32{0x100, 0x200, 0x1F600} // various non-ASCII
	p.Parse(data, len(data))
	want := Expectation{Printed: true}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- ESC handler with intermediates ---

func TestParseESCWithIntermediate(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Called bool
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	// ESC # 8 (DECALN)
	p.RegisterEscHandler(FunctionIdentifier{Intermediates: "#", Final: '8'}, func() bool {
		got.Called = true
		return true
	})
	data := toUint32("\x1b#8")
	p.Parse(data, len(data))
	want := Expectation{Called: true}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- Error handler ---

func TestErrorHandler(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		ErrorCount int
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.SetErrorHandler(func(state ParsingState) ParsingState {
		got.ErrorCount++
		return state
	})
	// 0x7f in GROUND is IGNORE, not ERROR. Use a code that triggers error.
	// In CSI_IGNORE state, most things are ignored, not errors.
	// Actually, the default table sets ERROR for unhandled transitions.
	// Let's trigger one: 0x80 in ESCAPE state (not mapped to anything specific)
	// First enter ESCAPE, then send 0x80 which maps to nonASCIIPrintable slot
	// In ESCAPE state, 0xA0 slot should be ERROR (default)
	data := []uint32{0x1b, 0x80}
	p.Parse(data, len(data))
	want := Expectation{ErrorCount: 1}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- CSI with sub-parameters ---

func TestParseCSISubParams(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		MainParams []int32
		HasSub     bool
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	// CSI 4:3m (curly underline)
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'm'}, func(params *Params) bool {
		got.MainParams = make([]int32, params.Length)
		copy(got.MainParams, params.Params[:params.Length])
		got.HasSub = params.HasSubParams(0)
		return true
	})
	data := toUint32("\x1b[4:3m")
	p.Parse(data, len(data))
	want := Expectation{MainParams: []int32{4}, HasSub: true}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- DCS sequence ---

func TestParseDCSSequence(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Hooked   bool
		Data     string
		Unhooked bool
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	// DCS q (Sixel) - ESC P q <data> ESC \
	p.RegisterDcsHandler(FunctionIdentifier{Final: 'q'}, NewDcsStringHandler(func(data string, params *Params) bool {
		got.Data = data
		got.Unhooked = true
		return true
	}))
	// \x1bPq#0;2;0;0;0\x1b\\
	data := toUint32("\x1bPqhello\x1b\\")
	p.Parse(data, len(data))
	want := Expectation{Data: "hello", Unhooked: true}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- EXE fast-path tests ---

func TestEXEFastPathDispatchesRegisteredHandler(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Codes []uint32
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	for _, c := range []byte{0x00, 0x07, 0x08, 0x0a, 0x0d, 0x0e, 0x0f} {
		code := c
		p.RegisterExecuteHandler(code, func() {
			got.Codes = append(got.Codes, uint32(code))
		})
	}
	data := []uint32{0x00, 0x07, 0x08, 0x0a, 0x0d, 0x0e, 0x0f}
	p.Parse(data, len(data))
	want := Expectation{Codes: []uint32{0x00, 0x07, 0x08, 0x0a, 0x0d, 0x0e, 0x0f}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestEXEFastPathFallback(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		FallbackCodes []uint32
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.SetExecuteHandlerFallback(func(code uint32) {
		got.FallbackCodes = append(got.FallbackCodes, code)
	})
	data := []uint32{0x05, 0x06}
	p.Parse(data, len(data))
	want := Expectation{FallbackCodes: []uint32{0x05, 0x06}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestEXEFastPathResetsJoinState(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		JoinState int
	}
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.RegisterExecuteHandler(0x0a, func() {})
	p.SetPrecedingJoinState(42)
	data := []uint32{0x0a}
	p.Parse(data, len(data))
	got := Expectation{JoinState: p.PrecedingJoinState()}
	want := Expectation{JoinState: 0}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestEXEFastPathInCSIStates(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Executed bool
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.RegisterExecuteHandler(0x0a, func() {
		got.Executed = true
	})
	// ESC [ puts us in CSI_ENTRY; then 0x0a should be dispatched via fast-path
	data := toUint32("\x1b[")
	p.Parse(data, len(data))
	data = []uint32{0x0a}
	p.Parse(data, len(data))
	want := Expectation{Executed: true}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestEXEFastPathSkippedInPayloadStates(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		ExecuteCount int
		OscData      string
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.RegisterExecuteHandler(0x0a, func() {
		got.ExecuteCount++
	})
	p.RegisterOscHandler(0, NewOscStringHandler(func(data string) bool {
		got.OscData = data
		return true
	}))
	data := toUint32("\x1b]0;title\x07")
	p.Parse(data, len(data))
	want := Expectation{ExecuteCount: 0, OscData: "title"}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestEXEFastPathMixedWithPrint(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Printed  string
		Executed []uint32
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {
		got.Printed += utf32ToString(data, start, end)
	})
	p.RegisterExecuteHandler(0x0a, func() {
		got.Executed = append(got.Executed, 0x0a)
	})
	p.RegisterExecuteHandler(0x0d, func() {
		got.Executed = append(got.Executed, 0x0d)
	})
	data := toUint32("AB\nCD\rEF")
	p.Parse(data, len(data))
	want := Expectation{
		Printed:  "ABCDEF",
		Executed: []uint32{0x0a, 0x0d},
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

// --- CSI fast-path tests ---

func TestCSIFastPathSimple(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Called bool
		Params []int32
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'H'}, func(params *Params) bool {
		got.Called = true
		got.Params = make([]int32, params.Length)
		copy(got.Params, params.Params[:params.Length])
		return true
	})
	data := toUint32("\x1b[10;20H")
	p.Parse(data, len(data))
	want := Expectation{Called: true, Params: []int32{10, 20}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCSIFastPathNoParams(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Called bool
		Params []int32
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'H'}, func(params *Params) bool {
		got.Called = true
		got.Params = make([]int32, params.Length)
		copy(got.Params, params.Params[:params.Length])
		return true
	})
	data := toUint32("\x1b[H")
	p.Parse(data, len(data))
	want := Expectation{Called: true, Params: []int32{0}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCSIFastPathWithPrefix(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Called bool
		Params []int32
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.RegisterCsiHandler(FunctionIdentifier{Prefix: '?', Final: 'h'}, func(params *Params) bool {
		got.Called = true
		got.Params = make([]int32, params.Length)
		copy(got.Params, params.Params[:params.Length])
		return true
	})
	data := toUint32("\x1b[?25h")
	p.Parse(data, len(data))
	want := Expectation{Called: true, Params: []int32{25}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCSIFastPathWithSubParams(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		MainParams []int32
		HasSub     bool
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'm'}, func(params *Params) bool {
		got.MainParams = make([]int32, params.Length)
		copy(got.MainParams, params.Params[:params.Length])
		got.HasSub = params.HasSubParams(0)
		return true
	})
	data := toUint32("\x1b[4:3m")
	p.Parse(data, len(data))
	want := Expectation{MainParams: []int32{4}, HasSub: true}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCSIFastPathFallbackHandler(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Ident int
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.SetCsiHandlerFallback(func(ident int, params *Params) {
		got.Ident = ident
	})
	data := toUint32("\x1b[0m")
	p.Parse(data, len(data))
	want := Expectation{Ident: int('m')}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCSIFastPathResetsJoinState(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		JoinState int
	}
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'H'}, func(params *Params) bool {
		return true
	})
	p.SetPrecedingJoinState(42)
	data := toUint32("\x1b[H")
	p.Parse(data, len(data))
	got := Expectation{JoinState: p.PrecedingJoinState()}
	want := Expectation{JoinState: 0}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCSIFastPathReturnsToGround(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		State ParserState
	}
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'H'}, func(params *Params) bool {
		return true
	})
	data := toUint32("\x1b[1;1H")
	p.Parse(data, len(data))
	got := Expectation{State: p.CurrentState()}
	want := Expectation{State: ParserStateGround}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCSIFastPathWithIntermediate(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Called bool
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	// CSI 2 SP q (DECSCUSR) — has intermediate, falls back to table-driven path
	p.RegisterCsiHandler(FunctionIdentifier{Intermediates: " ", Final: 'q'}, func(params *Params) bool {
		got.Called = true
		return true
	})
	data := toUint32("\x1b[2 q")
	p.Parse(data, len(data))
	want := Expectation{Called: true}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCSIFastPathFollowedByText(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		CSICalls int
		Printed  string
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {
		got.Printed += utf32ToString(data, start, end)
	})
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'H'}, func(params *Params) bool {
		got.CSICalls++
		return true
	})
	data := toUint32("\x1b[1;1Hhello")
	p.Parse(data, len(data))
	want := Expectation{CSICalls: 1, Printed: "hello"}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCSIFastPathMultipleSequences(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Calls  int
		Params [][]int32
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'H'}, func(params *Params) bool {
		got.Calls++
		ps := make([]int32, params.Length)
		copy(ps, params.Params[:params.Length])
		got.Params = append(got.Params, ps)
		return true
	})
	data := toUint32("\x1b[1;1H\x1b[5;10H\x1b[20;30H")
	p.Parse(data, len(data))
	want := Expectation{
		Calls: 3,
		Params: [][]int32{
			{1, 1},
			{5, 10},
			{20, 30},
		},
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCSIFastPathPartialSequence(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Called bool
		Params []int32
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	p.RegisterCsiHandler(FunctionIdentifier{Final: 'H'}, func(params *Params) bool {
		got.Called = true
		got.Params = make([]int32, params.Length)
		copy(got.Params, params.Params[:params.Length])
		return true
	})
	// First chunk: ESC [ 1 ; — incomplete
	data1 := toUint32("\x1b[1;")
	p.Parse(data1, len(data1))
	// Second chunk: 2 H — completes via table-driven path
	data2 := toUint32("2H")
	p.Parse(data2, len(data2))
	want := Expectation{Called: true, Params: []int32{1, 2}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestCSIFastPathHandlerStacking(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Order []int
	}
	var got Expectation
	p := NewEscapeSequenceParser()
	p.SetPrintHandler(func(data []uint32, start, end int) {})
	id := FunctionIdentifier{Final: 'm'}
	p.RegisterCsiHandler(id, func(params *Params) bool {
		got.Order = append(got.Order, 1)
		return true
	})
	p.RegisterCsiHandler(id, func(params *Params) bool {
		got.Order = append(got.Order, 2)
		return false // don't consume, let it bubble
	})
	data := toUint32("\x1b[0m")
	p.Parse(data, len(data))
	want := Expectation{Order: []int{2, 1}}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
