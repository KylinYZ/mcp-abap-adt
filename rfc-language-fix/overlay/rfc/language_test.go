package rfc

import "testing"

func TestLanguageIsoToSap(t *testing.T) {
	cases := []struct{ in, want string }{
		{"de", "D"}, {"ZH", "1"}, {"en-US", "E"}, {"KO", "3"}, {"TH", "2"},
	}
	for _, c := range cases {
		got, err := LanguageIsoToSap(c.in)
		if err != nil || got != c.want {
			t.Fatalf("LanguageIsoToSap(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
}

func TestLanguageSapToIso(t *testing.T) {
	got, err := LanguageSapToIso("1")
	if err != nil || got != "ZH" {
		t.Fatalf("LanguageSapToIso(%q) = %q, %v; want ZH", "1", got, err)
	}
}

func TestNormalizeLogonLanguage(t *testing.T) {
	cases := []struct{ in, want string }{
		{"ZH", "1"}, {"1", "1"}, {"EN", "E"}, {"E", "E"}, {"", "E"},
	}
	for _, c := range cases {
		got, err := normalizeLogonLanguage(c.in)
		if err != nil || got != c.want {
			t.Fatalf("normalizeLogonLanguage(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
}
