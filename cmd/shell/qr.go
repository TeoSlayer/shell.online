package main

import (
	"fmt"
	"net/url"
	"strings"

	qrcode "github.com/skip2/go-qrcode"
)

const maxTerminalQRModules = 57

// sessionQRPayload returns a one-scan browser credential. The password lives
// in the fragment, which browsers do not send in HTTP or WebSocket requests.
// The ordinary printed link deliberately remains password-free so people can
// still send the two pieces separately.
func sessionQRPayload(result backgroundLaunchResult) (string, error) {
	parsed, err := url.Parse(result.ShareURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid share URL")
	}
	if result.Password != "" {
		fragment, err := url.ParseQuery(parsed.Fragment)
		if err != nil {
			return "", fmt.Errorf("invalid share fragment: %w", err)
		}
		fragment.Set("password", result.Password)
		parsed.Fragment = fragment.Encode()
	}
	return parsed.String(), nil
}

// terminalQRCode renders two QR rows per terminal row using Unicode half
// blocks. Explicit black and white ANSI colours make the code independent of
// the user's light or dark theme. The encoder is pure Go, so this remains
// available on every release architecture.
func terminalQRCode(content string) (string, error) {
	code, err := qrcode.New(content, qrcode.Low)
	if err != nil {
		return "", err
	}
	bitmap := code.Bitmap()
	if len(bitmap) == 0 || len(bitmap) > maxTerminalQRModules {
		return "", fmt.Errorf("QR code is too large for a terminal")
	}

	var rendered strings.Builder
	for topRow := 0; topRow < len(bitmap); topRow += 2 {
		rendered.WriteString("  ")
		for column := range bitmap[topRow] {
			top := bitmap[topRow][column]
			bottom := topRow+1 < len(bitmap) && bitmap[topRow+1][column]
			switch {
			case top && bottom:
				rendered.WriteString("\x1b[40m ")
			case top:
				rendered.WriteString("\x1b[30;47m▀")
			case bottom:
				rendered.WriteString("\x1b[30;47m▄")
			default:
				rendered.WriteString("\x1b[47m ")
			}
		}
		rendered.WriteString("\x1b[0m\n")
	}
	return rendered.String(), nil
}
