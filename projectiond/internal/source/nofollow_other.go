//go:build !linux

package source

// Production is Linux. On any other platform the no-follow flag does not exist, and the secret loader's other
// checks — absolute path, regular file, bounded size, narrow permissions — still apply.
const osNoFollow = 0
