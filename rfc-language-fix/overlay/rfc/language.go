// SPDX-License-Identifier: Apache-2.0

package rfc

import (
	"fmt"
	"strings"
)

// isoToSAPLanguage mirrors open-rfc's archived ISO 639-1 to SAP language-key
// table. The values are SAP's own single-character language keys, not ISO codes.
var isoToSAPLanguage = map[string]string{
	"AF": "a", "SQ": "뽑", "AG": "뢇", "AR": "A", "AZ": "뢚",
	"BD": "룤", "BB": "룢", "BN": "룮", "BK": "룫", "BS": "룳",
	"Z9": "&", "BG": "W", "CA": "c", "ZH": "1", "ZF": "M",
	"KW": "뱗", "HR": "6", "Z1": "Z", "CS": "C", "DA": "K",
	"NL": "N", "DM": "릭", "EN": "E", "6N": "둮", "ET": "9",
	"FI": "U", "FR": "F", "3F": "덆", "DE": "D", "4G": "뎧",
	"EL": "G", "HE": "B", "HI": "묩", "HU": "H", "IS": "b",
	"IN": "뮎", "ID": "i", "IR": "뮒", "IT": "I", "JA": "J",
	"KK": "뱋", "KO": "3", "LV": "Y", "LT": "X", "MK": "봋",
	"MS": "7", "MV": "봖", "MO": "봏", "NI": "뵩", "NO": "O",
	"OM": "뷍", "P1": "븑", "PL": "L", "PT": "P", "1P": "느",
	"PK": "븫", "RO": "4", "RU": "R", "SA": "뽁", "SR": "0",
	"SH": "d", "SK": "Q", "SL": "5", "ES": "S", "1X": "늘",
	"SV": "V", "TA": "뾡", "TT": "뾴", "1Q": "늑", "2Q": "닱",
	"TH": "2", "TR": "T", "TC": "뾣", "Z8": ";", "UK": "8",
	"VI": "쁩",
}

var sapToISOLanguage = func() map[string]string {
	out := make(map[string]string, len(isoToSAPLanguage))
	for iso, sap := range isoToSAPLanguage {
		out[sap] = iso
	}
	return out
}()

// LanguageIsoToSap converts an ISO language code (for example "ZH" or
// "en-US") to SAP's internal one-character language key ("1" for Chinese).
func LanguageIsoToSap(language string) (string, error) {
	trimmed := strings.TrimSpace(language)
	if trimmed == "" {
		return "", fmt.Errorf("language must be a non-empty string")
	}
	iso := strings.ToUpper(trimmed)
	if strings.ContainsAny(iso, "-_") {
		iso = strings.SplitN(iso, "-", 2)[0]
		iso = strings.SplitN(iso, "_", 2)[0]
	}
	if len(iso) != 2 {
		return "", fmt.Errorf("language ISO code not found: %s", language)
	}
	sap, ok := isoToSAPLanguage[iso]
	if !ok {
		return "", fmt.Errorf("language ISO code not found: %s", language)
	}
	return sap, nil
}

// LanguageSapToIso converts SAP's internal one-character language key to its
// archived ISO language code.
func LanguageSapToIso(language string) (string, error) {
	if language == "" {
		return "", fmt.Errorf("SAP language must be a non-empty string")
	}
	iso, ok := sapToISOLanguage[language]
	if !ok {
		return "", fmt.Errorf("language SAP code not found: %s", language)
	}
	return iso, nil
}

// normalizeLogonLanguage keeps already-valid SAP keys and converts ISO input.
// This mirrors node-rfc/NCO behavior: callers may pass either "ZH" or "1".
func normalizeLogonLanguage(language string) (string, error) {
	trimmed := strings.TrimSpace(language)
	if trimmed == "" {
		return "E", nil
	}
	if _, ok := sapToISOLanguage[trimmed]; ok {
		return trimmed, nil
	}
	return LanguageIsoToSap(trimmed)
}
