import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  linkSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { hashFile, normalizeMediaTitle } from './local-media-pipeline.js';

export type PromotionLifecycleState =
  | 'VISIBLE_IN_JELLYFIN'
  | 'PROMOTION_APPROVED'
  | 'PROMOTED'
  | 'VISIBLE_IN_REAL_LIBRARY'
  | 'PROMOTION_WITHDRAWN'
  | 'PROMOTION_FAILED';

export type PromotionFailureCode =
  | 'PROMOTION_APPROVAL_REQUIRED'
  | 'PROMOTION_APPROVAL_MISMATCH'
  | 'PROMOTION_SOURCE_INVALID'
  | 'PROMOTION_TARGET_FORBIDDEN'
  | 'PROMOTION_DESTINATION_COLLISION'
  | 'PROMOTION_COPY_MISMATCH'
  | 'PROMOTION_VISIBILITY_REQUIRED'
  | 'PROMOTION_REAL_LIBRARY_VISIBILITY_TIMEOUT'
  | 'PROMOTION_VISIBILITY_CHECK_FAILED'
  | 'PROMOTION_WITHDRAWAL_REFUSED'
  | 'PROMOTION_WITHDRAWAL_FAILED';

export interface PromotionTransition {
  readonly state: PromotionLifecycleState;
  readonly ok: boolean;
  readonly observedState: boolean;
  readonly timestamp: string;
  readonly evidence: string;
  readonly failureCode?: PromotionFailureCode;
}

export interface RealLibraryVisibilityClient {
  findVisibleItem(input: RealLibraryVisibilityInput): Promise<RealLibraryVisibilityResult>;
}

export interface RealLibraryVisibilityInput {
  readonly title: string;
  readonly year?: number;
  readonly destinationPath: string;
}

export interface RealLibraryVisibilityResult {
  readonly visible: boolean;
  readonly itemId?: string;
  // Real-library visibility is accepted only when the observation is by exact path.
  // Title/title-year are not permitted bases: a same-title test-library twin must
  // never satisfy real-library visibility.
  readonly matchBasis?: 'path';
}

// One-shot operator approval, bound to the exact item, source, destination, and root.
// Every binding field is mandatory: the service recomputes each value from the actual
// run and fails closed (PROMOTION_APPROVAL_MISMATCH) on any divergence, so an approval
// can never authorize a different item, a swapped source, or a different destination.
export interface RealLibraryPromotionApproval {
  readonly approved: boolean;
  readonly approvalId?: string;
  readonly itemId?: string;
  readonly targetRoot?: string;
  readonly sourceRealPath?: string;
  readonly sourceSha256?: string;
  readonly destinationPath?: string;
}

export interface RealLibraryPromotionInput {
  readonly itemId: string;
  readonly title: string;
  readonly year?: number;
  readonly sourceFile: string;
  readonly testLibraryRoot: string;
  readonly targetRoot: string;
  readonly approval: RealLibraryPromotionApproval;
  readonly runId?: string;
  readonly now?: () => Date;
  readonly visibilityClient?: RealLibraryVisibilityClient;
  readonly visibilityPolls?: number;
  readonly visibilityPollMs?: number;
  readonly withdrawAfter?: boolean;
  readonly allowCustomTargetRootForTests?: boolean;
}

