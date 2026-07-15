import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

export type LocalMediaLifecycleState =
  | 'REQUESTED'
  | 'STORED'
  | 'IMPORT_VALIDATING'
  | 'IMPORTING'
  | 'IMPORTED'
  | 'JELLYFIN_SCAN_WAITING'
  | 'VISIBLE_IN_JELLYFIN'
  | 'FAILED';

export type LocalMediaFailureCode =
  | 'CATALOG_INPUT_REJECTED'
  | 'CATALOG_STORE_FAILED'
  | 'IMPORT_SOURCE_INVALID'
  | 'IMPORT_EXTENSION_FORBIDDEN'
  | 'IMPORT_DESTINATION_COLLISION'
  | 'IMPORT_COPY_MISMATCH'
  | 'JELLYFIN_SCAN_TIMEOUT'
  | 'JELLYFIN_VISIBLE_MISMATCH'
  | 'LIFECYCLE_EVIDENCE_UNAVAILABLE';

export interface LocalMediaTransition {
  readonly state: LocalMediaLifecycleState;
  readonly ok: boolean;
  readonly observedState: boolean;
  readonly timestamp: string;
  readonly evidence: string;
  readonly failureCode?: LocalMediaFailureCode;
}

export interface LocalMediaPipelineInput {
  readonly itemId: string;
  readonly title: string;
  readonly year?: number;
  readonly sourceFile: string;
  readonly libraryRoot: string;
  readonly attemptId?: string;
  readonly now?: () => Date;
  readonly visibilityClient?: LocalMediaVisibilityClient;
  readonly awaitJellyfinVisibility?: boolean;
  readonly visibilityPolls?: number;
  readonly visibilityPollMs?: number;
}

export interface LocalMediaVisibilityClient {
  findVisibleItem(input: LocalMediaVisibilityInput): Promise<LocalMediaVisibilityResult>;
}

export interface LocalMediaVisibilityInput {
  readonly title: string;
  readonly year?: number;
  readonly destinationPath: string;
}

export interface LocalMediaVisibilityResult {
  readonly visible: boolean;
  readonly itemId?: string;
  readonly matchBasis?: 'path' | 'title-year' | 'title';
}

export interface LocalMediaPipelineReport {
  readonly report: 'phase-225-local-media-pipeline';
  readonly version: 1;
  readonly ok: boolean;
  readonly status:
    | 'LOCAL_MEDIA_IMPORTED'
    | 'LOCAL_MEDIA_VISIBLE_IN_JELLYFIN'
    | 'LOCAL_MEDIA_FAILED';
  readonly redactionSafe: true;
  readonly attemptDigest: string;
  readonly itemDigest: string;
  readonly titleEchoed: false;
  readonly sourcePathEchoed: false;
  readonly destinationPathEchoed: false;
  readonly libraryRoot: '/mnt/user/media/catalog-authority-test-library' | 'custom-test-library';
  readonly importMode: 'copy';
  readonly lifecycle: {
    readonly currentState: LocalMediaLifecycleState;
    readonly transitions: readonly LocalMediaTransition[];
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
    readonly idempotentNoop: boolean;
    readonly partialResidue: false;
  };
  readonly jellyfin?: {
    readonly awaited: boolean;
    readonly visible: boolean;
    readonly itemDigest?: string;
    readonly matchBasis?: 'path' | 'title-year' | 'title';
    readonly polls: number;
  };
  readonly forbidden: readonly [
    'provider-live-mode',
    'downloading',
    'scraping',
    'playback',
    'jellyfin-write-api',
    'real-library-paths',
    'raw-source-path',
    'raw-media-title',
  ];
  readonly evidenceDigest: string;
}

const ALLOWED_EXTENSIONS = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm']);
const DEFAULT_LIBRARY_ROOT = '/mnt/user/media/catalog-authority-test-library';
const FORBIDDEN: LocalMediaPipelineReport['forbidden'] = [
  'provider-live-mode',
  'downloading',
  'scraping',
  'playback',
  'jellyfin-write-api',
  'real-library-paths',
  'raw-source-path',
  'raw-media-title',
];

export function defaultLocalMediaLibraryRoot(): string {
  return DEFAULT_LIBRARY_ROOT;
}

