//go:build !windows

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"time"

	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

const (
	localDetachPrefix          = byte(0x18) // Ctrl-X
	legacyLocalDetachByte      = byte(0x1d) // Ctrl-]
	localDetachSequenceTimeout = 750 * time.Millisecond
	saveTitle                  = "\x1b[22;0t"
	setAttachTitle             = "\x1b]2;shell.online | Ctrl-X D to detach\x1b\\"
	restoreTitle               = "\x1b[23;0t"
	restoreTerminalDisplay     = "\x18\x1b\\\x1b[0m\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1l\x1b>\x1b[?1049l"
)

type localDetachFilter struct {
	pendingPrefix bool
	pendingSince  time.Time
}

func (filter *localDetachFilter) consume(value []byte, now time.Time) ([]byte, bool) {
	forward := make([]byte, 0, len(value)+1)
	for _, candidate := range value {
		if candidate == legacyLocalDetachByte {
			filter.pendingPrefix = false
			filter.pendingSince = time.Time{}
			return forward, true
		}

		if filter.pendingPrefix {
			if candidate == 'd' || candidate == 'D' {
				filter.pendingPrefix = false
				filter.pendingSince = time.Time{}
				return forward, true
			}
			forward = append(forward, localDetachPrefix)
			filter.pendingPrefix = false
			filter.pendingSince = time.Time{}
		}

		if candidate == localDetachPrefix {
			filter.pendingPrefix = true
			filter.pendingSince = now
			continue
		}
		forward = append(forward, candidate)
	}
	return forward, false
}

func (filter *localDetachFilter) flushExpired(now time.Time) []byte {
	if !filter.pendingPrefix || now.Sub(filter.pendingSince) < localDetachSequenceTimeout {
		return nil
	}
	filter.pendingPrefix = false
	filter.pendingSince = time.Time{}
	return []byte{localDetachPrefix}
}

type attachOutputState uint8

const (
	attachOutputGround attachOutputState = iota
	attachOutputEscape
	attachOutputOSC
	attachOutputOSCEscape
)

type attachOutputWriter struct {
	output      io.Writer
	titleOutput io.Writer
	state       attachOutputState
}

func (writer *attachOutputWriter) Write(value []byte) (int, error) {
	written := 0
	segmentStart := 0
	flush := func(segmentEnd int) error {
		if segmentEnd <= segmentStart {
			return nil
		}
		count, err := writer.output.Write(value[segmentStart:segmentEnd])
		written += count
		segmentStart += count
		if err != nil {
			return err
		}
		if segmentStart != segmentEnd {
			return io.ErrShortWrite
		}
		return nil
	}
	reassertTitle := func(segmentEnd int) error {
		if err := flush(segmentEnd); err != nil {
			return err
		}
		_, _ = io.WriteString(writer.titleOutput, setAttachTitle)
		return nil
	}

	for index, candidate := range value {
		switch writer.state {
		case attachOutputGround:
			switch candidate {
			case 0x1b:
				writer.state = attachOutputEscape
			case 0x9d:
				writer.state = attachOutputOSC
			}
		case attachOutputEscape:
			if candidate == ']' {
				writer.state = attachOutputOSC
			} else if candidate != 0x1b {
				writer.state = attachOutputGround
			}
		case attachOutputOSC:
			switch candidate {
			case 0x07, 0x9c:
				writer.state = attachOutputGround
				if err := reassertTitle(index + 1); err != nil {
					return written, err
				}
			case 0x1b:
				writer.state = attachOutputOSCEscape
			}
		case attachOutputOSCEscape:
			if candidate == '\\' {
				writer.state = attachOutputGround
				if err := reassertTitle(index + 1); err != nil {
					return written, err
				}
			} else if candidate != 0x1b {
				writer.state = attachOutputOSC
			}
		}
	}
	if err := flush(len(value)); err != nil {
		return written, err
	}
	return written, nil
}

