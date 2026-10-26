// Package syncer implements the optional, authenticated content synchronization
// boundary. The agent's output and hardware configuration remain local.
package syncer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/CyanAutomation/ribbonfish/agent/internal/cache"
	"github.com/CyanAutomation/ribbonfish/agent/internal/config"
)

const (
	snapshotLimit = 1 << 20
	assetLimit    = 32 << 20
)

var digestPattern = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)
var errAssetSizeMismatch = errors.New("image body size does not match snapshot")

// PlaylistSnapshot is a complete desired playlist. It contains no filesystem
// paths, output devices, DRM connectors, or cache settings.
type PlaylistSnapshot struct {
	Version          int             `json:"version"`
	Revision         string          `json:"revision"`
	ID               string          `json:"id"`
	RotationInterval string          `json:"rotation_interval"`
	Assets           []PlaylistAsset `json:"assets"`
}

type PlaylistAsset struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Update carries a fully fetched and verified snapshot ready for activation.
type Update struct {
	Config   config.Config
	Snapshot PlaylistSnapshot
	ETag     string
	Changed  bool
}

// Synchronizer fetches a content snapshot while preserving local output
// settings and protecting the currently active assets during downloads.
type Synchronizer interface {
	Synchronize(context.Context, config.Config, config.Config) (Update, error)
}

type HTTPClient struct {
	baseURL  url.URL
	deviceID string
	token    string
	store    cache.Store
	http     *http.Client
	etag     string
}

var _ Synchronizer = (*HTTPClient)(nil)

// NewHTTPClient creates an authenticated client for a Ribbonfish sync Worker.
// Plain HTTP is accepted only for loopback development servers.
func NewHTTPClient(baseURL, deviceID, token string, store cache.Store, client *http.Client) (*HTTPClient, error) {
	parsed, err := parseBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	if !validID(deviceID) {
		return nil, errors.New("device id must be 1-64 ASCII letters, digits, dots, underscores, or hyphens")
	}
	if len(token) < 32 || len(token) > 256 || strings.TrimSpace(token) != token || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("device token is required and must be 32-256 characters")
	}
	if store == nil {
		return nil, errors.New("image cache is required")
	}
	return &HTTPClient{baseURL: parsed, deviceID: deviceID, token: token, store: store, http: configuredHTTPClient(client)}, nil
}

// SetETag supplies the last persisted snapshot tag for conditional polling.
func (c *HTTPClient) SetETag(etag string) {
	if strings.ContainsAny(etag, "\r\n") {
		return
	}
	c.etag = strings.TrimSpace(etag)
}

// RestoreActivePins drops temporary candidate pins after the caller rejects an
// otherwise valid update, preserving only the currently running snapshot.
func (c *HTTPClient) RestoreActivePins(ctx context.Context, active config.Config) error {
	return c.store.Prune(ctx, configDigests(active))
}

