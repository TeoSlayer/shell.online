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

const permissionsTestSessionID = "p3rmiss10nSess10nIdXyZ0123456"

type permissionsCall struct {
	method string
	path   string
	body   map[string]any
}

func permissionsService(t *testing.T, current map[string]any) (*httptest.Server, *[]permissionsCall) {
	t.Helper()
	calls := []permissionsCall{}
	service := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer sha_access" {
			t.Errorf("Authorization = %q", request.Header.Get("Authorization"))
		}
		path := request.URL.Path
		want := "/api/cli/sessions/" + permissionsTestSessionID + "/automation"
		if path != want {
			t.Errorf("path = %q, want %q", path, want)
		}
		call := permissionsCall{method: request.Method, path: path}
		if request.Method == http.MethodPut {
			_ = json.NewDecoder(request.Body).Decode(&call.body)
		}
		calls = append(calls, call)
		writer.Header().Set("Content-Type", "application/json")
		if request.Method == http.MethodPut {
			answer := map[string]any{
				"mcpTeamAccess":           false,
				"dailyBriefingEnabled":    false,
				"dailyBriefingTeamAccess": false,
			}
			for key, value := range current {
				answer[key] = value
			}
			for key, value := range call.body {
				answer[key] = value
			}
			_ = json.NewEncoder(writer).Encode(answer)
			return
		}
		_ = json.NewEncoder(writer).Encode(current)
	}))
	t.Cleanup(service.Close)
	return service, &calls
}

func TestPermissionsReadsTheThreeSwitches(t *testing.T) {
	service, calls := permissionsService(t, map[string]any{
		"mcpTeamAccess": true, "dailyBriefingEnabled": false, "dailyBriefingTeamAccess": true,
	})
	linkedAccount(t, service.URL)
	var stdout, stderr bytes.Buffer
	if code := runPermissions([]string{permissionsTestSessionID}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	output := stdout.String()
	for _, expected := range []string{
		"Permissions for", "MCP team access", "Daily briefing", "Briefing team access",
	} {
		if !strings.Contains(output, expected) {
			t.Errorf("output does not contain %q:\n%s", expected, output)
		}
	}
	if len(*calls) != 1 || (*calls)[0].method != http.MethodGet {
		t.Fatalf("calls = %+v", *calls)
	}
}

func TestPermissionsUpdatesOnlyTheNamedSwitches(t *testing.T) {
	service, calls := permissionsService(t, map[string]any{
		"mcpTeamAccess": true, "dailyBriefingEnabled": false, "dailyBriefingTeamAccess": false,
	})
	linkedAccount(t, service.URL)
	var stdout, stderr bytes.Buffer
	code := runPermissions(
		[]string{permissionsTestSessionID, "--daily-briefing=true"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	if len(*calls) != 1 || (*calls)[0].method != http.MethodPut {
		t.Fatalf("calls = %+v", *calls)
	}
	body := (*calls)[0].body
	if body["dailyBriefingEnabled"] != true {
		t.Fatalf("body = %+v", body)
	}
	if _, present := body["mcpTeamAccess"]; present {
		t.Fatalf("an unnamed switch was sent: %+v", body)
	}
	if !strings.Contains(stdout.String(), "Daily briefing: on") {
		t.Errorf("output = %q", stdout.String())
	}
	if !strings.Contains(stdout.String(), permissionsNotActiveNote) {
		t.Errorf("the saved consent must not imply the switches are acted on:\n%s", stdout.String())
	}
}

func TestPermissionsAcceptsFlagsInAnyOrderAndBothForms(t *testing.T) {
	service, calls := permissionsService(t, map[string]any{})
	linkedAccount(t, service.URL)
	var stdout, stderr bytes.Buffer
	code := runPermissions(
		[]string{"--mcp-team-access=true", permissionsTestSessionID, "--briefing-team-access", "false"},
		&stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	body := (*calls)[0].body
	if body["mcpTeamAccess"] != true || body["dailyBriefingTeamAccess"] != false {
		t.Fatalf("body = %+v", body)
	}
}

func TestPermissionsTakesAnIDThatStartsWithAHyphen(t *testing.T) {
	id := "-3rmiss10nSess10nIdXyZ01234567"
	service := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/cli/sessions/"+id+"/automation" {
			t.Errorf("path = %q", request.URL.Path)
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"mcpTeamAccess": false, "dailyBriefingEnabled": false, "dailyBriefingTeamAccess": false,
		})
	}))
	defer service.Close()
	linkedAccount(t, service.URL)
	var stdout, stderr bytes.Buffer
	if code := runPermissions([]string{id}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
}

