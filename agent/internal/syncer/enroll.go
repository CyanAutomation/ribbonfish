package syncer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Enroll exchanges a one-time provisioning code for a device-scoped token.
// The returned token must be stored by the caller and never logged.
func Enroll(ctx context.Context, baseURL, deviceID, code string, client *http.Client) (string, error) {
	base, err := parseBaseURL(baseURL)
	if err != nil {
		return "", err
	}
	if !validID(deviceID) {
		return "", errors.New("device id must be a 1-64 character identifier")
	}
	code = strings.TrimSpace(code)
	if code == "" || len(code) > 512 || strings.ContainsAny(code, "\r\n") {
		return "", errors.New("one-time enrollment code is required")
	}
	endpoint := base
	endpoint.Path = path.Join(endpoint.Path, "v1", "enroll")
	endpoint.RawPath = ""
	body, err := json.Marshal(struct {
		DeviceID string `json:"device_id"`
		Code     string `json:"enrollment_code"`
	}{DeviceID: deviceID, Code: code})
	if err != nil {
		return "", fmt.Errorf("encode enrollment request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), strings.NewReader(string(body)))
	if err != nil {
		return "", fmt.Errorf("create enrollment request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := configuredHTTPClient(client).Do(request)
	if err != nil {
		return "", fmt.Errorf("enroll device: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated {
		return "", responseError("enroll device", response)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil {
		return "", fmt.Errorf("read enrollment response: %w", err)
	}
	if len(data) > 4096 {
		return "", errors.New("enrollment response exceeds 4 KiB limit")
	}
	var result struct {
		Token string `json:"device_token"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return "", fmt.Errorf("decode enrollment response: %w", err)
	}
	if len(result.Token) < 32 || len(result.Token) > 256 || strings.TrimSpace(result.Token) != result.Token || strings.ContainsAny(result.Token, "\r\n") {
		return "", errors.New("enrollment response contains an invalid device token")
	}
	return result.Token, nil
}

// WriteDeviceToken atomically writes a device token with mode 0600.
func WriteDeviceToken(filename, token string) error {
	if len(token) < 32 || len(token) > 256 || strings.TrimSpace(token) != token || strings.ContainsAny(token, "\r\n") {
		return errors.New("device token has invalid format")
	}
	directory := filepath.Dir(filename)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create device state directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".ribbonfish-token-*")
	if err != nil {
		return fmt.Errorf("create temporary device token: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("secure device token: %w", err)
	}
	if _, err := temporary.WriteString(token); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write device token: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync device token: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close device token: %w", err)
	}
	if err := os.Rename(temporaryName, filename); err != nil {
		return fmt.Errorf("install device token: %w", err)
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

// ReadDeviceToken loads a token from persistent device state without exposing
// the value in diagnostics.
func ReadDeviceToken(filename string) (string, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return "", fmt.Errorf("read device token: %w", err)
	}
	if len(data) > 4096 {
		return "", errors.New("device token file exceeds 4 KiB limit")
	}
	token := strings.TrimSpace(string(data))
	if len(token) < 32 || len(token) > 256 || strings.ContainsAny(token, "\r\n") {
		return "", errors.New("device token file has invalid format")
	}
	return token, nil
}
