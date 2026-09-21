package xterm

// Ported from xterm.js src/common/parser/EscapeSequenceParser.ts.
// TransitionTable and VT500 transition table initialization.

const (
	nonASCIIPrintable = 0xA0

	tableIndexStateShift       = 8
	tableTransitionActionShift = 8
	tableTransitionStateMask   = 0xFF
)

// TransitionTable maps (state, charCode) pairs to (action, nextState) transitions.
// Index: state << 8 | charCode. Value: action << 8 | nextState.
type TransitionTable struct {
	table []uint16
}

// NewTransitionTable creates a transition table with the given length.
func NewTransitionTable(length int) *TransitionTable {
	return &TransitionTable{table: make([]uint16, length)}
}

// SetDefault sets the default transition for all entries.
func (t *TransitionTable) SetDefault(action ParserAction, next ParserState) {
	val := uint16(action)<<tableTransitionActionShift | uint16(next)
	for i := range t.table {
		t.table[i] = val
	}
}

// Add sets the transition for a specific (code, state) pair.
func (t *TransitionTable) Add(code int, state ParserState, action ParserAction, next ParserState) {
	t.table[int(state)<<tableIndexStateShift|code] = uint16(action)<<tableTransitionActionShift | uint16(next)
}

// AddMany sets the transition for multiple codes in a given state.
func (t *TransitionTable) AddMany(codes []int, state ParserState, action ParserAction, next ParserState) {
	for _, code := range codes {
		t.Add(code, state, action, next)
	}
}

// r returns a slice of ints from start to end (exclusive), matching the TS r(a,b) helper.
func r(start, end int) []int {
	s := make([]int, 0, end-start)
	for i := start; i < end; i++ {
		s = append(s, i)
	}
	return s
}

// PRINTABLES is 0x20..0x7e (inclusive)
var printables = r(0x20, 0x7f)

// EXECUTABLES is 0x00..0x17, 0x19, 0x1c..0x1f
var executables = func() []int {
	e := r(0x00, 0x18)
	e = append(e, 0x19)
	e = append(e, r(0x1c, 0x20)...)
	return e
}()

// VT500TransitionTable is the package-level VT500 parser transition table.
var VT500TransitionTable = buildVT500TransitionTable()

