//go:build !windows

package main

import (
	"bytes"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"shell.online/internal/api"
)

type observedGrant struct {
	label  string
	scopes []string
	ttl    int
}

// startGrantHost starts a real local session whose MCP issuance is a stub that
// records the exact (label, scopes, ttl) the host hands to the API client.
func startGrantHost(t *testing.T, id string) (observed chan observedGrant) {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "mcp-boundary-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	t.Setenv("SHELL_ONLINE_RUNTIME_DIR", directory)
	control, err := startLocalSession(localSessionRecord{ID: id, PID: os.Getpid(), StartedAt: time.Now(), Command: "boundary-test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = control.Close() })
	observed = make(chan observedGrant, 1)
	control.(*managedLocalSession).SetMcpHandlers(func(label string, scopes []string, ttl int) (api.McpGrantCreated, error) {
		observed <- observedGrant{label, scopes, ttl}
		return api.McpGrantCreated{GrantID: "synthetic-grant", Bearer: "synthetic-boundary-credential"}, nil
	}, nil, nil, nil)
	return observed
}

func TestMcpGrantBoundaryQuotedLabelPreservesAuthority(t *testing.T) {
	id := strings.Repeat("b", 32)
	observed := startGrantHost(t, id)
	var out, warnings bytes.Buffer
	code := runSessionMcp([]string{"grant", id, "Agent control 86400", "observe", "900"}, &out, &warnings)
	if code != 0 {
		t.Fatalf("quoted label rejected: code=%d error=%q", code, warnings.String())
	}
	if strings.TrimSpace(out.String()) != "synthetic-boundary-credential" {
		t.Fatalf("bearer output = %q", out.String())
	}
	select {
	case got := <-observed:
		if got.label != "Agent control 86400" || strings.Join(got.scopes, ",") != "observe" || got.ttl != 900 {
			t.Fatalf("label changed grant authority: label=%q scopes=%q ttl=%d", got.label, got.scopes, got.ttl)
		}
	case <-time.After(time.Second):
		t.Fatal("issuance callback did not execute")
	}
}

func TestMcpGrantBoundaryUnicodeAndEmptyLabels(t *testing.T) {
	for _, test := range []struct {
		name, label string
		ttl         int
	}{
		{"unicode label", "Agent—contrôle ✓", 900},
		{"cjk label", "エージェント 管理 86400", 0},
		{"empty label", "", 900},
	} {
		t.Run(test.name, func(t *testing.T) {
			id := strings.Repeat("u", 32)
			observed := startGrantHost(t, id)
			var out, warnings bytes.Buffer
			arguments := []string{"grant", id, test.label, "observe"}
			if test.ttl > 0 {
				arguments = append(arguments, strconv.Itoa(test.ttl))
			}
			if code := runSessionMcp(arguments, &out, &warnings); code != 0 {
				t.Fatalf("label %q rejected: code=%d error=%q", test.label, code, warnings.String())
			}
			if strings.TrimSpace(out.String()) != "synthetic-boundary-credential" {
				t.Fatalf("bearer output = %q", out.String())
			}
			select {
			case got := <-observed:
				if got.label != test.label || strings.Join(got.scopes, ",") != "observe" || got.ttl != test.ttl {
					t.Fatalf("authority changed: label=%q scopes=%q ttl=%d, want label=%q ttl=%d", got.label, got.scopes, got.ttl, test.label, test.ttl)
				}
			case <-time.After(time.Second):
				t.Fatal("issuance callback did not execute")
			}
		})
	}
}

func TestMcpGrantBoundaryMalformedNeverIssues(t *testing.T) {
	for _, test := range []struct {
		name      string
		arguments []string
	}{
		{"non-numeric ttl", []string{"grant", "id", "agent", "observe", "not-a-number"}},
		{"negative ttl", []string{"grant", "id", "agent", "observe", "-1"}},
		{"overflowing ttl", []string{"grant", "id", "agent", "observe", "99999999999999999999999999"}},
		{"extra argument", []string{"grant", "id", "agent", "observe", "900", "extra"}},
		{"missing label", []string{"grant", "id", "observe"}},
		{"control character in label", []string{"grant", "id", "bad\x01label", "observe", "900"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			id := strings.Repeat("m", 32)
			observed := startGrantHost(t, id)
			arguments := append([]string{test.arguments[0], id}, test.arguments[2:]...)
			var out, warnings bytes.Buffer
			if code := runSessionMcp(arguments, &out, &warnings); code != 2 {
				t.Fatalf("malformed command accepted: code=%d out=%q", code, out.String())
			}
			if out.Len() != 0 {
				t.Fatalf("credential printed for rejected request: %q", out.String())
			}
			select {
			case <-observed:
				t.Fatal("malformed request reached issuance callback")
			default:
			}
		})
	}
}
