// Package namespace turns an admitted manifest into the immutable in-memory directory tree the filesystem
// answers from.
//
// EVERYTHING HERE IS BUILT ONCE AND NEVER MUTATED. A snapshot is constructed, published by an atomic pointer
// swap, and then read by any number of goroutines without a lock. That is what lets `lookup`, `getattr`,
// `readdir` and `statfs` be answered with zero database calls and zero provider calls — the whole metadata
// surface a library scan touches is already in memory before the scan starts.
package namespace

import (
	"sort"
	"strings"
	"time"

	"github.com/cdb8457/streaming-catalog-authority/projectiond/internal/manifest"
)

// DirectoryEpoch is the timestamp every derived directory carries, including the mount root.
//
// WHY A CONSTANT RATHER THAN SOMETHING DERIVED FROM THE CONTENTS. A directory is not a manifest row: it has
// no entry, no projected version and no mtime of its own. An earlier draft gave it the mtime of the first
// entry that happened to need it, which meant reordering the manifest, adding a different first child or
// deleting that child changed the directory's mtime while its path and contents were otherwise unchanged.
// Media servers watch directory mtimes to decide what to re-scan, so that is a churn generator wearing the
// costume of a metadata field.
//
// A fixed epoch is generation-independent by construction: the same directory reports the same mtime across
// reorders, additions, deletions, generation swaps and daemon restarts. Directory INODES stay path-derived,
// so a directory keeps its identity as long as its path does.
var DirectoryEpoch = time.Unix(1_600_000_000, 0).UTC()

// Node is one node of the immutable tree. A file node carries a pointer into the manifest entry it came from;
// a directory node carries its children. Neither is written to after Build returns.
type Node struct {
	Name  string
	Ino   uint64
	IsDir bool
	Mode  uint32
	Size  int64
	Mtime time.Time
	Entry *manifest.Entry
	// Links is how many paths in this generation share this inode. A projected version that appears at two
	// paths is a HARDLINK: one byte stream, one inode, two names. Reporting nlink=1 for it would tell a media
	// server the two paths were unrelated files, which is exactly the duplicate-import behaviour the shared
	// projected version exists to avoid.
	Links    int
	Children map[string]*Node
	// Ordered is the readdir order: sorted, so two readdirs of an unchanged generation agree exactly.
	Ordered []*Node
}

// RootIno is reserved. The contract reserves inode numbers below 1024 for the mount root and the daemon's own
// nodes, and every derived inode is displaced above that.
const RootIno uint64 = 1

// Tree is one generation's namespace.
type Tree struct {
	Root       *Node
	ByPath     map[string]*Node
	ByIno      map[uint64]*Node
	FileCount  int
	TotalBytes int64
}

// inoOwner records what a given inode belongs to, so a genuine hardlink can be told from a collision.
type inoOwner struct {
	versionID string
	isDir     bool
}

