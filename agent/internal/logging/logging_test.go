package logging

import (
	"bytes"
	"strings"
	"testing"
)

// Test suite contract source: docs/agent-foundation.md#local-configuration-contract.

func TestNewFiltersBelowConfiguredLevelAndEmitsVisibleAttributes(t *testing.T) {
	var output bytes.Buffer
	logger, err := New(&output, "warn")
	if err != nil {
		t.Fatal(err)
	}
	logger.Info("hidden")
	logger.Warn("visible", "display_id", "left")
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("warning logger emitted %d records, want only the warning record: %q", len(lines), output.String())
	}
	fields := strings.Fields(lines[0])
	for _, want := range []string{"level=WARN", "msg=visible", "display_id=left"} {
		found := false
		for _, field := range fields {
			if field == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("warning record fields = %v, missing %q", fields, want)
		}
	}
}

func TestNewRejectsUnsupportedLevelValues(t *testing.T) {
	for _, level := range []string{"trace", ""} {
		t.Run(level, func(t *testing.T) {
			if _, err := New(&bytes.Buffer{}, level); err == nil || err.Error() != `unsupported log level "`+level+`"` {
				t.Fatalf("New(%q) error = %v, want unsupported log level diagnostic", level, err)
			}
		})
	}
}
