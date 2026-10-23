// Package syncer defines a replaceable configuration and asset synchronizer.
package syncer

import "context"

// Synchronizer refreshes local state when a future online provider is
// configured. Offline playback does not depend on an implementation of this
// interface succeeding.
type Synchronizer interface {
	Synchronize(context.Context) error
}