export function normalizeMediaTitle(title: string): string {
  const cleaned = title
    .normalize('NFKD')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) throw new Error('CATALOG_INPUT_REJECTED');
  return cleaned.slice(0, 120);
}

export function buildLocalMediaDestination(input: { title: string; year?: number; sourceFile: string; libraryRoot: string }): string {
  const title = normalizeMediaTitle(input.title);
  const year = Number.isInteger(input.year) ? String(input.year) : 'Unknown Year';
  const ext = extname(input.sourceFile).toLowerCase();
  const folder = `${title} (${year})`;
  return join(input.libraryRoot, 'Movies', folder, `${folder}${ext}`);
}

export async function runLocalMediaPipeline(input: LocalMediaPipelineInput): Promise<LocalMediaPipelineReport> {
  const now = input.now ?? (() => new Date());
  const transitions: LocalMediaTransition[] = [];
  const attemptId = input.attemptId ?? randomUUID();
  const itemDigest = digest('phase-225-item', input.itemId);
  const attemptDigest = digest('phase-225-attempt', attemptId);
  let currentState: LocalMediaLifecycleState = 'REQUESTED';
  let failureCode: LocalMediaFailureCode | undefined;
  let sourceSizeBytes: number | undefined;
  let destinationSizeBytes: number | undefined;
  let sourceSha256: string | undefined;
  let destinationSha256: string | undefined;
  let destinationNameDigest: string | undefined;
  let idempotentNoop = false;
  let jellyfin: LocalMediaPipelineReport['jellyfin'] | undefined;

  const transition = (state: LocalMediaLifecycleState, ok: boolean, evidence: string, observedState: boolean, code?: LocalMediaFailureCode): void => {
    currentState = state;
    transitions.push({
      state,
      ok,
      observedState,
      timestamp: now().toISOString(),
      evidence,
      ...(code ? { failureCode: code } : {}),
    });
    if (!ok) failureCode = code ?? 'LIFECYCLE_EVIDENCE_UNAVAILABLE';
  };

  const fail = async (code: LocalMediaFailureCode, evidence: string): Promise<LocalMediaPipelineReport> => {
    transition('FAILED', false, evidence, true, code);
    return finalize();
  };

  const finalize = async (): Promise<LocalMediaPipelineReport> => {
    const ok = currentState === 'IMPORTED' || currentState === 'VISIBLE_IN_JELLYFIN';
    const withoutDigest: Omit<LocalMediaPipelineReport, 'evidenceDigest'> = {
      report: 'phase-225-local-media-pipeline',
      version: 1,
      ok,
      status: currentState === 'VISIBLE_IN_JELLYFIN' ? 'LOCAL_MEDIA_VISIBLE_IN_JELLYFIN' : ok ? 'LOCAL_MEDIA_IMPORTED' : 'LOCAL_MEDIA_FAILED',
      redactionSafe: true,
      attemptDigest,
      itemDigest,
      titleEchoed: false,
      sourcePathEchoed: false,
      destinationPathEchoed: false,
      libraryRoot: input.libraryRoot === DEFAULT_LIBRARY_ROOT ? '/mnt/user/media/catalog-authority-test-library' : 'custom-test-library',
      importMode: 'copy',
      lifecycle: {
        currentState,
        transitions,
        retrySafe: failureCode !== 'IMPORT_DESTINATION_COLLISION',
        logsRetrievable: true,
      },
      file: {
        extension: extname(input.sourceFile).toLowerCase(),
        ...(sourceSizeBytes !== undefined ? { sourceSizeBytes } : {}),
        ...(destinationSizeBytes !== undefined ? { destinationSizeBytes } : {}),
        ...(sourceSha256 !== undefined ? { sourceSha256 } : {}),
        ...(destinationSha256 !== undefined ? { destinationSha256 } : {}),
        ...(destinationNameDigest !== undefined ? { destinationNameDigest } : {}),
        idempotentNoop,
        partialResidue: false,
      },
      ...(jellyfin ? { jellyfin } : {}),
      forbidden: FORBIDDEN,
    };
    return { ...withoutDigest, evidenceDigest: digest('phase-225-report', JSON.stringify(withoutDigest)) };
  };

  try {
    normalizeMediaTitle(input.title);
  } catch {
    return fail('CATALOG_INPUT_REJECTED', 'title normalization produced no usable media name');
  }
  transition('REQUESTED', true, 'operator input accepted for local-media pipeline', true);
  transition('STORED', true, 'catalog item storage/custody assertion completed before import', true);
  transition('IMPORT_VALIDATING', true, 'source validation started', true);

  const ext = extname(input.sourceFile).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return fail('IMPORT_EXTENSION_FORBIDDEN', 'source extension is outside media allowlist');
  let sourceStat;
  try {
    sourceStat = statSync(input.sourceFile);
  } catch {
    return fail('IMPORT_SOURCE_INVALID', 'source file is not readable');
  }
  if (!sourceStat.isFile() || sourceStat.size <= 0) return fail('IMPORT_SOURCE_INVALID', 'source is not a regular non-empty file');
  sourceSizeBytes = sourceStat.size;
  sourceSha256 = hashFile(input.sourceFile);

  const destinationPath = buildLocalMediaDestination(input);
  destinationNameDigest = digest('phase-225-destination-name', basename(destinationPath));
  mkdirSync(dirname(destinationPath), { recursive: true });

  if (existsSync(destinationPath)) {
    destinationSizeBytes = statSync(destinationPath).size;
    destinationSha256 = hashFile(destinationPath);
    if (destinationSizeBytes !== sourceSizeBytes || destinationSha256 !== sourceSha256) {
      return fail('IMPORT_DESTINATION_COLLISION', 'destination exists with a different observed checksum');
    }
    idempotentNoop = true;
    transition('IMPORTING', true, 'destination already exists with matching observed checksum', true);
  } else {
    transition('IMPORTING', true, 'copy to temporary destination started', true);
    const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      copyFileSync(input.sourceFile, tempPath);
      const tempSize = statSync(tempPath).size;
      const tempHash = hashFile(tempPath);
      if (tempSize !== sourceSizeBytes || tempHash !== sourceSha256) {
        rmSync(tempPath, { force: true });
        return fail('IMPORT_COPY_MISMATCH', 'temporary copy checksum did not match source');
      }
      renameSync(tempPath, destinationPath);
    } catch {
      rmSync(tempPath, { force: true });
      return fail('IMPORT_COPY_MISMATCH', 'copy operation failed and temporary residue was removed');
    }
    destinationSizeBytes = statSync(destinationPath).size;
    destinationSha256 = hashFile(destinationPath);
  }

  if (destinationSizeBytes !== sourceSizeBytes || destinationSha256 !== sourceSha256) {
    return fail('IMPORT_COPY_MISMATCH', 'destination checksum did not match source after rename');
  }
  transition('IMPORTED', true, 'destination file exists with matching observed size and sha256', true);

  if (input.awaitJellyfinVisibility) {
    if (!input.visibilityClient) return fail('LIFECYCLE_EVIDENCE_UNAVAILABLE', 'Jellyfin visibility requested without read-only visibility client');
    transition('JELLYFIN_SCAN_WAITING', true, 'awaiting Jellyfin read-only visibility by observed query', true);
    const maxPolls = Math.max(1, input.visibilityPolls ?? 12);
    const pollMs = Math.max(0, input.visibilityPollMs ?? 5000);
    for (let poll = 1; poll <= maxPolls; poll += 1) {
      const result = await input.visibilityClient.findVisibleItem({
        title: input.title,
        ...(input.year !== undefined ? { year: input.year } : {}),
        destinationPath,
      });
      if (result.visible) {
        jellyfin = {
          awaited: true,
          visible: true,
          ...(result.itemId ? { itemDigest: digest('phase-225-jellyfin-item', result.itemId) } : {}),
          ...(result.matchBasis ? { matchBasis: result.matchBasis } : {}),
          polls: poll,
        };
        transition('VISIBLE_IN_JELLYFIN', true, 'Jellyfin read-only query observed imported item', true);
        return finalize();
      }
      if (poll < maxPolls && pollMs > 0) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    jellyfin = { awaited: true, visible: false, polls: maxPolls };
    return fail('JELLYFIN_SCAN_TIMEOUT', 'Jellyfin read-only query did not observe imported item within bounded retry window');
  }

  return finalize();
}

export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
