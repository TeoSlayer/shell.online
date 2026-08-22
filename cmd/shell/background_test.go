package main

import (
	"os"
	"strconv"
	"testing"
)

func TestBackgroundChildRequiresCurrentParent(t *testing.T) {
	t.Setenv(backgroundChildEnvironment, "1")
	t.Setenv(backgroundReadyEnvironment, "3")

	if isBackgroundChild() {
		t.Fatal("a leaked marker without a parent binding must not enable background-child mode")
	}

	t.Setenv(backgroundParentEnvironment, strconv.Itoa(os.Getppid()+1))
	if isBackgroundChild() {
		t.Fatal("a stale marker from another parent must not enable background-child mode")
	}

	t.Setenv(backgroundParentEnvironment, strconv.Itoa(os.Getppid()))
	if !isBackgroundChild() {
		t.Fatal("a marker bound to the current parent should enable background-child mode")
	}
}
