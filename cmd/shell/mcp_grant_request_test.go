package main

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
)

func TestMcpGrantEnvelopeKeepsLabelsAsData(t *testing.T) {
	for _, label := range []string{"Agent control 86400", "My Agent", "", "  ", "測試 агент 🦊", "a\u2028b", "quoted \"label\" \\ tail", strings.Repeat("<", 256)} {
		t.Run(label, func(t *testing.T) {
			want := mcpGrantRequest{Label: label, Scopes: "observe", TTL: 900}
			command, err := encodeMcpGrantCommand(want)
			if err != nil {
				t.Fatal(err)
			}
			if len(command)+1 > 2048 {
				t.Fatal("request exceeds local framing limit")
			}
			fields := strings.Fields(command)
			if len(fields) != 3 || fields[1] != "grant-v2" {
				t.Fatalf("unsafe command framing: %q", command)
			}
			got, err := parseMcpGrantCommand(fields[1:])
			if err != nil || got != want {
				t.Fatalf("round trip = %#v, %v; want %#v", got, err, want)
			}
		})
	}
}

func TestMcpGrantEnvelopeRejectsInvalidData(t *testing.T) {
	for _, body := range []string{
		`{}`, `[]`, `null`,
		`{"label":"x","scopes":"observe"}`,
		`{"label":"x","scopes":"observe","ttl":null}`,
		`{"label":null,"scopes":"observe","ttl":0}`,
		`{"label":"x","scopes":null,"ttl":0}`,
		`{"label":"x","scopes":"observe","ttl":1.5}`,
		`{"label":"x","scopes":"observe","ttl":-1}`,
		`{"label":"x","scopes":"observe","ttl":999999999999999999999999}`,
		`{"label":"x","scopes":"observe","ttl":900,"extra":true}`,
		`{"label":"x","scopes":"observe","scopes":"control","ttl":900}`,
		`{"label":"x","label":"y","scopes":"observe","ttl":900}`,
		`{"label":"x","scopes":"observe","ttl":900,"ttl":3600}`,
		`{"label":"x","scopes":"observe","ttl":900} {}`,
		`{"label":"line\ncontrol","scopes":"observe","ttl":900}`,
		`{"label":"x","scopes":"input","ttl":900}`,
		`{"label":"x","scopes":"observe control","ttl":900}`,
		"{\"label\":\"\xff\",\"scopes\":\"observe\",\"ttl\":900}",
	} {
		t.Run(body, func(t *testing.T) {
			if _, err := decodeMcpGrantEnvelope(base64.RawURLEncoding.EncodeToString([]byte(body))); err == nil {
				t.Fatal("invalid envelope accepted")
			}
		})
	}
	for _, encoded := range []string{"", "not!base64", strings.Repeat("A", maxMcpGrantEnvelope+1)} {
		if _, err := decodeMcpGrantEnvelope(encoded); err == nil {
			t.Fatal("invalid encoding accepted")
		}
	}
}

func TestMcpGrantRequestValidation(t *testing.T) {
	for _, label := range []string{"line\nbreak", "line\rbreak", "tab\tcontrol", "nul\x00control", "del\x7fcontrol", "\u0085", "\xff", strings.Repeat("a", 257)} {
		if _, err := encodeMcpGrantCommand(mcpGrantRequest{Label: label, Scopes: "observe", TTL: 900}); err == nil {
			t.Fatalf("unsafe label accepted: %q", label)
		}
	}
	for _, scopes := range []string{"observe", "control", "controlInterrupt", "observe,input", "input,observe", "observe,input,interrupt"} {
		if err := validateMcpGrantRequest(mcpGrantRequest{Label: "test", Scopes: scopes}); err != nil {
			t.Fatalf("valid scope set %q: %v", scopes, err)
		}
	}
	for _, scopes := range []string{"", "input", "interrupt", "observe,interrupt", "observe control", "observe\n", strings.Repeat("observe,", 32)} {
		if err := validateMcpGrantRequest(mcpGrantRequest{Label: "test", Scopes: scopes}); err == nil {
			t.Fatalf("invalid scope set accepted: %q", scopes)
		}
	}
}

func TestMcpLegacyGrantParsingIsStrict(t *testing.T) {
	for _, args := range [][]string{{"grant", "agent", "observe"}, {"grant", "agent", "control", "0"}, {"grant", "agent", "observe", "900"}} {
		if _, err := parseMcpGrantCommand(args); err != nil {
			t.Fatalf("valid legacy request: %v", err)
		}
	}
	for _, args := range [][]string{nil, {"grant"}, {"grant", "agent"}, {"grant", "agent", "observe", "900", "extra"}, {"grant-v2"}, {"grant-v2", "e30", "extra"}} {
		if _, err := parseMcpGrantCommand(args); err == nil {
			t.Fatalf("malformed request accepted: %q", args)
		}
	}
	for _, ttl := range []string{"", "-1", "+1", "1.5", "bad", " 900", "999999999999999999999999"} {
		if _, err := parseMcpGrantCommand([]string{"grant", "agent", "observe", ttl}); err == nil {
			t.Fatalf("invalid TTL accepted: %q", ttl)
		}
	}
}

func TestMcpCLIRejectsInvalidArgumentsBeforeHostLookup(t *testing.T) {
	for _, args := range [][]string{
		{"grant", "missing", "agent", "observe", "900", "extra"},
		{"grant", "missing", "agent", "observe", "bad"},
		{"grant", "missing", "agent", "observe", "-1"},
		{"grant", "missing", "line\nbreak", "observe", "900"},
		{"grant", "missing", "agent", "observe control", "900"},
		{"list", "missing", "extra"}, {"revoke-all", "missing", "extra"},
		{"revoke", "missing", "grant", "extra"}, {"revoke", "missing", "grant\nstop"},
	} {
		var output, warnings bytes.Buffer
		if code := runSessionMcp(args, &output, &warnings); code != 2 {
			t.Fatalf("args=%q code=%d, want usage failure before host lookup; %s", args, code, warnings.String())
		}
		if output.Len() != 0 {
			t.Fatal("invalid invocation wrote to credential output")
		}
	}
}
