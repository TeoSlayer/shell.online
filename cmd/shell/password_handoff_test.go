package main

import (
	"bytes"
	"os/exec"
	"runtime"
	"strings"
	"testing"

	"shell.online/internal/e2ee"
)

func environmentOf(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func TestSuppliedPasswordReadsTheEnvironmentWithoutTheMarker(t *testing.T) {
	password, err := suppliedPassword(environmentOf(map[string]string{passwordEnvironment: "Chosen1234"}), strings.NewReader("ignored"))
	if err != nil || password != "Chosen1234" {
		t.Fatalf("suppliedPassword() = %q, %v", password, err)
	}
	password, err = suppliedPassword(environmentOf(nil), strings.NewReader("ignored"))
	if err != nil || password != "" {
		t.Fatalf("with nothing supplied = %q, %v; want empty so one is generated", password, err)
	}
}

func TestSuppliedPasswordPrefersStandardInputWhenMarked(t *testing.T) {
	password, err := suppliedPassword(environmentOf(map[string]string{
		passwordOnStdinEnvironment: "1",
		passwordEnvironment:        "Stale12345",
	}), strings.NewReader("FromPipe99"))
	if err != nil || password != "FromPipe99" {
		t.Fatalf("suppliedPassword() = %q, %v", password, err)
	}
}

func TestSuppliedPasswordRefusesAnOverlongPipe(t *testing.T) {
	_, err := suppliedPassword(
		environmentOf(map[string]string{passwordOnStdinEnvironment: "1"}),
		strings.NewReader(strings.Repeat("a", e2ee.MaxBrowserPasswordBytes+1)),
	)
	if err == nil {
		t.Fatal("an over-long password was accepted")
	}
}

func TestPasswordHandoffEnvironmentNeverCarriesThePassword(t *testing.T) {
	inherited := []string{"PATH=/bin", passwordEnvironment + "=Parent1234", passwordOnStdinEnvironment + "=1"}

	with := passwordHandoffEnvironment(append([]string(nil), inherited...), "Child12345")
	if value := environmentValue(with, passwordEnvironment); value != "" {
		t.Errorf("password left in the environment: %q", value)
	}
	if value := environmentValue(with, passwordOnStdinEnvironment); value != "1" {
		t.Errorf("marker = %q, want 1", value)
	}
	for _, entry := range with {
		if strings.Contains(entry, "Child12345") {
			t.Errorf("the handed-down password is in the environment: %q", entry)
		}
	}

	without := passwordHandoffEnvironment(append([]string(nil), inherited...), "")
	if value := environmentValue(without, passwordEnvironment); value != "" {
		t.Errorf("inherited password passed on: %q", value)
	}
	if value := environmentValue(without, passwordOnStdinEnvironment); value != "" {
		t.Errorf("marker set with no password to read: %q", value)
	}
}

func TestStartWithPasswordDeliversItOnStandardInput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses cat")
	}
	var output bytes.Buffer
	command := exec.Command("cat")
	command.Stdout = &output
	if err := startWithPassword(command, "Piped12345"); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	if output.String() != "Piped12345" {
		t.Fatalf("child read %q", output.String())
	}
}
