package e2ee

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"
)

func TestFrameRoundTripAndTamperRejection(t *testing.T) {
	cipher, fragment, err := Generate("")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(fragment, "#key=") {
		t.Fatalf("fragment = %q", fragment)
	}
	frame := append([]byte{0x01}, bytes.Repeat([]byte("secret terminal bytes"), 20)...)
	sealed, err := cipher.SealFrame(frame)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("secret terminal bytes")) {
		t.Fatal("ciphertext contains plaintext")
	}
	opened, err := cipher.OpenFrame(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(opened, frame) {
		t.Fatal("round trip changed frame")
	}
	opcodeTamper := append([]byte(nil), sealed...)
	opcodeTamper[0] ^= 1
	if _, err := cipher.OpenFrame(opcodeTamper); err == nil {
		t.Fatal("modified opcode authenticated")
	}
	sealed[len(sealed)-1] ^= 1
	if _, err := cipher.OpenFrame(sealed); err == nil {
		t.Fatal("tampered frame authenticated")
	}
}

func TestCrossLanguageVector(t *testing.T) {
	key := make([]byte, 32)
	for index := range key {
		key[index] = byte(index)
	}
	nonce := make([]byte, 12)
	for index := range nonce {
		nonce[index] = byte(index)
	}
	cipher, err := New(key)
	if err != nil {
		t.Fatal(err)
	}
	for index := range cipher.sendStream {
		cipher.sendStream[index] = byte(index)
	}
	sealed, err := cipher.sealFrameWithNonce(append([]byte{1}, []byte("hello")...), nonce)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(sealed) != "01020100010203040506070000000000000001000102030405060708090a0b2f67ba77aaca8b8b050124ea94b7b8803644a14b0b" {
		t.Fatalf("vector = %x", sealed)
	}
}

func TestFrameSequenceRejectsReplayAndAllowsLimitedReordering(t *testing.T) {
	key := bytes.Repeat([]byte{4}, KeyBytes)
	cipher, err := New(key)
	if err != nil {
		t.Fatal(err)
	}
	frames := make([][]byte, 3)
	for index := range frames {
		frames[index], err = cipher.SealFrame([]byte{0x02, byte('a' + index)})
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, index := range []int{2, 0, 1} {
		if _, err := cipher.OpenFrame(frames[index]); err != nil {
			t.Fatalf("open reordered frame %d: %v", index, err)
		}
	}
	if _, err := cipher.OpenFrame(frames[1]); err == nil {
		t.Fatal("replayed frame authenticated")
	}
}

func TestPasswordModeProducesSaltOnly(t *testing.T) {
	_, fragment, err := Generate("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(fragment, "#salt=") || strings.Contains(fragment, "correct") {
		t.Fatalf("password leaked in fragment %q", fragment)
	}
}

func TestPasswordDerivationCompatibilityVector(t *testing.T) {
	salt := make([]byte, SaltBytes)
	for index := range salt {
		salt[index] = byte(index)
	}
	key, err := DerivePasswordKey("test password", salt)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(key) != "1ad5d77f9a39c82adf8284238480beab5734a27bdf4c249cda309ade5f51df7d" {
		t.Fatalf("derived key = %x", key)
	}
}

func TestGeneratedBrowserPasswordIsTenCharacterBase64URL(t *testing.T) {
	password, err := GenerateBrowserPassword()
	if err != nil {
		t.Fatal(err)
	}
	if len(password) != BrowserPasswordLength {
		t.Fatalf("password length = %d, want %d", len(password), BrowserPasswordLength)
	}
	for _, character := range password {
		if !strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", character) {
			t.Fatalf("password contains non-base64url character %q", character)
		}
	}
}

func TestBrowserPasswordValidationRejectsUnsafeOutput(t *testing.T) {
	for _, password := range []string{"", "line\nbreak", string([]byte{0xff}), strings.Repeat("x", MaxBrowserPasswordBytes+1)} {
		if ValidateBrowserPassword(password) == nil {
			t.Fatalf("accepted invalid browser password %q", password)
		}
	}
	if err := ValidateBrowserPassword("correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
}

func TestTargetedSnapshotSurvivesRelayHeaderRemoval(t *testing.T) {
	key := bytes.Repeat([]byte{7}, KeyBytes)
	cipher, err := New(key)
	if err != nil {
		t.Fatal(err)
	}
	frame := append([]byte{0x03, 0, 0, 0, 42}, []byte("snapshot")...)
	sealed, err := cipher.SealFrame(frame)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(sealed[:5], frame[:5]) {
		t.Fatal("target routing header changed")
	}
	relayed := append([]byte{0x03}, sealed[5:]...)
	opened, err := cipher.OpenFrame(relayed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(opened, append([]byte{0x03}, []byte("snapshot")...)) {
		t.Fatalf("opened snapshot = %x", opened)
	}
}

func TestTargetedFileFramesSurviveRelayRouting(t *testing.T) {
	key := bytes.Repeat([]byte{8}, KeyBytes)
	cipher, err := New(key)
	if err != nil {
		t.Fatal(err)
	}

	response := append([]byte{0x0b, 0, 0, 0, 42}, []byte("file bytes")...)
	sealedResponse, err := cipher.SealFrame(response)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(sealedResponse[:5], response[:5]) {
		t.Fatal("file response routing header changed")
	}
	relayedResponse := append([]byte{0x0b}, sealedResponse[5:]...)
	openedResponse, err := cipher.OpenFrame(relayedResponse)
	if err != nil || !bytes.Equal(openedResponse, append([]byte{0x0b}, []byte("file bytes")...)) {
		t.Fatalf("opened response = %x, err %v", openedResponse, err)
	}

	request, err := cipher.SealFrame(append([]byte{0x0a}, []byte("request")...))
	if err != nil {
		t.Fatal(err)
	}
	targetedRequest := append([]byte{0x0a, 0, 0, 0, 42}, request[1:]...)
	openedRequest, err := cipher.OpenFrame(targetedRequest)
	wantRequest := append([]byte{0x0a, 0, 0, 0, 42}, []byte("request")...)
	if err != nil || !bytes.Equal(openedRequest, wantRequest) {
		t.Fatalf("opened request = %x, err %v", openedRequest, err)
	}
}