func attachLocalSession(id string, stdout, stderr io.Writer) error {
	if !localSessionIDPattern.MatchString(id) {
		return fmt.Errorf("invalid session id")
	}
	stdin := os.Stdin
	stdinFD := int(stdin.Fd())
	if !term.IsTerminal(stdinFD) {
		return fmt.Errorf("local attach requires an interactive terminal")
	}

	directory, err := localSessionDirectory()
	if err != nil {
		return err
	}
	connection, err := net.DialTimeout("unix", localSessionSocketPath(directory, id), time.Second)
	if err != nil {
		return err
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := fmt.Fprintln(connection, "attach"); err != nil {
		return err
	}

	reader := bufio.NewReader(connection)
	responseLine, err := reader.ReadBytes('\n')
	if err != nil {
		return err
	}
	var response localControlResponse
	if err := json.Unmarshal(responseLine, &response); err != nil {
		return err
	}
	if !response.OK {
		if response.Error == "" {
			response.Error = "request rejected"
		}
		return errors.New(response.Error)
	}
	_ = connection.SetDeadline(time.Time{})

	fmt.Fprintf(stderr, "Attached to %s. Press Ctrl-X, then D to detach (Ctrl-] also works).\r\n", shortSessionID(id))
	_, _ = io.WriteString(stderr, saveTitle+setAttachTitle)
	defer func() {
		_, _ = io.WriteString(stderr, restoreTitle)
	}()
	previousState, err := term.MakeRaw(stdinFD)
	if err != nil {
		return fmt.Errorf("enter raw terminal mode: %w", err)
	}
	restored := false
	defer func() {
		if !restored {
			_ = term.Restore(stdinFD, previousState)
		}
	}()

	outputDone := make(chan error, 1)
	go func() {
		_, copyError := io.Copy(&attachOutputWriter{output: stdout, titleOutput: stderr}, reader)
		outputDone <- copyError
	}()

	detached := false
	remoteEnded := false
	buffer := make([]byte, 32*1024)
	inputFilter := localDetachFilter{}
inputLoop:
	for {
		select {
		case <-outputDone:
			remoteEnded = true
			break inputLoop
		default:
		}
		if pending := inputFilter.flushExpired(time.Now()); len(pending) > 0 {
			if err := writeAll(connection, pending); err != nil {
				remoteEnded = true
				break inputLoop
			}
		}

		descriptors := []unix.PollFd{{Fd: int32(stdinFD), Events: unix.POLLIN}}
		_, pollError := unix.Poll(descriptors, 100)
		if pollError != nil {
			if errors.Is(pollError, unix.EINTR) {
				continue
			}
			return pollError
		}
		if descriptors[0].Revents&unix.POLLIN == 0 {
			continue
		}

		count, readError := stdin.Read(buffer)
		if count > 0 {
			forward, shouldDetach := inputFilter.consume(buffer[:count], time.Now())
			if len(forward) > 0 {
				if err := writeAll(connection, forward); err != nil {
					remoteEnded = true
					break inputLoop
				}
			}
			if shouldDetach {
				detached = true
				break inputLoop
			}
		}
		if readError != nil {
			if !errors.Is(readError, io.EOF) {
				return readError
			}
			break inputLoop
		}
	}

	_ = connection.Close()
	if !remoteEnded {
		select {
		case <-outputDone:
		case <-time.After(500 * time.Millisecond):
		}
	}
	_, _ = io.WriteString(stderr, restoreTerminalDisplay)
	discardPendingTerminalInput(stdin, stdinFD)
	_ = term.Restore(stdinFD, previousState)
	restored = true
	if detached {
		fmt.Fprintf(stderr, "\r\nDetached from %s.\n", shortSessionID(id))
	} else {
		fmt.Fprintf(stderr, "\r\nSession %s ended.\n", shortSessionID(id))
	}
	return nil
}

func discardPendingTerminalInput(stdin *os.File, stdinFD int) {
	const quietPeriod = 80 * time.Millisecond
	const maximumWait = 300 * time.Millisecond
	quietDeadline := time.Now().Add(quietPeriod)
	finalDeadline := time.Now().Add(maximumWait)
	buffer := make([]byte, 4096)
	for {
		now := time.Now()
		if !now.Before(quietDeadline) || !now.Before(finalDeadline) {
			return
		}
		wait := min(quietDeadline.Sub(now), finalDeadline.Sub(now))
		timeout := max(1, int((wait+time.Millisecond-1)/time.Millisecond))
		descriptors := []unix.PollFd{{Fd: int32(stdinFD), Events: unix.POLLIN}}
		ready, err := unix.Poll(descriptors, timeout)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return
		}
		if ready == 0 || descriptors[0].Revents&unix.POLLIN == 0 {
			return
		}
		if _, err := stdin.Read(buffer); err != nil {
			return
		}
		quietDeadline = time.Now().Add(quietPeriod)
	}
}