export interface RealLibraryPromotionReport {
  readonly report: 'phase-230-real-library-promotion';
  readonly version: 1;
  readonly ok: boolean;
  readonly status:
    | 'REAL_LIBRARY_PROMOTION_VISIBLE'
    | 'REAL_LIBRARY_PROMOTION_WITHDRAWN'
    | 'REAL_LIBRARY_PROMOTION_FAILED';
  readonly redactionSafe: true;
  readonly runDigest: string;
  readonly itemDigest: string;
  readonly approvalDigest?: string;
  readonly titleEchoed: false;
  readonly sourcePathEchoed: false;
  readonly destinationPathEchoed: false;
  readonly targetRoot: '/mnt/user/media/Movies' | 'custom-real-movies-root';
  readonly lifecycle: {
    readonly currentState: PromotionLifecycleState;
    readonly transitions: readonly PromotionTransition[];
    readonly retrySafe: boolean;
    readonly logsRetrievable: true;
  };
  readonly file: {
    readonly extension: string;
    readonly sourceSizeBytes?: number;
    readonly destinationSizeBytes?: number;
    readonly sourceSha256?: string;
    readonly destinationSha256?: string;
    readonly destinationNameDigest?: string;
    readonly alreadyPresent: boolean;
    readonly withdrawn: boolean;
  };
  readonly realLibrary: {
    readonly beforeDigest: string;
    readonly promotedDigest?: string;
    readonly afterPromotionDigest?: string;
    readonly afterWithdrawalDigest?: string;
    readonly returnedToBefore?: boolean;
  };
  readonly jellyfin?: {
    readonly awaited: boolean;
    readonly visible: boolean;
    readonly itemDigest?: string;
    readonly matchBasis?: 'path';
    readonly polls: number;
    readonly absentAfterWithdrawal?: boolean;
  };
  readonly forbidden: readonly [
    'provider-live-mode',
    'downloading',
    'scraping',
    'playback',
    'jellyfin-write-api',
    'gelato-path',
    'aio-streams-path',
    'overwrite-real-library-file',
    'raw-source-path',
    'raw-destination-path',
    'raw-media-title',
  ];
  readonly evidenceDigest: string;
}

const DEFAULT_TEST_LIBRARY_ROOT = '/mnt/user/media/catalog-authority-test-library';
const DEFAULT_REAL_MOVIES_ROOT = '/mnt/user/media/Movies';
const FORBIDDEN: RealLibraryPromotionReport['forbidden'] = [
  'provider-live-mode',
  'downloading',
  'scraping',
  'playback',
  'jellyfin-write-api',
  'gelato-path',
  'aio-streams-path',
  'overwrite-real-library-file',
  'raw-source-path',
  'raw-destination-path',
  'raw-media-title',
];
// Single source of truth for the media extension allowlist, shared with the offline
// approval-attestation workflow so its readiness checks match this service exactly.
export const ALLOWED_MEDIA_EXTENSIONS = ['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm'] as const;
const ALLOWED_EXTENSIONS = new Set<string>(ALLOWED_MEDIA_EXTENSIONS);

export function defaultRealMoviesRoot(): string {
  return DEFAULT_REAL_MOVIES_ROOT;
}

// Exact-path visibility predicate for real-library promotion. Real-library visibility
// and withdrawal-absence must key on the EXACT promoted destination path: a same-title
// item elsewhere — notably the isolated test-library twin, which is also
// VISIBLE_IN_JELLYFIN — must never satisfy "visible in the real library" nor mask
// absence after withdrawal. Title/year are deliberately not a fallback here.
export function realLibraryPathMatch(itemPath: string, destinationPath: string): boolean {
  return canonicalPath(itemPath) === canonicalPath(destinationPath);
}

export function buildPromotionDestination(input: { title: string; year?: number; sourceFile: string; targetRoot: string }): string {
  const title = normalizeMediaTitle(input.title);
  const year = Number.isInteger(input.year) ? String(input.year) : 'Unknown Year';
  const ext = extname(input.sourceFile).toLowerCase();
  const folder = `${title} (${year})`;
  return join(input.targetRoot, folder, `${folder}${ext}`);
}

