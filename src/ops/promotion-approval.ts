import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import {
  ALLOWED_MEDIA_EXTENSIONS,
  buildPromotionDestination,
  canonicalPath,
  defaultRealMoviesRoot,
  hasSymlinkComponent,
  resolvesWithin,
} from './real-library-promotion.js';

// Local, non-live readiness workflow for the later operator-approved real-library
// promotion. It PRODUCES and VALIDATES the approval JSON that binds a run to one exact
// item, source real path/checksum, destination, and target root — the same binding the
// promotion service enforces at run time (fail closed on mismatch). It never runs a
// promotion, never touches the real Movies root, and never calls Jellyfin: building an
// attestation only reads the source file (to hash it) and computes a destination *path
// string*; validating only re-derives and compares.

// The attestation is exactly the binding subset the promotion CLI reads from its
// --approval-file. `approved` is deliberately absent: authorization to RUN is a separate
// gate (PROMOTION_APPROVED=true), not something this offline artifact can grant.
export interface PromotionApprovalAttestation {
  readonly approvalId: string;
  readonly itemId: string;
  readonly targetRoot: string;
  readonly sourceRealPath: string;
  readonly sourceSha256: string;
  readonly destinationPath: string;
}

export interface ApprovalWorkflowInput {
  readonly itemId: string;
  readonly title: string;
  readonly year?: number;
  readonly sourceFile: string;
  readonly testLibraryRoot?: string;
  readonly targetRoot?: string;
  readonly approvalId?: string;
}

// Generic, value-free problem codes: safe to place in redaction-safe evidence.
export type ApprovalProblem =
  | 'MISSING_APPROVAL_ID'
  | 'MISSING_ITEM_ID'
  | 'MISSING_TARGET_ROOT'
  | 'MISSING_SOURCE_REAL_PATH'
  | 'MISSING_SOURCE_SHA256'
  | 'MISSING_DESTINATION_PATH'
  | 'ITEM_ID_MISMATCH'
  | 'TARGET_ROOT_MISMATCH'
  | 'SOURCE_MISSING'
  | 'SOURCE_NOT_REGULAR_FILE'
  | 'SOURCE_IS_SYMLINK'
  | 'SOURCE_SYMLINK_COMPONENT'
  | 'SOURCE_RESOLVES_OUTSIDE'
  | 'SOURCE_OUTSIDE_TEST_LIBRARY'
  | 'SOURCE_EXTENSION_NOT_ALLOWED'
  | 'SOURCE_EMPTY'
  | 'SOURCE_REAL_PATH_MISMATCH'
  | 'SOURCE_CHECKSUM_MISMATCH'
  | 'DESTINATION_PATH_MISMATCH';

export interface ApprovalEvidence {
  readonly report: 'phase-230-promotion-approval-attestation';
  readonly version: 1;
  readonly mode: 'build' | 'validate';
  readonly ok: boolean;
  readonly redactionSafe: true;
  readonly status: 'APPROVAL_ATTESTATION_READY' | 'APPROVAL_ATTESTATION_INVALID';
  readonly approvalIdDigest?: string;
  readonly itemDigest: string;
  readonly targetRoot: '/mnt/user/media/Movies' | 'custom-real-movies-root';
  readonly sourceRealPathDigest?: string;
  readonly sourceSha256?: string;
  readonly destinationPathDigest?: string;
  readonly destinationNameDigest?: string;
  readonly extension?: string;
  readonly sourceSizeBytes?: number;
  readonly titleEchoed: false;
  readonly sourcePathEchoed: false;
  readonly destinationPathEchoed: false;
  readonly problems: readonly ApprovalProblem[];
  readonly evidenceDigest: string;
}

const DEFAULT_TEST_LIBRARY_ROOT = '/mnt/user/media/catalog-authority-test-library';

export interface BuildApprovalResult {
  readonly ok: boolean;
  readonly approval?: PromotionApprovalAttestation;
  readonly evidence: ApprovalEvidence;
}

