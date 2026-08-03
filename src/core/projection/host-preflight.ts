// Projection Phase 1 — what has to be true of the HOST before a data-plane gate can mean anything.
//
// WHY THIS EXISTS, AND WHY IT EXISTS NOW. All three media-server gates pass on Windows / Docker Desktop, and
// `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6 says that closes **none** of G7–G13. The tranche closes on a
// Linux or Unraid host, three consecutive times, and **no gate has ever run on one**. So every assumption the
// gates make about their host is currently untested in the only environment that counts.
//
// DOCKER DESKTOP HIDES THE ENTIRE CLASS OF DEFECT THIS FILE IS ABOUT. Its bind mounts live inside a Linux VM
// whose root is already a shared mount, and it ignores uid, gid and mode on the host side of a bind. So a
// host-shaped assumption that is simply wrong on Linux produces a green run here, every time, forever. Two
// such assumptions have already been found the expensive way — a token file written `0600` that the container
// uid could not have read, and a path spelling that opened `C:\c\Users\…` — and both were found by reasoning
// or by a twenty-minute failure rather than by a check.
//
// SO THE POINT OF THIS MODULE IS TO FAIL EARLY AND SAY WHY. Everything here is a pure function over text a
// shell can cheaply obtain, which is what lets the awkward hosts — Unraid's non-systemd root, a bind source on
// a FUSE share, a host with no `/proc/self/mountinfo` at all — be tested offline, from this machine, without
// any of them being present.
//
// IT DIAGNOSES AND IT DOES NOT REPAIR. Making a host mount shared is `mount --make-rshared`, which changes the
// machine the operator is standing on, outside the run directory, and survives the gate. A gate that quietly
// did that would be mutating an operator's host to make itself pass. It names the remedy instead.

// ---------------------------------------------------------------------------------------------------------
// Mount propagation
// ---------------------------------------------------------------------------------------------------------

/**
 * THE FAILURE THIS EXISTS TO CATCH, STATED FIRST BECAUSE IT IS THE ONE THAT WILL HAPPEN.
 *
 * Every one of the three gates starts the daemon with `-v "$WORK/mnt:/mnt/projection:rshared"`, because the
 * FUSE namespace the daemon creates *inside* its container has to become visible to the sibling containers
 * that read it — the media server, and the non-root verifier. `rshared` is what propagates it back out.
 *
 * The Linux kernel will only accept `rshared` on a bind whose **source is already on a shared mount**. Docker
 * refuses the container outright when it is not, with an error naming the path and the mount it sits on. It is
 * not a warning and not a degraded mode: the daemon never starts, and the gate dies at its first container.
 *
 * WHY IT HAS NEVER BEEN SEEN. On Docker Desktop the bind source lives inside Docker's own Linux VM, whose root
 * is shared, so the condition is satisfied by construction. On a systemd Linux host it is *usually* satisfied
 * too, because systemd remounts `/` shared during early boot. **Unraid is not systemd**, and a repository
 * checked out under `/mnt/user` is on `shfs`, a FUSE share — neither of which is shared by default.
 *
 * So the most likely first failure of the first Unraid run is a container that refuses to start, for a reason
 * that has nothing to do with this product, and that no run so far could have revealed.
 */
export const RSHARED_REQUIRES_A_SHARED_SOURCE_MOUNT = true;

/** How a mount propagates, as `/proc/self/mountinfo` describes it. */
export type Propagation = 'shared' | 'slave' | 'private' | 'unbindable';

export interface MountEntry {
  readonly mountPoint: string;
  readonly propagation: Propagation;
  readonly filesystem: string;
}

/**
 * Parse `/proc/self/mountinfo`.
 *
 * THE FORMAT IS POSITIONAL UP TO A SEPARATOR AND THEN POSITIONAL AGAIN, and the separator is the only reliable
 * landmark. Each line is:
 *
 *     id parentId major:minor root mountPoint options [optional-tags...] - fstype source superOptions
 *
 * The optional tags are what carry propagation — `shared:N`, `master:N`, `propagate_from:N`, `unbindable` —
 * and there can be **any number of them, including none**. That is precisely why the ` - ` separator exists,
 * and why splitting the line on whitespace and indexing from the left for `fstype` is wrong. A parser that
 * assumed a fixed field count would misread exactly the hosts that have something interesting to say.
 *
 * MOUNT POINTS ARE OCTAL-ESCAPED BY THE KERNEL. A space in a path appears as `\040`, and a gate run from a
 * directory with a space in its name is not exotic — the media this gate generates has spaces in every
 * filename. Unescaping is therefore required for the longest-prefix match below to work at all.
 *
 * A LINE IT CANNOT READ IS SKIPPED, NOT GUESSED AT. A malformed entry that became a `private` mount by
 * default would be a fabricated reason to refuse a host that is actually fine.
 */