func TestPermissionsRejectsAValueThatIsNotTrueOrFalse(t *testing.T) {
	var stdout, stderr bytes.Buffer
	for _, arguments := range [][]string{
		{permissionsTestSessionID, "--daily-briefing=1"},
		{permissionsTestSessionID, "--daily-briefing=yes"},
		{permissionsTestSessionID, "--daily-briefing"},
	} {
		if code := runPermissions(arguments, &stdout, &stderr); code != 2 {
			t.Fatalf("%v: exit = %d, want 2", arguments, code)
		}
	}
}

func TestPermissionsRejectsUnknownFlagsAndExtraArguments(t *testing.T) {
	var stdout, stderr bytes.Buffer
	for _, arguments := range [][]string{
		{permissionsTestSessionID, "--mcp=true"},
		{permissionsTestSessionID, "extra"},
		{},
	} {
		if code := runPermissions(arguments, &stdout, &stderr); code != 2 {
			t.Fatalf("%v: exit = %d, want 2", arguments, code)
		}
	}
}

func TestPermissionsRejectsASwitchGivenTwice(t *testing.T) {
	service, calls := permissionsService(t, map[string]any{})
	linkedAccount(t, service.URL)
	/*
	 * Consent is not a place for last-one-wins: a contradictory pair is far
	 * more likely to be a paste mistake than an intent, and the caller cannot
	 * tell from the output which value was saved.
	 */
	for _, arguments := range [][]string{
		{permissionsTestSessionID, "--daily-briefing=true", "--daily-briefing=false"},
		{permissionsTestSessionID, "--mcp-team-access=false", "--mcp-team-access=false"},
		{permissionsTestSessionID, "--briefing-team-access", "true", "--briefing-team-access=true"},
	} {
		var stdout, stderr bytes.Buffer
		if code := runPermissions(arguments, &stdout, &stderr); code != 2 {
			t.Fatalf("%v: exit = %d, want 2 (stderr %q)", arguments, code, stderr.String())
		}
		if !strings.Contains(stderr.String(), "more than once") {
			t.Fatalf("%v: stderr = %q", arguments, stderr.String())
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("a rejected duplicate still called the service: %+v", *calls)
	}
}

func TestPermissionsExplainsAnUnlinkedMachine(t *testing.T) {
	t.Setenv("SHELL_ONLINE_CONFIG", filepath.Join(t.TempDir(), "absent.json"))
	var stdout, stderr bytes.Buffer
	if code := runPermissions([]string{permissionsTestSessionID}, &stdout, &stderr); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	for _, expected := range []string{"not signed in", "shell auth"} {
		if !strings.Contains(stderr.String(), expected) {
			t.Errorf("stderr does not contain %q: %q", expected, stderr.String())
		}
	}
}

func TestPermissionsReportsARejectionWithoutClaimingSuccess(t *testing.T) {
	service := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(writer).Encode(map[string]string{
			"error": "only the session's owner can change its automation settings",
		})
	}))
	defer service.Close()
	linkedAccount(t, service.URL)
	var stdout, stderr bytes.Buffer
	code := runPermissions(
		[]string{permissionsTestSessionID, "--daily-briefing=true"}, &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	if strings.Contains(stdout.String(), "Daily briefing: on") {
		t.Errorf("a refused update was reported as saved:\n%s", stdout.String())
	}
	if !strings.Contains(stderr.String(), "owner") {
		t.Errorf("stderr = %q", stderr.String())
	}
}

func TestPermissionsHelpPrintsUsage(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := runPermissions([]string{"--help"}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	for _, expected := range []string{
		"shell permissions <session-id>",
		"--mcp-team-access=true|false",
		"--daily-briefing=true|false",
		"--briefing-team-access=true|false",
	} {
		if !strings.Contains(stdout.String(), expected) {
			t.Errorf("help does not contain %q:\n%s", expected, stdout.String())
		}
	}
}

func TestRunSessionCommandRoutesPermissions(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code, handled := runSessionCommand([]string{"permissions", "--help"}, &stdout, &stderr)
	if !handled || code != 0 {
		t.Fatalf("permissions --help = %d, handled %v", code, handled)
	}
}
