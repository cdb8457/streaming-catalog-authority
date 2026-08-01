//go:build linux

package fusefs

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/hanwen/go-fuse/v2/fuse"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/daemon"
)

const localEntryPath = "Movies/Local (2019)/Local (2019).bin"
const localEntrySize = int64(64 * 1024)

// newServedFS builds a daemon over a real local file and returns the raw filesystem plus the node id of the
// projected entry. It needs no mount: the raw protocol methods are called directly, which is exactly what the
// kernel would do.
func newServedFS(t *testing.T) (*FS, uint64, []byte) {
	t.Helper()
	base := t.TempDir()
	manifestDir := filepath.Join(base, "manifest")
	mediaRoot := filepath.Join(base, "media")
	for _, dir := range []string{manifestDir, filepath.Join(mediaRoot, "local")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	content := make([]byte, localEntrySize)
	for i := range content {
		content[i] = byte(i % 251)
	}
	if err := os.WriteFile(filepath.Join(mediaRoot, "local", "one.bin"), content, 0o644); err != nil {
		t.Fatal(err)
	}

	publish(t, manifestDir, "generation-1.json", buildManifest(1, "gen-one", nil, []entrySpec{
		{path: localEntryPath, size: localEntrySize, local: true, relative: "local/one.bin"},
	}))

	d, err := daemon.New(daemon.Config{
		PointerPath:   filepath.Join(manifestDir, "pointer.json"),
		LocalRoots:    map[string]string{"media": mediaRoot},
		ProbeCacheDir: filepath.Join(base, "cache"),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if record := d.LoadPointer(); !record.Accepted {
		t.Fatalf("the generation was not admitted: %+v", record)
	}

	fs := New(d)
	// Walk the namespace the way the kernel does, so the node ids under test are the ones it would use.
	nodeID := uint64(fuse.FUSE_ROOT_ID)
	for _, segment := range []string{"Movies", "Local (2019)", "Local (2019).bin"} {
		var out fuse.EntryOut
		status := fs.Lookup(nil, &fuse.InHeader{NodeId: nodeID}, segment, &out)
		if status != fuse.OK {
			t.Fatalf("lookup %q: %v", segment, status)
		}
		nodeID = out.NodeId
	}
	return fs, nodeID, content
}

func openHandle(t *testing.T, fs *FS, nodeID uint64) uint64 {
	t.Helper()
	var out fuse.OpenOut
	if status := fs.Open(nil, &fuse.OpenIn{InHeader: fuse.InHeader{NodeId: nodeID}}, &out); status != fuse.OK {
		t.Fatalf("open: %v", status)
	}
	t.Cleanup(func() { fs.Release(nil, &fuse.ReleaseIn{Fh: out.Fh}) })
	return out.Fh
}

// REGRESSION: END OF FILE IS NOT AN ERROR.
//
// readpath signals the end of a file with io.EOF; the FUSE layer used to hand that to the generic failure
// mapper, which turned it into EIO. A reader parked exactly at the declared size therefore never saw a clean
// end — `io.Copy` retried forever and the mount looked like it had hung. A hang caused by an error mapping is
// the worst kind to diagnose from outside, so this is asserted directly.
func TestReadAtEOFReturnsZeroBytesAndOK(t *testing.T) {
	fs, nodeID, _ := newServedFS(t)
	fh := openHandle(t, fs, nodeID)

	buf := make([]byte, 4096)
	for _, offset := range []uint64{uint64(localEntrySize), uint64(localEntrySize) + 1, uint64(localEntrySize) * 2} {
		result, status := fs.Read(nil, &fuse.ReadIn{
			InHeader: fuse.InHeader{NodeId: nodeID}, Fh: fh, Offset: offset, Size: 4096,
		}, buf)
		if status != fuse.OK {
			t.Fatalf("a read at offset %d must be OK with zero bytes, got %v", offset, status)
		}
		bytes, status := result.Bytes(buf)
		if status != fuse.OK {
			t.Fatalf("reading the result at %d: %v", offset, status)
		}
		if len(bytes) != 0 {
			t.Fatalf("a read at offset %d must produce zero bytes, got %d", offset, len(bytes))
		}
	}
}

// The ordinary path still works, and a read that straddles EOF is a SHORT read rather than zero padding.
func TestReadReturnsExactBytesAndShortReadsAtTheEnd(t *testing.T) {
	fs, nodeID, content := newServedFS(t)
	fh := openHandle(t, fs, nodeID)

	buf := make([]byte, 8192)
	result, status := fs.Read(nil, &fuse.ReadIn{
		InHeader: fuse.InHeader{NodeId: nodeID}, Fh: fh, Offset: 1024, Size: 8192,
	}, buf)
	if status != fuse.OK {
		t.Fatalf("read: %v", status)
	}
	got, status := result.Bytes(buf)
	if status != fuse.OK {
		t.Fatal(status)
	}
	if len(got) != 8192 {
		t.Fatalf("expected 8192 bytes, got %d", len(got))
	}
	for i := range got {
		if got[i] != content[1024+i] {
			t.Fatalf("byte %d is wrong", i)
		}
	}

	// A read whose window crosses the end returns only the bytes that exist.
	straddle := make([]byte, 8192)
	result, status = fs.Read(nil, &fuse.ReadIn{
		InHeader: fuse.InHeader{NodeId: nodeID}, Fh: fh, Offset: uint64(localEntrySize) - 100, Size: 8192,
	}, straddle)
	if status != fuse.OK {
		t.Fatalf("straddling read: %v", status)
	}
	got, status = result.Bytes(straddle)
	if status != fuse.OK {
		t.Fatal(status)
	}
	if len(got) != 100 {
		t.Fatalf("a read crossing EOF must be short, got %d bytes", len(got))
	}
}

// An untrusted readdir offset must never wrap into a negative index.
func TestReadDirRefusesAnAbsurdOffsetWithoutPanicking(t *testing.T) {
	fs, _, _ := newServedFS(t)
	var out fuse.EntryOut
	if status := fs.Lookup(nil, &fuse.InHeader{NodeId: fuse.FUSE_ROOT_ID}, "Movies", &out); status != fuse.OK {
		t.Fatalf("lookup: %v", status)
	}
	for _, offset := range []uint64{0, 1, 1 << 62, 1<<64 - 1} {
		list := fuse.NewDirEntryList(make([]byte, 4096), 0)
		if status := fs.ReadDir(nil, &fuse.ReadIn{
			InHeader: fuse.InHeader{NodeId: out.NodeId}, Offset: offset, Size: 4096,
		}, list); status != fuse.OK {
			t.Fatalf("readdir at offset %d must not fail: %v", offset, status)
		}
	}
}

// Every mutation-intent open is refused before it can reach a source.
func TestWriteIntentOpenIsRefused(t *testing.T) {
	fs, nodeID, _ := newServedFS(t)
	for _, flags := range []uint32{syscall.O_WRONLY, syscall.O_RDWR, syscall.O_APPEND, syscall.O_TRUNC} {
		var out fuse.OpenOut
		status := fs.Open(nil, &fuse.OpenIn{InHeader: fuse.InHeader{NodeId: nodeID}, Flags: flags}, &out)
		if status != fuse.Status(syscall.EROFS) {
			t.Fatalf("a write-intent open must be EROFS, got %v", status)
		}
	}
}

// Directory metadata is the fixed epoch, and a file's is the manifest's — through the actual attribute path.
func TestAttributesComeFromTheManifest(t *testing.T) {
	fs, nodeID, _ := newServedFS(t)

	var fileAttr fuse.AttrOut
	if status := fs.GetAttr(nil, &fuse.GetAttrIn{InHeader: fuse.InHeader{NodeId: nodeID}}, &fileAttr); status != fuse.OK {
		t.Fatalf("getattr: %v", status)
	}
	if fileAttr.Size != uint64(localEntrySize) {
		t.Fatalf("size came from somewhere other than the manifest: %d", fileAttr.Size)
	}
	if fileAttr.Mode&0o777 != 0o444 {
		t.Fatalf("the namespace is not read-only in its mode bits: %o", fileAttr.Mode)
	}

	var rootAttr fuse.AttrOut
	if status := fs.GetAttr(nil, &fuse.GetAttrIn{InHeader: fuse.InHeader{NodeId: fuse.FUSE_ROOT_ID}}, &rootAttr); status != fuse.OK {
		t.Fatalf("root getattr: %v", status)
	}
	if rootAttr.Mtime == 0 {
		t.Fatal("the mount root must carry the fixed directory epoch, not a zero time")
	}
	if rootAttr.Mtime > 1<<62 {
		t.Fatal("a negative time was converted into an absurd unsigned timestamp")
	}
}