export async function runRealLibraryPromotion(input: RealLibraryPromotionInput): Promise<RealLibraryPromotionReport> {
  const now = input.now ?? (() => new Date());
  const transitions: PromotionTransition[] = [];
  const runId = input.runId ?? randomUUID();
  const runDigest = digest('phase-230-run', runId);
  const itemDigest = digest('phase-230-item', input.itemId);
  const approvalDigest = input.approval.approvalId ? digest('phase-230-approval', input.approval.approvalId) : undefined;
  const targetRootKind = input.targetRoot === DEFAULT_REAL_MOVIES_ROOT ? '/mnt/user/media/Movies' : 'custom-real-movies-root';
  const beforeDigest = treeDigest(input.targetRoot);
  let currentState: PromotionLifecycleState = 'VISIBLE_IN_JELLYFIN';
  let failureCode: PromotionFailureCode | undefined;
  let sourceSizeBytes: number | undefined;
  let destinationSizeBytes: number | undefined;
  let sourceSha256: string | undefined;
  let destinationSha256: string | undefined;
  let destinationNameDigest: string | undefined;
  let alreadyPresent = false;
  let createdByRun = false;
  let createdDirectory = false;
  let withdrawn = false;
  let promotedDigest: string | undefined;
  let afterPromotionDigest: string | undefined;
  let afterWithdrawalDigest: string | undefined;
  let returnedToBefore: boolean | undefined;
  let jellyfin: RealLibraryPromotionReport['jellyfin'] | undefined;

  const transition = (state: PromotionLifecycleState, ok: boolean, evidence: string, observedState: boolean, code?: PromotionFailureCode): void => {
    currentState = state;
    transitions.push({
      state,
      ok,
      observedState,
      timestamp: now().toISOString(),
      evidence,
      ...(code ? { failureCode: code } : {}),
    });
    if (!ok) failureCode = code ?? 'PROMOTION_WITHDRAWAL_FAILED';
  };

  const fail = async (code: PromotionFailureCode, evidence: string): Promise<RealLibraryPromotionReport> => {
    transition('PROMOTION_FAILED', false, evidence, true, code);
    return finalize();
  };

  const finalize = async (): Promise<RealLibraryPromotionReport> => {
    const ok = currentState === 'VISIBLE_IN_REAL_LIBRARY' || currentState === 'PROMOTION_WITHDRAWN';
    const withoutDigest: Omit<RealLibraryPromotionReport, 'evidenceDigest'> = {
      report: 'phase-230-real-library-promotion',
      version: 1,
      ok,
      status: currentState === 'PROMOTION_WITHDRAWN'
        ? 'REAL_LIBRARY_PROMOTION_WITHDRAWN'
        : currentState === 'VISIBLE_IN_REAL_LIBRARY'
          ? 'REAL_LIBRARY_PROMOTION_VISIBLE'
          : 'REAL_LIBRARY_PROMOTION_FAILED',
      redactionSafe: true,
      runDigest,
      itemDigest,
      ...(approvalDigest ? { approvalDigest } : {}),
      titleEchoed: false,
      sourcePathEchoed: false,
      destinationPathEchoed: false,
      targetRoot: targetRootKind,
      lifecycle: {
        currentState,
        transitions,
        retrySafe: failureCode !== 'PROMOTION_DESTINATION_COLLISION',
        logsRetrievable: true,
      },
      file: {
        extension: extname(input.sourceFile).toLowerCase(),
        ...(sourceSizeBytes !== undefined ? { sourceSizeBytes } : {}),
        ...(destinationSizeBytes !== undefined ? { destinationSizeBytes } : {}),
        ...(sourceSha256 !== undefined ? { sourceSha256 } : {}),
        ...(destinationSha256 !== undefined ? { destinationSha256 } : {}),
        ...(destinationNameDigest !== undefined ? { destinationNameDigest } : {}),
        alreadyPresent,
        withdrawn,
      },
      realLibrary: {
        beforeDigest,
        ...(promotedDigest ? { promotedDigest } : {}),
        ...(afterPromotionDigest ? { afterPromotionDigest } : {}),
        ...(afterWithdrawalDigest ? { afterWithdrawalDigest } : {}),
        ...(returnedToBefore !== undefined ? { returnedToBefore } : {}),
      },
      ...(jellyfin ? { jellyfin } : {}),
      forbidden: FORBIDDEN,
    };
    return { ...withoutDigest, evidenceDigest: digest('phase-230-report', JSON.stringify(withoutDigest)) };
  };

  const approval = input.approval;
  if (!approval.approved || !approval.approvalId
    || !approval.itemId || !approval.targetRoot || !approval.sourceRealPath
    || !approval.sourceSha256 || !approval.destinationPath) {
    return fail('PROMOTION_APPROVAL_REQUIRED', 'explicit one-shot operator approval bound to item, source, destination, and root is required');
  }
  // Bindings verifiable before any filesystem work: item identity and target root.
  if (approval.itemId !== input.itemId) return fail('PROMOTION_APPROVAL_MISMATCH', 'approval does not bind the promoted item id');
  if (canonicalPath(approval.targetRoot) !== canonicalPath(input.targetRoot)) return fail('PROMOTION_APPROVAL_MISMATCH', 'approval does not bind the target root');
  transition('PROMOTION_APPROVED', true, 'operator approval present and bound to one item and destination', true);

  if (!isAllowedTargetRoot(input.targetRoot, input.allowCustomTargetRootForTests === true)) return fail('PROMOTION_TARGET_FORBIDDEN', 'promotion target root is not the approved real Movies root');
  if (containsForbiddenPath(input.targetRoot) || containsForbiddenPath(input.sourceFile)) {
    return fail('PROMOTION_TARGET_FORBIDDEN', 'promotion path intersects Gelato or AIO Streams boundary');
  }
  if (!isWithin(input.sourceFile, input.testLibraryRoot)) return fail('PROMOTION_SOURCE_INVALID', 'source file is not inside the isolated test library');
  if (isSymlink(input.sourceFile)) return fail('PROMOTION_SOURCE_INVALID', 'source path is a symlink and is refused');
  if (hasSymlinkComponent(input.testLibraryRoot, input.sourceFile)) return fail('PROMOTION_SOURCE_INVALID', 'source path traverses a symlink out of the isolated test library');
  if (!existsSync(input.sourceFile) || !statSync(input.sourceFile).isFile()) return fail('PROMOTION_SOURCE_INVALID', 'source file is missing or not a regular file');
  if (!resolvesWithin(input.sourceFile, input.testLibraryRoot)) return fail('PROMOTION_SOURCE_INVALID', 'source path resolves outside the isolated test library');
  const ext = extname(input.sourceFile).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return fail('PROMOTION_SOURCE_INVALID', 'source extension is outside media allowlist');

  sourceSizeBytes = statSync(input.sourceFile).size;
  if (sourceSizeBytes <= 0) return fail('PROMOTION_SOURCE_INVALID', 'source file is empty');
  sourceSha256 = hashFile(input.sourceFile);

  // Source bindings: the approval must pin this exact source real path and checksum.
  const sourceReal = safeRealpath(input.sourceFile);
  if (!sourceReal || canonicalPath(approval.sourceRealPath) !== canonicalPath(sourceReal)) {
    return fail('PROMOTION_APPROVAL_MISMATCH', 'approval does not bind the source real path');
  }
  if (approval.sourceSha256 !== sourceSha256) return fail('PROMOTION_APPROVAL_MISMATCH', 'approval does not bind the source checksum');

  const destinationPath = buildPromotionDestination(input);
  if (!isWithin(destinationPath, input.targetRoot)) return fail('PROMOTION_TARGET_FORBIDDEN', 'destination escapes approved real Movies root');
  if (hasSymlinkComponent(input.targetRoot, destinationPath)) return fail('PROMOTION_TARGET_FORBIDDEN', 'destination path traverses a symlink out of the approved real Movies root');
  // Destination binding: the approval must pin this exact planned destination path.
  if (canonicalPath(approval.destinationPath) !== canonicalPath(destinationPath)) {
    return fail('PROMOTION_APPROVAL_MISMATCH', 'approval does not bind the destination path');
  }
  destinationNameDigest = digest('phase-230-destination-name', basename(destinationPath));
  const destinationDir = dirname(destinationPath);
  createdDirectory = !existsSync(destinationDir);
  mkdirSync(destinationDir, { recursive: true });
  // Realpath-verify the just-created directory: catches a symlinked root/ancestor and
  // any swap that occurred between the textual checks above and directory creation.
  if (!resolvesWithin(destinationDir, input.targetRoot)) {
    if (createdDirectory) { try { rmdirSync(destinationDir); } catch { /* leave for operator */ } }
    return fail('PROMOTION_TARGET_FORBIDDEN', 'destination directory resolves outside the approved real Movies root');
  }

  if (existsSync(destinationPath)) {
    destinationSizeBytes = statSync(destinationPath).size;
    destinationSha256 = hashFile(destinationPath);
    if (destinationSizeBytes !== sourceSizeBytes || destinationSha256 !== sourceSha256) {
      return fail('PROMOTION_DESTINATION_COLLISION', 'destination exists with a different observed checksum');
    }
    alreadyPresent = true;
  } else {
    const tempPath = `${destinationPath}.tmp-${randomUUID()}`;
    try {
      copyFileSync(input.sourceFile, tempPath);
    } catch {
      rmSync(tempPath, { force: true });
      return fail('PROMOTION_COPY_MISMATCH', 'promotion copy failed and temporary residue was removed');
    }
    const tempSize = statSync(tempPath).size;
    const tempHash = hashFile(tempPath);
    if (tempSize !== sourceSizeBytes || tempHash !== sourceSha256) {
      rmSync(tempPath, { force: true });
      return fail('PROMOTION_COPY_MISMATCH', 'temporary promotion copy checksum did not match source');
    }
    // Atomic no-clobber publish. linkSync fails with EEXIST if the destination was
    // created between the existence check above and now, so a promotion can never
    // overwrite a concurrently-written real-library file.
    let published = false;
    try {
      linkSync(tempPath, destinationPath);
      published = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        rmSync(tempPath, { force: true });
        return fail('PROMOTION_COPY_MISMATCH', 'atomic promotion publish failed and temporary residue was removed');
      }
    }
    rmSync(tempPath, { force: true });
    if (published) {
      createdByRun = true;
      destinationSizeBytes = statSync(destinationPath).size;
      destinationSha256 = hashFile(destinationPath);
    } else {
      // A concurrent writer won the race: treat exactly like a pre-existing destination,
      // never a rewrite. Same checksum is an already-present no-op; different is a collision.
      let existingSize: number;
      let existingHash: string;
      try {
        existingSize = statSync(destinationPath).size;
        existingHash = hashFile(destinationPath);
      } catch {
        return fail('PROMOTION_DESTINATION_COLLISION', 'destination appeared concurrently and could not be verified');
      }
      destinationSizeBytes = existingSize;
      destinationSha256 = existingHash;
      if (existingSize !== sourceSizeBytes || existingHash !== sourceSha256) {
        return fail('PROMOTION_DESTINATION_COLLISION', 'destination appeared concurrently with a different observed checksum');
      }
      alreadyPresent = true;
    }
  }

  // Final race-resistant containment on the materialized file: reject a symlinked
  // destination or one whose real path escaped the approved root between mkdir and now.
  if (isSymlink(destinationPath) || !resolvesWithin(destinationPath, input.targetRoot)) {
    if (createdByRun) rmSync(destinationPath, { force: true });
    return fail('PROMOTION_TARGET_FORBIDDEN', 'destination file resolves outside the approved real Movies root');
  }
  if (destinationSizeBytes !== sourceSizeBytes || destinationSha256 !== sourceSha256) {
    return fail('PROMOTION_COPY_MISMATCH', 'destination checksum did not match source after promotion');
  }
  promotedDigest = digest('phase-230-promoted-file', destinationSha256);
  afterPromotionDigest = treeDigest(input.targetRoot);
  transition('PROMOTED', true, 'destination file exists with matching observed size and sha256', true);

  // Observed read-only Jellyfin state is mandatory for real-library promotion success:
  // a file-on-disk proof alone can never reach VISIBLE_IN_REAL_LIBRARY.
  if (!input.visibilityClient) {
    return fail('PROMOTION_VISIBILITY_REQUIRED', 'real-library promotion success requires observed read-only Jellyfin visibility by exact path');
  }
  let visible: { visible: boolean; jellyfin?: RealLibraryPromotionReport['jellyfin'] };
  try {
    visible = await awaitVisible(input, destinationPath);
  } catch {
    return fail('PROMOTION_VISIBILITY_CHECK_FAILED', 'Jellyfin read-only visibility check failed before a verdict was observed');
  }
  if (!visible.visible) return fail('PROMOTION_REAL_LIBRARY_VISIBILITY_TIMEOUT', 'Jellyfin read-only query did not observe promoted item in real Movies library');
  jellyfin = visible.jellyfin;
  transition('VISIBLE_IN_REAL_LIBRARY', true, 'Jellyfin read-only query observed promoted item in real Movies library', true);

  if (input.withdrawAfter) {
    if (!createdByRun) {
      return fail('PROMOTION_WITHDRAWAL_REFUSED', 'withdrawal refused: destination file pre-existed this run and was not created by promotion');
    }
    const withdrawal = withdrawPromotedFile(destinationPath, destinationSha256, input.targetRoot, createdDirectory);
    if (!withdrawal.ok) return fail(withdrawal.code, withdrawal.evidence);
    withdrawn = true;
    afterWithdrawalDigest = treeDigest(input.targetRoot);
    returnedToBefore = afterWithdrawalDigest === beforeDigest;
    if (!returnedToBefore) return fail('PROMOTION_WITHDRAWAL_FAILED', 'real Movies subtree digest did not return to prior state');
    let absent: { absent: boolean };
    try {
      absent = await awaitAbsent(input, destinationPath);
    } catch {
      return fail('PROMOTION_VISIBILITY_CHECK_FAILED', 'Jellyfin read-only absence check failed before a verdict was observed');
    }
    jellyfin = { ...(jellyfin ?? { awaited: true, visible: false, polls: 0 }), absentAfterWithdrawal: absent.absent };
    if (!absent.absent) return fail('PROMOTION_WITHDRAWAL_FAILED', 'Jellyfin read-only query still observed withdrawn item');
    transition('PROMOTION_WITHDRAWN', true, 'withdrawal removed only the promoted file and restored prior subtree digest', true);
  }

  return finalize();
}

