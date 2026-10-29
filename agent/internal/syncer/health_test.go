package syncer

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

const healthTestToken = "health-secret-012345678901234567890123456789"

func TestHealthClientSendsBearerTelemetry(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/telemetry" || r.Header.Get("Authorization") != "Bearer "+healthTestToken {
			t.Fatalf("unexpected telemetry request: %s %s auth=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(body), `"schema_version":1`) {
			t.Fatalf("report body = %s", body)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"received_at":1}`)
	}))
	defer server.Close()

	client, err := NewHealthClient(server.URL, "pi-office", healthTestToken, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Report(context.Background(), map[string]any{"schema_version": 1}); err != nil {
		t.Fatalf("Report() error = %v", err)
	}
}

func TestHealthClientSignsExactBodyWithDeviceKey(t *testing.T) {
	key, err := LoadOrCreateDeviceKey(filepath.Join(t.TempDir(), "device-key"))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(body)
		canonical := strings.Join([]string{
			"ribbonfish-device-v1", r.Method, r.URL.RequestURI(), r.Header.Get("X-Ribbonfish-Device-ID"),
			r.Header.Get("X-Ribbonfish-Timestamp"), r.Header.Get("If-None-Match"), hex.EncodeToString(digest[:]),
		}, "\n")
		signature, err := base64.RawURLEncoding.DecodeString(r.Header.Get("X-Ribbonfish-Signature"))
		if err != nil || !ed25519.Verify(key.PublicKey(), []byte(canonical), signature) {
			t.Fatalf("request signature does not authenticate exact body %q", body)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"received_at":1}`)
	}))
	defer server.Close()

	client, err := NewHealthClient(server.URL, "pi-office", "", key, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Report(context.Background(), map[string]any{"schema_version": 1, "state": "ready"}); err != nil {
		t.Fatalf("Report() error = %v", err)
	}
}

func TestHealthClientRejectsInvalidConfigurationAndHTTPFailures(t *testing.T) {
	if _, err := NewHealthClient("http://not-loopback.test", "pi-office", healthTestToken, nil, nil); err == nil {
		t.Fatal("NewHealthClient() accepted insecure URL")
	}
	if _, err := NewHealthClient("https://sync.test", "pi-office", "short", nil, nil); err == nil {
		t.Fatal("NewHealthClient() accepted short token")
	}
	if _, err := NewHealthClient("https://sync.test", "pi-office", "", nil, nil); err == nil {
		t.Fatal("NewHealthClient() accepted missing identity")
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
	defer server.Close()
	client, err := NewHealthClient(server.URL, "pi-office", healthTestToken, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Report(context.Background(), map[string]any{"schema_version": 1}); err == nil {
		t.Fatal("Report() ignored HTTP failure")
	}
}

func TestHealthReportPayloadTooLargeIsRejected(t *testing.T) {
	client, err := NewHealthClient("https://sync.test", "pi-office", healthTestToken, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Report(context.Background(), map[string]any{"payload": strings.Repeat("x", maxHealthReportBytes)}); err == nil {
		t.Fatal("Report() accepted an oversized payload")
	}
}