// Produce an attestation from a source already sitting in the isolated test library.
// Fails closed (no approval emitted) if the source is unusable; the caller must not
// write an approval file when ok is false.
export function buildApprovalAttestation(input: ApprovalWorkflowInput): BuildApprovalResult {
  const targetRoot = input.targetRoot ?? defaultRealMoviesRoot();
  const testLibraryRoot = input.testLibraryRoot ?? DEFAULT_TEST_LIBRARY_ROOT;
  const approvalId = input.approvalId ?? randomUUID();
  // The attestation binds whatever target root the run declares; enforcing that it is the
  // approved /mnt/user/media/Movies root is the promotion service's run-time job, not this
  // offline artifact's. The evidence still records whether the root is the approved one.
  const problems = inspectSource(input.sourceFile, testLibraryRoot);

  const destinationPath = buildPromotionDestination({
    title: input.title,
    ...(input.year !== undefined ? { year: input.year } : {}),
    sourceFile: input.sourceFile,
    targetRoot,
  });

  if (problems.length > 0) {
    return {
      ok: false,
      evidence: buildEvidence('build', false, problems, {
        approvalId,
        itemId: input.itemId,
        targetRoot,
        destinationPath,
      }),
    };
  }

  const sourceRealPath = realpathSync(input.sourceFile);
  const sourceSha256 = sha256File(input.sourceFile);
  const sourceSizeBytes = statSync(input.sourceFile).size;
  const approval: PromotionApprovalAttestation = {
    approvalId,
    itemId: input.itemId,
    targetRoot,
    sourceRealPath,
    sourceSha256,
    destinationPath,
  };
  return {
    ok: true,
    approval,
    evidence: buildEvidence('build', true, [], {
      approvalId,
      itemId: input.itemId,
      targetRoot,
      sourceRealPath,
      sourceSha256,
      sourceSizeBytes,
      destinationPath,
    }),
  };
}

export interface ValidateApprovalResult {
  readonly ok: boolean;
  readonly evidence: ApprovalEvidence;
}

// Validate an approval JSON (as parsed, of unknown shape) against the actual run inputs,
// re-deriving every binding exactly as the promotion service would. Redaction-safe.
export function validateApprovalAttestation(candidate: unknown, input: ApprovalWorkflowInput): ValidateApprovalResult {
  const targetRoot = input.targetRoot ?? defaultRealMoviesRoot();
  const testLibraryRoot = input.testLibraryRoot ?? DEFAULT_TEST_LIBRARY_ROOT;
  const approval = (candidate && typeof candidate === 'object' ? candidate : {}) as Partial<PromotionApprovalAttestation>;
  const problems: ApprovalProblem[] = [];

  if (!isNonEmpty(approval.approvalId)) problems.push('MISSING_APPROVAL_ID');
  if (!isNonEmpty(approval.itemId)) problems.push('MISSING_ITEM_ID');
  if (!isNonEmpty(approval.targetRoot)) problems.push('MISSING_TARGET_ROOT');
  if (!isNonEmpty(approval.sourceRealPath)) problems.push('MISSING_SOURCE_REAL_PATH');
  if (!isNonEmpty(approval.sourceSha256)) problems.push('MISSING_SOURCE_SHA256');
  if (!isNonEmpty(approval.destinationPath)) problems.push('MISSING_DESTINATION_PATH');

  if (isNonEmpty(approval.targetRoot) && canonicalPath(approval.targetRoot) !== canonicalPath(targetRoot)) {
    problems.push('TARGET_ROOT_MISMATCH');
  }
  if (isNonEmpty(approval.itemId) && approval.itemId !== input.itemId) problems.push('ITEM_ID_MISMATCH');

  const sourceProblems = inspectSource(input.sourceFile, testLibraryRoot);
  problems.push(...sourceProblems);
  const destinationPath = buildPromotionDestination({
    title: input.title,
    ...(input.year !== undefined ? { year: input.year } : {}),
    sourceFile: input.sourceFile,
    targetRoot,
  });

  let sourceRealPath: string | undefined;
  let sourceSha256: string | undefined;
  let sourceSizeBytes: number | undefined;
  if (sourceProblems.length === 0) {
    sourceRealPath = realpathSync(input.sourceFile);
    sourceSha256 = sha256File(input.sourceFile);
    sourceSizeBytes = statSync(input.sourceFile).size;
    if (isNonEmpty(approval.sourceRealPath) && canonicalPath(approval.sourceRealPath) !== canonicalPath(sourceRealPath)) {
      problems.push('SOURCE_REAL_PATH_MISMATCH');
    }
    if (isNonEmpty(approval.sourceSha256) && approval.sourceSha256 !== sourceSha256) {
      problems.push('SOURCE_CHECKSUM_MISMATCH');
    }
  }
  if (isNonEmpty(approval.destinationPath) && canonicalPath(approval.destinationPath) !== canonicalPath(destinationPath)) {
    problems.push('DESTINATION_PATH_MISMATCH');
  }

  const ok = problems.length === 0;
  return {
    ok,
    evidence: buildEvidence('validate', ok, problems, {
      ...(isNonEmpty(approval.approvalId) ? { approvalId: approval.approvalId } : {}),
      itemId: input.itemId,
      targetRoot,
      ...(sourceRealPath ? { sourceRealPath } : {}),
      ...(sourceSha256 ? { sourceSha256 } : {}),
      ...(sourceSizeBytes !== undefined ? { sourceSizeBytes } : {}),
      destinationPath,
    }),
  };
}

