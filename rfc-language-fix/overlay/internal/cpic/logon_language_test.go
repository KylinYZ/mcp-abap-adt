package cpic

import (
	"bytes"
	"testing"
)

func TestEncodesNumericSAPLanguageKey(t *testing.T) {
	seed := uint32(1)
	encoded, err := EncodeInitialLogonRequest(InitialLogonRequestInput{
		Client: "001", User: "RFCUSR", Password: "secret", Language: "1",
		ClientAddress: "127.0.0.1", PartnerHostName: "host.example.test", Destination: "127.0.0.1",
		ProgramName: "open-rfc", SessionID: make([]byte, 16), PasswordSeed: &seed,
	})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeInitialLogonRequest(encoded)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range decoded.Fields {
		if f.Tag == uint16(TagLanguage) {
			found = true
			if f.ByteLength != 1 {
				t.Fatalf("language length = %d, want 1", f.ByteLength)
			}
		}
	}
	if !found {
		t.Fatal("language field not found")
	}
	_ = bytes.MinRead
}
