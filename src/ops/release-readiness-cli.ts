import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildConsumerReleaseArchive,
  buildConsumerReleaseBundle,
  RELEASE_IMAGE_REPOSITORY,
  RELEASE_IMAGE_TAG,
  type BundleSources,
} from './consumer-release-bundle.js';
import { RELEASE_REPOSITORY, RELEASE_REPOSITORY_OWNER } from './release-coordinates.js';
import {
  READINESS_EXIT_CODES,
  ReleaseReadinessError,
  evaluateReleaseReadiness,
  renderReadinessJson,
  renderReadinessText,
  type GitEvidence,
  type ReadinessEvidence,
} from './release-readiness.js';

// Phase 250 — `ops:release-readiness`, the command that gathers the evidence and prints the proof.
//
// It reads local Git and files and assembles the consumer bundle in memory. It runs `git` ONLY with
// read-only, non-network subcommands (status, rev-parse, rev-list), and it treats a missing Git as NOT_RUN
// rather than guessing. It never publishes, pushes, tags, logs in, fetches, or reaches the network; a run of
// it changes nothing.
//
//   npm run ops:release-readiness                 # readiness for the shipped version tag, JSON
//   npm run ops:release-readiness -- --text       # concise human summary
//   npm run ops:release-readiness -- --tag v1.2.3 # readiness for a specific tag
//
// Exit codes are fixed (see READINESS_EXIT_CODES): 0 READY, 10 BLOCKED, 11 INVALID, 12 NOT_RUN, plus 2 for a
// usage error and 3 for a refused (redaction-unsafe) render — a render refusal is a safe failure, not a pass.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function repoFile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

/** A read-only, non-network git call. Returns null when git is unavailable or the command fails. */
function git(args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function gatherGitEvidence(targetTag: string): GitEvidence {
  // `rev-parse --is-inside-work-tree` proves there is a repository here at all.
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return { available: false, clean: false, head: '', localTagPresent: false, localTagAtHead: false };
  }
  const head = git(['rev-parse', 'HEAD']) ?? '';
  const porcelain = git(['status', '--porcelain']);
  const clean = porcelain !== null && porcelain === '';
  // Does a local tag with exactly this name exist, and does it point at HEAD? Read-only; no network.
  const tagCommit = git(['rev-list', '-n', '1', `refs/tags/${targetTag}`]);
  const localTagPresent = tagCommit !== null && tagCommit !== '';
  const localTagAtHead = localTagPresent && head !== '' && tagCommit === head;
  return { available: true, clean, head, localTagPresent, localTagAtHead };
}

function gatherBundleSources(): BundleSources {
  return {
    runtimeCompose: repoFile('docker-compose.runtime.yml'),
    setupBash: repoFile('deploy/local-runtime-setup.sh'),
    setupPowerShell: repoFile('deploy/local-runtime-setup.ps1'),
  };
}

const CANDIDATE_DOCS = [
  'docs/PHASE_245_CONSUMER_RELEASE_IMAGE.md',
  'docs/PHASE_246_FIRST_RUN_AND_DIAGNOSTICS.md',
  'docs/PHASE_247_CSP_HARDENING.md',
  'docs/PHASE_248_RELEASE_CANDIDATE_ACCEPTANCE.md',
  'docs/PHASE_249_LIFECYCLE_ACCEPTANCE.md',
  'docs/PHASE_250_RELEASE_READINESS.md',
];

function gatherEvidence(targetTag: string): ReadinessEvidence {
  const bundle = buildConsumerReleaseBundle(gatherBundleSources(), {
    image: { repository: RELEASE_IMAGE_REPOSITORY, tag: targetTag },
    // A fixed, deterministic revision/timestamp: this proof is about coordinates, not about a specific build,
    // and must render identically every time it is run against the same checkout.
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  const archive = buildConsumerReleaseArchive(bundle);
  return {
    targetTag,
    repository: RELEASE_REPOSITORY,
    repositoryOwner: RELEASE_REPOSITORY_OWNER,
    git: gatherGitEvidence(targetTag),
    workflowText: repoFile('.github/workflows/runtime-image.yml'),
    composeText: repoFile('docker-compose.runtime.yml'),
    dockerfileText: repoFile('Dockerfile.runtime'),
    bundle,
    archive,
    presentDocs: CANDIDATE_DOCS.filter((doc) => existsSync(join(REPO_ROOT, doc))),
  };
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('usage: ops:release-readiness [--text] [--tag vX.Y.Z] [--generated-at <iso-8601>]');
    console.log('');
    console.log('Deterministic, read-only, non-publishing proof that the release coordinates line up and the');
    console.log('publish path is safe. Prints redaction-safe JSON (or --text). Outcomes: READY_FOR_HUMAN_RELEASE_DECISION,');
    console.log('BLOCKED, INVALID, NOT_RUN. READY is evidence only, never an approval. Exit: 0/10/11/12.');
    return 0;
  }

  const targetTag = valueAfter(args, '--tag') ?? RELEASE_IMAGE_TAG;
  const generatedAt = valueAfter(args, '--generated-at') ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(generatedAt))) {
    console.error('FAIL: --generated-at must be an ISO-8601 timestamp.');
    return 2;
  }

  let report;
  try {
    report = evaluateReleaseReadiness(gatherEvidence(targetTag), { generatedAt });
  } catch (err) {
    // An unexpected failure while assembling evidence (e.g. a malformed tag rejected by the bundle builder)
    // is an INVALID outcome — we could not pose the question — not a crash and never a pass.
    console.error(`INVALID: could not evaluate readiness: ${(err as Error).message}`);
    return READINESS_EXIT_CODES.INVALID;
  }

  try {
    console.log(args.includes('--text') ? renderReadinessText(report) : renderReadinessJson(report));
  } catch (err) {
    if (!(err instanceof ReleaseReadinessError)) throw err;
    console.error(`FAIL: ${err.message}. Nothing was printed.`);
    return 3;
  }

  return READINESS_EXIT_CODES[report.outcome];
}

process.exit(main());
