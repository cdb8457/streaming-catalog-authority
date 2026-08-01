//go:build linux

package source

import "syscall"

// osNoFollow refuses a final symlink at open time. A secret path that is a symlink is a secret path somebody
// can repoint, so it is refused rather than followed.
const osNoFollow = syscall.O_NOFOLLOW
