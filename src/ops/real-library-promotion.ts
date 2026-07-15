import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
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
  | 'PROMOTION_SOURCE_INVALID'
  | 'PROMOTION_TARGET_FORBIDDEN'
  | 'PROMOTION_DESTINATION_COLLISION'
  | 'PROMOTION_COPY_MISMATCH'
  | 'PROMOTION_REAL_LIBRARY_VISIBILITY_TIMEOUT'
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
  readonly matchBasis?: 'path' | 'title-year' | 'title';
}

export interface RealLibraryPromotionInput {
  readonly itemId: string;
  readonly title: string;
  readonly year?: number;
  readonly sourceFile: string;
  readonly testLibraryRoot: string;
  readonly targetRoot: string;
  readonly approval: {
    readonly approved: boolean;
    readonly approvalId?: string;
  };
  readonly runId?: string;
  readonly now?: () => Date;
  readonly visibilityClient?: RealLibraryVisibilityClient;
  readonly awaitVisibility?: boolean;
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
    readonly matchBasis?: 'path' | 'title-year' | 'title';
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
const ALLOWED_EXTENSIONS = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm']);

export function defaultRealMoviesRoot(): string {
  return DEFAULT_REAL_MOVIES_ROOT;
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

  if (!input.approval.approved || !input.approval.approvalId) {
    return fail('PROMOTION_APPROVAL_REQUIRED', 'explicit one-shot operator approval is required');
  }
  transition('PROMOTION_APPROVED', true, 'operator approval present for one item and destination', true);

  if (!isAllowedTargetRoot(input.targetRoot, input.allowCustomTargetRootForTests === true)) return fail('PROMOTION_TARGET_FORBIDDEN', 'promotion target root is not the approved real Movies root');
  if (containsForbiddenPath(input.targetRoot) || containsForbiddenPath(input.sourceFile)) {
    return fail('PROMOTION_TARGET_FORBIDDEN', 'promotion path intersects Gelato or AIO Streams boundary');
  }
  if (!isWithin(input.sourceFile, input.testLibraryRoot)) return fail('PROMOTION_SOURCE_INVALID', 'source file is not inside the isolated test library');
  if (!existsSync(input.sourceFile) || !statSync(input.sourceFile).isFile()) return fail('PROMOTION_SOURCE_INVALID', 'source file is missing or not a regular file');
  const ext = extname(input.sourceFile).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return fail('PROMOTION_SOURCE_INVALID', 'source extension is outside media allowlist');

  sourceSizeBytes = statSync(input.sourceFile).size;
  if (sourceSizeBytes <= 0) return fail('PROMOTION_SOURCE_INVALID', 'source file is empty');
  sourceSha256 = hashFile(input.sourceFile);

  const destinationPath = buildPromotionDestination(input);
  if (!isWithin(destinationPath, input.targetRoot)) return fail('PROMOTION_TARGET_FORBIDDEN', 'destination escapes approved real Movies root');
  destinationNameDigest = digest('phase-230-destination-name', basename(destinationPath));
  mkdirSync(dirname(destinationPath), { recursive: true });

  if (existsSync(destinationPath)) {
    destinationSizeBytes = statSync(destinationPath).size;
    destinationSha256 = hashFile(destinationPath);
    if (destinationSizeBytes !== sourceSizeBytes || destinationSha256 !== sourceSha256) {
      return fail('PROMOTION_DESTINATION_COLLISION', 'destination exists with a different observed checksum');
    }
    alreadyPresent = true;
  } else {
    const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      copyFileSync(input.sourceFile, tempPath);
      const tempSize = statSync(tempPath).size;
      const tempHash = hashFile(tempPath);
      if (tempSize !== sourceSizeBytes || tempHash !== sourceSha256) {
        rmSync(tempPath, { force: true });
        return fail('PROMOTION_COPY_MISMATCH', 'temporary promotion copy checksum did not match source');
      }
      renameSync(tempPath, destinationPath);
    } catch {
      rmSync(tempPath, { force: true });
      return fail('PROMOTION_COPY_MISMATCH', 'promotion copy failed and temporary residue was removed');
    }
    destinationSizeBytes = statSync(destinationPath).size;
    destinationSha256 = hashFile(destinationPath);
  }

