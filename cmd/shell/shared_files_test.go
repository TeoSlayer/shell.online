package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestSharedFilesRequireE2EE(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"--no-e2ee", "--files", "true"}, &stdout, &stderr); code != 2 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr.String())
	}
	if !bytes.Contains(stderr.Bytes(), []byte("require end-to-end encryption")) {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestSharedFilesAreOptInAndRooted(t *testing.T) {
	service, err := openSharedFileService(false, "")
	if err != nil || service != nil {
		t.Fatalf("disabled service = %#v, %v", service, err)
	}

	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "hello.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "src"), 0o700); err != nil {
		t.Fatal(err)
	}
	service, err = openSharedFileService(false, root)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	entries, err := service.list("")
	if err != nil || len(entries) != 2 || entries[0].Name != "src" || entries[1].Name != "hello.txt" {
		t.Fatalf("entries = %#v, %v", entries, err)
	}
	if _, err := service.validPath("../outside.txt"); err == nil {
		t.Fatal("accepted parent traversal")
	}
	inside, err := service.validPath(filepath.Join(root, "hello.txt"))
	if err != nil || inside != "hello.txt" {
		t.Fatalf("absolute in-root path = %q, %v", inside, err)
	}
	if _, err := service.validPath(filepath.Join(filepath.Dir(root), "outside.txt")); err == nil {
		t.Fatal("accepted absolute path outside the shared root")
	}
}

func TestSharedFilesDoNotAdvertiseSymlinks(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	service, err := openSharedFileService(false, root)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	entries, err := service.list("")
	if err != nil || len(entries) != 0 {
		t.Fatalf("symlink entries = %#v, %v", entries, err)
	}
	if _, err := service.root.Open("escape.txt"); err == nil {
		t.Fatal("os.Root followed a symlink outside the shared root")
	}
}

func TestSharedFileMediaTypeIsCanonicalAndSniffed(t *testing.T) {
	root := t.TempDir()
	markdown := filepath.Join(root, "README.md")
	if err := os.WriteFile(markdown, []byte("# Shared files\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(markdown)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if got := sharedFileMediaType(file, markdown); got != "text/plain" && got != "text/markdown" {
		t.Fatalf("markdown media type = %q", got)
	}
}
