//go:build !windows

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"shell.online/internal/api"
)

func TestMcpGrantNewClientDoesNotFallBackOnOldHost(t *testing.T) {
	directory, err := os.MkdirTemp("/tmp", "mcp-compat-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	t.Setenv("SHELL_ONLINE_RUNTIME_DIR", directory)
	id := strings.Repeat("c", 32)
	record := localSessionRecord{ID: id, PID: os.Getpid(), StartedAt: time.Now(), Command: "test"}
	if err := writeLocalSessionRecord(directory, record); err != nil {
		t.Fatal(err)
	}
	listener, err := listenLocalControl(id)
	if err != nil {
		t.Fatal(err)
	}
	requests := make(chan string, 8)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
			request, _ := bufio.NewReader(connection).ReadString('\n')
			requests <- request
			response := localControlResponse{OK: true, ID: id, PID: record.PID}
			switch {
			case strings.TrimSpace(request) == "ping":
			case strings.HasPrefix(request, "mcp grant "):
				response.Bearer = "synthetic-old-host-credential"
			default:
				response.OK, response.Error = false, "unknown mcp command"
			}
			_ = json.NewEncoder(connection).Encode(response)
			_ = connection.Close()
		}
	}()
	defer func() { _ = listener.Close(); <-done }()
	var out, warnings bytes.Buffer
	if code := runSessionMcp([]string{"grant", id, "Agent control 86400", "observe", "900"}, &out, &warnings); code != 1 {
		t.Fatalf("old host result = %d, want refusal", code)
	}
	if out.Len() != 0 || !strings.Contains(warnings.String(), "update and restart") {
		t.Fatal("missing safe host-upgrade guidance or unexpected credential output")
	}
	sawVersioned := false
	for len(requests) > 0 {
		request := <-requests
		if strings.HasPrefix(request, "mcp grant ") {
			t.Fatal("client fell back to unsafe legacy grant")
		}
		if strings.HasPrefix(request, "mcp grant-v2 ") {
			sawVersioned = true
		}
	}
	if !sawVersioned {
		t.Fatal("versioned request never reached host")
	}
}

func TestMcpGrantNewHostAcceptsValidLegacyRequests(t *testing.T) {
	for _, test := range []struct {
		command, label, scopes string
		ttl                    int
	}{
		{"mcp grant agent observe 900", "agent", "observe", 900},
		{"mcp grant agent control 0", "agent", "observe,input", 0},
		{"mcp grant agent observe", "agent", "observe", 0},
	} {
		t.Run(test.command, func(t *testing.T) {
			calls := make(chan mcpGrantRequest, 1)
			session := &managedLocalSession{}
			session.SetMcpHandlers(func(label string, scopes []string, ttl int) (api.McpGrantCreated, error) {
				calls <- mcpGrantRequest{Label: label, Scopes: strings.Join(scopes, ","), TTL: ttl}
				return api.McpGrantCreated{Bearer: "synthetic-legacy-credential"}, nil
			}, nil, nil, nil)
			client, server := net.Pipe()
			defer client.Close()
			_ = client.SetDeadline(time.Now().Add(2 * time.Second))
			go session.handleConnection(server)
			if _, err := fmt.Fprintln(client, test.command); err != nil {
				t.Fatal(err)
			}
			var response localControlResponse
			if err := json.NewDecoder(client).Decode(&response); err != nil || !response.OK {
				t.Fatalf("legacy request failed: %v", err)
			}
			select {
			case got := <-calls:
				if got != (mcpGrantRequest{Label: test.label, Scopes: test.scopes, TTL: test.ttl}) {
					t.Fatalf("legacy values changed: %#v", got)
				}
			default:
				t.Fatal("legacy callback not invoked")
			}
		})
	}
}