  if (destinationSizeBytes !== sourceSizeBytes || destinationSha256 !== sourceSha256) {
    return fail('PROMOTION_COPY_MISMATCH', 'destination checksum did not match source after promotion');
  }
  promotedDigest = digest('phase-230-promoted-file', destinationSha256);
  afterPromotionDigest = treeDigest(input.targetRoot);
  transition('PROMOTED', true, 'destination file exists with matching observed size and sha256', true);

  if (input.awaitVisibility) {
    const visible = await awaitVisible(input, destinationPath);
    if (!visible.visible) return fail('PROMOTION_REAL_LIBRARY_VISIBILITY_TIMEOUT', 'Jellyfin read-only query did not observe promoted item in real Movies library');
    jellyfin = visible.jellyfin;
    transition('VISIBLE_IN_REAL_LIBRARY', true, 'Jellyfin read-only query observed promoted item in real Movies library', true);
  } else {
    transition('VISIBLE_IN_REAL_LIBRARY', true, 'promotion visibility accepted by file-state proof only', true);
  }

  if (input.withdrawAfter) {
    const withdrawal = withdrawPromotedFile(destinationPath, destinationSha256, input.targetRoot);
    if (!withdrawal.ok) return fail(withdrawal.code, withdrawal.evidence);
    withdrawn = true;
    afterWithdrawalDigest = treeDigest(input.targetRoot);
    returnedToBefore = afterWithdrawalDigest === beforeDigest;
    if (!returnedToBefore) return fail('PROMOTION_WITHDRAWAL_FAILED', 'real Movies subtree digest did not return to prior state');
    if (input.awaitVisibility) {
      const absent = await awaitAbsent(input, destinationPath);
      jellyfin = { ...(jellyfin ?? { awaited: true, visible: false, polls: 0 }), absentAfterWithdrawal: absent.absent };
      if (!absent.absent) return fail('PROMOTION_WITHDRAWAL_FAILED', 'Jellyfin read-only query still observed withdrawn item');
    }
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
    if (result.visible) {
      return {
        visible: true,
        jellyfin: {
          awaited: true,
          visible: true,
          ...(result.itemId ? { itemDigest: digest('phase-230-jellyfin-item', result.itemId) } : {}),
          ...(result.matchBasis ? { matchBasis: result.matchBasis } : {}),
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
    if (!result.visible) return { absent: true };
    if (poll < maxPolls && pollMs > 0) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { absent: false };
}

function withdrawPromotedFile(destinationPath: string, expectedSha256: string | undefined, targetRoot: string): { ok: true } | { ok: false; code: PromotionFailureCode; evidence: string } {
  if (!expectedSha256 || !isWithin(destinationPath, targetRoot)) return { ok: false, code: 'PROMOTION_WITHDRAWAL_REFUSED', evidence: 'withdrawal target is outside approved root or missing checksum' };
  if (!existsSync(destinationPath)) return { ok: false, code: 'PROMOTION_WITHDRAWAL_FAILED', evidence: 'promoted file was missing before withdrawal' };
  if (hashFile(destinationPath) !== expectedSha256) return { ok: false, code: 'PROMOTION_WITHDRAWAL_REFUSED', evidence: 'promoted file checksum changed before withdrawal' };
  rmSync(destinationPath);
  const dir = dirname(destinationPath);
  try {
    if (isWithin(dir, targetRoot) && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    return { ok: false, code: 'PROMOTION_WITHDRAWAL_FAILED', evidence: 'promoted file removed but empty directory cleanup failed' };
  }
  return { ok: true };
}

function isAllowedTargetRoot(path: string, allowCustomTargetRootForTests: boolean): boolean {
  return allowCustomTargetRootForTests || normalizePath(path) === normalizePath(DEFAULT_REAL_MOVIES_ROOT);
}

function isWithin(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedRoot, resolvedPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
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
      const st = statSync(path);
      const relDigest = digest('phase-230-tree-rel', relative(root, path).replace(/\\/g, '/'));
      if (st.isDirectory()) {
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

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
