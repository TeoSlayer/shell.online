package account

import "testing"

func TestContentMarkdownLayout(t *testing.T) {
	if !validContentTextWithLayout("## Work\n\n- one\n\tcode", 600, true) {
		t.Fatal("Markdown layout rejected")
	}
	if validContentText("bad\ntitle", 120) {
		t.Fatal("title allowed a newline")
	}
	for _, text := range []string{"bad\x1b", "bad\u202e", "bad\x00", "bad\r"} {
		if validContentTextWithLayout(text, 600, true) {
			t.Fatal("unsafe control accepted")
		}
	}
}
