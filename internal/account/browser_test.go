package account

import "testing"

func TestOpenBrowserRefusesNonHTTPSchemes(t *testing.T) {
	// The target comes from configuration, so a hostile value must not reach
	// the system opener, which would happily run a registered protocol handler.
	for _, target := range []string{
		"file:///etc/passwd",
		"javascript:alert(1)",
		"ms-msdt:/id",
		"vscode://file/etc/passwd",
		"",
	} {
		if err := OpenBrowser(target); err == nil {
			t.Fatalf("OpenBrowser(%q) should have refused", target)
		}
	}
}
