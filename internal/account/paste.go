package account

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

/*
 * A browser that cannot reach this machine.
 *
 * --no-browser exists for a machine with no browser on it: a server, a
 * container, something over SSH. The person opens the printed link on a
 * computer that has one, approves, and that browser is then redirected to a
 * loopback address which on that computer means nothing. It stops on an error
 * page with the whole callback URL in the address bar -- code, state and all
 * -- and until now there was nothing to do with it. The CLI went on waiting
 * for a callback that could never arrive and gave up five minutes later.
 *
 * So it is read back instead. The URL is what a browser makes easy to copy,
 * and a bare code is what somebody who has read the URL would rather paste.
 */

// errNothingPasted is a blank line: somebody pressed return, which is not an
// answer and not a mistake worth a message.
var errNothingPasted = errors.New("nothing pasted")

// codeShape is what an authorization code can look like. The service mints
// them as a prefix and base64url, and this is deliberately about shape rather
// than that exact format: the code is proved by the exchange, and a paste that
// is merely the wrong length should be described as what it is rather than
// sent to the service to be refused.
var codeShape = regexp.MustCompile(`^[A-Za-z0-9_-]{8,256}$`)

// pastedCallback reads one line copied out of a browser.
//
// The state is checked whenever the paste carries one, which a copied URL
// always does. A bare code carries none, and is still safe to accept: it is
// single-use, bound to the redirect URI, and worthless without the PKCE
// verifier this process is holding and never sent anywhere.
func pastedCallback(line, state string) (callbackResult, error) {
	line = strings.TrimSpace(line)
	if line == "" {
		return callbackResult{}, errNothingPasted
	}

	if parsed, err := url.Parse(line); err == nil && parsed.Scheme != "" && parsed.RawQuery != "" {
		query := parsed.Query()
		if failure := query.Get("error"); failure != "" {
			description := query.Get("error_description")
			if description == "" {
				description = failure
			}
			return callbackResult{}, fmt.Errorf("that sign-in was refused: %s", description)
		}
		code := query.Get("code")
		if code == "" {
			return callbackResult{}, errors.New("that link carries no authorization code")
		}
		if !SameState(state, query.Get("state")) {
			return callbackResult{}, errors.New("that link came from a different sign-in; run shell auth again")
		}
		accountKey := query.Get("account_key")
		if ParseAccountKey(accountKey) != nil {
			accountKey = ""
		}
		return callbackResult{code: code, accountKey: accountKey}, nil
	}

	if !codeShape.MatchString(line) {
		return callbackResult{}, errors.New("that is neither the URL the browser stopped on nor an authorization code")
	}
	return callbackResult{code: line}, nil
}
