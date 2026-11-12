package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"

	"shell.online/internal/e2ee"
)

// passwordEnvironment is how a person hands shell.online a browser password
// of their own choosing.
const passwordEnvironment = "SHELL_ONLINE_E2EE_PASSWORD"

// passwordOnStdinEnvironment tells a shell process that its browser password
// arrives on standard input rather than in passwordEnvironment.
//
// A process's environment is readable by every other process of the same
// user for as long as it runs (`ps -E`, /proc/<pid>/environ), and unsetting a
// variable later does not change what those report. A browser-started
// session and every background session live for hours, so between shell's
// own processes the password travels over a pipe and never enters an
// environment at all. Only this marker does, and it holds no secret.
const passwordOnStdinEnvironment = "SHELL_ONLINE_E2EE_PASSWORD_STDIN"

// suppliedPassword returns the browser password this process was given, or
// empty when it was given none and should generate one.
func suppliedPassword(getenv func(string) string, stdin io.Reader) (string, error) {
	if getenv(passwordOnStdinEnvironment) != "1" {
		return getenv(passwordEnvironment), nil
	}
	contents, err := io.ReadAll(io.LimitReader(stdin, e2ee.MaxBrowserPasswordBytes+1))
	if err != nil {
		return "", fmt.Errorf("read the browser password: %w", err)
	}
	if len(contents) > e2ee.MaxBrowserPasswordBytes {
		return "", fmt.Errorf("browser password must not exceed %d bytes", e2ee.MaxBrowserPasswordBytes)
	}
	return string(contents), nil
}

// passwordHandoffEnvironment is the environment for a shell process that is
// handed password with startWithPassword. Neither form a parent was given
// is passed on, so the child reads the password from its pipe or not at all.
func passwordHandoffEnvironment(environment []string, password string) []string {
	environment = removeEnvironmentVariables(environment, passwordEnvironment, passwordOnStdinEnvironment)
	if password == "" {
		return environment
	}
	return setEnvironmentValue(environment, passwordOnStdinEnvironment, "1")
}

// startWithPassword starts command with password on its standard input. With
// no password, command is started as it is.
//
// The pipe replaces whatever Stdin was: the child reads it to the end before
// anything else, after which it is at end-of-file just like the null device
// a background process otherwise gets.
func startWithPassword(command *exec.Cmd, password string) error {
	if password == "" {
		return command.Start()
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		return fmt.Errorf("create password channel: %w", err)
	}
	command.Stdin = reader
	if err := command.Start(); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		return err
	}
	_ = reader.Close()
	/* A child that died before reading reports that on its readiness channel. */
	_, _ = io.WriteString(writer, password)
	return writer.Close()
}