async function awaitVisible(input: RealLibraryPromotionInput, destinationPath: string): Promise<{ visible: boolean; jellyfin?: RealLibraryPromotionReport['jellyfin'] }> {
  if (!input.visibilityClient) throw new Error('visibility client required');
  const maxPolls = Math.max(1, input.visibilityPolls ?? 12);
  const pollMs = Math.max(0, input.visibilityPollMs ?? 5000);
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    const result = await input.visibilityClient.findVisibleItem({
      title: input.title,
      ...(input.year !== undefined ? { year: input.year } : {}),
      destinationPath,
    });
    // Accept a visibility observation only when it is by exact path. A client that
    // reports visible without a 'path' basis (e.g. a title match) is not evidence.
    if (result.visible && result.matchBasis === 'path') {
      return {
        visible: true,
        jellyfin: {
          awaited: true,
          visible: true,
          ...(result.itemId ? { itemDigest: digest('phase-230-jellyfin-item', result.itemId) } : {}),
          matchBasis: 'path',
          polls: poll,
        },
      };
    }
    if (poll < maxPolls && pollMs > 0) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { visible: false, jellyfin: { awaited: true, visible: false, polls: maxPolls } };
}

async function awaitAbsent(input: RealLibraryPromotionInput, destinationPath: string): Promise<{ absent: boolean }> {
  if (!input.visibilityClient) throw new Error('visibility client required');
  const maxPolls = Math.max(1, input.visibilityPolls ?? 12);
  const pollMs = Math.max(0, input.visibilityPollMs ?? 5000);
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    const result = await input.visibilityClient.findVisibleItem({
      title: input.title,
      ...(input.year !== undefined ? { year: input.year } : {}),
      destinationPath,
    });
    // Absent unless the exact path is still observed; a non-path "visible" is not the item.
    if (!(result.visible && result.matchBasis === 'path')) return { absent: true };
    if (poll < maxPolls && pollMs > 0) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { absent: false };
}

