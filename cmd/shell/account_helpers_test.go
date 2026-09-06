package main

import "os"

func writeFileForTest(path, contents string) error {
	return os.WriteFile(path, []byte(contents), 0o600)
}
