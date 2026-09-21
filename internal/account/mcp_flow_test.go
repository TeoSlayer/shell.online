package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"testing"
)

// The host's allowlists must be the relay's allowlists. The TypeScript unions
// are the source of truth; this reads them and fails on any drift.
func literalsFromTypeScript(t *testing.T, path, declaration string) []string {
	t.Helper()
	source, err := os.ReadFile(filepath.Join("..", "..", "shared", path))
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	pattern := regexp.MustCompile(`export type ` + declaration + ` =([^;]*);`)
	match := pattern.FindSubmatch(source)
	if match == nil {
		t.Fatalf("declaration %s not found in %s", declaration, path)
	}
	found := regexp.MustCompile(`"([a-z_]+)"`).FindAllSubmatch(match[1], -1)
	values := make([]string, 0, len(found))
	for _, entry := range found {
		values = append(values, string(entry[1]))
	}
	sort.Strings(values)
	return values
}

func TestMcpFlowAllowlistsMatchSharedTypeScript(t *testing.T) {
	outcomes := literalsFromTypeScript(t, "mcp-audit.ts", "McpAuditOutcome")
	expectedOutcomes := append([]string(nil), McpAuditOutcomes...)
	sort.Strings(expectedOutcomes)
	if !reflect.DeepEqual(outcomes, expectedOutcomes) {
		t.Fatalf("McpAuditOutcomes drifted from shared/mcp-audit.ts\nshared: %v\nhost:   %v", outcomes, expectedOutcomes)
	}

	tools := literalsFromTypeScript(t, "mcp-flow.ts", "McpFlowTool")
	expectedTools := append([]string(nil), McpFlowTools...)
	sort.Strings(expectedTools)
	if !reflect.DeepEqual(tools, expectedTools) {
		t.Fatalf("McpFlowTools drifted from shared/mcp-flow.ts\nshared: %v\nhost:   %v", tools, expectedTools)
	}
}

func TestUUIDV4Validation(t *testing.T) {
	valid := "6f1d9f5e-4a1b-4c8d-9f2e-0b7c3a5d1e2f"
	if !IsUUIDV4(valid) {
		t.Fatalf("%q should be a v4 UUID", valid)
	}
	for _, candidate := range []string{
		"",
		"6f1d9f5e4a1b4c8d9f2e0b7c3a5d1e2f",
		"6f1d9f5e-4a1b-3c8d-9f2e-0b7c3a5d1e2f", // version 3
		"6f1d9f5e-4a1b-4c8d-1f2e-0b7c3a5d1e2f", // variant 1
		"6f1d9f5e-4a1b-4c8d-9f2e-0b7c3a5d1e2Z", // not hex
		"6f1d9f5e-4a1b-4c8d-9f2e-0b7c3a5d1e2f0",
	} {
		if IsUUIDV4(candidate) {
			t.Fatalf("%q should not be a v4 UUID", candidate)
		}
	}
}

func TestReportMcpFlowsPostsOnlyEvents(t *testing.T) {
	type seen struct {
		method string
		path   string
		auth   string
		body   map[string]json.RawMessage
	}
	requests := make(chan seen, 4)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body map[string]json.RawMessage
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		requests <- seen{method: request.Method, path: request.URL.Path, auth: request.Header.Get("Authorization"), body: body}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"accepted":true}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "test/1")
	events := []McpFlowEvent{
		{ID: "6f1d9f5e-4a1b-4c8d-9f2e-0b7c3a5d1e2f", Tool: "shell_screen", Phase: "started", At: 1730000000000},
		{ID: "6f1d9f5e-4a1b-4c8d-9f2e-0b7c3a5d1e2f", Tool: "shell_screen", Phase: "settled", At: 1730000000123, Outcome: "ok"},
	}
	if err := client.ReportMcpFlows(context.Background(), "token-1", "session-1", events); err != nil {
		t.Fatalf("report: %v", err)
	}
	got := <-requests
	if got.method != http.MethodPost || got.path != "/api/cli/sessions/session-1/mcp-flows" {
		t.Fatalf("request = %s %s", got.method, got.path)
	}
	if got.auth != "Bearer token-1" {
		t.Fatalf("authorization = %q", got.auth)
	}
	if len(got.body) != 1 {
		t.Fatalf("body keys = %v", got.body)
	}
	var posted []map[string]any
	if err := json.Unmarshal(got.body["events"], &posted); err != nil {
		t.Fatalf("events: %v", err)
	}
	if len(posted) != 2 {
		t.Fatalf("posted %d events", len(posted))
	}
	for _, event := range posted {
		for key := range event {
			switch key {
			case "id", "tool", "phase", "at", "outcome":
			default:
				t.Fatalf("event carries an unapproved field %q", key)
			}
		}
	}
	if posted[1]["outcome"] != "ok" || posted[0]["outcome"] != nil {
		t.Fatalf("outcomes = %v", posted)
	}

	/* Nothing to say is not a request. */
	if err := client.ReportMcpFlows(context.Background(), "token-1", "session-1", nil); err != nil {
		t.Fatalf("empty report: %v", err)
	}
	select {
	case extra := <-requests:
		t.Fatalf("empty batch still called the service: %+v", extra)
	default:
	}
}