function withdrawPromotedFile(destinationPath: string, expectedSha256: string | undefined, targetRoot: string, createdDirectory: boolean): { ok: true } | { ok: false; code: PromotionFailureCode; evidence: string } {
  if (!expectedSha256 || !isWithin(destinationPath, targetRoot)) return { ok: false, code: 'PROMOTION_WITHDRAWAL_REFUSED', evidence: 'withdrawal target is outside approved root or missing checksum' };
  if (isSymlink(destinationPath) || hasSymlinkComponent(targetRoot, destinationPath)) return { ok: false, code: 'PROMOTION_WITHDRAWAL_REFUSED', evidence: 'promoted path is a symlink and is refused for withdrawal' };
  if (!resolvesWithin(destinationPath, targetRoot)) return { ok: false, code: 'PROMOTION_WITHDRAWAL_REFUSED', evidence: 'promoted path resolves outside approved root and is refused for withdrawal' };
  if (!existsSync(destinationPath)) return { ok: false, code: 'PROMOTION_WITHDRAWAL_FAILED', evidence: 'promoted file was missing before withdrawal' };
  if (hashFile(destinationPath) !== expectedSha256) return { ok: false, code: 'PROMOTION_WITHDRAWAL_REFUSED', evidence: 'promoted file checksum changed before withdrawal' };
  rmSync(destinationPath);
  const dir = dirname(destinationPath);
  try {
    // Only remove the movie directory if this run created it and it is now empty;
    // never delete a real-library directory that pre-existed the promotion or that
    // resolves (via symlink) outside the approved root.
    if (createdDirectory && isWithin(dir, targetRoot) && canonicalPath(dir) !== canonicalPath(targetRoot) && !isSymlink(dir) && resolvesWithin(dir, targetRoot) && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    return { ok: false, code: 'PROMOTION_WITHDRAWAL_FAILED', evidence: 'promoted file removed but empty directory cleanup failed' };
  }
  return { ok: true };
}

function isAllowedTargetRoot(path: string, allowCustomTargetRootForTests: boolean): boolean {
  // Case-sensitive: Linux paths are case-sensitive, so /mnt/user/media/movies is NOT
  // the approved /mnt/user/media/Movies root.
  return allowCustomTargetRootForTests || canonicalPath(path) === canonicalPath(DEFAULT_REAL_MOVIES_ROOT);
}

function isWithin(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedRoot, resolvedPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

// Deepest ancestor of `path` that currently exists (or `path` itself when it exists).
// Lets us realpath a not-yet-created destination by resolving its real parent chain.
function nearestExistingAncestor(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

// Race-resistant containment: resolves symlinks on both the approved root and the
// deepest existing ancestor of `path`, then checks textual containment of the *real*
// paths. Re-checked immediately before/after each mutation to bound TOCTOU windows
// (Node has no portable openat/O_NOFOLLOW; realpath-immediately-before-use is the
// practical mitigation).
export function resolvesWithin(path: string, root: string): boolean {
  const realRoot = safeRealpath(root);
  if (!realRoot) return false;
  const realAncestor = safeRealpath(nearestExistingAncestor(path));
  if (!realAncestor) return false;
  const rel = relative(realRoot, realAncestor);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Returns true if any existing path component strictly between `root` and `target`
// (inclusive of intermediate directories, exclusive of `root` itself) is a symlink.
// A symlinked component can redirect the real destination outside the approved root
// even when the textual path passes `isWithin`.
export function hasSymlinkComponent(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  // The approved root itself must be a real directory: a symlinked root can redirect
  // the entire subtree out of bounds while every relative component looks contained.
  if (isSymlink(resolvedRoot)) return true;
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]/).filter((part) => part.length > 0);
  let current = resolvedRoot;
  for (const part of parts) {
    current = join(current, part);
    if (isSymlink(current)) return true;
  }
  return false;
}

function containsForbiddenPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized.includes('/gelato') || normalized.includes('/aio') || normalized.includes('/aio-streams');
}

function treeDigest(root: string): string {
  if (!existsSync(root)) return digest('phase-230-tree', 'missing-root');
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      // lstat, never stat: a symlinked entry is recorded as a symlink and never
      // followed, so the before/after subtree digest cannot be redirected out of
      // the real Movies subtree or made to hash an attacker-chosen target.
      const st = lstatSync(path);
      const relDigest = digest('phase-230-tree-rel', relative(root, path).replace(/\\/g, '/'));
      if (st.isSymbolicLink()) {
        entries.push(`l:${relDigest}`);
      } else if (st.isDirectory()) {
        entries.push(`d:${relDigest}`);
        walk(path);
      } else if (st.isFile()) {
        entries.push(`f:${relDigest}:${st.size}:${hashFile(path)}`);
      }
    }
  };
  walk(root);
  return digest('phase-230-tree', entries.join('\n'));
}

// Case-PRESERVING canonical form for path EQUALITY (target root, approval bindings,
// visibility match, directory identity). Must not lowercase: Linux paths are
// case-sensitive and lowercasing can false-match distinct paths. Exported so the
// offline approval-attestation validator uses identical equality semantics.
export function canonicalPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
}

// Case-INSENSITIVE form, used ONLY for the Gelato/AIO denylist substring scan where a
// broader (case-folded) match is intentionally safe.
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
