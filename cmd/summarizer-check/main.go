// Command summarizer-check verifies the hosted summarizer exactly as shell
// hosts do, and fails early when its trust anchors are about to lapse: the
// signed image allowlist must still verify 30 days from now. A scheduled
// workflow runs it so an expiring allowlist or a retired Confidential Space
// image is noticed before hosts start refusing the enclave.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"shell.online/internal/summary"
)

func main() {
	endpoint := flag.String("endpoint", summary.DefaultEndpoint, "summarizer base URL")
	warn := flag.Duration("warn", 30*24*time.Hour, "fail when the allowlist expires within this long")
	flag.Parse()
	if err := check(*endpoint, *warn); err != nil {
		fmt.Fprintln(os.Stderr, "summarizer-check:", err)
		os.Exit(1)
	}
}

func check(endpoint string, warn time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/v1/identity", nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("identity: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if err != nil {
		return err
	}
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("identity: status %d", response.StatusCode)
	}
	var identity summary.Identity
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&identity); err != nil {
		return fmt.Errorf("identity: %w", err)
	}
	verified, err := summary.NewVerifier(summary.DefaultAudience).Verify(ctx, identity)
	if err != nil {
		return fmt.Errorf("hosts would refuse this enclave: %w", err)
	}
	ahead := summary.NewAllowlistVerifier(summary.DefaultAudience)
	ahead.Now = func() time.Time { return time.Now().Add(warn) }
	if _, err := ahead.Verify(identity.Allowlist); err != nil {
		return errors.New("the image allowlist expires within the warning window: sign a new one with the release key")
	}
	fmt.Printf("ok: image %s, attestation token valid until %s\n", verified.ImageDigest, verified.ExpiresAt.UTC().Format(time.RFC3339))
	return nil
}
