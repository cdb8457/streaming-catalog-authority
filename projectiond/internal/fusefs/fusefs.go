//go:build linux

// Package fusefs is the low-level FUSE surface.
//
// IT IS THE RAW PROTOCOL, DELIBERATELY. Node ids are the manifest's own inode numbers, lookup counts are
// tracked here, and file handles are ours. That is more code than a high-level tree binding, but it is the
// only way to be certain that a generation swap does not disturb an open handle and that no operation this
// contract forbids exists at all.
//
// EVERY METADATA OPERATION IS A MAP READ. lookup, getattr, readdir, readdirplus, statfs and open answer from
// the immutable in-memory generation with zero database calls and zero provider calls. A library scan of a
// fully remote namespace therefore costs no provider traffic beyond the scan windows.
package fusefs

import (
	"context"
	"errors"
	"io"
	"sync"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fuse"
	"golang.org/x/sys/unix"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/daemon"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/namespace"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/readpath"
	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/source"
)

const (
	// attrTimeout is how long the kernel may cache an attribute. Size and mtime come only from the manifest
	// and a carried entry's never change, so this can be generous without risking a stale size.
	attrTimeout  = 60 * time.Second
	entryTimeout = 30 * time.Second
	blockSize    = 512
	fsBlockSize  = 4096
)

// nodeRef carries GENERATION OWNERSHIP, not just a node.
//
// A node without its snapshot is a trap: the caller has an entry from generation n and no way to know that,
// so it pins whatever is current when it gets around to opening. Then the handle reads n's entry while
// claiming n+1 — different source, possibly different size, possibly a file the newer generation deleted.
type nodeRef struct {
	path     string
	node     *namespace.Node
	snapshot *namespace.Snapshot
	lookups  uint64
}

type handle struct {
	snapshot *namespace.Snapshot
	read     *readpath.Handle
}

// FS is the raw filesystem.
type FS struct {
	fuse.RawFileSystem
	d *daemon.Daemon

	mu      sync.Mutex
	nodes   map[uint64]*nodeRef
	handles map[uint64]*handle
	nextFH  uint64
}

func New(d *daemon.Daemon) *FS {
	return &FS{
		RawFileSystem: fuse.NewDefaultRawFileSystem(),
		d:             d,
		nodes:         map[uint64]*nodeRef{},
		handles:       map[uint64]*handle{},
		nextFH:        1,
	}
}

// resolve returns a node together with THE SNAPSHOT IT BELONGS TO.
//
// The root always resolves against the current generation, so a swap is visible to any lookup that starts
// after it. A non-root node is re-resolved by path against the current generation — and when it is still
// there under the same inode, the caller gets the current snapshot. Only when it is gone does the caller get
// the remembered node and the snapshot it actually came from, which is what keeps a file the kernel already
// knows describable after a deletion generation removed it.
func (f *FS) resolve(nodeID uint64) (*namespace.Node, *namespace.Snapshot, bool) {
	snap := f.d.Store.Current()
	if snap == nil {
		return nil, nil, false
	}
	if nodeID == fuse.FUSE_ROOT_ID {
		return snap.Tree.Root, snap, true
	}
	f.mu.Lock()
	ref, ok := f.nodes[nodeID]
	f.mu.Unlock()
	if !ok {
		return nil, nil, false
	}
	if current, found := snap.Tree.ByPath[ref.path]; found && current.Ino == nodeID {
		return current, snap, true
	}
	return ref.node, ref.snapshot, true
}

