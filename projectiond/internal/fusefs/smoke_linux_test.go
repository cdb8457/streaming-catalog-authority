//go:build linux && fusesmoke

// The FUSE smoke run. It needs /dev/fuse and CAP_SYS_ADMIN, so it is behind a build tag and its own Compose
// service rather than something the ordinary gates inherit.
//
// WHAT IT PROVES THAT NOTHING ELSE CAN. Every other gate in this repository exercises the daemon's own code.
// This one asks the KERNEL: it mounts the namespace, stats it, lists it, reads it, seeks in it, hashes it,
// tries to write to it, swaps a generation underneath an open handle, and unmounts. A contract test cannot
// tell you that a media server will see a regular file; a mount can.
package fusefs

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"sort"
	"syscall"
	"testing"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/daemon"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/fakeprovider"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/manifest"
)

func TestFUSEMountServesTheNamespace(t *testing.T) {
	if os.Getenv("PROJECTIOND_FUSE_SMOKE") == "" {
		t.Skip("set PROJECTIOND_FUSE_SMOKE=1 and run with /dev/fuse to exercise the mount")
	}
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skipf("no /dev/fuse on this host: %v", err)
	}

	base := t.TempDir()
	manifestDir := filepath.Join(base, "manifest")
	mediaRoot := filepath.Join(base, "media")
	cacheDir := filepath.Join(base, "cache")
	mountPoint := filepath.Join(base, "mnt")
	for _, dir := range []string{manifestDir, mediaRoot, cacheDir, mountPoint} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	// One local file with real bytes on disk.
	const localSize = 3 * 1024 * 1024
	localBytes := make([]byte, localSize)
	for i := range localBytes {
		localBytes[i] = byte(i % 251)
	}
	if err := os.MkdirAll(filepath.Join(mediaRoot, "local"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mediaRoot, "local", "one.bin"), localBytes, 0o644); err != nil {
		t.Fatal(err)
	}

	// One remote file served by the fake endpoint.
	server, err := fakeprovider.New(fakeprovider.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	const remoteSize = int64(5 * 1024 * 1024)
	server.AddObject("obj-remote", remoteSize)

	specs := []entrySpec{
		{path: "Movies/Local (2019)/Local (2019).bin", size: localSize, local: true, relative: "local/one.bin"},
		{path: "Movies/Remote (2021)/Remote (2021).bin", size: remoteSize, objectRef: "obj-remote"},
		{path: "Movies/Degraded (2018)/Degraded (2018).bin", size: remoteSize, objectRef: "obj-remote",
			visibility: "degraded"},
	}
	first := buildManifest(1, "gen-one", nil, specs)
	publish(t, manifestDir, "generation-1.json", first)

	d, err := daemon.New(daemon.Config{
		MountPoint:    mountPoint,
		PointerPath:   filepath.Join(manifestDir, "pointer.json"),
		LocalRoots:    map[string]string{"media": mediaRoot},
		ProbeCacheDir: cacheDir,
		Endpoints: []daemon.EndpointConfigFile{{
			ID: "fake", ResolverURL: server.ResolveURL(),
			AllowedOrigins: []string{server.BaseURL()}, AllowInsecureHTTP: true,
			AllowPrivateAddresses: true, MaxConnections: 4,
		}},
	})
	if err != nil {
		t.Fatalf("daemon: %v", err)
	}
	defer d.Close()
	if record := d.LoadPointer(); !record.Accepted {
		t.Fatalf("the first generation was not admitted: %+v", record)
	}

	// Mount starts the request loop and waits for INIT before returning; without a serve loop the first
	// readdir below would hang forever.
	mount, err := Mount(d, mountPoint, false)
	if err != nil {
		t.Skipf("this host cannot mount FUSE: %v", err)
	}
	t.Logf("phase: %s", "MOUNTED")
	// Readiness is only true once the mount is actually serving, which is after Mount returned.
	if !d.Status().Ready {
		d.SetMounted(true)
	}
	if !d.Status().Ready {
		t.Fatal("the daemon must be ready once an admitted generation is mounted and serving")
	}
	mounted := true
	unmount := func() {
		if mounted {
			_ = mount.Unmount()
			mount.Wait()
			mounted = false
		}
	}
	defer unmount()

	t.Logf("phase: %s", "LIST")
	// --- LIST -------------------------------------------------------------------------------------------
	names := listNames(t, filepath.Join(mountPoint, "Movies"))
	want := []string{"Degraded (2018)", "Local (2019)", "Remote (2021)"}
	if len(names) != len(want) {
		t.Fatalf("readdir returned %v, expected %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("readdir order is not stable: %v", names)
		}
	}

	t.Logf("phase: %s", "STAT")
	// --- STAT -------------------------------------------------------------------------------------------
	localPath := filepath.Join(mountPoint, "Movies/Local (2019)/Local (2019).bin")
	info, err := os.Stat(localPath)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Size() != localSize {
		t.Fatalf("size came from somewhere other than the manifest: %d", info.Size())
	}
	if info.Mode().Perm() != 0o444 {
		t.Fatalf("the namespace is not read-only in its mode bits: %v", info.Mode())
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("a media server must never see a symlink")
	}
	stat := info.Sys().(*syscall.Stat_t)
	// The inode is the manifest's, derived from the projected version and from nothing else.
	versionID := "pv_" + hex64("version:Movies/Local (2019)/Local (2019).bin")
	if stat.Ino != manifest.DeriveInode(versionID) {
		t.Fatalf("the kernel sees inode %d, the manifest derives %d", stat.Ino, manifest.DeriveInode(versionID))
	}
	inodeBefore := stat.Ino
	mtimeBefore := info.ModTime()

	t.Logf("phase: %s", "READ/SEEK/HASH")
	// --- READ, SEEK AND HASH ----------------------------------------------------------------------------
	file, err := os.Open(localPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		t.Fatalf("full read: %v", err)
	}
	expected := sha256.Sum256(localBytes)
	if hex.EncodeToString(hasher.Sum(nil)) != hex.EncodeToString(expected[:]) {
		t.Fatal("the bytes read through the mount are not the bytes on disk")
	}
	// A backwards seek, which is what a transcode does.
	if _, err := file.Seek(1024, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	spot := make([]byte, 4096)
	if _, err := io.ReadFull(file, spot); err != nil {
		t.Fatal(err)
	}
	for i := range spot {
		if spot[i] != localBytes[1024+i] {
			t.Fatalf("a seek returned the wrong bytes at %d", i)
		}
	}
	_ = file.Close()

	// The remote entry reads through the HTTP Range adapter and the fake endpoint.
	remotePath := filepath.Join(mountPoint, "Movies/Remote (2021)/Remote (2021).bin")
	remoteFile, err := os.Open(remotePath)
	if err != nil {
		t.Fatalf("open remote: %v", err)
	}
	head := make([]byte, 65536)
	if _, err := io.ReadFull(remoteFile, head); err != nil {
		t.Fatalf("remote read: %v", err)
	}
	if string(head) != string(fakeprovider.ObjectBytes("obj-remote", 0, 65536)) {
		t.Fatal("the remote bytes are wrong")
	}

	t.Logf("phase: %s", "DEGRADED")
	// --- DEGRADED IS PRESENT AND COSTS NOTHING ----------------------------------------------------------
	degradedPath := filepath.Join(mountPoint, "Movies/Degraded (2018)/Degraded (2018).bin")
	degradedInfo, err := os.Stat(degradedPath)
	if err != nil {
		t.Fatalf("a degraded entry must still be visible: %v", err)
	}
	if degradedInfo.Size() != remoteSize {
		t.Fatal("a degraded entry must keep its size")
	}
	requestsBefore := server.Counters().RangeRequests.Load()
	degradedFile, err := os.Open(degradedPath)
	if err != nil {
		t.Fatalf("a degraded entry must still open: %v", err)
	}
	if _, err := degradedFile.Read(make([]byte, 4096)); err == nil {
		t.Fatal("a degraded entry must fail its reads")
	}
	_ = degradedFile.Close()
	if server.Counters().RangeRequests.Load() != requestsBefore {
		t.Fatal("a degraded read reached the provider")
	}

	t.Logf("phase: %s", "MUTATIONS REFUSED")
	// --- EVERY MUTATION IS REFUSED ----------------------------------------------------------------------
	for name, attempt := range map[string]func() error{
		"create": func() error { f, err := os.Create(filepath.Join(mountPoint, "new.bin")); closeIf(f); return err },
		"write":  func() error { f, err := os.OpenFile(localPath, os.O_WRONLY, 0); closeIf(f); return err },
		"append": func() error { f, err := os.OpenFile(localPath, os.O_APPEND|os.O_WRONLY, 0); closeIf(f); return err },
		"unlink": func() error { return os.Remove(localPath) },
		"mkdir":  func() error { return os.Mkdir(filepath.Join(mountPoint, "newdir"), 0o755) },
		"rename": func() error { return os.Rename(localPath, localPath+".moved") },
		"chmod":  func() error { return os.Chmod(localPath, 0o666) },
		"symlink": func() error {
			return os.Symlink("/etc/passwd", filepath.Join(mountPoint, "link"))
		},
		"truncate": func() error { return os.Truncate(localPath, 0) },
	} {
		if err := attempt(); err == nil {
			t.Fatalf("%s succeeded against a read-only namespace", name)
		}
	}

	t.Logf("phase: %s", "GENERATION SWAP")
	// --- GENERATION SWAP UNDER AN OPEN HANDLE -----------------------------------------------------------
	predecessor := map[string]any{
		"generationId":   "gen_" + hex32("gen-one"),
		"sequence":       1,
		"manifestDigest": manifest.DigestOfBytes(first),
	}
	extended := append(append([]entrySpec{}, specs...), entrySpec{
		path: "Movies/Added (2022)/Added (2022).bin", size: remoteSize, objectRef: "obj-remote",
	})
	second := buildManifest(2, "gen-two", predecessor, extended)
	publish(t, manifestDir, "generation-2.json", second)
	if record := d.LoadPointer(); !record.Accepted {
		t.Fatalf("the successor was not admitted: %+v", record)
	}

	// The handle opened against generation 1 keeps reading correctly across the swap.
	more := make([]byte, 65536)
	if _, err := remoteFile.Read(more); err != nil {
		t.Fatalf("a generation swap disturbed an open handle: %v", err)
	}
	if string(more) != string(fakeprovider.ObjectBytes("obj-remote", 65536, 65536)) {
		t.Fatal("the bytes after a swap are wrong")
	}
	_ = remoteFile.Close()

	// The new entry is visible; the old ones are unchanged.
	if _, err := os.Stat(filepath.Join(mountPoint, "Movies/Added (2022)/Added (2022).bin")); err != nil {
		t.Fatalf("the added entry is not visible after the swap: %v", err)
	}
	afterSwap, err := os.Stat(localPath)
	if err != nil {
		t.Fatal(err)
	}
	if afterSwap.Sys().(*syscall.Stat_t).Ino != inodeBefore {
		t.Fatal("a generation swap moved an inode")
	}
	if !afterSwap.ModTime().Equal(mtimeBefore) {
		t.Fatal("a generation swap moved an mtime")
	}

	t.Logf("phase: %s", "STATFS")
	// --- STATFS -----------------------------------------------------------------------------------------
	var vfs syscall.Statfs_t
	if err := syscall.Statfs(mountPoint, &vfs); err != nil {
		t.Fatalf("statfs: %v", err)
	}
	if vfs.Bavail != 0 {
		t.Fatal("a read-only namespace must not advertise free space")
	}

	t.Logf("phase: %s", "UNMOUNT/REMOUNT")
	// --- UNMOUNT AND REMOUNT ----------------------------------------------------------------------------
	unmount()
	d.SetMounted(false)
	if _, err := os.Stat(localPath); err == nil {
		t.Fatal("the namespace is still readable after unmount")
	}

	remounted, err := Mount(d, mountPoint, false)
	if err != nil {
		t.Fatalf("remount: %v", err)
	}
	mounted = true
	mount = remounted
	if _, err := os.Stat(localPath); err != nil {
		t.Fatalf("the namespace is not readable after a remount: %v", err)
	}
	// Metadata survives a remount unchanged — the whole point of deriving it from the manifest.
	afterRemount, err := os.Stat(localPath)
	if err != nil {
		t.Fatal(err)
	}
	if afterRemount.Sys().(*syscall.Stat_t).Ino != inodeBefore {
		t.Fatal("a remount moved an inode")
	}
	if !afterRemount.ModTime().Equal(mtimeBefore) {
		t.Fatal("a remount moved an mtime")
	}
	unmount()
}

func closeIf(f *os.File) {
	if f != nil {
		_ = f.Close()
	}
}

func listNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir %s: %v", dir, err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}
