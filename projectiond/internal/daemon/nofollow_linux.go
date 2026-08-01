//go:build linux

package daemon

import "syscall"

// osNoFollow refuses a final symlink at open time. A pointer or an artifact reached through a link is a file
// somebody else chose.
const osNoFollow = syscall.O_NOFOLLOW
