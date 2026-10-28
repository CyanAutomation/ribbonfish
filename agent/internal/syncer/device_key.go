package syncer

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// DeviceKey is the device's persistent Ed25519 identity. Its private key never
// leaves the device; management approves the corresponding public key.
type DeviceKey struct {
	private ed25519.PrivateKey
}

// LoadOrCreateDeviceKey loads a device identity or creates one with mode 0600.
func LoadOrCreateDeviceKey(filename string) (*DeviceKey, error) {
	key, err := ReadDeviceKey(filename)
	if err == nil {
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate device identity: %w", err)
	}
	key = &DeviceKey{private: private}
	if err := writeDeviceKey(filename, private); err != nil {
		return nil, err
	}
	return key, nil
}

// ReadDeviceKey loads a raw Ed25519 private key without exposing it in errors.
func ReadDeviceKey(filename string) (*DeviceKey, error) {
	info, err := os.Lstat(filename)
	if err != nil {
		return nil, fmt.Errorf("read device identity: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("device identity file permissions are not private")
	}
	if info.Size() != ed25519.PrivateKeySize {
		return nil, errors.New("device identity file has invalid format")
	}
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("read device identity: %w", err)
	}
	if len(data) != ed25519.PrivateKeySize {
		return nil, errors.New("device identity file has invalid format")
	}
	private := append(ed25519.PrivateKey(nil), data...)
	derived, ok := private.Public().(ed25519.PublicKey)
	if !ok || !equalBytes(derived, private[ed25519.SeedSize:]) {
		return nil, errors.New("device identity file has invalid key material")
	}
	return &DeviceKey{private: private}, nil
}

func writeDeviceKey(filename string, private ed25519.PrivateKey) error {
	directory := filepath.Dir(filename)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create device state directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".ribbonfish-key-*")
	if err != nil {
		return fmt.Errorf("create temporary device identity: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("secure device identity: %w", err)
	}
	if _, err := temporary.Write(private); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write device identity: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync device identity: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close device identity: %w", err)
	}
	if err := os.Rename(temporaryName, filename); err != nil {
		return fmt.Errorf("install device identity: %w", err)
	}
	dir, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("open device state directory: %w", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return fmt.Errorf("sync device state directory: %w", err)
	}
	return nil
}

// PublicKey returns a copy of the raw Ed25519 public key.
func (key *DeviceKey) PublicKey() ed25519.PublicKey {
	if key == nil || len(key.private) != ed25519.PrivateKeySize {
		return nil
	}
	return append(ed25519.PublicKey(nil), key.private[ed25519.SeedSize:]...)
}

// PublicKeyText is the raw public key encoded as unpadded base64url.
func (key *DeviceKey) PublicKeyText() string {
	return base64.RawURLEncoding.EncodeToString(key.PublicKey())
}

// RequestID is the SHA-256 digest of the raw public key, in lowercase hex.
func (key *DeviceKey) RequestID() string {
	digest := sha256.Sum256(key.PublicKey())
	return hex.EncodeToString(digest[:])
}

// Fingerprint is the first 128 bits of the public key digest, grouped in fours.
func (key *DeviceKey) Fingerprint() string {
	compact := key.RequestID()[:32]
	groups := make([]string, 0, 8)
	for i := 0; i < len(compact); i += 4 {
		groups = append(groups, compact[i:i+4])
	}
	return strings.Join(groups, "-")
}

// SignRequest adds the canonical request signature used by the sync Worker.
func (key *DeviceKey) SignRequest(request *http.Request, body []byte) error {
	if key == nil || len(key.private) != ed25519.PrivateKeySize || request == nil || request.URL == nil {
		return errors.New("device identity and request are required")
	}
	timestamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
	bodyDigest := sha256.Sum256(body)
	payload := strings.Join([]string{
		"ribbonfish-device-v1",
		request.Method,
		request.URL.RequestURI(),
		request.Header.Get("X-Ribbonfish-Device-ID"),
		timestamp,
		request.Header.Get("If-None-Match"),
		hex.EncodeToString(bodyDigest[:]),
	}, "\n")
	signature := ed25519.Sign(key.private, []byte(payload))
	request.Header.Set("X-Ribbonfish-Timestamp", timestamp)
	request.Header.Set("X-Ribbonfish-Signature", base64.RawURLEncoding.EncodeToString(signature))
	return nil
}

// EnrollmentStatus is the server's current view of this device identity.
type EnrollmentStatus struct {
	Status           string `json:"status"`
	Fingerprint      string `json:"fingerprint"`
	RequestID        string `json:"request_id"`
	ExpiresAt        *int64 `json:"expires_at"`
	ReplacesExisting bool   `json:"replaces_existing"`
}

// RequestDeviceEnrollment idempotently creates or polls this device's pending
// request. It does not grant access; the management console must approve it.
func RequestDeviceEnrollment(ctx context.Context, baseURL, deviceID string, key *DeviceKey, client *http.Client) (EnrollmentStatus, error) {
	base, err := parseBaseURL(baseURL)
	if err != nil {
		return EnrollmentStatus{}, err
	}
	if !validID(deviceID) {
		return EnrollmentStatus{}, errors.New("device id must be a 1-64 character identifier")
	}
	if key == nil || len(key.PublicKey()) != ed25519.PublicKeySize {
		return EnrollmentStatus{}, errors.New("device identity is required")
	}
	endpoint := base
	endpoint.Path = path.Join(endpoint.Path, "v1", "enrollment-requests")
	endpoint.RawPath = ""
	body, err := json.Marshal(struct {
		DeviceID  string `json:"device_id"`
		PublicKey string `json:"public_key"`
	}{DeviceID: deviceID, PublicKey: key.PublicKeyText()})
	if err != nil {
		return EnrollmentStatus{}, fmt.Errorf("encode enrollment request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), strings.NewReader(string(body)))
	if err != nil {
		return EnrollmentStatus{}, fmt.Errorf("create enrollment request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-Ribbonfish-Device-ID", deviceID)
	if err := key.SignRequest(request, body); err != nil {
		return EnrollmentStatus{}, fmt.Errorf("sign enrollment request: %w", err)
	}
	response, err := configuredHTTPClient(client).Do(request)
	if err != nil {
		return EnrollmentStatus{}, fmt.Errorf("request device enrollment: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return EnrollmentStatus{}, responseError("request device enrollment", response)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil {
		return EnrollmentStatus{}, fmt.Errorf("read enrollment response: %w", err)
	}
	if len(data) > 4096 {
		return EnrollmentStatus{}, errors.New("enrollment response exceeds 4 KiB limit")
	}
	var status EnrollmentStatus
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&status); err != nil {
		return EnrollmentStatus{}, fmt.Errorf("decode enrollment response: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return EnrollmentStatus{}, errors.New("enrollment response contains multiple JSON values")
		}
		return EnrollmentStatus{}, fmt.Errorf("decode enrollment response: %w", err)
	}
	if status.Status != "pending" && status.Status != "approved" && status.Status != "rejected" && status.Status != "disabled" {
		return EnrollmentStatus{}, errors.New("enrollment response contains an invalid status")
	}
	if status.Fingerprint != key.Fingerprint() || status.RequestID != key.RequestID() {
		return EnrollmentStatus{}, errors.New("enrollment response does not match this device identity")
	}
	return status, nil
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var different byte
	for i := range left {
		different |= left[i] ^ right[i]
	}
	return different == 0
}
