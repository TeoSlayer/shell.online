package account

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// LoginTimeout bounds how long the CLI waits for the browser to come back.
const LoginTimeout = 5 * time.Minute

// callbackResult carries what the browser handed back on the loopback listener.
type callbackResult struct {
	code string
	// accountKey is the vault public key the browser vouched for, or empty
	// when it sent none or sent something that is not a key.
	accountKey string
	err        error
}

// callbackPage is what the person sees after approving, in the browser tab the
// CLI opened. It stays deliberately plain: no assets, no network, no script.
const callbackPage = `<!doctype html>
<meta charset="utf-8">
<title>%s | shell.online</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-content:center;place-items:center;
       background:#f3f1e9;color:#191b18;font:16px/1.6 system-ui,sans-serif;text-align:center}
  h1{margin:0 0 10px;font-size:26px;font-weight:450;letter-spacing:-.03em}
  p{margin:0;color:#686c63;font-size:14px;max-width:34ch}
  @media(prefers-color-scheme:dark){body{background:#161914;color:#f1f2ea}p{color:#9ca194}}
</style>
<h1>%s</h1>
<p>%s</p>
`

func writePage(writer http.ResponseWriter, status int, title, heading, body string) {
	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	fmt.Fprintf(writer, callbackPage, title, heading, body)
}

// signedInPath is where a linked browser is sent once the CLI has its code.
//
// The sessions page, because that is the thing the person came for: they ran
// shell login to get their terminals into the app, and the tab they approved
// in is already there.
const signedInPath = "/sessions?linked=1"

// successRedirect is where to send the browser after a successful callback, or
// empty when there is nowhere better than the plain page.
//
// A relative or otherwise unparseable web URL yields nothing rather than a
// broken Location header, and anything but http(s) is refused: this value
// reaches a browser as somewhere to go, and the CLI should not be a way to
// open arbitrary schemes.
func successRedirect(webURL string) string {
	if webURL == "" {
		return ""
	}
	parsed, err := url.Parse(webURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return ""
	}
	return strings.TrimRight(parsed.Scheme+"://"+parsed.Host, "/") + signedInPath
}

// newCallbackHandler serves the single loopback callback for one login.
//
// It reports exactly one result on results and ignores anything after, so a
// refresh or a stray probe cannot resolve the login twice.
//
// webURL, when usable, is where the browser is sent once the code is in hand.
// The redirect happens after the result is delivered, so a browser that never
// follows it still leaves the terminal signed in.
func newCallbackHandler(state, webURL string, results chan<- callbackResult) http.Handler {
	onwards := successRedirect(webURL)
	delivered := false
	deliver := func(result callbackResult) {
		if delivered {
			return
		}
		delivered = true
		results <- result
	}

	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/callback" {
			http.NotFound(writer, request)
			return
		}
		query := request.URL.Query()

		if failure := query.Get("error"); failure != "" {
			description := query.Get("error_description")
			if description == "" {
				description = failure
			}
			writePage(writer, http.StatusOK, "Sign-in failed", "Sign-in failed", description)
			deliver(callbackResult{err: fmt.Errorf("authorization failed: %s", description)})
			return
		}

		// A mismatched state means this callback did not come from the login
		// this process started, so the code is not ours to use.
		if !SameState(state, query.Get("state")) {
			writePage(writer, http.StatusBadRequest, "Sign-in failed", "Sign-in failed",
				"This link did not come from the sign-in you started. Run shell login again.")
			deliver(callbackResult{err: errors.New("state did not match; sign-in was not completed")})
			return
		}

		code := query.Get("code")
		if code == "" {
			writePage(writer, http.StatusBadRequest, "Sign-in failed", "Sign-in failed",
				"The browser came back without an authorization code.")
			deliver(callbackResult{err: errors.New("no authorization code in callback")})
			return
		}

		// Read only once the state has matched, so it comes from the browser
		// this login opened. It travels browser to loopback directly, which is
		// why it is trusted over whatever the accounts service says later. A
		// malformed value is dropped rather than failing the login: the key is
		// an addition to signing in, not a condition of it.
		accountKey := query.Get("account_key")
		if ParseAccountKey(accountKey) != nil {
			accountKey = ""
		}

		deliver(callbackResult{code: code, accountKey: accountKey})
		if onwards != "" {
			// 303, because the browser should follow this with a GET and not
			// re-send anything from the request that got it here.
			writer.Header().Set("Cache-Control", "no-store")
			http.Redirect(writer, request, onwards, http.StatusSeeOther)
			return
		}
		writePage(writer, http.StatusOK, "Signed in", "You are signed in.",
			"Your terminal is linked. You can close this tab and go back to it.")
	})
}

