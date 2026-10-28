package syncer

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image/color"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadOrCreateDeviceKeyPersistsPrivateKeySecurely(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "state", "device-key")
	first, err := LoadOrCreateDeviceKey(filename)
	if err != nil {
		t.Fatalf("LoadOrCreateDeviceKey() error = %v", err)
	}
	second, err := LoadOrCreateDeviceKey(filename)
	if err != nil {
		t.Fatalf("LoadOrCreateDeviceKey() second call error = %v", err)
	}
	if first.PublicKeyText() != second.PublicKeyText() || first.Fingerprint() != second.Fingerprint() {
		t.Fatal("device key changed after reloading persistent state")
	}
	if !strings.Contains(first.Fingerprint(), "-") || len(strings.ReplaceAll(first.Fingerprint(), "-", "")) != 32 {
		t.Fatalf("fingerprint = %q, want 128-bit grouped hexadecimal", first.Fingerprint())
	}
	info, err := os.Stat(filename)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("private key permissions = %04o, want 0600", info.Mode().Perm())
	}
	if err := os.Chmod(filename, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadDeviceKey(filename); err == nil {
		t.Fatal("ReadDeviceKey accepted a key file readable by other users")
	}
}

func TestRequestDeviceEnrollmentSignsRequestAndValidatesIdentity(t *testing.T) {
	key, err := LoadOrCreateDeviceKey(filepath.Join(t.TempDir(), "device-key"))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.RequestURI() != "/api/v1/enrollment-requests" {
			t.Errorf("request target = %s %s", r.Method, r.URL.RequestURI())
		}
		body := readRequestBody(t, r)
		var data struct {
			DeviceID  string `json:"device_id"`
			PublicKey string `json:"public_key"`
		}
		if err := json.Unmarshal(body, &data); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		if data.DeviceID != "pi-office" || data.PublicKey != key.PublicKeyText() {
			t.Errorf("enrollment request = %#v", data)
		}
		if !verifyTestSignature(r, body, key.PublicKey()) {
			t.Error("enrollment request signature is invalid")
		}
		_, _ = fmt.Fprintf(w, `{"status":"pending","fingerprint":%q,"request_id":%q,"expires_at":123456789,"replaces_existing":false}`,
			key.Fingerprint(), key.RequestID())
	}))
	defer server.Close()

	status, err := RequestDeviceEnrollment(context.Background(), server.URL+"/api", "pi-office", key, server.Client())
	if err != nil {
		t.Fatalf("RequestDeviceEnrollment() error = %v", err)
	}
	if status.Status != "pending" || status.Fingerprint != key.Fingerprint() || status.RequestID != key.RequestID() {
		t.Fatalf("enrollment status = %#v", status)
	}
}

func TestKeyHTTPClientSignsPlaylistAndAssetRequests(t *testing.T) {
	pngBytes := syncerPNG(t, color.RGBA{R: 60, G: 120, B: 210, A: 255})
	digest := fmt.Sprintf("%x", sha256.Sum256(pngBytes))
	snapshotBytes, err := json.Marshal(PlaylistSnapshot{
		Version: 2, Revision: "revision-key", ID: "welcome", RotationInterval: "30s",
		Assets: []PlaylistAsset{{SHA256: digest, Size: int64(len(pngBytes))}},
	})
	if err != nil {
		t.Fatal(err)
	}
	key, err := LoadOrCreateDeviceKey(filepath.Join(t.TempDir(), "device-key"))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readRequestBody(t, r)
		if len(body) != 0 || !verifyTestSignature(r, body, key.PublicKey()) {
			t.Errorf("invalid signed GET request for %s", r.URL.RequestURI())
			http.Error(w, "invalid signature", http.StatusUnauthorized)
			return
		}
		if r.Header.Get("Authorization") != "" {
			t.Error("key-based request also sent a bearer token")
		}
		switch r.URL.Path {
		case "/api/v2/playlist":
			if r.Header.Get("If-None-Match") == `"revision-key"` {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			w.Header().Set("ETag", `"revision-key"`)
			_, _ = w.Write(snapshotBytes)
		case "/api/v2/assets/" + digest:
			_, _ = w.Write(pngBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	store := syncerStore(t)
	client, err := NewKeyHTTPClient(server.URL+"/api", "pi-office", key, store, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	hardware := syncerConfig()
	update, err := client.Synchronize(context.Background(), hardware, hardware)
	if err != nil {
		t.Fatalf("Synchronize() with key authentication error = %v", err)
	}
	unchanged, err := client.Synchronize(context.Background(), hardware, update.Config)
	if err != nil {
		t.Fatalf("conditional Synchronize() with key authentication error = %v", err)
	}
	if unchanged.Changed {
		t.Fatal("key-authenticated conditional poll activated an unchanged playlist")
	}
}

func readRequestBody(t *testing.T, request *http.Request) []byte {
	t.Helper()
	var body []byte
	if request.Body != nil {
		var err error
		body, err = io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}
	}
	return body
}

func verifyTestSignature(request *http.Request, body []byte, publicKey ed25519.PublicKey) bool {
	timestamp := request.Header.Get("X-Ribbonfish-Timestamp")
	deviceID := request.Header.Get("X-Ribbonfish-Device-ID")
	if deviceID != "pi-office" || timestamp == "" {
		return false
	}
	signature, err := base64.RawURLEncoding.DecodeString(request.Header.Get("X-Ribbonfish-Signature"))
	if err != nil {
		return false
	}
	bodyDigest := sha256.Sum256(body)
	payload := strings.Join([]string{
		"ribbonfish-device-v1", request.Method, request.URL.RequestURI(), deviceID, timestamp,
		request.Header.Get("If-None-Match"), hex.EncodeToString(bodyDigest[:]),
	}, "\n")
	return ed25519.Verify(publicKey, []byte(payload), signature)
}
