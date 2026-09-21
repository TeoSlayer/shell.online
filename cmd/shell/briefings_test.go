package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// briefingsService answers the two briefing routes and records what it saw.
type briefingsCall struct {
	method string
	path   string
	body   map[string]any
}

func briefingsService(t *testing.T, current bool, putAnswer map[string]any) (*httptest.Server, *[]briefingsCall) {
	t.Helper()
	calls := []briefingsCall{}
	service := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer sha_access" {
			t.Errorf("Authorization = %q", request.Header.Get("Authorization"))
		}
		call := briefingsCall{method: request.Method, path: request.URL.Path}
		if request.Method == http.MethodPut {
			_ = json.NewDecoder(request.Body).Decode(&call.body)
		}
		calls = append(calls, call)
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/api/cli/briefings":
			_ = json.NewEncoder(writer).Encode(map[string]any{"enabled": current})
		case request.Method == http.MethodPut && request.URL.Path == "/api/cli/briefings":
			_ = json.NewEncoder(writer).Encode(putAnswer)
		default:
			t.Errorf("unexpected request %s %s", request.Method, request.URL.Path)
		}
	}))
	t.Cleanup(service.Close)
	return service, &calls
}

func TestBriefingsStatusReportsTheSavedDefault(t *testing.T) {
	for _, current := range []bool{false, true} {
		service, _ := briefingsService(t, current, nil)
		linkedAccount(t, service.URL)
		var stdout, stderr bytes.Buffer
		if code := runBriefings([]string{"status"}, &stdout, &stderr); code != 0 {
			t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
		}
		output := stdout.String()
		if current && !strings.Contains(output, "on for your new sessions") {
			t.Errorf("saved on should read on:\n%s", output)
		}
		if !current && !strings.Contains(output, "off") {
			t.Errorf("saved off should read off:\n%s", output)
		}
	}
}

func TestBriefingsOnSavesTheDefaultAndSaysGenerationIsAbsent(t *testing.T) {
	service, calls := briefingsService(t, false, map[string]any{"enabled": true, "applied": 0})
	linkedAccount(t, service.URL)
	var stdout, stderr bytes.Buffer
	if code := runBriefings([]string{"on"}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	output := stdout.String()
	if !strings.Contains(output, "on for your new sessions") {
		t.Errorf("output = %q", output)
	}
	if !strings.Contains(output, briefingNotAvailableNote) {
		t.Errorf("the saved consent must not imply generation works:\n%s", output)
	}
	if len(*calls) != 1 || (*calls)[0].method != http.MethodPut {
		t.Fatalf("calls = %+v", *calls)
	}
	if (*calls)[0].body["enabled"] != true || (*calls)[0].body["apply_to_existing"] != false {
		t.Fatalf("body = %+v", (*calls)[0].body)
	}
}

func TestBriefingsOnAllAppliesToCurrentSessions(t *testing.T) {
	service, calls := briefingsService(t, false, map[string]any{"enabled": true, "applied": 3})
	linkedAccount(t, service.URL)
	var stdout, stderr bytes.Buffer
	if code := runBriefings([]string{"on", "--all"}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "3 current sessions") {
		t.Errorf("output = %q", stdout.String())
	}
	if (*calls)[0].body["apply_to_existing"] != true {
		t.Fatalf("body = %+v", (*calls)[0].body)
	}
}

func TestBriefingsOffSavesOff(t *testing.T) {
	service, calls := briefingsService(t, true, map[string]any{"enabled": false, "applied": 1})
	linkedAccount(t, service.URL)
	var stdout, stderr bytes.Buffer
	if code := runBriefings([]string{"off", "--all"}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "off for your new sessions and 1 current session") {
		t.Errorf("output = %q", stdout.String())
	}
	if (*calls)[0].body["enabled"] != false {
		t.Fatalf("body = %+v", (*calls)[0].body)
	}
}

func TestBriefingsExplainsAnUnlinkedMachine(t *testing.T) {
	t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "absent.json"))
	var stdout, stderr bytes.Buffer
	if code := runBriefings([]string{"status"}, &stdout, &stderr); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	for _, expected := range []string{"not signed in", "shell auth"} {
		if !strings.Contains(stderr.String(), expected) {
			t.Errorf("stderr does not contain %q: %q", expected, stderr.String())
		}
	}
}

func TestBriefingsReportsAServiceFailureWithoutClaimingSuccess(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(writer).Encode(map[string]string{"error": "the database is away"})
	}))
	defer service.Close()
	linkedAccount(t, service.URL)
	var stdout, stderr bytes.Buffer
	if code := runBriefings([]string{"on"}, &stdout, &stderr); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	if strings.Contains(stdout.String(), "on for your new sessions") {
		t.Errorf("a failed save was reported as saved:\n%s", stdout.String())
	}
	if !strings.Contains(stderr.String(), "the database is away") {
		t.Errorf("stderr = %q", stderr.String())
	}
}

func TestBriefingsRejectsUnknownVerbsAndArguments(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := runBriefings(nil, &stdout, &stderr); code != 2 {
		t.Fatalf("no verb: exit = %d, want 2", code)
	}
	if code := runBriefings([]string{"maybe"}, &stdout, &stderr); code != 2 {
		t.Fatalf("unknown verb: exit = %d, want 2", code)
	}
	if code := runBriefings([]string{"status", "extra"}, &stdout, &stderr); code != 2 {
		t.Fatalf("extra argument: exit = %d, want 2", code)
	}
	if code := runBriefings([]string{"on", "--all", "extra"}, &stdout, &stderr); code != 2 {
		t.Fatalf("extra flag argument: exit = %d, want 2", code)
	}
}

func TestBriefingsHelpPrintsUsage(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := runBriefings([]string{"--help"}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	for _, expected := range []string{"shell briefings status", "on [--all]", "off [--all]"} {
		if !strings.Contains(stdout.String(), expected) {
			t.Errorf("help does not contain %q:\n%s", expected, stdout.String())
		}
	}
}

func TestRunSessionCommandRoutesBriefings(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code, handled := runSessionCommand([]string{"briefings", "--help"}, &stdout, &stderr)
	if !handled || code != 0 {
		t.Fatalf("briefings --help = %d, handled %v", code, handled)
	}
}