// Options configures a login attempt.
type Options struct {
	// WebURL is the web app that hosts the approval screen.
	WebURL string
	// Label names this machine in the account's device list.
	Label string
	// MachineID identifies this machine to the accounts service, so a repeat
	// login updates the entry it already has. Empty when this machine could
	// not record one.
	MachineID string
	// Output receives the human-readable progress and the fallback URL.
	Output io.Writer
	// OpenBrowser is swapped out in tests. When nil the system opener is used.
	OpenBrowser func(string) error
	// Timeout overrides LoginTimeout.
	Timeout time.Duration
	// NoBrowser prints the URL and waits without launching anything, for
	// headless machines, CI, and agents driving their own browser.
	NoBrowser bool
}

// Login runs the loopback authorization flow and returns linked credentials.
func Login(ctx context.Context, client *Client, options Options) (Credentials, error) {
	if _, err := url.ParseRequestURI(options.WebURL); err != nil {
		return Credentials{}, fmt.Errorf("invalid web URL %q", options.WebURL)
	}

	verifier, err := NewVerifier()
	if err != nil {
		return Credentials{}, err
	}
	state, err := NewState()
	if err != nil {
		return Credentials{}, err
	}

	// Port 0 lets the OS pick a free port; binding to loopback keeps the
	// callback unreachable from anywhere but this machine.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return Credentials{}, fmt.Errorf("open loopback listener: %w", err)
	}
	defer listener.Close()

	port := listener.Addr().(*net.TCPAddr).Port
	redirectURI := fmt.Sprintf("http://127.0.0.1:%d/callback", port)

	results := make(chan callbackResult, 1)
	server := &http.Server{
		Handler:           newCallbackHandler(state, options.WebURL, results),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() { _ = server.Serve(listener) }()
	defer func() {
		shutdownContext, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownContext)
	}()

	authorizeURL := AuthorizeURL(options.WebURL, redirectURI, state, Challenge(verifier))

	if options.Output != nil {
		if options.NoBrowser {
			fmt.Fprintf(options.Output, "\n  Open this in a browser to sign in:\n\n  %s\n\n", authorizeURL)
		} else {
			fmt.Fprintf(options.Output, "\n  Opening your browser to sign in.\n")
			fmt.Fprintf(options.Output, "  If it does not open, paste this into a browser:\n\n  %s\n\n", authorizeURL)
		}
	}
	if !options.NoBrowser {
		open := options.OpenBrowser
		if open == nil {
			open = OpenBrowser
		}
		if err := open(authorizeURL); err != nil && options.Output != nil {
			fmt.Fprintf(options.Output, "  Could not open a browser automatically: %v\n\n", err)
		}
	}

	timeout := options.Timeout
	if timeout <= 0 {
		timeout = LoginTimeout
	}
	waitContext, cancelWait := context.WithTimeout(ctx, timeout)
	defer cancelWait()

	select {
	case result := <-results:
		if result.err != nil {
			return Credentials{}, result.err
		}
		label := options.Label
		if label == "" {
			label = defaultLabel()
		}
		credentials, err := client.Exchange(ctx, result.code, verifier, redirectURI, label, options.MachineID)
		if err != nil {
			return Credentials{}, err
		}
		credentials.AccountKey = result.accountKey
		return credentials, nil
	case <-waitContext.Done():
		if errors.Is(waitContext.Err(), context.DeadlineExceeded) {
			return Credentials{}, fmt.Errorf("timed out after %s waiting for the browser", timeout)
		}
		return Credentials{}, waitContext.Err()
	}
}

// AuthorizeURL builds the link the browser opens to approve a CLI login.
func AuthorizeURL(webURL, redirectURI, state, challenge string) string {
	base := webURL
	for len(base) > 0 && base[len(base)-1] == '/' {
		base = base[:len(base)-1]
	}
	query := url.Values{}
	query.Set("redirect_uri", redirectURI)
	query.Set("state", state)
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	return base + "/cli/authorize?" + query.Encode()
}

func defaultLabel() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		return "shell cli"
	}
	return host
}