func buildVT500TransitionTable() *TransitionTable {
	table := NewTransitionTable(int(ParserStateLength) << tableIndexStateShift)

	// Default: error action, GROUND state
	table.SetDefault(ParserActionError, ParserStateGround)

	// --- Anywhere transitions (applied to all states) ---
	for state := ParserState(0); state < ParserStateLength; state++ {
		// C0 executables that abort any sequence
		table.Add(0x18, state, ParserActionExecute, ParserStateGround)
		table.Add(0x1a, state, ParserActionExecute, ParserStateGround)
		table.Add(0x1b, state, ParserActionClear, ParserStateEscape)
		// C1 controls
		table.Add(0x9c, state, ParserActionIgnore, ParserStateGround)                       // ST as terminator
		table.Add(0x9d, state, ParserActionOSCStart, ParserStateOSCString)                  // OSC
		table.AddMany([]int{0x98, 0x9e}, state, ParserActionIgnore, ParserStateSOSPMString) // SOS, PM
		table.Add(0x9f, state, ParserActionClear, ParserStateAPCEntry)                       // APC
		table.Add(0x9b, state, ParserActionClear, ParserStateCSIEntry)                      // CSI
		table.Add(0x90, state, ParserActionClear, ParserStateDCSEntry)                      // DCS
	}

	// --- Rules for executables and 0x7f ---
	table.AddMany(executables, ParserStateGround, ParserActionExecute, ParserStateGround)
	table.AddMany(executables, ParserStateEscape, ParserActionExecute, ParserStateEscape)
	table.Add(0x7f, ParserStateEscape, ParserActionIgnore, ParserStateEscape)
	table.AddMany(executables, ParserStateOSCString, ParserActionIgnore, ParserStateOSCString)
	table.AddMany(executables, ParserStateCSIEntry, ParserActionExecute, ParserStateCSIEntry)
	table.Add(0x7f, ParserStateCSIEntry, ParserActionIgnore, ParserStateCSIEntry)
	table.AddMany(executables, ParserStateCSIParam, ParserActionExecute, ParserStateCSIParam)
	table.Add(0x7f, ParserStateCSIParam, ParserActionIgnore, ParserStateCSIParam)
	table.AddMany(executables, ParserStateCSIIgnore, ParserActionExecute, ParserStateCSIIgnore)
	table.AddMany(executables, ParserStateCSIIntermediate, ParserActionExecute, ParserStateCSIIntermediate)
	table.Add(0x7f, ParserStateCSIIntermediate, ParserActionIgnore, ParserStateCSIIntermediate)
	table.AddMany(executables, ParserStateEscapeIntermediate, ParserActionExecute, ParserStateEscapeIntermediate)
	table.Add(0x7f, ParserStateEscapeIntermediate, ParserActionIgnore, ParserStateEscapeIntermediate)

	// --- GROUND ---
	table.AddMany(printables, ParserStateGround, ParserActionPrint, ParserStateGround)
	table.Add(0x7f, ParserStateGround, ParserActionIgnore, ParserStateGround)

	// --- OSC ---
	table.Add(0x5d, ParserStateEscape, ParserActionOSCStart, ParserStateOSCString)
	table.AddMany(printables, ParserStateOSCString, ParserActionOSCPut, ParserStateOSCString)
	table.Add(0x7f, ParserStateOSCString, ParserActionOSCPut, ParserStateOSCString)
	table.AddMany([]int{0x9c, 0x1b, 0x18, 0x1a, 0x07}, ParserStateOSCString, ParserActionOSCEnd, ParserStateGround)
	table.AddMany(r(0x1c, 0x20), ParserStateOSCString, ParserActionIgnore, ParserStateOSCString)

	// --- SOS/PM ---
	table.AddMany([]int{0x58, 0x5e}, ParserStateEscape, ParserActionIgnore, ParserStateSOSPMString)
	table.AddMany(printables, ParserStateSOSPMString, ParserActionIgnore, ParserStateSOSPMString)
	table.AddMany(executables, ParserStateSOSPMString, ParserActionIgnore, ParserStateSOSPMString)
	table.Add(0x9c, ParserStateSOSPMString, ParserActionIgnore, ParserStateGround)
	table.Add(0x7f, ParserStateSOSPMString, ParserActionIgnore, ParserStateSOSPMString)

	// --- APC ---
	table.Add(0x5f, ParserStateEscape, ParserActionClear, ParserStateAPCEntry)
	table.AddMany(executables, ParserStateAPCEntry, ParserActionIgnore, ParserStateAPCEntry)
	table.Add(0x7f, ParserStateAPCEntry, ParserActionIgnore, ParserStateAPCEntry)
	table.AddMany(r(0x20, 0x30), ParserStateAPCEntry, ParserActionCollect, ParserStateAPCIntermediate)
	table.AddMany(r(0x30, 0x7f), ParserStateAPCEntry, ParserActionAPCStart, ParserStateAPCPassthrough)
	table.AddMany(r(0x30, 0x7f), ParserStateAPCIntermediate, ParserActionAPCStart, ParserStateAPCPassthrough)
	table.AddMany(executables, ParserStateAPCIntermediate, ParserActionIgnore, ParserStateAPCIntermediate)
	table.AddMany(r(0x20, 0x30), ParserStateAPCIntermediate, ParserActionCollect, ParserStateAPCIntermediate)
	table.Add(0x7f, ParserStateAPCIntermediate, ParserActionIgnore, ParserStateAPCIntermediate)
	table.AddMany(printables, ParserStateAPCPassthrough, ParserActionAPCPut, ParserStateAPCPassthrough)
	table.AddMany(executables, ParserStateAPCPassthrough, ParserActionIgnore, ParserStateAPCPassthrough)
	table.AddMany(r(0x08, 0x0e), ParserStateAPCPassthrough, ParserActionAPCPut, ParserStateAPCPassthrough)
	table.Add(0x7f, ParserStateAPCPassthrough, ParserActionIgnore, ParserStateAPCPassthrough)
	table.AddMany([]int{0x1b, 0x9c, 0x18, 0x1a}, ParserStateAPCPassthrough, ParserActionAPCEnd, ParserStateGround)

	// --- CSI entries ---
	table.Add(0x5b, ParserStateEscape, ParserActionClear, ParserStateCSIEntry)
	table.AddMany(r(0x40, 0x7f), ParserStateCSIEntry, ParserActionCSIDispatch, ParserStateGround)
	table.AddMany(r(0x30, 0x3c), ParserStateCSIEntry, ParserActionParam, ParserStateCSIParam)
	table.AddMany([]int{0x3c, 0x3d, 0x3e, 0x3f}, ParserStateCSIEntry, ParserActionCollect, ParserStateCSIParam)
	table.AddMany(r(0x30, 0x3c), ParserStateCSIParam, ParserActionParam, ParserStateCSIParam)
	table.AddMany(r(0x40, 0x7f), ParserStateCSIParam, ParserActionCSIDispatch, ParserStateGround)
	table.AddMany([]int{0x3c, 0x3d, 0x3e, 0x3f}, ParserStateCSIParam, ParserActionIgnore, ParserStateCSIIgnore)
	table.AddMany(r(0x20, 0x40), ParserStateCSIIgnore, ParserActionIgnore, ParserStateCSIIgnore)
	table.Add(0x7f, ParserStateCSIIgnore, ParserActionIgnore, ParserStateCSIIgnore)
	table.AddMany(r(0x40, 0x7f), ParserStateCSIIgnore, ParserActionIgnore, ParserStateGround)
	table.AddMany(r(0x20, 0x30), ParserStateCSIEntry, ParserActionCollect, ParserStateCSIIntermediate)
	table.AddMany(r(0x20, 0x30), ParserStateCSIIntermediate, ParserActionCollect, ParserStateCSIIntermediate)
	table.AddMany(r(0x30, 0x40), ParserStateCSIIntermediate, ParserActionIgnore, ParserStateCSIIgnore)
	table.AddMany(r(0x40, 0x7f), ParserStateCSIIntermediate, ParserActionCSIDispatch, ParserStateGround)
	table.AddMany(r(0x20, 0x30), ParserStateCSIParam, ParserActionCollect, ParserStateCSIIntermediate)

	// --- ESC intermediate ---
	table.AddMany(r(0x20, 0x30), ParserStateEscape, ParserActionCollect, ParserStateEscapeIntermediate)
	table.AddMany(r(0x20, 0x30), ParserStateEscapeIntermediate, ParserActionCollect, ParserStateEscapeIntermediate)
	table.AddMany(r(0x30, 0x7f), ParserStateEscapeIntermediate, ParserActionESCDispatch, ParserStateGround)
	table.AddMany(r(0x30, 0x50), ParserStateEscape, ParserActionESCDispatch, ParserStateGround)
	table.AddMany(r(0x51, 0x58), ParserStateEscape, ParserActionESCDispatch, ParserStateGround)
	table.AddMany([]int{0x59, 0x5a, 0x5c}, ParserStateEscape, ParserActionESCDispatch, ParserStateGround)
	table.AddMany(r(0x60, 0x7f), ParserStateEscape, ParserActionESCDispatch, ParserStateGround)

	// --- DCS entry ---
	table.Add(0x50, ParserStateEscape, ParserActionClear, ParserStateDCSEntry)
	table.AddMany(executables, ParserStateDCSEntry, ParserActionIgnore, ParserStateDCSEntry)
	table.Add(0x7f, ParserStateDCSEntry, ParserActionIgnore, ParserStateDCSEntry)
	table.AddMany(r(0x20, 0x30), ParserStateDCSEntry, ParserActionCollect, ParserStateDCSIntermediate)
	table.AddMany(r(0x30, 0x3c), ParserStateDCSEntry, ParserActionParam, ParserStateDCSParam)
	table.AddMany([]int{0x3c, 0x3d, 0x3e, 0x3f}, ParserStateDCSEntry, ParserActionCollect, ParserStateDCSParam)

	// --- DCS ignore ---
	table.AddMany(executables, ParserStateDCSIgnore, ParserActionIgnore, ParserStateDCSIgnore)
	table.AddMany(r(0x20, 0x80), ParserStateDCSIgnore, ParserActionIgnore, ParserStateDCSIgnore)

	// --- DCS param ---
	table.AddMany(executables, ParserStateDCSParam, ParserActionIgnore, ParserStateDCSParam)
	table.Add(0x7f, ParserStateDCSParam, ParserActionIgnore, ParserStateDCSParam)
	table.AddMany(r(0x30, 0x3c), ParserStateDCSParam, ParserActionParam, ParserStateDCSParam)
	table.AddMany([]int{0x3c, 0x3d, 0x3e, 0x3f}, ParserStateDCSParam, ParserActionIgnore, ParserStateDCSIgnore)
	table.AddMany(r(0x20, 0x30), ParserStateDCSParam, ParserActionCollect, ParserStateDCSIntermediate)

	// --- DCS intermediate ---
	table.AddMany(executables, ParserStateDCSIntermediate, ParserActionIgnore, ParserStateDCSIntermediate)
	table.Add(0x7f, ParserStateDCSIntermediate, ParserActionIgnore, ParserStateDCSIntermediate)
	table.AddMany(r(0x20, 0x30), ParserStateDCSIntermediate, ParserActionCollect, ParserStateDCSIntermediate)
	table.AddMany(r(0x30, 0x40), ParserStateDCSIntermediate, ParserActionIgnore, ParserStateDCSIgnore)
	table.AddMany(r(0x40, 0x7f), ParserStateDCSIntermediate, ParserActionDCSHook, ParserStateDCSPassthrough)
	table.AddMany(r(0x40, 0x7f), ParserStateDCSParam, ParserActionDCSHook, ParserStateDCSPassthrough)
	table.AddMany(r(0x40, 0x7f), ParserStateDCSEntry, ParserActionDCSHook, ParserStateDCSPassthrough)

	// --- DCS passthrough ---
	table.AddMany(printables, ParserStateDCSPassthrough, ParserActionDCSPut, ParserStateDCSPassthrough)
	table.AddMany(executables, ParserStateDCSPassthrough, ParserActionDCSPut, ParserStateDCSPassthrough)
	table.Add(0x7f, ParserStateDCSPassthrough, ParserActionIgnore, ParserStateDCSPassthrough)
	table.AddMany([]int{0x1b, 0x9c, 0x18, 0x1a}, ParserStateDCSPassthrough, ParserActionDCSUnhook, ParserStateGround)

	// --- Non-ASCII printable slot ---
	table.Add(nonASCIIPrintable, ParserStateGround, ParserActionPrint, ParserStateGround)
	table.Add(nonASCIIPrintable, ParserStateOSCString, ParserActionOSCPut, ParserStateOSCString)
	table.Add(nonASCIIPrintable, ParserStateCSIIgnore, ParserActionIgnore, ParserStateCSIIgnore)
	table.Add(nonASCIIPrintable, ParserStateDCSIgnore, ParserActionIgnore, ParserStateDCSIgnore)
	table.Add(nonASCIIPrintable, ParserStateDCSPassthrough, ParserActionDCSPut, ParserStateDCSPassthrough)
	table.Add(nonASCIIPrintable, ParserStateAPCPassthrough, ParserActionAPCPut, ParserStateAPCPassthrough)

	return table
}
