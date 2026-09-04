//go:build windows

package main

import (
	"bufio"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

type authenticatedReadyWriter struct{ net.Conn }

func openBackgroundReadyFile() (backgroundReadyWriter, error) {
	if !isBackgroundChild() {
		return nil, nil
	}
	address := os.Getenv(backgroundReadyAddress)
	token := os.Getenv(backgroundReadyToken)
	host, _, err := net.SplitHostPort(address)
	ip := net.ParseIP(host)
	if err != nil || ip == nil || !ip.IsLoopback() || len(token) < 32 {
		return nil, fmt.Errorf("invalid background readiness channel")
	}
	connection, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("connect background readiness channel: %w", err)
	}
	if _, err := fmt.Fprintln(connection, token); err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("authenticate background readiness channel: %w", err)
	}
	return &authenticatedReadyWriter{connection}, nil
}

func launchBackgroundProcess(arguments []string, jsonOutput bool, stdout, stderr io.Writer) int {
	_ = stdout
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintf(stderr, "shell: locate executable: %v\n", err)
		return 1
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(stderr, "shell: create background channel: %v\n", err)
		return 1
	}
	defer listener.Close()
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		fmt.Fprintf(stderr, "shell: secure background channel: %v\n", err)
		return 1
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)

	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		fmt.Fprintf(stderr, "shell: open null device: %v\n", err)
		return 1
	}
	defer null.Close()
	command := exec.Command(executable, arguments...)
	command.Env = setEnvironmentValue(os.Environ(), backgroundChildEnvironment, "1")
	command.Env = setEnvironmentValue(command.Env, backgroundReadyAddress, listener.Addr().String())
	command.Env = setEnvironmentValue(command.Env, backgroundReadyToken, token)
	command.Env = setEnvironmentValue(command.Env, backgroundParentEnvironment, fmt.Sprint(os.Getpid()))
	command.Stdin, command.Stdout, command.Stderr = null, null, null
	command.SysProcAttr = &windows.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
	if err := command.Start(); err != nil {
		fmt.Fprintf(stderr, "shell: start in background: %v\n", err)
		return 1
	}

	stopAnimation := func() {}
	if !jsonOutput {
		stopAnimation = startSessionAnimation(stderr)
	}
	result, decodeError := receiveBackgroundResult(listener, token)
	stopAnimation()
	if decodeError != nil {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
		fmt.Fprintf(stderr, "shell: background session did not start: %v\n", decodeError)
		return 1
	}
	if !result.OK {
		if result.Error == "" {
			result.Error = "unknown startup error"
		}
		if result.ExitCode != nil {
			_, _ = command.Process.Wait()
			fmt.Fprintf(stderr, "shell: %s\n", result.Error)
			return *result.ExitCode
		}
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
		fmt.Fprintf(stderr, "shell: background session did not start: %s\n", result.Error)
		return 1
	}
	if err := command.Process.Release(); err != nil {
		fmt.Fprintf(stderr, "shell: release background process: %v\n", err)
		return 1
	}
	if jsonOutput {
		event := map[string]any{
			"type": "session", "session_id": result.ID, "share_url": result.ShareURL,
			"read_only": result.ReadOnly, "encrypted": result.Encrypted, "persistent": result.Persistent,
			"auto_close": "task", "expires_at": result.ExpiresAt.Format(time.RFC3339), "background": true,
		}
		if result.Password != "" {
			event["e2ee_password"] = result.Password
		}
		if result.ClosesAt != nil {
			event["auto_close"] = "deadline"
			event["closes_at"] = result.ClosesAt.Format(time.RFC3339)
		}
		if result.Handoff != "" {
			event["handoff"] = result.Handoff
		}
		encoded, _ := json.Marshal(event)
		fmt.Fprintf(stderr, "%s\n", encoded)
		return 0
	}
	printSessionCard(stderr, result, true)
	return 0
}

func receiveBackgroundResult(listener net.Listener, token string) (backgroundLaunchResult, error) {
	var result backgroundLaunchResult
	if tcpListener, ok := listener.(*net.TCPListener); ok {
		_ = tcpListener.SetDeadline(time.Now().Add(20 * time.Second))
	}
	connection, err := listener.Accept()
	if err != nil {
		return result, err
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(20 * time.Second))
	reader := bufio.NewReader(io.LimitReader(connection, 20*1024))
	presented, err := reader.ReadString('\n')
	if err != nil {
		return result, err
	}
	presented = strings.TrimSpace(presented)
	if len(presented) != len(token) || subtle.ConstantTimeCompare([]byte(presented), []byte(token)) != 1 {
		return result, fmt.Errorf("background readiness authentication failed")
	}
	if err := json.NewDecoder(reader).Decode(&result); err != nil {
		return result, err
	}
	return result, nil
}
