//go:build linux

package fusefs

import (
	"fmt"
	"os"
	"strings"
	"syscall"
	"testing"
)

// THE ROOT MODE IS KNOWN, NOT ASKED, AND THAT IS THE WHOLE FIX.
//
// go-fuse's mountDirect stats the mount point for one field, `rootmode`, and with DirectMountStrict that
// stat's error IS the mount error. A dead FUSE root answers stat from the attribute cache while it is warm
// and with ENOTCONN once it is not — and this package sets attrTimeout to a minute. So a daemon could stack
// over a corpse for the first minute of its death and never afterwards, which made `--auto-remount`
// permanently unable to recover any daemon that had ever restarted over one.
func TestSelfMountAsksTheMountPointNothing(t *testing.T) {
	got := selfMountOptions(7, true, true)
	if !strings.Contains(got, fmt.Sprintf("rootmode=%o", syscall.S_IFDIR)) {
		t.Fatalf("the mount data does not name a directory root mode: %q", got)
	}
	if strings.Contains(got, "rootmode=0") && !strings.Contains(got, "rootmode=40000") {
		t.Fatalf("the root mode is not a directory: %q", got)
	}
}

// THE OPTIONS THE PRODUCT CANNOT LOSE SILENTLY. A mount missing `allow_other` succeeds and then hands every
// media server EACCES; a mount missing `default_permissions` succeeds and moves permission enforcement out of
// the kernel and into this process. Neither failure announces itself at mount time, which is exactly why they
// are asserted here rather than left to a run.
func TestSelfMountCarriesTheOptionsTheProductDependsOn(t *testing.T) {
	got := selfMountOptions(7, true, true)
	for _, want := range []string{"fd=7", "allow_other", "default_permissions",
		fmt.Sprintf("user_id=%d", os.Geteuid()), fmt.Sprintf("group_id=%d", os.Getegid())} {
		if !hasOption(got, want) {
			t.Fatalf("the mount data is missing %q: %q", want, got)
		}
	}
	// ...AND THEY ARE CONDITIONAL RATHER THAN CONSTANT, so the test above is not passing on a fixed string.
	off := selfMountOptions(7, false, false)
	if hasOption(off, "allow_other") || hasOption(off, "default_permissions") {
		t.Fatalf("options that were switched off are still in the mount data: %q", off)
	}
}

// THE THREE THAT MUST NOT BE THERE. The kernel takes nosuid, nodev and noexec as mount FLAGS and rejects them
// as filesystem DATA with EINVAL. This repository has already spent one defect on that: `ro` and `noatime` in
// the options list made every direct mount fail with "invalid argument" and fall back to a suid helper the
// shipped image does not contain, so the image could not mount at all.
func TestSelfMountDoesNotPassMountFlagsAsFilesystemData(t *testing.T) {
	got := selfMountOptions(7, true, true)
	for _, forbidden := range []string{"nosuid", "nodev", "noexec", "ro", "noatime", "rw"} {
		if hasOption(got, forbidden) {
			t.Fatalf("%q is a mount FLAG and the kernel rejects it as data: %q", forbidden, got)
		}
	}
}

// max_read IS OMITTED ON PURPOSE, and the pin exists so that a future reader adding it back has to say why.
// go-fuse sends `max_read=MaxWrite` from a value NewServer fills in from the kernel's own limit; this process
// would have to guess that number before NewServer runs, and a wrong guess caps every read at whatever this
// file said. That is a throughput regression with no failing assertion anywhere.
func TestSelfMountDoesNotGuessTheKernelsReadLimit(t *testing.T) {
	if hasOption(selfMountOptions(7, true, true), "max_read") {
		t.Fatal("max_read is being guessed; omit it and let the kernel default apply")
	}
}

// THE MAGIC MOUNT POINT IS THE SHAPE go-fuse PARSES, and getting it wrong is silent in the worst way: an
// unparseable form makes go-fuse fall through to the fusermount suid helper, which the shipped distroless
// image does not contain, so a recovery that had already mounted successfully would report a mount failure.
func TestFuseFdMountpointIsTheFormGoFuseParses(t *testing.T) {
	if got := fuseFdMountpoint(12); got != "/dev/fd/12" {
		t.Fatalf("the magic mount point is %q, which go-fuse will not parse as a descriptor", got)
	}
}

// hasOption reports whether a comma-separated mount data string carries an option, matching whole fields so
// that "nodev" is not found inside "nodevice" and "ro" is not found inside "rootmode".
func hasOption(data, option string) bool {
	for _, field := range strings.Split(data, ",") {
		if field == option || strings.HasPrefix(field, option+"=") {
			return true
		}
	}
	return false
}