export function parseMountInfo(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const separator = line.indexOf(' - ');
    if (separator === -1) continue;
    const left = line.slice(0, separator).split(/\s+/);
    const right = line.slice(separator + 3).split(/\s+/);
    // id parentId major:minor root mountPoint options, then zero or more optional tags.
    if (left.length < 6) continue;
    const mountPoint = unescapeMountPath(left[4] as string);
    if (mountPoint === '') continue;
    const tags = left.slice(6);
    entries.push({
      mountPoint,
      propagation: propagationFromTags(tags),
      filesystem: right[0] ?? '',
    });
  }
  return entries;
}

/**
 * The kernel escapes space, tab, newline and backslash in mountinfo paths as octal.
 *
 * IT IS NOT COSMETIC HERE. `mountFor` matches a path against these strings, and this repository's own gates
 * run out of directories whose media filenames contain spaces. An unescaped `\040` would simply never match.
 */
function unescapeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_whole, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function propagationFromTags(tags: readonly string[]): Propagation {
  // ORDER MATTERS, AND IT IS THE KERNEL'S ORDER RATHER THAN A PREFERENCE. A mount can be BOTH shared and a
  // slave — `shared:2 master:1` — which is a mount that receives from its master and propagates onward. For
  // the question this module asks, that mount IS shared: a bind from it can be `rshared`.
  if (tags.some((tag) => tag.startsWith('shared:'))) return 'shared';
  if (tags.some((tag) => tag.startsWith('master:'))) return 'slave';
  if (tags.includes('unbindable')) return 'unbindable';
  return 'private';
}

/**
 * The mount a path actually lives on: the longest mount point that is a prefix of it.
 *
 * LONGEST WINS, AND THE ORDER OF THE FILE DOES NOT. `/` matches every path, so a first-match scan would say
 * every path is on the root filesystem and would answer the propagation question about the wrong mount every
 * time there is a nested one — which on Unraid, where the interesting directory is under `/mnt/user`, is
 * always.
 *
 * THE PREFIX IS COMPARED ON PATH BOUNDARIES, not on characters. `/mnt/userdata` is not inside `/mnt/user`,
 * and a naive `startsWith` says it is.
 */
export function mountFor(path: string, entries: readonly MountEntry[]): MountEntry | undefined {
  const normalised = normalisePath(path);
  let best: MountEntry | undefined;
  for (const entry of entries) {
    const point = normalisePath(entry.mountPoint);
    const contains = point === '/' ? true : (normalised === point || normalised.startsWith(`${point}/`));
    if (!contains) continue;
    if (best === undefined || point.length > normalisePath(best.mountPoint).length) best = entry;
  }
  return best;
}

