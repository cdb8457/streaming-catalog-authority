//go:build linux

// The mountpoint probe, tested without a kernel: the mountinfo parser against synthetic mountinfo, the pure
// classify table across the whole decision space, and the two empty states against the real filesystem. The
// live and stale states need a real FUSE mount, so they live in probe_smoke_linux_test.go behind the fusesmoke
// tag.
package fusefs

import (
	"path/filepath"
	"syscall"
	"testing"
)

func TestParseMountInfoExtractsFields(t *testing.T) {
	raw := []byte(
		"26 22 0:4 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw\n" +
			"36 26 0:33 / /mnt/projection rw,nosuid,nodev,noexec,relatime - fuse.projectiond projectiond rw,user_id=0,group_id=0\n" +
			"42 26 0:38 / /data rw,relatime - ext4 /dev/sda1 rw\n" +
			"58 26 0:44 / /mnt/media\\040library rw,relatime - fuse.sshfs sshfs rw\n" +
			"garbage without a separator\n")
	entries := parseMountInfo(raw)
	if len(entries) != 4 {
		t.Fatalf("expected 4 entries, got %d: %+v", len(entries), entries)
	}
	if entries[1].mountPoint != "/mnt/projection" ||
		entries[1].fsType != fuseProjectiondType ||
		entries[1].source != "projectiond" {
		t.Fatalf("the projectiond entry is wrong: %+v", entries[1])
	}
	if entries[3].mountPoint != "/mnt/media library" || entries[3].fsType != "fuse.sshfs" {
		t.Fatalf("the escape-unescaped entry is wrong: %+v", entries[3])
	}
}

func TestMountInfoEntryAtFindsRealMounts(t *testing.T) {
	// Any Linux environment has /proc mounted as proc; seeing it proves the parser reads real mountinfo with
	// real absolute paths. The skip keeps the test honest on an environment that mounts nothing at /proc.
	entry := mountInfoEntryAt("/proc")
	if entry == nil || entry.fsType != "proc" {
		t.Skipf("/proc is not a proc mount in this environment: %+v", entry)
	}
	if entry.mountPoint != "/proc" {
		t.Fatalf("expected mount point /proc, got %q", entry.mountPoint)
	}
	if got := mountInfoEntryAt(t.TempDir()); got != nil {
		t.Fatalf("a plain directory must have no mount entry, got %+v", got)
	}
}

func TestUnescapeMountInfo(t *testing.T) {
	cases := []struct{ in, want string }{
		{`/mnt/media\040library`, "/mnt/media library"},
		{`/mnt/a\011b\012c`, "/mnt/a\tb\nc"},
		{`/mnt/back\134slash`, "/mnt/back\\slash"},
		{`/mnt/plain`, "/mnt/plain"},
		{`/mnt/unknown\141escape`, `/mnt/unknown\141escape`},
	}
	for _, tc := range cases {
		if got := unescapeMountInfo(tc.in); got != tc.want {
			t.Fatalf("unescapeMountInfo(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestClassifyDecisionTable(t *testing.T) {
	projectiond := &mountInfoEntry{mountPoint: "/mnt/projection", fsType: fuseProjectiondType, source: "projectiond"}
	foreign := &mountInfoEntry{mountPoint: "/data", fsType: "ext4", source: "/dev/sda1"}
	cases := []struct {
		name      string
		statfsErr error
		entry     *mountInfoEntry
		want      ProbeResult
	}{
		{"a plain directory", nil, nil, ProbeEmpty},
		{"a missing path", syscall.ENOENT, nil, ProbeEmpty},
		{"our own live mount", nil, projectiond, ProbeLiveProjectiond},
		{"our own dead mount", syscall.ENOTCONN, projectiond, ProbeStaleProjectiond},
		{"a foreign live mount", nil, foreign, ProbeForeign},
		{"a foreign dead mount", syscall.ENOTCONN, foreign, ProbeForeign},
		{"an unexplained statfs error", syscall.EACCES, nil, ProbeForeign},
		{"an unexplained error over our own mount", syscall.EIO, projectiond, ProbeForeign},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classify(tc.statfsErr, tc.entry); got != tc.want {
				t.Fatalf("classify(%v, %+v) = %v, want %v", tc.statfsErr, tc.entry, got, tc.want)
			}
		})
	}
}

func TestProbeMountpointEmptyStates(t *testing.T) {
	if got := ProbeMountpoint(filepath.Join(t.TempDir(), "does-not-exist")); got != ProbeEmpty {
		t.Fatalf("a missing path must probe empty, got %v", got)
	}
	if got := ProbeMountpoint(t.TempDir()); got != ProbeEmpty {
		t.Fatalf("a plain directory must probe empty, got %v", got)
	}
}
