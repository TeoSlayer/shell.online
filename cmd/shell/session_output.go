package main

import (
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

func printSessionCard(writer io.Writer, result backgroundLaunchResult, background bool) {
	color := sessionOutputUsesColor(writer)
	brand := styleSessionText(color, "38;5;111", "shell.online")
	spark := styleSessionText(color, "38;5;183", "✦")
	label := func(value string) string { return styleSessionText(color, "2", fmt.Sprintf("%-10s", value)) }
	value := func(value string) string { return styleSessionText(color, "38;5;153", value) }

	fmt.Fprintf(writer, "\n  %s  %s\n", brand, spark)
	fmt.Fprintln(writer)
	fmt.Fprintf(writer, "  %s %s\n", label("Link"), value(result.ShareURL))
	if result.Password != "" {
		fmt.Fprintf(writer, "  %s %s\n", label("Password"), styleSessionText(color, "1;38;5;222", result.Password))
	}

	access := "interactive"
	if result.ReadOnly {
		access = "view only"
	}
	privacy := "end-to-end encrypted"
	if !result.Encrypted {
		privacy = "transport encryption only"
	}
	fmt.Fprintf(writer, "  %s %s · %s\n", label("Access"), access, styleSessionText(color, "38;5;114", privacy))

	sessionLabel := shortSessionID(result.ID)
	if background {
		sessionLabel += " · background"
	}
	if result.Persistent {
		sessionLabel += " · persistent"
	}
	fmt.Fprintf(writer, "  %s %s\n", label("Session"), sessionLabel)
	if result.ClosesAt == nil {
		fmt.Fprintf(writer, "  %s when the task exits\n", label("Closes"))
	} else {
		fmt.Fprintf(writer, "  %s %s, or when the task exits\n", label("Closes"), result.ClosesAt.Format(time.RFC3339))
	}
	if !result.Encrypted {
		fmt.Fprintf(writer, "  %s %s\n", label("Privacy"), styleSessionText(color, "38;5;209", "Cloudflare can relay terminal plaintext (--no-e2ee)"))
	}
	if result.Handoff == claudeConversationHandoff {
		fmt.Fprintf(writer, "  %s forked Claude conversation; the original stays open\n", label("Handoff"))
	}

	if background {
		fmt.Fprintln(writer)
		fmt.Fprintf(writer, "  %s %s\n", label("Rejoin"), value("shell attach "+shortSessionID(result.ID)))
		fmt.Fprintf(writer, "  %s %s\n", label("Stop"), value("shell kill "+shortSessionID(result.ID)))
	}
	fmt.Fprintln(writer)
}

func styleSessionText(enabled bool, code, value string) string {
	if !enabled {
		return value
	}
	return "\x1b[" + code + "m" + value + "\x1b[0m"
}

func sessionOutputUsesColor(writer io.Writer) bool {
	if os.Getenv("NO_COLOR") != "" || os.Getenv("TERM") == "dumb" {
		return false
	}
	file, ok := writer.(*os.File)
	if !ok {
		return false
	}
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func startSessionAnimation(writer io.Writer) func() {
	if !sessionOutputUsesColor(writer) {
		return func() {}
	}
	done := make(chan struct{})
	finished := make(chan struct{})
	var once sync.Once
	go func() {
		defer close(finished)
		frames := []string{"∙", "◦", "○", "◦"}
		ticker := time.NewTicker(90 * time.Millisecond)
		defer ticker.Stop()
		index := 0
		for {
			fmt.Fprintf(writer, "\r\x1b[2K  \x1b[38;5;111mshell.online\x1b[0m  \x1b[38;5;183m%s\x1b[0m connecting", frames[index])
			index = (index + 1) % len(frames)
			select {
			case <-done:
				fmt.Fprint(writer, "\r\x1b[2K")
				return
			case <-ticker.C:
			}
		}
	}()
	return func() {
		once.Do(func() { close(done) })
		<-finished
	}
}
