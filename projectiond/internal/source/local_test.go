//go:build linux

package source

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func localFixture(t *testing.T, size int) (*LocalAdapter, string, []byte) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "Movies", "A"), 0o755); err != nil {
		t.Fatal(err)
	}
	content := make([]byte, size)
	for i := range content {
		content[i] = byte(i % 251)
	}
	path := filepath.Join(root, "Movies", "A", "a.mkv")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	adapter, err := NewLocalAdapter(map[string]string{"root": root})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = adapter.Close() })
	return adapter, root, content
}

func localRequest(size int64, offset, length int64) ReadRequest {
	return ReadRequest{
		SourceID: "src", SizeBytes: size, Offset: offset, Length: length,
		Locator: Locator{Kind: "local", RootID: "root", RelativePath: "Movies/A/a.mkv"},
	}
}

func TestLocalReadsExactBytes(t *testing.T) {
	const size = 4096
	adapter, _, content := localFixture(t, size)
	buf := make([]byte, 100)
	n, err := adapter.Fetch(context.Background(), localRequest(size, 10, 100), buf)
	if err != nil {
		t.Fatal(err)
	}
	if n != 100 {
		t.Fatalf("expected 100 bytes, got %d", n)
	}
	if !bytes.Equal(buf, content[10:110]) {
		t.Fatal("the bytes returned are not the bytes on disk")
	}
}

// REGRESSION: the adapter used to clamp silently at EOF and return nil with no count, so a caller that
// assumed dst[:Length] was filled would have served zero padding past the end of the file as media bytes.
// The engine clamps before dispatch and the adapter reports what it produced.
func TestReadEndingExactlyAtEOFAndPastItAreExplicit(t *testing.T) {
	const size = 4096
	adapter, _, content := localFixture(t, size)

	// Exactly to EOF: a full read.
	buf := make([]byte, 96)
	n, err := adapter.Fetch(context.Background(), localRequest(size, size-96, 96), buf)
	if err != nil {
		t.Fatal(err)
	}
	if n != 96 || !bytes.Equal(buf, content[size-96:]) {
		t.Fatalf("a read ending at EOF must be complete, got %d bytes", n)
	}

	// Crossing EOF is refused as malformed rather than silently truncated: the engine should never build one.
	over := make([]byte, 200)
	if _, err := adapter.Fetch(context.Background(), localRequest(size, size-100, 200), over); err == nil {
		t.Fatal("a request past the manifest size must be refused")
	} else if AsFailure(err).Cond != CondRangeMismatch {
		t.Fatalf("expected a range mismatch, got %v", err)
	}

	// A destination shorter than the request is refused rather than indexed.
	short := make([]byte, 4)
	if _, err := adapter.Fetch(context.Background(), localRequest(size, 0, 64), short); err == nil {
		t.Fatal("a destination shorter than the request must be refused")
	}
}

func TestLocalRefusesSizeDisagreement(t *testing.T) {
	const size = 4096
	adapter, _, _ := localFixture(t, size)
	buf := make([]byte, 16)
	// The manifest says the file is bigger than it is. Those are not this projected version's bytes.
	_, err := adapter.Fetch(context.Background(), localRequest(size+1, 0, 16), buf)
	if err == nil || AsFailure(err).Cond != CondSizeDisagrees {
		t.Fatalf("expected a size disagreement, got %v", err)
	}
}

// A symlink anywhere on the path is never followed: a media server must not be able to reach anything the
// operator did not put inside a configured root.
func TestLocalRefusesSymlinkEscape(t *testing.T) {
	adapter, root, _ := localFixture(t, 4096)
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("not yours"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "Movies", "A", "escape.mkv")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	req := localRequest(9, 0, 9)
	req.Locator.RelativePath = "Movies/A/escape.mkv"
	buf := make([]byte, 9)
	if _, err := adapter.Fetch(context.Background(), req, buf); err == nil {
		t.Fatal("a symlinked entry must be refused, not followed")
	} else if AsFailure(err).Cond != CondSourceRefUnknown {
		t.Fatalf("expected the symlink refusal, got %v", err)
	}

	// And a symlinked DIRECTORY component is refused too.
	dirLink := filepath.Join(root, "Movies", "B")
	if err := os.Symlink(filepath.Dir(outside), dirLink); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	req.Locator.RelativePath = "Movies/B/secret.txt"
	if _, err := adapter.Fetch(context.Background(), req, buf); err == nil {
		t.Fatal("a symlinked directory component must be refused")
	}
}

func TestLocalRefusesNonRegularFile(t *testing.T) {
	adapter, root, _ := localFixture(t, 4096)
	if err := os.MkdirAll(filepath.Join(root, "Movies", "A", "dir.mkv"), 0o755); err != nil {
		t.Fatal(err)
	}
	req := localRequest(4096, 0, 16)
	req.Locator.RelativePath = "Movies/A/dir.mkv"
	buf := make([]byte, 16)
	if _, err := adapter.Fetch(context.Background(), req, buf); err == nil {
		t.Fatal("a directory behind a projected path must be refused")
	}
}

// REGRESSION: openConfined released the roots lock before using the root descriptor, so a concurrent Close
// could close it mid-walk and the number could be reused by the next open anywhere in the process. The walk
// now runs on a private duplicate taken under the lock. Run this with -race.
func TestCloseDuringFetchIsSafe(t *testing.T) {
	const size = 65536
	for attempt := 0; attempt < 20; attempt++ {
		adapter, _, _ := localFixture(t, size)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			buf := make([]byte, 4096)
			for i := 0; i < 40; i++ {
				// Either it reads or it refuses. What it must never do is read something else.
				_, _ = adapter.Fetch(context.Background(), localRequest(size, 0, 4096), buf)
			}
		}()
		go func() {
			defer wg.Done()
			_ = adapter.Close()
		}()
		wg.Wait()
	}
}

func TestUnknownRootIsRefused(t *testing.T) {
	adapter, _, _ := localFixture(t, 4096)
	req := localRequest(4096, 0, 16)
	req.Locator.RootID = "nope"
	buf := make([]byte, 16)
	if _, err := adapter.Fetch(context.Background(), req, buf); err == nil {
		t.Fatal("an unknown root must be refused")
	} else if AsFailure(err).Cond != CondSourceRefUnknown {
		t.Fatalf("expected an unknown reference, got %v", err)
	}
}

func TestCancelledContextStopsTheRead(t *testing.T) {
	adapter, _, _ := localFixture(t, 4096)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	buf := make([]byte, 16)
	if _, err := adapter.Fetch(ctx, localRequest(4096, 0, 16), buf); err == nil {
		t.Fatal("a cancelled read must not proceed")
	} else if AsFailure(err).Cond != CondReadDeadline {
		t.Fatalf("expected a deadline failure, got %v", err)
	}
}
