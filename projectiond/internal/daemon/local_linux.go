//go:build linux

package daemon

import "github.com/cdb8457/streaming-catalog-authority/projectiond/internal/source"

// newLocalAdapter is split out because the local adapter is built on Linux confinement syscalls. Production is
// Linux; the manifest, namespace and cache packages stay portable so their gates run anywhere.
func newLocalAdapter(roots map[string]string) (source.Adapter, error) {
	return source.NewLocalAdapter(roots)
}
