package xterm

import (
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
)

// testOscHandler records calls for testing.
type testOscHandler struct {
	starts int
	puts   []string
	ends   []bool
	endRet bool
}

func (h *testOscHandler) Start() { h.starts++ }
func (h *testOscHandler) Put(data []uint32, start, end int) {
	h.puts = append(h.puts, utf32ToString(data, start, end))
}
func (h *testOscHandler) End(success bool) bool { h.ends = append(h.ends, success); return h.endRet }

func toUint32(s string) []uint32 {
	r := make([]uint32, len(s))
	for i, c := range s {
		r[i] = uint32(c)
	}
	return r
}

func TestOscParserIDParsing(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Starts int
		Puts   []string
		Ends   []bool
	}
	type TestCase struct {
		Name     string
		Input    string
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name:  "parse id and payload",
			Input: "52;SGVsbG8=",
			Expected: Expectation{
				Starts: 1,
				Puts:   []string{"SGVsbG8="},
				Ends:   []bool{true},
			},
		},
		{
			Name:  "id only no payload",
			Input: "0",
			Expected: Expectation{
				Starts: 1,
				Puts:   nil,
				Ends:   []bool{true},
			},
		},
		{
			Name:  "empty semicolon payload",
			Input: "7;",
			Expected: Expectation{
				Starts: 1,
				Puts:   nil,
				Ends:   []bool{true},
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			p := NewOscParser()
			h := &testOscHandler{endRet: true}
			// Register for all test IDs
			for _, id := range []int{0, 7, 52} {
				p.RegisterHandler(id, h)
			}
			data := toUint32(tc.Input)
			p.Start()
			p.Put(data, 0, len(data))
			p.End(true)

			got := Expectation{Starts: h.starts, Puts: h.puts, Ends: h.ends}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestOscParserHandlerDispatch(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		H1Starts int
		H2Starts int
		H1Ends   int
		H2Ends   int
	}

	p := NewOscParser()
	h1 := &testOscHandler{}
	h2 := &testOscHandler{}
	p.RegisterHandler(10, h1)
	p.RegisterHandler(10, h2)

	data := toUint32("10;payload")
	p.Start()
	p.Put(data, 0, len(data))
	p.End(true)

	got := Expectation{
		H1Starts: h1.starts,
		H2Starts: h2.starts,
		H1Ends:   len(h1.ends),
		H2Ends:   len(h2.ends),
	}
	expected := Expectation{
		H1Starts: 1,
		H2Starts: 1,
		H1Ends:   1,
		H2Ends:   1,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOscParserFallback(t *testing.T) {
	t.Parallel()
	type FallbackCall struct {
		Ident  int
		Action string
	}
	type Expectation struct {
		Calls []FallbackCall
	}

	p := NewOscParser()
	var calls []FallbackCall
	p.SetHandlerFallback(func(ident int, action string, payload ...interface{}) {
		calls = append(calls, FallbackCall{Ident: ident, Action: action})
	})

	data := toUint32("999;hello")
	p.Start()
	p.Put(data, 0, len(data))
	p.End(true)

	got := Expectation{Calls: calls}
	expected := Expectation{Calls: []FallbackCall{
		{Ident: 999, Action: "START"},
		{Ident: 999, Action: "PUT"},
		{Ident: 999, Action: "END"},
	}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOscParserDispose(t *testing.T) {
	t.Parallel()
	p := NewOscParser()
	h := &testOscHandler{}
	d := p.RegisterHandler(10, h)

	d.Dispose()

	data := toUint32("10;test")
	p.Start()
	p.Put(data, 0, len(data))
	p.End(true)

	if h.starts != 0 {
		t.Errorf("handler should not have been called after dispose, got %d starts", h.starts)
	}
}

func TestOscParserAbort(t *testing.T) {
	t.Parallel()
	p := NewOscParser()
	h := &testOscHandler{}
	p.RegisterHandler(0, h)

	// Non-digit in ID position causes abort
	data := toUint32("x;payload")
	p.Start()
	p.Put(data, 0, len(data))
	p.End(true)

	if h.starts != 0 {
		t.Errorf("handler should not start on abort, got %d starts", h.starts)
	}
}

func TestOscParserReset(t *testing.T) {
	t.Parallel()
	p := NewOscParser()
	h := &testOscHandler{}
	p.RegisterHandler(1, h)

	data := toUint32("1;partial")
	p.Start()
	p.Put(data, 0, len(data))
	// Reset without End
	p.Reset()

	// h.End should have been called with false
	type Expectation struct {
		Ends []bool
	}
	got := Expectation{Ends: h.ends}
	expected := Expectation{Ends: []bool{false}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOscStringHandler(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Received string
		Result   bool
	}
	type TestCase struct {
		Name     string
		Payload  string
		Success  bool
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name:     "successful end",
			Payload:  "hello world",
			Success:  true,
			Expected: Expectation{Received: "hello world", Result: true},
		},
		{
			Name:     "unsuccessful end",
			Payload:  "hello",
			Success:  false,
			Expected: Expectation{Received: "", Result: false},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			var received string
			h := NewOscStringHandler(func(data string) bool {
				received = data
				return true
			})
			h.Start()
			data := toUint32(tc.Payload)
			h.Put(data, 0, len(data))
			result := h.End(tc.Success)

			got := Expectation{Received: received, Result: result}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestOscStringHandlerPayloadLimit(t *testing.T) {
	t.Parallel()
	var received string
	h := NewOscStringHandler(func(data string) bool {
		received = data
		return true
	})
	h.Start()
	// Exceed payload limit
	big := strings.Repeat("A", ParserPayloadLimit+1)
	data := toUint32(big)
	h.Put(data, 0, len(data))
	result := h.End(true)

	if result != false {
		t.Error("expected false when payload limit exceeded")
	}
	if received != "" {
		t.Error("handler should not have been called when limit exceeded")
	}
}

func TestOscParserMultiplePuts(t *testing.T) {
	t.Parallel()
	p := NewOscParser()
	h := &testOscHandler{endRet: true}
	p.RegisterHandler(4, h)

	// Send ID and payload in separate Put calls
	id := toUint32("4;")
	p.Start()
	p.Put(id, 0, len(id))

	payload1 := toUint32("hel")
	p.Put(payload1, 0, len(payload1))

	payload2 := toUint32("lo")
	p.Put(payload2, 0, len(payload2))

	p.End(true)

	type Expectation struct {
		Starts int
		Puts   []string
	}
	got := Expectation{Starts: h.starts, Puts: h.puts}
	expected := Expectation{Starts: 1, Puts: []string{"hel", "lo"}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOscParserClearHandler(t *testing.T) {
	t.Parallel()
	p := NewOscParser()
	h := &testOscHandler{}
	p.RegisterHandler(5, h)
	p.ClearHandler(5)

	data := toUint32("5;test")
	p.Start()
	p.Put(data, 0, len(data))
	p.End(true)

	if h.starts != 0 {
		t.Errorf("handler should not be called after ClearHandler, got %d starts", h.starts)
	}
}

func TestOscParserHandlerEndConsumption(t *testing.T) {
	t.Parallel()
	// When a later handler returns true from End, earlier handlers get End(false)
	p := NewOscParser()
	h1 := &testOscHandler{endRet: false}
	h2 := &testOscHandler{endRet: true} // this one consumes
	p.RegisterHandler(1, h1)
	p.RegisterHandler(1, h2)

	data := toUint32("1;data")
	p.Start()
	p.Put(data, 0, len(data))
	p.End(true)

	// h2 (last registered) is called first with success=true
	// h1 gets End(false) because h2 consumed
	type Expectation struct {
		H1Ends []bool
		H2Ends []bool
	}
	got := Expectation{H1Ends: h1.ends, H2Ends: h2.ends}
	expected := Expectation{H1Ends: []bool{false}, H2Ends: []bool{true}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
