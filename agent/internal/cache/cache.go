// Package cache defines the persistent local image cache contract.
package cache

import (
	"context"
	"image"
	"io"
)

// Asset identifies one verified, content-addressed image in the local cache.
type Asset struct {
	SHA256 string
	Path   string
	Bytes  int64 // When supplied to Load, the cached object must have this size.
}

// Store provides verified local images and protects assets in active
// playlists during bounded eviction.
type Store interface {
	Put(ctx context.Context, source io.Reader, expectedSHA256 string) (Asset, error)
	Load(ctx context.Context, asset Asset) (image.Image, error)
	Prune(ctx context.Context, retainedSHA256 []string) error
	Close() error
}