// Synchronize downloads and validates one complete snapshot. hardware is the
// immutable local configuration; active identifies assets that must remain
// available if candidate download or validation fails.
func (c *HTTPClient) Synchronize(ctx context.Context, hardware, active config.Config) (Update, error) {
	if err := ctx.Err(); err != nil {
		return Update{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint("v2/playlist"), nil)
	if err != nil {
		return Update{}, fmt.Errorf("create snapshot request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("X-Ribbonfish-Device-ID", c.deviceID)
	request.Header.Set("Accept", "application/json")
	if c.etag != "" {
		request.Header.Set("If-None-Match", c.etag)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return Update{}, fmt.Errorf("fetch snapshot: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotModified {
		return Update{ETag: c.etag}, nil
	}
	if response.StatusCode != http.StatusOK {
		return Update{}, responseError("fetch snapshot", response)
	}
	snapshot, err := decodePlaylistSnapshot(response.Body)
	if err != nil {
		return Update{}, fmt.Errorf("decode snapshot: %w", err)
	}
	if err := validatePlaylistSnapshot(snapshot, hardware); err != nil {
		return Update{}, fmt.Errorf("validate snapshot: %w", err)
	}
	etag := strings.TrimSpace(response.Header.Get("ETag"))
	if etag != "" && !snapshotETagMatchesRevision(etag, snapshot.Revision) {
		return Update{}, fmt.Errorf("snapshot ETag %q does not match revision %q", etag, snapshot.Revision)
	}
	expectedETag := `"` + snapshot.Revision + `"`

	activeDigests := configDigests(active)
	candidateDigests := snapshotDigests(snapshot)
	protected := append(append([]string(nil), activeDigests...), candidateDigests...)
	if err := c.store.Prune(ctx, protected); err != nil {
		if ctx.Err() == nil {
			_ = c.store.Prune(context.Background(), activeDigests)
		}
		return Update{}, fmt.Errorf("protect active and candidate images: %w", err)
	}
	committed := false
	defer func() {
		if !committed && ctx.Err() == nil {
			_ = c.store.Prune(context.Background(), activeDigests)
		}
	}()

	assets := make(map[string]cache.Asset, len(candidateDigests))
	for _, item := range snapshot.Assets {
		digest := strings.ToLower(item.SHA256)
		if _, exists := assets[digest]; exists {
			continue
		}
		if _, err := c.store.Load(ctx, cache.Asset{SHA256: digest, Bytes: item.Size}); err == nil {
			assets[digest] = cache.Asset{SHA256: digest, Path: "cached:" + digest, Bytes: item.Size}
			continue
		}
		asset, err := c.fetchAsset(ctx, digest, item.Size)
		if err != nil {
			return Update{}, err
		}
		assets[digest] = asset
	}
	candidate, err := mergePlaylistSnapshot(hardware, snapshot, assets)
	if err != nil {
		return Update{}, err
	}
	etag = expectedETag
	c.etag = etag
	committed = true
	return Update{Config: candidate, Snapshot: snapshot, ETag: etag, Changed: true}, nil
}

func (c *HTTPClient) fetchAsset(ctx context.Context, digest string, expectedSize int64) (cache.Asset, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint("v2/assets/"+digest), nil)
	if err != nil {
		return cache.Asset{}, fmt.Errorf("create image request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("X-Ribbonfish-Device-ID", c.deviceID)
	request.Header.Set("Accept", "image/png,image/jpeg,image/gif")
	response, err := c.http.Do(request)
	if err != nil {
		return cache.Asset{}, fmt.Errorf("fetch image %s: %w", digest, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return cache.Asset{}, responseError("fetch image "+digest, response)
	}
	if expectedSize <= 0 || expectedSize > assetLimit {
		return cache.Asset{}, fmt.Errorf("image %s has invalid or excessive declared size %d", digest, expectedSize)
	}
	if response.ContentLength >= 0 && response.ContentLength != expectedSize {
		return cache.Asset{}, fmt.Errorf("image %s length mismatch: snapshot says %d bytes, server says %d", digest, expectedSize, response.ContentLength)
	}
	asset, err := c.store.Put(ctx, &assetSizeReader{source: response.Body, remaining: expectedSize}, digest)
	if err != nil {
		return cache.Asset{}, fmt.Errorf("verify and cache image %s: %w", digest, err)
	}
	if asset.Bytes != expectedSize {
		return cache.Asset{}, fmt.Errorf("image %s length mismatch: snapshot says %d bytes, received %d", digest, expectedSize, asset.Bytes)
	}
	return asset, nil
}

// assetSizeReader lets exactly the declared number of bytes reach Put, then
// probes for excess data. Any size mismatch becomes a read error, so Put never
// publishes a truncated or oversized object into the cache.
type assetSizeReader struct {
	source    io.Reader
	remaining int64
}

func (r *assetSizeReader) Read(buffer []byte) (int, error) {
	if len(buffer) == 0 {
		return 0, nil
	}
	if r.remaining == 0 {
		var extra [1]byte
		n, err := r.source.Read(extra[:])
		if n > 0 {
			return 0, errAssetSizeMismatch
		}
		return 0, err
	}
	if int64(len(buffer)) > r.remaining {
		buffer = buffer[:r.remaining]
	}
	n, err := r.source.Read(buffer)
	r.remaining -= int64(n)
	if err == io.EOF && r.remaining > 0 {
		return n, errAssetSizeMismatch
	}
	return n, err
}

func (c *HTTPClient) endpoint(endpointPath string) string {
	base := c.baseURL
	base.Path = path.Join(base.Path, endpointPath)
	base.RawPath = ""
	return base.String()
}

func decodePlaylistSnapshot(reader io.Reader) (PlaylistSnapshot, error) {
	data, err := io.ReadAll(io.LimitReader(reader, snapshotLimit+1))
	if err != nil {
		return PlaylistSnapshot{}, err
	}
	if len(data) > snapshotLimit {
		return PlaylistSnapshot{}, errors.New("snapshot exceeds 1 MiB limit")
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	var snapshot PlaylistSnapshot
	if err := decoder.Decode(&snapshot); err != nil {
		return PlaylistSnapshot{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return PlaylistSnapshot{}, errors.New("snapshot contains multiple JSON values")
		}
		return PlaylistSnapshot{}, err
	}
	return snapshot, nil
}

func validatePlaylistSnapshot(snapshot PlaylistSnapshot, hardware config.Config) error {
	if snapshot.Version != 2 {
		return fmt.Errorf("unsupported playlist snapshot version %d", snapshot.Version)
	}
	if !validID(snapshot.Revision) {
		return errors.New("revision must be a 1-64 character identifier")
	}
	if !validID(snapshot.ID) {
		return fmt.Errorf("invalid playlist id %q", snapshot.ID)
	}
	interval, err := time.ParseDuration(snapshot.RotationInterval)
	if err != nil {
		return fmt.Errorf("playlist %q has invalid rotation interval: %w", snapshot.ID, err)
	}
	if interval <= 0 {
		return fmt.Errorf("playlist %q rotation interval must be positive", snapshot.ID)
	}
	if len(snapshot.Assets) == 0 || len(snapshot.Assets) > 256 {
		return fmt.Errorf("playlist %q must contain between 1 and 256 assets", snapshot.ID)
	}
	assets := make(map[string]int64)
	for _, asset := range snapshot.Assets {
		if !digestPattern.MatchString(asset.SHA256) {
			return fmt.Errorf("playlist %q has invalid SHA-256 digest", snapshot.ID)
		}
		if asset.Size <= 0 || asset.Size > assetLimit {
			return fmt.Errorf("playlist %q has invalid or excessive image size %d", snapshot.ID, asset.Size)
		}
		digest := strings.ToLower(asset.SHA256)
		if previous, exists := assets[digest]; exists && previous != asset.Size {
			return fmt.Errorf("asset %s has conflicting declared sizes", digest)
		}
		assets[digest] = asset.Size
	}
	if len(assets) > 512 {
		return errors.New("playlist exceeds the 512 unique image limit")
	}
	var totalAssetBytes int64
	for _, size := range assets {
		// Playlist snapshot limits keep size bounded, so this subtraction cannot underflow;
		// it also avoids overflowing a sum before comparing with the cache limit.
		if totalAssetBytes > hardware.Cache.MaxBytes-size {
			return errors.New("snapshot assets exceed the device cache budget")
		}
		totalAssetBytes += size
	}
	return nil
}

func mergePlaylistSnapshot(hardware config.Config, snapshot PlaylistSnapshot, assets map[string]cache.Asset) (config.Config, error) {
	candidate := copyConfig(hardware)
	candidate.Playlist = config.PlaylistConfig{
		ID: snapshot.ID, RotationInterval: snapshot.RotationInterval,
		Assets: make([]config.AssetConfig, 0, len(snapshot.Assets)),
	}
	for _, item := range snapshot.Assets {
		digest := strings.ToLower(item.SHA256)
		asset, ok := assets[digest]
		if !ok || asset.Path == "" {
			return config.Config{}, fmt.Errorf("image %s is not cached", digest)
		}
		candidate.Playlist.Assets = append(candidate.Playlist.Assets, config.AssetConfig{Path: asset.Path, SHA256: digest})
	}
	if err := candidate.Validate(); err != nil {
		return config.Config{}, fmt.Errorf("validate merged content: %w", err)
	}
	return candidate, nil
}

func copyConfig(source config.Config) config.Config {
	copy := source
	copy.Playlist.Assets = append([]config.AssetConfig(nil), source.Playlist.Assets...)
	copy.Displays = append([]config.DisplayConfig(nil), source.Displays...)
	return copy
}

func snapshotDigests(snapshot PlaylistSnapshot) []string {
	seen := make(map[string]struct{})
	var digests []string
	for _, asset := range snapshot.Assets {
		digest := strings.ToLower(asset.SHA256)
		if _, ok := seen[digest]; !ok {
			seen[digest] = struct{}{}
			digests = append(digests, digest)
		}
	}
	return digests
}

func configDigests(cfg config.Config) []string {
	seen := make(map[string]struct{})
	var digests []string
	for _, asset := range cfg.Playlist.Assets {
		if !digestPattern.MatchString(asset.SHA256) {
			continue
		}
		digest := strings.ToLower(asset.SHA256)
		if _, ok := seen[digest]; !ok {
			seen[digest] = struct{}{}
			digests = append(digests, digest)
		}
	}
	return digests
}

func parseBaseURL(value string) (url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" {
		return url.URL{}, errors.New("sync URL must be an absolute HTTPS URL")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname())) {
		return url.URL{}, errors.New("sync URL must use HTTPS outside loopback development")
	}
	return *parsed, nil
}

func configuredHTTPClient(client *http.Client) *http.Client {
	var result http.Client
	if client != nil {
		result = *client
	}
	if result.Timeout == 0 {
		result.Timeout = 20 * time.Second
	}
	result.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &result
}

func responseError(action string, response *http.Response) error {
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	return fmt.Errorf("%s: unexpected HTTP status %d", action, response.StatusCode)
}

func validID(value string) bool {
	if len(value) == 0 || len(value) > 64 || !isAlphaNumeric(value[0]) {
		return false
	}
	for i := 1; i < len(value); i++ {
		c := value[i]
		if !isAlphaNumeric(c) && c != '.' && c != '_' && c != '-' {
			return false
		}
	}
	return true
}

func snapshotETagMatchesRevision(etag, revision string) bool {
	etag = strings.TrimSpace(etag)
	if strings.HasPrefix(etag, "W/") {
		etag = strings.TrimSpace(strings.TrimPrefix(etag, "W/"))
	}
	return etag == `"`+revision+`"`
}

func isAlphaNumeric(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
