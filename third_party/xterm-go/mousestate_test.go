package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestMouseStateServiceDefaults(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ActiveProtocol string
		ActiveEncoding string
		EventsActive   bool
	}

	m := NewMouseStateService()
	got := Expectation{
		ActiveProtocol: m.ActiveProtocol(),
		ActiveEncoding: m.ActiveEncoding(),
		EventsActive:   m.AreMouseEventsActive(),
	}
	expected := Expectation{
		ActiveProtocol: "NONE",
		ActiveEncoding: "DEFAULT",
		EventsActive:   false,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMouseStateServiceSetActiveProtocol(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ActiveProtocol string
		EventsActive   bool
	}
	type TestCase struct {
		Name     string
		Protocol string
		Expected Expectation
	}

	tests := []TestCase{
		{"NONE", "NONE", Expectation{"NONE", false}},
		{"X10", "X10", Expectation{"X10", true}},
		{"VT200", "VT200", Expectation{"VT200", true}},
		{"DRAG", "DRAG", Expectation{"DRAG", true}},
		{"ANY", "ANY", Expectation{"ANY", true}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			m := NewMouseStateService()
			m.SetActiveProtocol(tc.Protocol)
			got := Expectation{
				ActiveProtocol: m.ActiveProtocol(),
				EventsActive:   m.AreMouseEventsActive(),
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestMouseStateServiceSetActiveEncoding(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ActiveEncoding string
	}
	type TestCase struct {
		Name     string
		Encoding string
		Expected Expectation
	}

	tests := []TestCase{
		{"DEFAULT", "DEFAULT", Expectation{"DEFAULT"}},
		{"SGR", "SGR", Expectation{"SGR"}},
		{"SGR_PIXELS", "SGR_PIXELS", Expectation{"SGR_PIXELS"}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			m := NewMouseStateService()
			m.SetActiveEncoding(tc.Encoding)
			got := Expectation{ActiveEncoding: m.ActiveEncoding()}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestMouseStateServiceUnknownProtocol(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ActiveProtocol string
	}

	m := NewMouseStateService()
	m.SetActiveProtocol("BOGUS")
	got := Expectation{ActiveProtocol: m.ActiveProtocol()}
	expected := Expectation{ActiveProtocol: "NONE"}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMouseStateServiceUnknownEncoding(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ActiveEncoding string
	}

	m := NewMouseStateService()
	m.SetActiveEncoding("BOGUS")
	got := Expectation{ActiveEncoding: m.ActiveEncoding()}
	expected := Expectation{ActiveEncoding: "DEFAULT"}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMouseStateServiceReset(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ActiveProtocol string
		ActiveEncoding string
	}

	m := NewMouseStateService()
	m.SetActiveProtocol("ANY")
	m.SetActiveEncoding("SGR")
	m.Reset()

	got := Expectation{
		ActiveProtocol: m.ActiveProtocol(),
		ActiveEncoding: m.ActiveEncoding(),
	}
	expected := Expectation{
		ActiveProtocol: "NONE",
		ActiveEncoding: "DEFAULT",
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMouseStateServiceProtocolChangeEvent(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Events []CoreMouseEventType
	}

	m := NewMouseStateService()
	var events []CoreMouseEventType
	m.OnProtocolChangeEmitter.Event(func(e CoreMouseEventType) {
		events = append(events, e)
	})

	m.SetActiveProtocol("VT200")
	m.SetActiveProtocol("ANY")

	got := Expectation{Events: events}
	expected := Expectation{Events: []CoreMouseEventType{
		MouseEventDown | MouseEventUp | MouseEventWheel,
		MouseEventDown | MouseEventUp | MouseEventWheel | MouseEventDrag | MouseEventMove,
	}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMouseEventCodeBasic(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Code int
	}
	type TestCase struct {
		Name     string
		Event    CoreMouseEvent
		IsSGR    bool
		Expected Expectation
	}

	tests := []TestCase{
		{
			"left button down",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionDown, Col: 1, Row: 1},
			false,
			Expectation{0},
		},
		{
			"right button down",
			CoreMouseEvent{Button: MouseButtonRight, Action: MouseActionDown, Col: 1, Row: 1},
			false,
			Expectation{2},
		},
		{
			"middle button down",
			CoreMouseEvent{Button: MouseButtonMiddle, Action: MouseActionDown, Col: 1, Row: 1},
			false,
			Expectation{1},
		},
		{
			"left button up non-SGR reports NONE",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionUp, Col: 1, Row: 1},
			false,
			Expectation{int(MouseButtonNone)},
		},
		{
			"left button up SGR reports actual button",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionUp, Col: 1, Row: 1},
			true,
			Expectation{0},
		},
		{
			"wheel scroll down",
			CoreMouseEvent{Button: MouseButtonWheel, Action: MouseActionDown, Col: 1, Row: 1},
			false,
			Expectation{64 | int(MouseActionDown)},
		},
		{
			"ctrl modifier",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionDown, Ctrl: true, Col: 1, Row: 1},
			false,
			Expectation{mouseModCtrl},
		},
		{
			"shift modifier",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionDown, Shift: true, Col: 1, Row: 1},
			false,
			Expectation{mouseModShift},
		},
		{
			"alt modifier",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionDown, Alt: true, Col: 1, Row: 1},
			false,
			Expectation{mouseModAlt},
		},
		{
			"move action",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionMove, Col: 1, Row: 1},
			false,
			Expectation{int(MouseActionMove)},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			got := Expectation{Code: mouseEventCode(&tc.Event, tc.IsSGR)}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestMouseStateServiceTriggerNONE(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Encoded string
		OK      bool
	}

	m := NewMouseStateService()
	// NONE protocol rejects all events.
	encoded, ok := m.TriggerMouseEvent(CoreMouseEvent{
		Button: MouseButtonLeft, Action: MouseActionDown, Col: 1, Row: 1,
	})
	got := Expectation{Encoded: encoded, OK: ok}
	expected := Expectation{Encoded: "", OK: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMouseStateServiceTriggerX10(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Encoded string
		OK      bool
	}
	type TestCase struct {
		Name     string
		Event    CoreMouseEvent
		Expected Expectation
	}

	tests := []TestCase{
		{
			"left down accepted",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionDown, Col: 1, Row: 1},
			Expectation{Encoded: "\x1b[M !!", OK: true},
		},
		{
			"left up rejected",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionUp, Col: 1, Row: 1},
			Expectation{Encoded: "", OK: false},
		},
		{
			"wheel rejected",
			CoreMouseEvent{Button: MouseButtonWheel, Action: MouseActionDown, Col: 1, Row: 1},
			Expectation{Encoded: "", OK: false},
		},
		{
			"move rejected",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionMove, Col: 1, Row: 1},
			Expectation{Encoded: "", OK: false},
		},
		{
			"modifiers stripped",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionDown, Col: 1, Row: 1, Ctrl: true, Alt: true, Shift: true},
			// X10 strips modifiers, so code is just 0+32=32=' '
			Expectation{Encoded: "\x1b[M !!", OK: true},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			m := NewMouseStateService()
			m.SetActiveProtocol("X10")
			encoded, ok := m.TriggerMouseEvent(tc.Event)
			got := Expectation{Encoded: encoded, OK: ok}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestMouseStateServiceTriggerVT200(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Encoded string
		OK      bool
	}
	type TestCase struct {
		Name     string
		Event    CoreMouseEvent
		Expected Expectation
	}

	tests := []TestCase{
		{
			"left down",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionDown, Col: 1, Row: 1},
			Expectation{Encoded: "\x1b[M !!", OK: true},
		},
		{
			"left up (reports NONE button in DEFAULT encoding)",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionUp, Col: 1, Row: 1},
			Expectation{Encoded: "\x1b[M#!!", OK: true},
		},
		{
			"move rejected",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionMove, Col: 1, Row: 1},
			Expectation{Encoded: "", OK: false},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			m := NewMouseStateService()
			m.SetActiveProtocol("VT200")
			encoded, ok := m.TriggerMouseEvent(tc.Event)
			got := Expectation{Encoded: encoded, OK: ok}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestMouseStateServiceTriggerDRAG(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Encoded string
		OK      bool
	}
	type TestCase struct {
		Name     string
		Event    CoreMouseEvent
		Expected Expectation
	}

	tests := []TestCase{
		{
			"left drag accepted",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionMove, Col: 5, Row: 10},
			Expectation{Encoded: "\x1b[M@%*", OK: true},
		},
		{
			"move without button rejected",
			CoreMouseEvent{Button: MouseButtonNone, Action: MouseActionMove, Col: 1, Row: 1},
			Expectation{Encoded: "", OK: false},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			m := NewMouseStateService()
			m.SetActiveProtocol("DRAG")
			encoded, ok := m.TriggerMouseEvent(tc.Event)
			got := Expectation{Encoded: encoded, OK: ok}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestMouseStateServiceTriggerANY(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Encoded string
		OK      bool
	}

	m := NewMouseStateService()
	m.SetActiveProtocol("ANY")
	// ANY accepts move without button.
	encoded, ok := m.TriggerMouseEvent(CoreMouseEvent{
		Button: MouseButtonNone, Action: MouseActionMove, Col: 1, Row: 1,
	})
	// code: button=3 | move=32 = 35, +32 = 67 = 'C'; col=1+32=33='!'; row=1+32=33='!'
	got := Expectation{Encoded: encoded, OK: ok}
	expected := Expectation{Encoded: "\x1b[MC!!", OK: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMouseStateServiceSGREncoding(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Encoded string
		OK      bool
	}
	type TestCase struct {
		Name     string
		Event    CoreMouseEvent
		Expected Expectation
	}

	tests := []TestCase{
		{
			"left down",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionDown, Col: 10, Row: 20},
			Expectation{Encoded: "\x1b[<0;10;20M", OK: true},
		},
		{
			"left up (reports actual button, final=m)",
			CoreMouseEvent{Button: MouseButtonLeft, Action: MouseActionUp, Col: 10, Row: 20},
			Expectation{Encoded: "\x1b[<0;10;20m", OK: true},
		},
		{
			"right down with ctrl",
			CoreMouseEvent{Button: MouseButtonRight, Action: MouseActionDown, Col: 5, Row: 3, Ctrl: true},
			Expectation{Encoded: "\x1b[<18;5;3M", OK: true},
		},
		{
			"wheel up (action=up but button=wheel, final=M)",
			CoreMouseEvent{Button: MouseButtonWheel, Action: MouseActionUp, Col: 1, Row: 1},
			Expectation{Encoded: "\x1b[<64;1;1M", OK: true},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			m := NewMouseStateService()
			m.SetActiveProtocol("VT200")
			m.SetActiveEncoding("SGR")
			encoded, ok := m.TriggerMouseEvent(tc.Event)
			got := Expectation{Encoded: encoded, OK: ok}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestMouseStateServiceSGRPixelsEncoding(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Encoded string
		OK      bool
	}

	m := NewMouseStateService()
	m.SetActiveProtocol("VT200")
	m.SetActiveEncoding("SGR_PIXELS")
	encoded, ok := m.TriggerMouseEvent(CoreMouseEvent{
		Button: MouseButtonLeft, Action: MouseActionDown, Col: 10, Row: 20, X: 150, Y: 300,
	})
	got := Expectation{Encoded: encoded, OK: ok}
	expected := Expectation{Encoded: "\x1b[<0;150;300M", OK: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMouseStateServiceDEFAULTEncodingOverflow(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Encoded string
		OK      bool
	}

	m := NewMouseStateService()
	m.SetActiveProtocol("ANY")
	// Col 224 + 32 = 256 > 255, should be suppressed.
	encoded, ok := m.TriggerMouseEvent(CoreMouseEvent{
		Button: MouseButtonLeft, Action: MouseActionDown, Col: 224, Row: 1,
	})
	got := Expectation{Encoded: encoded, OK: ok}
	expected := Expectation{Encoded: "", OK: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestTerminalTriggerMouseEvent(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Accepted   bool
		DataEvents []string
	}

	term := New(WithCols(80), WithRows(24))
	defer term.Dispose()

	var dataEvents []string
	term.OnData(func(s string) { dataEvents = append(dataEvents, s) })

	// No tracking mode set — should be rejected.
	ok1 := term.TriggerMouseEvent(CoreMouseEvent{
		Button: MouseButtonLeft, Action: MouseActionDown, Col: 1, Row: 1,
	})

	got := Expectation{Accepted: ok1, DataEvents: dataEvents}
	expected := Expectation{Accepted: false, DataEvents: nil}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("no tracking (-want +got):\n%s", diff)
	}
}

func TestTerminalTriggerMouseEventVT200(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Accepted   bool
		DataEvents []string
	}

	term := New(WithCols(80), WithRows(24))
	defer term.Dispose()

	var dataEvents []string
	term.OnData(func(s string) { dataEvents = append(dataEvents, s) })

	// Enable VT200 tracking.
	term.WriteString("\x1b[?1000h")

	ok := term.TriggerMouseEvent(CoreMouseEvent{
		Button: MouseButtonLeft, Action: MouseActionDown, Col: 1, Row: 1,
	})

	got := Expectation{Accepted: ok, DataEvents: dataEvents}
	expected := Expectation{Accepted: true, DataEvents: []string{"\x1b[M !!"}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("VT200 DEFAULT (-want +got):\n%s", diff)
	}
}

func TestTerminalTriggerMouseEventRequiresAlt(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Accepted   bool
		DataEvents []string
	}
	tests := []struct {
		Name     string
		Event    CoreMouseEvent
		Expected Expectation
	}{
		{
			Name: "non-wheel event without Alt is rejected",
			Event: CoreMouseEvent{
				Button: MouseButtonLeft, Action: MouseActionDown, Col: 1, Row: 1,
			},
			Expected: Expectation{Accepted: false},
		},
		{
			Name: "non-wheel event with Alt is accepted without modifier",
			Event: CoreMouseEvent{
				Button: MouseButtonLeft, Action: MouseActionDown, Col: 1, Row: 1, Alt: true,
			},
			Expected: Expectation{Accepted: true, DataEvents: []string{"\x1b[M !!"}},
		},
		{
			Name: "wheel event without Alt is accepted",
			Event: CoreMouseEvent{
				Button: MouseButtonWheel, Action: MouseActionDown, Col: 1, Row: 1,
			},
			Expected: Expectation{Accepted: true, DataEvents: []string{"\x1b[Ma!!"}},
		},
	}

	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			term := New(WithCols(80), WithRows(24), WithMouseEventsRequireAlt(true))
			defer term.Dispose()

			var dataEvents []string
			term.OnData(func(s string) { dataEvents = append(dataEvents, s) })
			term.WriteString("\x1b[?1000h")

			got := Expectation{
				Accepted:   term.TriggerMouseEvent(tc.Event),
				DataEvents: dataEvents,
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestTerminalTriggerMouseEventSGR(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Accepted   bool
		DataEvents []string
	}

	term := New(WithCols(80), WithRows(24))
	defer term.Dispose()

	var dataEvents []string
	term.OnData(func(s string) { dataEvents = append(dataEvents, s) })

	// Enable VT200 tracking with SGR encoding.
	term.WriteString("\x1b[?1000h")
	term.WriteString("\x1b[?1006h")

	ok := term.TriggerMouseEvent(CoreMouseEvent{
		Button: MouseButtonLeft, Action: MouseActionDown, Col: 10, Row: 5,
	})

	got := Expectation{Accepted: ok, DataEvents: dataEvents}
	expected := Expectation{Accepted: true, DataEvents: []string{"\x1b[<0;10;5M"}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("VT200 SGR (-want +got):\n%s", diff)
	}
}

func TestTerminalTriggerMouseEventReset(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Accepted bool
	}

	term := New(WithCols(80), WithRows(24))
	defer term.Dispose()

	term.OnData(func(string) {})

	// Enable then disable tracking.
	term.WriteString("\x1b[?1000h")
	term.WriteString("\x1b[?1000l")

	ok := term.TriggerMouseEvent(CoreMouseEvent{
		Button: MouseButtonLeft, Action: MouseActionDown, Col: 1, Row: 1,
	})

	got := Expectation{Accepted: ok}
	expected := Expectation{Accepted: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("after reset (-want +got):\n%s", diff)
	}
}

func TestTerminalTriggerMouseEventANYMove(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Accepted   bool
		DataEvents []string
	}

	term := New(WithCols(80), WithRows(24))
	defer term.Dispose()

	var dataEvents []string
	term.OnData(func(s string) { dataEvents = append(dataEvents, s) })

	// Enable ANY tracking with SGR encoding.
	term.WriteString("\x1b[?1003h")
	term.WriteString("\x1b[?1006h")

	ok := term.TriggerMouseEvent(CoreMouseEvent{
		Button: MouseButtonNone, Action: MouseActionMove, Col: 15, Row: 8,
	})

	got := Expectation{Accepted: ok, DataEvents: dataEvents}
	expected := Expectation{Accepted: true, DataEvents: []string{"\x1b[<35;15;8M"}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("ANY move SGR (-want +got):\n%s", diff)
	}
}