func (f *FS) remember(path string, node *namespace.Node, snap *namespace.Snapshot) {
	if node.Ino == fuse.FUSE_ROOT_ID {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if ref, ok := f.nodes[node.Ino]; ok {
		ref.lookups++
		ref.node = node
		ref.path = path
		ref.snapshot = snap
		return
	}
	f.nodes[node.Ino] = &nodeRef{path: path, node: node, snapshot: snap, lookups: 1}
}

func (f *FS) fillAttr(node *namespace.Node, out *fuse.Attr) {
	out.Ino = node.Ino
	// STABLE ino, size and mtime come only from the manifest. Nothing here stats a backing file, which is why
	// a remote entry costs nothing to describe and why its metadata cannot drift between two scans.
	if node.IsDir {
		out.Mode = syscall.S_IFDIR | 0o555
		out.Nlink = 2
		out.Size = 4096
	} else {
		out.Mode = syscall.S_IFREG | (node.Mode & 0o777)
		// A projected version at two paths is one inode with two names. Reporting nlink=1 would tell a media
		// server they were unrelated files.
		out.Nlink = uint32(node.Links)
		if out.Nlink == 0 {
			out.Nlink = 1
		}
		out.Size = uint64(node.Size)
	}
	// A pre-1970 timestamp would convert to an enormous unsigned second count and show up as a file from the
	// year 2500. Clamping is the honest answer: the manifest's own validator refuses a malformed timestamp,
	// so this only ever fires on a deliberately antique one.
	seconds := node.Mtime.Unix()
	if seconds < 0 {
		seconds = 0
	}
	nanos := uint32(node.Mtime.Nanosecond())
	out.Mtime, out.Mtimensec = uint64(seconds), nanos
	out.Atime, out.Atimensec = uint64(seconds), nanos
	out.Ctime, out.Ctimensec = uint64(seconds), nanos
	out.Blksize = fsBlockSize
	out.Blocks = (out.Size + blockSize - 1) / blockSize
}

func (f *FS) Lookup(cancel <-chan struct{}, header *fuse.InHeader, name string, out *fuse.EntryOut) fuse.Status {
	parent, snap, ok := f.resolve(header.NodeId)
	if !ok {
		return fuse.ENOENT
	}
	child, ok := parent.Lookup(name)
	if !ok {
		// ENOENT MEANS ONE THING: the path is not in the admitted generation. Nothing transient reaches here.
		return fuse.ENOENT
	}
	path := name
	if parentPath := f.pathOf(header.NodeId); parentPath != "" {
		path = parentPath + "/" + name
	}
	f.remember(path, child, snap)
	out.NodeId = child.Ino
	out.Generation = 0
	out.SetEntryTimeout(entryTimeout)
	out.SetAttrTimeout(attrTimeout)
	f.fillAttr(child, &out.Attr)
	return fuse.OK
}

func (f *FS) pathOf(nodeID uint64) string {
	if nodeID == fuse.FUSE_ROOT_ID {
		return ""
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if ref, ok := f.nodes[nodeID]; ok {
		return ref.path
	}
	return ""
}

func (f *FS) Forget(nodeID, nlookup uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ref, ok := f.nodes[nodeID]
	if !ok {
		return
	}
	if ref.lookups <= nlookup {
		delete(f.nodes, nodeID)
		return
	}
	ref.lookups -= nlookup
}

func (f *FS) GetAttr(cancel <-chan struct{}, in *fuse.GetAttrIn, out *fuse.AttrOut) fuse.Status {
	node, _, ok := f.resolve(in.NodeId)
	if !ok {
		return fuse.ENOENT
	}
	out.SetTimeout(attrTimeout)
	f.fillAttr(node, &out.Attr)
	return fuse.OK
}

func (f *FS) Access(cancel <-chan struct{}, in *fuse.AccessIn) fuse.Status {
	if _, _, ok := f.resolve(in.NodeId); !ok {
		return fuse.ENOENT
	}
	// W_OK is 2. There is no writable path in this namespace at all.
	if in.Mask&2 != 0 {
		return fuse.Status(syscall.EROFS)
	}
	return fuse.OK
}

func (f *FS) OpenDir(cancel <-chan struct{}, in *fuse.OpenIn, out *fuse.OpenOut) fuse.Status {
	node, _, ok := f.resolve(in.NodeId)
	if !ok {
		return fuse.ENOENT
	}
	if !node.IsDir {
		return fuse.ENOTDIR
	}
	return fuse.OK
}

func (f *FS) ReadDir(cancel <-chan struct{}, in *fuse.ReadIn, out *fuse.DirEntryList) fuse.Status {
	return f.readDir(in, out, false)
}

func (f *FS) ReadDirPlus(cancel <-chan struct{}, in *fuse.ReadIn, out *fuse.DirEntryList) fuse.Status {
	return f.readDir(in, out, true)
}

func (f *FS) readDir(in *fuse.ReadIn, out *fuse.DirEntryList, plus bool) fuse.Status {
	node, snap, ok := f.resolve(in.NodeId)
	if !ok {
		return fuse.ENOENT
	}
	if !node.IsDir {
		return fuse.ENOTDIR
	}
	// THE OFFSET COMES FROM THE KERNEL AND IS UNTRUSTED. Converting a uint64 straight to int wraps negative
	// on a 64-bit platform for anything above 2^63, and a negative slice index is a panic that takes the
	// mount with it. An out-of-range offset is simply the end of the directory.
	count := uint64(len(node.Ordered))
	if in.Offset > count {
		return fuse.OK
	}
	basePath := f.pathOf(in.NodeId)
	// The order was fixed when the generation was built, so two readdirs of an unchanged generation agree
	// exactly and an offset means the same thing on both.
	for i := in.Offset; i < count; i++ {
		child := node.Ordered[i]
		mode := uint32(syscall.S_IFREG)
		if child.IsDir {
			mode = syscall.S_IFDIR
		}
		entry := fuse.DirEntry{Mode: mode, Name: child.Name, Ino: child.Ino}
		if plus {
			entryOut := out.AddDirLookupEntry(entry)
			if entryOut == nil {
				break
			}
			childPath := child.Name
			if basePath != "" {
				childPath = basePath + "/" + child.Name
			}
			f.remember(childPath, child, snap)
			entryOut.NodeId = child.Ino
			entryOut.SetEntryTimeout(entryTimeout)
			entryOut.SetAttrTimeout(attrTimeout)
			f.fillAttr(child, &entryOut.Attr)
			continue
		}
		if !out.AddDirEntry(entry) {
			break
		}
	}
	return fuse.OK
}

func (f *FS) Open(cancel <-chan struct{}, in *fuse.OpenIn, out *fuse.OpenOut) fuse.Status {
	// The kernel is mounted read-only, so a write-intent open never reaches here. This is the second lock on
	// the same door, on the side that would otherwise have to invent a behaviour for it.
	if in.Flags&(syscall.O_WRONLY|syscall.O_RDWR|syscall.O_APPEND|syscall.O_CREAT|syscall.O_TRUNC) != 0 {
		return fuse.Status(syscall.EROFS)
	}
	node, snap, ok := f.resolve(in.NodeId)
	if !ok {
		return fuse.ENOENT
	}

	// AN OPEN PINS THE GENERATION THE NODE CAME FROM, ATOMICALLY. Pinning "whatever is current" would let a
	// swap between resolve and open give the handle an entry from one generation and a pin on another.
	if !f.d.Store.AcquirePinned(snap) {
		// The owning generation was reclaimed between the lookup and the open. Re-resolve against what is
		// current rather than reading a generation nobody is holding any more.
		current := f.d.Store.Current()
		if current == nil {
			return fuse.EIO
		}
		refreshed, found := current.Tree.ByPath[f.pathOf(in.NodeId)]
		if !found || !f.d.Store.AcquirePinned(current) {
			return fuse.ENOENT
		}
		node, snap = refreshed, current
	}
	if node.IsDir {
		f.d.Store.Release(snap)
		return fuse.Status(syscall.EISDIR)
	}
	if node.Entry == nil {
		f.d.Store.Release(snap)
		return fuse.EIO
	}

	readHandle, err := f.d.Reader.Open(node.Entry, snap.GenerationID())
	if err != nil {
		f.d.Store.Release(snap)
		return fuse.Status(source.AsFailure(err).Errno())
	}

	f.mu.Lock()
	fh := f.nextFH
	f.nextFH++
	f.handles[fh] = &handle{snapshot: snap, read: readHandle}
	f.mu.Unlock()

	out.Fh = fh
	// No kernel page cache for this file: the daemon owns caching, and a page cache that outlived a
	// generation swap would be a second, invisible copy of the metadata this contract makes authoritative.
	out.OpenFlags = fuse.FOPEN_DIRECT_IO
	return fuse.OK
}

func (f *FS) Read(cancel <-chan struct{}, in *fuse.ReadIn, buf []byte) (fuse.ReadResult, fuse.Status) {
	f.mu.Lock()
	h, ok := f.handles[in.Fh]
	f.mu.Unlock()
	if !ok {
		return nil, fuse.EBADF
	}
	size := int(in.Size)
	if size < 0 || size > len(buf) {
		size = len(buf)
	}
	if in.Offset > 1<<62 {
		return nil, fuse.Status(syscall.EINVAL)
	}
	ctx, cancelCtx := contextFor(cancel)
	defer cancelCtx()

	n, err := f.d.Reader.Read(ctx, h.read, buf[:size], int64(in.Offset))
	if err != nil {
		if n > 0 {
			// A short read is a real answer. Discarding it would turn a partial success into an error.
			return fuse.ReadResultData(buf[:n]), fuse.OK
		}
		// END OF FILE IS NOT AN ERROR. A read at or past EOF answers ZERO BYTES with OK, which is how the
		// kernel — and therefore every `read(2)` loop above it — learns the file has ended.
		//
		// Converting it to EIO is not merely a wrong errno: `io.Copy` and friends never see a clean end, so a
		// reader parked exactly at the declared size retries forever and the mount appears to hang. That is a
		// hang caused by an error mapping, which is the worst kind to diagnose from the outside.
		if errors.Is(err, io.EOF) {
			return fuse.ReadResultData(buf[:0]), fuse.OK
		}
		failure := source.AsFailure(err)
		return nil, fuse.Status(failure.Errno())
	}
	return fuse.ReadResultData(buf[:n]), fuse.OK
}

func (f *FS) Release(cancel <-chan struct{}, in *fuse.ReleaseIn) {
	f.mu.Lock()
	h, ok := f.handles[in.Fh]
	delete(f.handles, in.Fh)
	f.mu.Unlock()
	if !ok {
		return
	}
	f.d.Reader.Release(h.read)
	// The last release of the last handle on a retired generation is what lets it be reclaimed.
	f.d.Store.Release(h.snapshot)
}

func (f *FS) StatFs(cancel <-chan struct{}, in *fuse.InHeader, out *fuse.StatfsOut) fuse.Status {
	snap := f.d.Store.Current()
	if snap == nil {
		return fuse.EIO
	}
	blocks := uint64(snap.Tree.TotalBytes+fsBlockSize-1) / fsBlockSize
	out.Blocks = blocks
	out.Bfree = 0 // a read-only namespace has no free space, and saying otherwise invites a write attempt
	out.Bavail = 0
	out.Files = uint64(snap.Tree.FileCount)
	out.Ffree = 0
	out.Bsize = fsBlockSize
	out.NameLen = 255
	out.Frsize = fsBlockSize
	return fuse.OK
}

// contextFor bridges go-fuse's cancel channel to a context, so an interrupted syscall stops the read rather
// than leaving it running against a provider nobody is waiting for.
func contextFor(cancel <-chan struct{}) (context.Context, context.CancelFunc) {
	ctx, cancelCtx := context.WithCancel(context.Background())
	if cancel == nil {
		return ctx, cancelCtx
	}
	go func() {
		select {
		case <-cancel:
			cancelCtx()
		case <-ctx.Done():
		}
	}()
	return ctx, cancelCtx
}

// Mounted is a mount whose request loop is ALREADY RUNNING.
//
// WHY THE TYPE EXISTS. `fuse.NewServer` creates a mount but services nothing; `Server.Wait` only blocks until
// the mount goes away. A caller that did `NewServer` then `Wait` got a mount the kernel could see and no loop
// to answer INIT, so the first `readdir` hung forever — a production hang, not a test artefact. Returning a
// started mount rather than a raw server makes that mistake unrepresentable: there is no way to obtain the
// server without the loop, and Mount does not return until the kernel has completed INIT.
type Mounted struct {
	server *fuse.Server
	served chan struct{}
}

// MountSettings are the few knobs a caller has over how the mount is made.
type MountSettings struct {
	// Debug logs the FUSE protocol. Explicit, off by default, and a development switch: it is the one mode
	// that prints paths.
	Debug bool
	// StrictDirectMount refuses to fall back to the `fusermount` suid helper.
	//
	// The default is to allow the fallback, because a deployment that runs unprivileged with fusermount3
	// installed is a legitimate shape. The image gate turns this ON, which is how it proves the shipped
	// image — which contains no helper at all — really did mount by syscall rather than quietly finding one.
	StrictDirectMount bool
}

// Mount mounts the namespace and starts serving it.
//
// The mount is read-only at the kernel level, so every mutation syscall is refused before it reaches this
// process. Mount returns only once the mount is live: a caller that gets a *Mounted can immediately stat it.
func Mount(d *daemon.Daemon, mountpoint string, settings MountSettings) (*Mounted, error) {
	fs := New(d)
	opts := &fuse.MountOptions{
		// ALLOW OTHER USERS TO READ IT. A media server is the whole audience for this namespace, and one
		// normally runs as an unprivileged user in a sibling container while the mount is made by root.
		// Without allow_other the kernel hands every such reader EACCES, so the mount would succeed and the
		// product would still not work. (Which servers those are is the control plane's business; the data
		// plane deliberately does not know their names.)
		//
		// It is safe here in a way it would not be for a writable filesystem: every entry is 0444, there is no
		// mutation surface at all, and `default_permissions` below has the KERNEL enforce those bits rather
		// than trusting this process to.
		AllowOther:    true,
		Debug:         settings.Debug,
		FsName:        "projectiond",
		Name:          "projectiond",
		DisableXAttrs: true,
		// THESE OPTIONS ARE ONLY THE ONES A DIRECT MOUNT UNDERSTANDS. go-fuse converts exactly dev/nodev,
		// suid/nosuid and exec/noexec from this list into mount flags; anything else it passes through as FUSE
		// filesystem DATA, and the kernel rejects unknown data with EINVAL. `ro` and `noatime` used to be here,
		// which made every direct mount fail with "invalid argument" and silently fall back to the fusermount
		// suid helper — a helper the shipped distroless image does not contain, so the image could not mount at
		// all. The read-only and noatime intent moved to DirectMountFlags below, where it belongs.
		Options:       []string{"nosuid", "nodev", "noexec", "default_permissions"},
		MaxBackground: 16,
		// Mount by syscall rather than through the suid helper, so the deployment needs no fusermount binary.
		DirectMount:       true,
		DirectMountStrict: settings.StrictDirectMount,
		DirectMountFlags:  unix.MS_RDONLY | unix.MS_NOATIME | unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC,
	}
	server, err := fuse.NewServer(fs, mountpoint, opts)
	if err != nil {
		return nil, err
	}
	m := &Mounted{server: server, served: make(chan struct{})}
	go func() {
		defer close(m.served)
		// THE REQUEST LOOP. Without this the mount exists and answers nothing.
		server.Serve()
	}()
	// Do not hand back a mount before the kernel has finished INIT: a caller that stats it immediately would
	// otherwise race the handshake.
	if err := server.WaitMount(); err != nil {
		_ = server.Unmount()
		<-m.served
		return nil, err
	}
	return m, nil
}

// Wait blocks until the filesystem is unmounted and the request loop has finished.
func (m *Mounted) Wait() { <-m.served }

// Unmount detaches the mount. The request loop ends on its own once the kernel closes the channel.
func (m *Mounted) Unmount() error { return m.server.Unmount() }