function normalisePath(path: string): string {
  const collapsed = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

/**
 * Whether a bind of `path` may be given `rshared`.
 *
 * `undetermined` IS A THIRD ANSWER AND IT IS NOT `shared`. There is no `/proc/self/mountinfo` on a Windows
 * host, and Docker Desktop does not need one — its bind sources are inside a VM whose root is shared. So the
 * check must be able to say "this host cannot be measured this way" WITHOUT either failing a host where the
 * gates demonstrably pass, or blessing one nobody has looked at.
 *
 * The distinction is the whole value of the check: on Linux the answer is authoritative, and a `not-shared`
 * there is a run that would have died at its first container.
 */
export type PropagationVerdict = 'shared' | 'not-shared' | 'undetermined';

export interface PropagationCheck {
  readonly verdict: PropagationVerdict;
  /** The mount the path was found on, when one was found. */
  readonly mountPoint?: string;
  readonly filesystem?: string;
  readonly propagation?: Propagation;
  /** What to tell the operator. Empty when the verdict is `shared`. */
  readonly problem: string;
}

/**
 * Hold a path against the host's mount table.
 *
 * `mountinfo` IS PASSED IN RATHER THAN READ HERE, which is what makes every awkward host testable from a
 * machine that is none of them: an Unraid `shfs` share, a private root, a mount that is shared-and-slave, a
 * host with no mountinfo at all.
 */
export function checkPropagation(path: string, mountinfo: string | undefined): PropagationCheck {
  if (mountinfo === undefined || mountinfo.trim() === '') {
    return {
      verdict: 'undetermined',
      problem: 'this host publishes no /proc/self/mountinfo, so mount propagation could not be measured. '
        + 'On Docker Desktop that is expected and harmless: the bind source lives inside Docker\'s own Linux '
        + 'VM, whose root is shared. On a Linux or Unraid host it means the check did not run, and a check '
        + 'that did not run is not a check that passed',
    };
  }
  const entries = parseMountInfo(mountinfo);
  const entry = mountFor(path, entries);
  if (entry === undefined) {
    return {
      verdict: 'undetermined',
      problem: `no mount in /proc/self/mountinfo contains ${path}, which should be impossible on a Linux `
        + 'host and means this check cannot speak for it',
    };
  }
  if (entry.propagation === 'shared') {
    return {
      verdict: 'shared', mountPoint: entry.mountPoint, filesystem: entry.filesystem,
      propagation: entry.propagation, problem: '',
    };
  }
  return {
    verdict: 'not-shared',
    mountPoint: entry.mountPoint,
    filesystem: entry.filesystem,
    propagation: entry.propagation,
    problem: `the gate's working directory is on the ${entry.filesystem} mount at ${entry.mountPoint}, whose `
      + `propagation is ${entry.propagation}. The daemon binds its mount point \`rshared\` so that the FUSE `
      + 'namespace it creates becomes visible to the media server beside it, and the kernel only permits '
      + '`rshared` on a bind whose source is already a shared mount — so Docker will REFUSE to start the '
      + 'daemon container at all. Nothing about this is a defect in the product, and no run on Docker Desktop '
      + 'could have revealed it, because there the bind source lives inside a VM whose root is already shared.'
      + `\n  The remedy is to make that mount shared, which is a change to the HOST and is deliberately not `
      + `something this gate does for you:\n      sudo mount --make-rshared ${entry.mountPoint}\n`
      + '  ...or run the gate from a directory on a mount that is already shared. On a systemd host `/` is '
      + 'usually shared already; Unraid is not systemd, and a checkout under /mnt/user is on a FUSE share '
      + 'that is not shared either.',
  };
}

// ---------------------------------------------------------------------------------------------------------
// Traversal into the run directory
// ---------------------------------------------------------------------------------------------------------

/**
 * THE SECOND DEFECT DOCKER DESKTOP HIDES, and it is in all three gates.
 *
 * The paced consumer runs as `--user 1000:1000` and is given the whole run directory as `-v "$WORK:/work"`.
 * It then writes its decoded output into `/work/out`, which the gates `chmod 777` for exactly that reason.
 *
 * **But a permissive leaf is unreachable through a private parent.** To open `/work/out/…` the process must
 * have execute permission on `/work` — and `$WORK` is created by `mkdir -p` under the caller's umask. With the
 * common `022` it lands at `0755` and everything works. With `077` — which is a perfectly ordinary hardened
 * default, and which some operators set for root — it lands at `0700`, owned by whoever ran the gate, and uid
 * 1000 cannot traverse it. The five-minute play then fails on a permission error four phases in.
 *
 * On Docker Desktop none of this is visible, because the host side of a bind carries no modes at all.
 *
 * SO THE GATES MAKE THE PATH TRAVERSABLE EXPLICITLY rather than inheriting whatever the umask happened to be.
 * `0755` on the directories, not `0777`: traversal is all that is needed, the writable leaves are already
 * `0777`, and widening a parent that does not need to be writable would be doing more than the problem asks.
 */
export const CONSUMER_NEEDS_TRAVERSAL_OF_THE_RUN_DIRECTORY = true;

/** The directories every gate must make traversable, relative to its own run directory. */
export const TRAVERSABLE_MODE = 0o755;

/**
 * Everything wrong with a set of directory modes, from the point of view of a container uid that is not the
 * one that created them.
 *
 * IT TAKES MODES RATHER THAN READING THEM, so the hostile cases — a `0700` run root with a `0777` leaf inside
 * it — can be stated directly in a test on a machine whose filesystem does not have modes worth speaking of.
 */
export function traversalProblems(
  directories: ReadonlyArray<{ readonly path: string; readonly mode: number }>,
): string[] {
  const problems: string[] = [];
  for (const directory of directories) {
    // WORLD EXECUTE IS THE BIT THAT MATTERS, and it is the one a restrictive umask removes. Read is not
    // enough to traverse, and owner-execute says nothing about a container uid that is somebody else.
    if ((directory.mode & 0o001) === 0) {
      problems.push(`${directory.path} is mode ${directory.mode.toString(8).padStart(3, '0')}, which a `
        + 'container uid that did not create it cannot traverse — so every permissive directory beneath it '
        + 'is unreachable, however permissive it is');
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// What an operator's host has to have at all
// ---------------------------------------------------------------------------------------------------------

/**
 * The host-side prerequisites, as a list rather than as prose in a runbook nobody reads at the right moment.
 *
 * THE FIRST ENTRY IS THE ONE THAT WILL SURPRISE SOMEBODY. The gates run their driver on the HOST — `npx tsx
 * src/ops/…` — and a stock Unraid installation has no Node.js at all. The acceptance plan names Unraid as the
 * environment that closes the media-server gates, and the command it names cannot start there without it.
 * That is a real prerequisite of the tranche-closing run and it belongs somewhere an operator meets it before
 * they have spent half an hour, rather than in the middle of a failure.
 */
export interface HostRequirement {
  readonly id: string;
  readonly what: string;
  readonly why: string;
  /** A command an operator can run to see whether they have it. */
  readonly probe: string;
}

export const HOST_REQUIREMENTS: readonly HostRequirement[] = Object.freeze([
  {
    id: 'node',
    what: 'Node.js and npx on the HOST, not in a container',
    why: 'every gate drives its media server from `npx tsx src/ops/projection-<server>-dataplane-cli.ts`, '
      + 'which runs on the host. A stock Unraid installation has no Node.js, so the command the acceptance '
      + 'plan names as the tranche-closing one cannot start there without it',
    probe: 'node --version && npx --version',
  },
  {
    id: 'docker-compose-v2',
    what: 'the Docker Compose v2 plugin (`docker compose`, not `docker-compose`)',
    why: 'each gate stands up its own throwaway PostgreSQL with `docker compose -f … up -d --wait`, and '
      + '`--wait` is a v2 flag. On Unraid this is the Compose Manager plugin rather than something installed '
      + 'by default',
    probe: 'docker compose version',
  },
  {
    id: 'dev-fuse',
    what: '/dev/fuse reachable from inside a container',
    why: 'the daemon serves the projection over FUSE. Every gate already probes for this and exits 77 — a '
      + 'SKIP, not a pass — when it is missing',
    probe: 'docker run --rm --device /dev/fuse:/dev/fuse alpine test -c /dev/fuse',
  },
  {
    id: 'shared-mount',
    what: 'the gate\'s working directory on a mount whose propagation is `shared`',
    why: 'the daemon binds its mount point `rshared` so the FUSE namespace reaches the media server beside '
      + 'it, and the kernel only permits that on a bind whose source is already shared. Docker refuses the '
      + 'container outright otherwise. See `RSHARED_REQUIRES_A_SHARED_SOURCE_MOUNT`',
    probe: 'findmnt -no PROPAGATION -T .',
  },
  {
    id: 'no-selinux-relabel',
    what: 'either no SELinux enforcement, or bind mounts relabelled for it',
    why: 'on an SELinux-enforcing host (Fedora, RHEL, CentOS) a container cannot read a bind mount that has '
      + 'not been relabelled, and every gate binds several. Unraid does not use SELinux, so this is a '
      + 'statement about "Linux" generally rather than about the tranche-closing host — and it is RECORDED '
      + 'rather than handled, because adding `:z` to a bind relabels files on the operator\'s disk',
    probe: 'getenforce 2>/dev/null || echo "not enforcing"',
  },
] as const);
