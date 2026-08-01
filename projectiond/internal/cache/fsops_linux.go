//go:build linux

package cache

import (
	"errors"
	"io"
	"os"
	"syscall"
)

// lstatRegular refuses anything that is not a plain regular file, without following a symlink to find out.
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

// readNoFollow reads a bounded record without following a final symlink.
//
// The no-follow flag is the important part: a cache directory an attacker can write to could otherwise have a
// record name replaced by a link to something else on the host, and the daemon would serve that file's bytes
// as media.
func readNoFollow(path string, limit int64) ([]byte, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("cache entry is not a regular file")
	}
	if info.Size() > limit {
		return nil, errors.New("cache entry exceeds its bound")
	}
	return io.ReadAll(io.LimitReader(file, limit))
}

// syncDir makes a rename durable rather than merely visible. Without it a crash can lose a record that was
// already published — which is a safe miss rather than a corruption, but a miss the cache claimed not to have.
func syncDir(dir string) {
	handle, err := os.Open(dir)
	if err != nil {
		return
	}
	defer handle.Close()
	_ = handle.Sync()
}
