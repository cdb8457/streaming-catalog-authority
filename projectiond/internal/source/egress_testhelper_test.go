package source

import (
	"net/url"
	"testing"
)

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("unparseable URL %q: %v", raw, err)
	}
	return parsed
}
