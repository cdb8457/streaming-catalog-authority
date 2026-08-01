//go:build !linux

package cache

import (
	"errors"
	"io"
	"os"
)

// Production is Linux. Elsewhere the same checks apply minus the no-follow open flag, which does not exist.
func lstatRegular(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("cache entry is not a regular file")
	}
	return info, nil
}

func readNoFollow(path string, limit int64) ([]byte, error) {
	if _, err := lstatRegular(path); err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, limit))
}

func syncDir(dir string) {
	handle, err := os.Open(dir)
	if err != nil {
		return
	}
	defer handle.Close()
	_ = handle.Sync()
}
