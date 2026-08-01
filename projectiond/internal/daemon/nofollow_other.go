//go:build !linux

package daemon

// Production is Linux. Elsewhere the flag does not exist and the remaining checks — regular file, exact
// length, bounded read from the statted descriptor — still apply.
const osNoFollow = 0
