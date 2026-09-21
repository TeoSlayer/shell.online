package xterm

import (
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
)

// testDcsHandler records calls for testing.
type testDcsHandler struct {
	hooks     int
	params    []*Params
	puts      []string
	unhooks   []bool
	unhookRet bool
}

func (h *testDcsHandler) Hook(params *Params) {
	h.hooks++
	h.params = append(h.params, params.Clone())
}
func (h *testDcsHandler) Put(data []uint32, start, end int) {
	h.puts = append(h.puts, utf32ToString(data, start, end))
}
func (h *testDcsHandler) Unhook(success bool) bool {
	h.unhooks = append(h.unhooks, success)
	return h.unhookRet
}

func TestDcsParserHookPutUnhook(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Hooks   int
		Puts    []string
		Unhooks []bool
	}
	type TestCase struct {
		Name     string
		Ident    int
		Payload  []string
		Success  bool
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name:    "basic lifecycle",
			Ident:   100,
			Payload: []string{"hello"},
			Success: true,
			Expected: Expectation{
				Hooks:   1,
				Puts:    []string{"hello"},
				Unhooks: []bool{true},
			},
		},
		{
			Name:    "multiple puts",
			Ident:   100,
			Payload: []string{"hel", "lo", " world"},
			Success: true,
			Expected: Expectation{
				Hooks:   1,
				Puts:    []string{"hel", "lo", " world"},
				Unhooks: []bool{true},
			},
		},
		{
			Name:    "unsuccessful unhook",
			Ident:   100,
			Payload: []string{"data"},
			Success: false,
			Expected: Expectation{
				Hooks:   1,
				Puts:    []string{"data"},
				Unhooks: []bool{false},
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			p := NewDcsParser()
			h := &testDcsHandler{unhookRet: true}
			p.RegisterHandler(tc.Ident, h)

			params := DefaultParams()
			params.AddParam(1)
			p.Hook(tc.Ident, params)
			for _, payload := range tc.Payload {
				data := toUint32(payload)
				p.Put(data, 0, len(data))
			}
			p.Unhook(tc.Success)

			got := Expectation{
				Hooks:   h.hooks,
				Puts:    h.puts,
				Unhooks: h.unhooks,
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestDcsParserHandlerDispatch(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		H1Hooks int
		H2Hooks int
	}

	p := NewDcsParser()
	h1 := &testDcsHandler{}
	h2 := &testDcsHandler{}
	p.RegisterHandler(50, h1)
	p.RegisterHandler(50, h2)

	params := DefaultParams()
	params.AddParam(0)
	p.Hook(50, params)
	p.Unhook(true)

	got := Expectation{H1Hooks: h1.hooks, H2Hooks: h2.hooks}
	expected := Expectation{H1Hooks: 1, H2Hooks: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestDcsParserFallback(t *testing.T) {
	t.Parallel()
	type FallbackCall struct {
		Ident  int
		Action string
	}
	type Expectation struct {
		Calls []FallbackCall
	}

	p := NewDcsParser()
	var calls []FallbackCall
	p.SetHandlerFallback(func(ident int, action string, payload ...interface{}) {
		calls = append(calls, FallbackCall{Ident: ident, Action: action})
	})

	params := DefaultParams()
	params.AddParam(0)
	p.Hook(999, params)
	data := toUint32("payload")
	p.Put(data, 0, len(data))
	p.Unhook(true)

	got := Expectation{Calls: calls}
	expected := Expectation{Calls: []FallbackCall{
		{Ident: 999, Action: "HOOK"},
		{Ident: 999, Action: "PUT"},
		{Ident: 999, Action: "UNHOOK"},
	}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestDcsParserDispose(t *testing.T) {
	t.Parallel()
	p := NewDcsParser()
	h := &testDcsHandler{}
	d := p.RegisterHandler(10, h)
	d.Dispose()

	params := DefaultParams()
	params.AddParam(0)
	p.Hook(10, params)
	p.Unhook(true)

	if h.hooks != 0 {
		t.Errorf("handler should not have been called after dispose, got %d hooks", h.hooks)
	}
}

func TestDcsParserReset(t *testing.T) {
	t.Parallel()
	p := NewDcsParser()
	h := &testDcsHandler{}
	p.RegisterHandler(1, h)

	params := DefaultParams()
	params.AddParam(0)
	p.Hook(1, params)
	data := toUint32("partial")
	p.Put(data, 0, len(data))
	p.Reset()

	type Expectation struct {
		Unhooks []bool
	}
	got := Expectation{Unhooks: h.unhooks}
	expected := Expectation{Unhooks: []bool{false}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestDcsParserClearHandler(t *testing.T) {
	t.Parallel()
	p := NewDcsParser()
	h := &testDcsHandler{}
	p.RegisterHandler(5, h)
	p.ClearHandler(5)

	params := DefaultParams()
	params.AddParam(0)
	p.Hook(5, params)
	p.Unhook(true)

	if h.hooks != 0 {
		t.Errorf("handler should not be called after ClearHandler, got %d hooks", h.hooks)
	}
}

func TestDcsParserUnhookConsumption(t *testing.T) {
	t.Parallel()
	p := NewDcsParser()
	h1 := &testDcsHandler{unhookRet: false}
	h2 := &testDcsHandler{unhookRet: true}
	p.RegisterHandler(1, h1)
	p.RegisterHandler(1, h2)

	params := DefaultParams()
	params.AddParam(0)
	p.Hook(1, params)
	p.Unhook(true)

	type Expectation struct {
		H1Unhooks []bool
		H2Unhooks []bool
	}
	got := Expectation{H1Unhooks: h1.unhooks, H2Unhooks: h2.unhooks}
	expected := Expectation{H1Unhooks: []bool{false}, H2Unhooks: []bool{true}}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestDcsStringHandler(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Data   string
		Param0 int32
		Result bool
	}
	type TestCase struct {
		Name     string
		Payload  string
		Param    int32
		Success  bool
		Expected Expectation
	}
	tests := []TestCase{
		{
			Name:     "successful unhook",
			Payload:  "hello",
			Param:    42,
			Success:  true,
			Expected: Expectation{Data: "hello", Param0: 42, Result: true},
		},
		{
			Name:     "unsuccessful unhook",
			Payload:  "hello",
			Param:    0,
			Success:  false,
			Expected: Expectation{Data: "", Param0: 0, Result: false},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			var receivedData string
			var receivedParam int32
			h := NewDcsStringHandler(func(data string, params *Params) bool {
				receivedData = data
				receivedParam = params.Params[0]
				return true
			})
			params := DefaultParams()
			params.AddParam(tc.Param)
			h.Hook(params)
			data := toUint32(tc.Payload)
			h.Put(data, 0, len(data))
			result := h.Unhook(tc.Success)

			got := Expectation{Data: receivedData, Param0: receivedParam, Result: result}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestDcsStringHandlerPayloadLimit(t *testing.T) {
	t.Parallel()
	var received string
	h := NewDcsStringHandler(func(data string, params *Params) bool {
		received = data
		return true
	})
	params := DefaultParams()
	params.AddParam(0)
	h.Hook(params)
	big := strings.Repeat("B", ParserPayloadLimit+1)
	data := toUint32(big)
	h.Put(data, 0, len(data))
	result := h.Unhook(true)

	if result != false {
		t.Error("expected false when payload limit exceeded")
	}
	if received != "" {
		t.Error("handler should not have been called when limit exceeded")
	}
}

func TestDcsParserHookParams(t *testing.T) {
	t.Parallel()
	p := NewDcsParser()
	h := &testDcsHandler{unhookRet: true}
	p.RegisterHandler(1, h)

	params := DefaultParams()
	params.AddParam(10)
	params.AddParam(20)
	p.Hook(1, params)
	p.Unhook(true)

	if len(h.params) != 1 {
		t.Fatalf("expected 1 hook call, got %d", len(h.params))
	}
	type Expectation struct {
		Length int
		P0     int32
		P1     int32
	}
	got := Expectation{
		Length: h.params[0].Length,
		P0:     h.params[0].Params[0],
		P1:     h.params[0].Params[1],
	}
	expected := Expectation{Length: 2, P0: 10, P1: 20}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