function inspectSource(sourceFile: string, testLibraryRoot: string): ApprovalProblem[] {
  const problems: ApprovalProblem[] = [];
  if (!isWithin(sourceFile, testLibraryRoot)) problems.push('SOURCE_OUTSIDE_TEST_LIBRARY');
  if (safeIsSymlink(sourceFile)) { problems.push('SOURCE_IS_SYMLINK'); return problems; }
  // Mirror runRealLibraryPromotion's source containment: reject a symlinked test-library
  // root or any symlinked intermediate component (hasSymlinkComponent), then a realpath
  // escape (resolvesWithin). A symlinked ancestor can redirect the source read outside the
  // isolated test library even when the textual path looks contained; refuse before hashing.
  if (hasSymlinkComponent(testLibraryRoot, sourceFile)) { problems.push('SOURCE_SYMLINK_COMPONENT'); return problems; }
  if (!existsSync(sourceFile)) { problems.push('SOURCE_MISSING'); return problems; }
  if (!statSync(sourceFile).isFile()) { problems.push('SOURCE_NOT_REGULAR_FILE'); return problems; }
  if (!resolvesWithin(sourceFile, testLibraryRoot)) { problems.push('SOURCE_RESOLVES_OUTSIDE'); return problems; }
  const ext = extname(sourceFile).toLowerCase();
  if (!ALLOWED_MEDIA_EXTENSIONS.includes(ext as (typeof ALLOWED_MEDIA_EXTENSIONS)[number])) problems.push('SOURCE_EXTENSION_NOT_ALLOWED');
  if (statSync(sourceFile).size <= 0) problems.push('SOURCE_EMPTY');
  return problems;
}

interface EvidenceFields {
  readonly approvalId?: string;
  readonly itemId: string;
  readonly targetRoot: string;
  readonly sourceRealPath?: string;
  readonly sourceSha256?: string;
  readonly sourceSizeBytes?: number;
  readonly destinationPath: string;
}

function buildEvidence(mode: 'build' | 'validate', ok: boolean, problems: ApprovalProblem[], fields: EvidenceFields): ApprovalEvidence {
  const withoutDigest: Omit<ApprovalEvidence, 'evidenceDigest'> = {
    report: 'phase-230-promotion-approval-attestation',
    version: 1,
    mode,
    ok,
    redactionSafe: true,
    status: ok ? 'APPROVAL_ATTESTATION_READY' : 'APPROVAL_ATTESTATION_INVALID',
    ...(fields.approvalId ? { approvalIdDigest: digest('phase-230-approval', fields.approvalId) } : {}),
    itemDigest: digest('phase-230-item', fields.itemId),
    targetRoot: canonicalPath(fields.targetRoot) === canonicalPath(defaultRealMoviesRoot()) ? '/mnt/user/media/Movies' : 'custom-real-movies-root',
    ...(fields.sourceRealPath ? { sourceRealPathDigest: digest('phase-230-source-real-path', fields.sourceRealPath) } : {}),
    ...(fields.sourceSha256 ? { sourceSha256: fields.sourceSha256 } : {}),
    destinationPathDigest: digest('phase-230-destination-path', fields.destinationPath),
    destinationNameDigest: digest('phase-230-destination-name', baseName(fields.destinationPath)),
    extension: extname(fields.destinationPath).toLowerCase(),
    ...(fields.sourceSizeBytes !== undefined ? { sourceSizeBytes: fields.sourceSizeBytes } : {}),
    titleEchoed: false,
    sourcePathEchoed: false,
    destinationPathEchoed: false,
    problems,
  };
  return { ...withoutDigest, evidenceDigest: digest('phase-230-approval-evidence', JSON.stringify(withoutDigest)) };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function safeIsSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function baseName(path: string): string {
  const norm = path.replace(/\\/g, '/');
  return norm.slice(norm.lastIndexOf('/') + 1);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