// Build constructs the tree, refusing anything that would make the namespace incoherent.
//
// Directories are DERIVED here rather than carried in the manifest, so this is where a directory's inode is
// decided and where a collision between a derived directory inode and a projected-version inode is caught.
// The derivation uses a separate domain separator, so a collision is a 2^63 coincidence rather than a bug —
// and it is still refused, because a namespace where two nodes share an inode is a namespace where a media
// server's dedupe silently drops one of them.
func Build(m *manifest.Manifest) (*Tree, []manifest.Problem) {
	var problems []manifest.Problem
	add := func(code, at string) {
		if len(problems) < manifest.MaxReportedProblems {
			problems = append(problems, manifest.Problem{Code: code, At: at})
		}
	}

	root := &Node{Name: "", Ino: RootIno, IsDir: true, Mode: 0o555, Mtime: DirectoryEpoch, Children: map[string]*Node{}, Links: 2}
	tree := &Tree{
		Root:   root,
		ByPath: map[string]*Node{"": root},
		ByIno:  map[uint64]*Node{RootIno: root},
	}
	owners := map[uint64]inoOwner{RootIno: {isDir: true}}
	// linked collects every node sharing an inode, so nlink can be filled in once the whole tree is known.
	linked := map[uint64][]*Node{}

	for i := range m.Entries {
		entry := &m.Entries[i]
		segments := strings.Split(entry.Path, "/")
		parent := root
		parentPath := ""
		for _, segment := range segments[:len(segments)-1] {
			childPath := segment
			if parentPath != "" {
				childPath = parentPath + "/" + segment
			}
			existing, ok := parent.Children[segment]
			if ok {
				if !existing.IsDir {
					// A path that needs `a/b` as a directory while `a/b` is already a projected file. The
					// manifest's own path-uniqueness rules do not catch this, because neither path repeats.
					add("NAMESPACE_PATH_COMPONENT_IS_FILE", entry.Path)
					parent = nil
					break
				}
				parent = existing
				parentPath = childPath
				continue
			}
			ino := manifest.DeriveDirectoryInode(childPath)
			if _, taken := owners[ino]; taken {
				// Directories never share an inode with anything: two different paths are two different
				// directories, and a directory can never be the same byte stream as a file.
				add("NAMESPACE_INODE_COLLISION", childPath)
				parent = nil
				break
			}
			owners[ino] = inoOwner{isDir: true}
			dir := &Node{
				Name: segment, Ino: ino, IsDir: true, Mode: 0o555,
				Mtime: DirectoryEpoch, Children: map[string]*Node{},
			}
			parent.Children[segment] = dir
			tree.ByPath[childPath] = dir
			tree.ByIno[ino] = dir
			parent = dir
			parentPath = childPath
		}
		if parent == nil {
			continue
		}

		name := segments[len(segments)-1]
		if _, taken := parent.Children[name]; taken {
			add("NAMESPACE_NAME_TAKEN", entry.Path)
			continue
		}
		// A SHARED PROJECTED VERSION IS A HARDLINK, NOT A COLLISION. One byte stream may legitimately appear at
		// more than one path — the control plane proves byte identity before it may — and every such path gets
		// the same inode, because the inode is derived from the version. What is refused is two DIFFERENT
		// versions, or a version and a directory, landing on one inode: that is a 2^63 coincidence, and a
		// namespace where it went unnoticed is one where a media server's dedupe silently drops a file.
		if owner, taken := owners[entry.Inode]; taken {
			if owner.isDir || owner.versionID != entry.ProjectedVersionID {
				add("NAMESPACE_INODE_COLLISION", entry.Path)
				continue
			}
		}
		owners[entry.Inode] = inoOwner{versionID: entry.ProjectedVersionID}
		// Stable ino, size and mtime come from the manifest and from nowhere else. There is no stat of a
		// backing file anywhere in this function, which is why a remote entry costs nothing to describe.
		file := &Node{
			Name:  name,
			Ino:   entry.Inode,
			Mode:  entry.Mode,
			Size:  entry.SizeBytes,
			Mtime: entry.Mtime,
			Entry: entry,
		}
		parent.Children[name] = file
		tree.ByPath[entry.Path] = file
		if _, seen := tree.ByIno[entry.Inode]; !seen {
			tree.ByIno[entry.Inode] = file
		}
		linked[entry.Inode] = append(linked[entry.Inode], file)
		tree.FileCount++
		// Bytes are counted per PATH, because statfs describes the namespace a media server walks. A hardlink
		// occupies its size at both names as far as a scanner is concerned.
		tree.TotalBytes += entry.SizeBytes
	}

	if len(problems) > 0 {
		return nil, problems
	}
	for _, nodes := range linked {
		for _, node := range nodes {
			node.Links = len(nodes)
		}
	}
	finalize(root)
	return tree, nil
}

// finalize fixes the readdir order once, so it is stable for the life of the generation.
func finalize(node *Node) {
	if !node.IsDir {
		return
	}
	node.Ordered = make([]*Node, 0, len(node.Children))
	for _, child := range node.Children {
		node.Ordered = append(node.Ordered, child)
	}
	sort.Slice(node.Ordered, func(i, j int) bool { return node.Ordered[i].Name < node.Ordered[j].Name })
	for _, child := range node.Ordered {
		finalize(child)
	}
}

// Lookup resolves one child by name. It is a map read and nothing else.
func (n *Node) Lookup(name string) (*Node, bool) {
	if !n.IsDir {
		return nil, false
	}
	child, ok := n.Children[name]
	return child, ok
}
