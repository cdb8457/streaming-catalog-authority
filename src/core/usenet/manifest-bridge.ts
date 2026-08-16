import {
  checkLocatorValue,
  deriveProjectedEntryId,
  deriveProjectedVersionId,
  normalizeProjectedPath,
  type ProjectedEntry,
} from '../projection/manifest-v1.js';
import { USENET_PROJECTED_PATH_PREFIX, type UsenetRefusalReason } from './sab-contract.js';
import type { ProvenOutput } from './completed-output.js';

// Projection Phase 9 §3, SEVENTH DELIVERABLE — "manifest production for admitted local files without changing
// TorBox locators".
//
// WHAT THIS MODULE DOES, AND — MORE IMPORTANTLY — WHAT IT DOES NOT.
//
// It turns a PROVEN output into the three values the existing registration boundary already takes: a version
// key, a projected path, and a `local` source pointing at a relative path under the media root the appliance
// already mounts. It does not invent a source kind, it does not extend the manifest schema, and it does not
// add a field. §2 of the Phase 9 contract says the control plane publishes the admitted file "as a local
// source through the existing manifest contract", and the strongest way to keep that promise is for this file
// to be unable to express anything else — every value it produces goes through `manifest-v1.ts`'s own
// derivation and validation functions rather than being formatted here.
//
// THE TORBOX HALF IS UNTOUCHED, AND THAT IS ASSERTED RATHER THAN INTENDED. §4's sixth hard refusal is "let a
// Usenet outage alter the TorBox namespace". A Usenet path that never writes to a TorBox entry is the
// mechanism; `torBoxDrift` is the proof, and it is run by the admission service before every publish, so a
// bug that reordered, re-derived or dropped an http-range entry is a refusal instead of a namespace change.
//
// IT CONTACTS NOTHING AND OPENS NOTHING. It takes a value and returns a value, exactly as `manifest-v1.ts`
// does, and for the same reason.

export interface UsenetLocalSourcePlan {
  /** The projected path inside the namespace, e.g. `usenet/Some.Folder/file.mkv`. */
  readonly projectedPath: string;
  readonly projectedEntryId: string;
  /** `usenet-<32 hex>` derived from the whole-file digest. */
  readonly versionKey: string;
  readonly projectedVersionId: string;
  /** The configured local root id the appliance already serves the media directory as. */
  readonly rootId: string;
  /** The path under that root, which is what a `local` locator carries. */
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly probes: ProvenOutput['probes'];
  /**
   * `YYYY-MM-DDTHH:MM:SS.sssZ`, taken from the output's own stat.
   *
   * WHY THE FILE'S OWN MTIME AND NOT THE ADMISSION TIME. `validateSuccession` refuses `MTIME_CHANGED` on a
   * carried entry, so this value has to be a pure function of the thing being published rather than of when
   * it was published — otherwise a re-publish after a crash between the publish and the ledger record would
   * mint a second, different mtime for the same bytes and the next generation would be refused.
   */
  readonly mtime: string;
}

/**
 * A stat's mtime as the manifest's exact-millisecond timestamp.
 *
 * A filesystem that reports a nonsensical mtime — zero, negative, or past the range a JS date can render —
 * falls back to the epoch rather than throwing. The value is metadata a media server displays; it is not
 * identity, and refusing an otherwise-provable file over it would be refusing the wrong thing.
 */
export function projectedMtimeFrom(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0 || mtimeMs > 8.64e15) return '1970-01-01T00:00:00.000Z';
  return new Date(Math.floor(mtimeMs)).toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z');
}

export type BridgeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: UsenetRefusalReason; readonly detail: string };

const refuse = <T>(reason: UsenetRefusalReason, detail: string): BridgeResult<T> => ({ ok: false, reason, detail });

/**
 * `usenet-<32 hex>` from the whole-file digest.
 *
 * WHY THE DIGEST AND NOT THE JOB. §3.5.1 of the manifest contract makes the projected version the identity of
 * one exact byte stream, and the byte stream is what the digest names. Deriving it from the submission
 * instead would mean two submissions of identical bytes were two projected versions, which is two inodes for
 * one file — the collision a media server silently swallows.
 */
export function usenetVersionKeyFor(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('USENET_VERSION_KEY_DIGEST_INVALID: a version key is derived from a whole-file digest');
  }
  return `usenet-${sha256.slice(0, 32)}`;
}

/**
 * Build the local-source plan for a proven output, or say why the output cannot be projected.
 *
 * THE NAME IS REFUSED, NEVER REWRITTEN. A release directory can contain a character the projected-path rules
 * forbid — a backslash, a control character, a segment that folds onto another entry's. Sanitising it here
 * would produce a namespace whose paths the control plane cannot reproduce from the filesystem it read them
 * from, and reproducing them is what makes a re-scan idempotent. So an unprojectable name is
 * `output-name-not-projectable`, which an operator fixes by renaming the file the worker produced.
 */
