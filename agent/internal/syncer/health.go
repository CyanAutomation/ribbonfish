package syncer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path"
	"strings"
)

const maxHealthReportBytes = 8 << 10

// HealthClient sends bounded, authenticated device state to the management API.
type HealthClient struct {
	endpoint string
	deviceID string
	token    string
	key      *DeviceKey
	http     *http.Client
}

// NewHealthClient accepts the same bearer token or approved key used by sync.
func NewHealthClient(baseURL, deviceID, token string, key *DeviceKey, client *http.Client) (*HealthClient, error) {
	parsed, err := parseBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	if !validID(deviceID) {
		return nil, errors.New("device id must be 1-64 ASCII letters, digits, dots, underscores, or hyphens")
	}
	if key != nil {
		if len(key.PublicKey()) != 32 {
			return nil, errors.New("device identity is required")
		}
		if token != "" {
			return nil, errors.New("choose either device token or device key authentication")
		}
	} else if len(token) < 32 || len(token) > 256 || strings.TrimSpace(token) != token || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("device token is required and must be 32-256 characters")
	}
	parsed.Path = path.Join(parsed.Path, "v1", "telemetry")
	parsed.RawPath = ""
	return &HealthClient{endpoint: parsed.String(), deviceID: deviceID, token: token, key: key, http: configuredHTTPClient(client)}, nil
}

// Report serializes and posts one complete health snapshot. The body limit
// keeps telemetry small and matches the Worker's request bound.
func (c *HealthClient) Report(ctx context.Context, report any) error {
	if ctx == nil {
		return errors.New("health report context is required")
	}
	body, err := json.Marshal(report)
	if err != nil {
		return fmt.Errorf("encode health report: %w", err)
	}
	if len(body) == 0 || len(body) > maxHealthReportBytes {
		return errors.New("health report exceeds the 8 KiB limit")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create health report request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Ribbonfish-Device-ID", c.deviceID)
	if c.key != nil {
		if err := c.key.SignRequest(request, body); err != nil {
			return fmt.Errorf("sign health report: %w", err)
		}
	} else {
		request.Header.Set("Authorization", "Bearer "+c.token)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("send health report: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return responseError("send health report", response)
	}
	return nil
}