export function planLocalSource(input: {
  readonly output: ProvenOutput;
  /** The configured local root id — the SAME one TorBox-era local entries already use. */
  readonly rootId: string;
  /** Where the completed root sits under the media root, as segments. Empty when they are the same directory. */
  readonly completedRootUnderMediaRoot: readonly string[];
  /** Overrides the `usenet` prefix. Present so a gate can project into its own subtree. */
  readonly pathPrefix?: string;
}): BridgeResult<UsenetLocalSourcePlan> {
  const prefix = input.pathPrefix ?? USENET_PROJECTED_PATH_PREFIX;
  const prefixCheck = normalizeProjectedPath(prefix);
  if (!prefixCheck.ok) {
    return refuse('output-name-not-projectable', 'the configured projected prefix is not a normalized relative path');
  }

  const projectedPath = [prefix, ...input.output.segments].join('/');
  const normalized = normalizeProjectedPath(projectedPath);
  if (!normalized.ok) {
    return refuse('output-name-not-projectable',
      'the completed output cannot be named in the projection namespace without being rewritten, and this '
      + 'contract refuses a path rather than rewriting one');
  }

  const relativePath = [...input.completedRootUnderMediaRoot, ...input.output.segments].join('/');
  const relativeCheck = normalizeProjectedPath(relativePath);
  if (!relativeCheck.ok) {
    return refuse('output-name-not-projectable', 'the path under the media root is not a normalized relative path');
  }
  // THE REGISTRATION BOUNDARY'S OWN CHECK, RUN HERE. An operator learns at admission time what publish would
  // otherwise have told them a generation later, which is the same argument `source-registry.ts` makes for
  // running it at registration.
  const locatorProblem = checkLocatorValue(relativeCheck.path as string);
  if (locatorProblem !== null) {
    return refuse('output-name-not-projectable', 'the path under the media root is not an acceptable opaque locator');
  }

  const versionKey = usenetVersionKeyFor(input.output.sha256);
  return {
    ok: true,
    value: {
      projectedPath: normalized.path as string,
      projectedEntryId: deriveProjectedEntryId(normalized.path as string),
      versionKey,
      projectedVersionId: deriveProjectedVersionId(versionKey),
      rootId: input.rootId,
      relativePath: relativeCheck.path as string,
      sizeBytes: input.output.sizeBytes,
      sha256: input.output.sha256,
      probes: input.output.probes,
      mtime: projectedMtimeFrom(input.output.stat.mtimeMs),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// The TorBox guard
// ---------------------------------------------------------------------------------------------------------

/** An entry is TorBox-shaped when any of its sources is an `http-range` locator. */
export function isProviderBackedEntry(entry: ProjectedEntry): boolean {
  return entry.sources.some((source) => source.kind === 'http-range');
}

export interface TorBoxDriftProblem {
  readonly code:
  | 'TORBOX_ENTRY_DROPPED'
  | 'TORBOX_ENTRY_PATH_CHANGED'
  | 'TORBOX_ENTRY_VERSION_CHANGED'
  | 'TORBOX_ENTRY_INODE_CHANGED'
  | 'TORBOX_ENTRY_SIZE_CHANGED'
  | 'TORBOX_ENTRY_VISIBILITY_CHANGED'
  | 'TORBOX_ENTRY_SOURCES_CHANGED';
  /** The entry id's first eleven characters. Never a path, never a locator. */
  readonly at: string;
}

/**
 * Everything a Usenet publish did to the TorBox half of the namespace, which must be nothing.
 *
 * IT COMPARES SOURCES BY VALUE, not by count. An `http-range` locator whose `objectRef` changed while its
 * count stayed the same is exactly the failure this guard is for: the entry still exists, still has one
 * source, still has the same id — and now points somewhere else. `visibility` is included because degrading a
 * TorBox entry because a Usenet worker was unreachable is the same defect wearing a politer word.
 */
export function torBoxDrift(
  before: readonly ProjectedEntry[],
  after: readonly ProjectedEntry[],
): readonly TorBoxDriftProblem[] {
  const problems: TorBoxDriftProblem[] = [];
  const nextById = new Map(after.map((entry) => [entry.projectedEntryId, entry]));

  for (const entry of before) {
    if (!isProviderBackedEntry(entry)) continue;
    const at = entry.projectedEntryId.slice(0, 11);
    const next = nextById.get(entry.projectedEntryId);
    if (next === undefined) {
      problems.push({ code: 'TORBOX_ENTRY_DROPPED', at });
      continue;
    }
    if (next.path !== entry.path) problems.push({ code: 'TORBOX_ENTRY_PATH_CHANGED', at });
    if (next.projectedVersionId !== entry.projectedVersionId) problems.push({ code: 'TORBOX_ENTRY_VERSION_CHANGED', at });
    if (next.inode !== entry.inode) problems.push({ code: 'TORBOX_ENTRY_INODE_CHANGED', at });
    if (next.sizeBytes !== entry.sizeBytes) problems.push({ code: 'TORBOX_ENTRY_SIZE_CHANGED', at });
    if (next.visibility !== entry.visibility) problems.push({ code: 'TORBOX_ENTRY_VISIBILITY_CHANGED', at });
    if (JSON.stringify(next.sources) !== JSON.stringify(entry.sources)) {
      problems.push({ code: 'TORBOX_ENTRY_SOURCES_CHANGED', at });
    }
  }
  return problems;
}

/**
 * A mixed namespace holds at least one of each. Exported because closure rule 4 is stated in those terms and
 * a gate that counted them itself would be a second implementation of the same sentence.
 */
export function mixedNamespaceCensus(entries: readonly ProjectedEntry[]): {
  readonly providerBacked: number;
  readonly localBacked: number;
  readonly usenetProjected: number;
  readonly mixed: boolean;
} {
  let providerBacked = 0;
  let localBacked = 0;
  let usenetProjected = 0;
  for (const entry of entries) {
    if (isProviderBackedEntry(entry)) providerBacked += 1;
    else localBacked += 1;
    if (entry.path === USENET_PROJECTED_PATH_PREFIX || entry.path.startsWith(`${USENET_PROJECTED_PATH_PREFIX}/`)) {
      usenetProjected += 1;
    }
  }
  return { providerBacked, localBacked, usenetProjected, mixed: providerBacked > 0 && usenetProjected > 0 };
}
