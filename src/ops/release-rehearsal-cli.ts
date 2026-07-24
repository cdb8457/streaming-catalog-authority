import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_IMAGE_REPOSITORY,
  RELEASE_IMAGE_TAG,
  buildConsumerReleaseArchive,
  buildConsumerReleaseBundle,
  type ConsumerReleaseBundle,
} from './consumer-release-bundle.js';
import { RELEASE_REPOSITORY, RELEASE_REPOSITORY_OWNER } from './release-coordinates.js';
import {
  evaluateReleaseReadiness,
  type GitEvidence,
  type ReadinessEvidence,
} from './release-readiness.js';
import {
  buildVerificationPacket,
  verifyRelease,
  type VerificationPacket,
} from './release-verification.js';
import {
  REHEARSAL_EXIT_CODES,
  ReleaseRehearsalError,
  evaluateReleaseRehearsal,
  renderRehearsalJson,
  renderRehearsalText,
  type CandidateCoordinates,
  type CiEvidenceInput,
  type DocEvidence,
  type RehearsalEvidence,
} from './release-rehearsal.js';

// Phase 252 — `ops:release-rehearsal`, the one command that rehearses the whole first release offline and
// prints the handoff a human reads before taking the single release action that remains.
//
// It assembles the exact candidate (bundle + archive + verification packet) into a FRESH directory, runs the
// Phase 250 readiness proof and the Phase 251 integrity verifier against what it just built, checks the
// install documentation and the per-platform verification commands, and VALIDATES — never fabricates —
// references to the Phase 248 and Phase 249 CI acceptances supplied as inputs.
//
//   npm run ops:release-rehearsal                          # JSON handoff report for the shipped tag
//   npm run ops:release-rehearsal -- --text                # a human-readable handoff
//   npm run ops:release-rehearsal -- --evidence ci.json    # supply the CI acceptance references from a file
//   (or via env: PHASE248_REF/COMMIT/CONCLUSION, PHASE249_REF/COMMIT/CONCLUSION, CANDIDATE_COMMIT)
//
// It contacts no network, uses no credential, holds no write permission, and publishes/pushes/tags nothing.
// Exit codes are fixed: 0 HANDOFF_READY, 30 BLOCKED, 31 INVALID, 32 NOT_RUN, plus 2 usage and 3 a refused
// (redaction-unsafe) render. HANDOFF_READY is evidence for a human decision, never approval, and cannot publish.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function repoFile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function git(gitArgs: readonly string[]): string | null {
  try {
    return execFileSync('git', gitArgs, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function gatherGitEvidence(targetTag: string): GitEvidence {
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return { available: false, clean: false, head: '', localTagPresent: false, localTagAtHead: false };
  }
  const head = git(['rev-parse', 'HEAD']) ?? '';
  const porcelain = git(['status', '--porcelain']);
  const clean = porcelain !== null && porcelain === '';
  const tagCommit = git(['rev-list', '-n', '1', `refs/tags/${targetTag}`]);
  const localTagPresent = tagCommit !== null && tagCommit !== '';
  const localTagAtHead = localTagPresent && head !== '' && tagCommit === head;
  return { available: true, clean, head, localTagPresent, localTagAtHead };
}

const CANDIDATE_DOCS = [
  'docs/PHASE_245_CONSUMER_RELEASE_IMAGE.md',
  'docs/PHASE_246_FIRST_RUN_AND_DIAGNOSTICS.md',
  'docs/PHASE_247_CSP_HARDENING.md',
  'docs/PHASE_248_RELEASE_CANDIDATE_ACCEPTANCE.md',
  'docs/PHASE_249_LIFECYCLE_ACCEPTANCE.md',
  'docs/PHASE_250_RELEASE_READINESS.md',
  'docs/PHASE_251_RELEASE_VERIFICATION.md',
];

/** Read a CI acceptance reference from env (REF/COMMIT/CONCLUSION), returning undefined when none is set. */
function ciRefFromEnv(prefix: string): unknown {
  const ref = process.env[`${prefix}_REF`];
  const commit = process.env[`${prefix}_COMMIT`];
  const conclusion = process.env[`${prefix}_CONCLUSION`];
  if (ref === undefined && commit === undefined && conclusion === undefined) return undefined;
  // Pass through as-is (possibly partial) so the validator reports INVALID rather than this guessing.
  return { ref, commit, conclusion };
}

function gatherCiEvidence(args: readonly string[]): CiEvidenceInput {
  const file = valueAfter(args, '--evidence');
  if (file !== undefined) {
    if (!existsSync(file)) return {}; // absent evidence -> NOT_RUN, honestly
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { phase248?: unknown; phase249?: unknown };
      return { phase248: parsed.phase248, phase249: parsed.phase249 };
    } catch {
      // A malformed file is passed through as a present-but-unparseable object so a gate reports INVALID.
      return { phase248: 'malformed', phase249: 'malformed' };
    }
  }
  return { phase248: ciRefFromEnv('PHASE248'), phase249: ciRefFromEnv('PHASE249') };
}

interface Assembled {
  readonly bundle: ConsumerReleaseBundle;
  readonly archiveBytes: Buffer;
  readonly packet: VerificationPacket;
  readonly readmeText: string;
  readonly freshDir: boolean;
  readonly dir: string;
}

/** Assemble the candidate into a fresh directory and read back the archive bytes and README. */
function assembleCandidate(args: readonly string[], tag: string, revision: string, createdAt: string): Assembled {
  const givenDir = valueAfter(args, '--assemble-dir');
  const dir = givenDir !== undefined ? resolve(givenDir) : mkdtempSync(join(tmpdir(), 'phase252-'));
  if (givenDir !== undefined) mkdirSync(dir, { recursive: true });
  const freshDir = !existsSync(dir) || readdirSync(dir).length === 0;

  const digest = valueAfter(args, '--digest');
  const bundle = buildConsumerReleaseBundle({
    runtimeCompose: repoFile('docker-compose.runtime.yml'),
    setupBash: repoFile('deploy/local-runtime-setup.sh'),
    setupPowerShell: repoFile('deploy/local-runtime-setup.ps1'),
  }, {
    image: { repository: RELEASE_IMAGE_REPOSITORY, tag, ...(digest === undefined ? {} : { digest }) },
    revision,
    createdAt,
  });
  const archive = buildConsumerReleaseArchive(bundle);

  // Write the bundle, the archive and its packet into the fresh directory, then read the archive back — the
  // rehearsal verifies what is actually on disk, exactly as a consumer's machine would.
  const bundleDir = join(dir, 'bundle');
  const archiveDir = join(dir, 'archive');
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });
  for (const file of bundle.files) {
    const path = join(bundleDir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(file.contents, 'utf8'));
  }
  writeFileSync(join(archiveDir, archive.filename), archive.bytes);
  writeFileSync(join(archiveDir, archive.checksumFilename), Buffer.from(archive.checksum, 'utf8'));

  const packet = buildVerificationPacket({
    bundle,
    archive,
    lockfileText: repoFile('package-lock.json'),
    dockerfileText: repoFile('Dockerfile.runtime'),
    workflowText: repoFile('.github/workflows/runtime-image.yml'),
    application: { name: applicationName(), version: tag },
    generatedAt: createdAt,
  });
  writeFileSync(join(archiveDir, `${archive.filename}.verification.json`), Buffer.from(renderPacketSafely(packet), 'utf8'));

  const archiveBytes = readFileSync(join(archiveDir, archive.filename));
  const readmeText = readFileSync(join(bundleDir, 'README.md'), 'utf8');
  return { bundle, archiveBytes, packet, readmeText, freshDir, dir };
}

function renderPacketSafely(packet: VerificationPacket): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

function applicationName(): string {
  const pkg = JSON.parse(repoFile('package.json')) as { name?: unknown };
  return typeof pkg.name === 'string' ? pkg.name : 'catalog-authority';
}

function docEvidence(readmeText: string, packet: VerificationPacket): DocEvidence {
  return {
    installDocumented: /## Five minutes|docker compose up/i.test(readmeText),
    upgradeDocumented: /## Upgrad/i.test(readmeText),
    rollbackDocumented: /## Rolling back/i.test(readmeText),
    verifyDocumented: /## Verifying/i.test(readmeText) && readmeText.includes('sha256sum') && readmeText.includes('Get-FileHash'),
    linuxCommand: packet.verify.linux.some((c) => c.includes('sha256sum')),
    macosCommand: packet.verify.macos.some((c) => c.includes('shasum -a 256')),
    windowsCommand: packet.verify.windows.some((c) => c.includes('Get-FileHash')),
  };
}

function gatherEvidence(args: readonly string[]): { evidence: RehearsalEvidence; cleanup: string | null } {
  const tag = valueAfter(args, '--tag') ?? RELEASE_IMAGE_TAG;
  const gitEvidence = gatherGitEvidence(tag);
  const candidateCommit = valueAfter(args, '--candidate-commit')
    ?? process.env.CANDIDATE_COMMIT
    ?? (gitEvidence.available && /^[0-9a-f]{40}$/.test(gitEvidence.head) ? gitEvidence.head : undefined)
    ?? null;

  // The rehearsal assembles the candidate honestly from this checkout: real revision and a fixed, passed-in
  // build time so a re-run of the same checkout rehearses the same candidate.
  const revision = valueAfter(args, '--revision') ?? candidateCommit ?? 'a'.repeat(40);
  const createdAt = valueAfter(args, '--created') ?? new Date().toISOString();

  const assembled = assembleCandidate(args, tag, revision, createdAt);
  const keep = args.includes('--keep');

  // Phase 250 readiness against the assembled candidate.
  const readiness = evaluateReleaseReadiness(readinessEvidence(tag, gitEvidence, assembled.bundle), { generatedAt: createdAt });

  // Phase 251 integrity: verify the archive that is actually on disk against its generated packet.
  const verification = verifyRelease({ packet: assembled.packet, archiveBytes: assembled.archiveBytes }, { generatedAt: createdAt });

  const candidate: CandidateCoordinates = {
    tag,
    imageRepository: assembled.bundle.image.repository,
    imageRef: assembled.bundle.imageRef,
    imageDigest: assembled.bundle.image.digest ?? null,
    archiveName: assembled.packet.archive.name,
    archiveSha256: assembled.packet.archive.sha256,
    bundleVersion: tag,
    sourceRevision: assembled.bundle.revision,
    candidateCommit,
  };

  const evidence: RehearsalEvidence = {
    candidate,
    assembledInFreshDir: assembled.freshDir,
    readinessOutcome: readiness.outcome,
    verificationOutcome: verification.outcome,
    ci: gatherCiEvidence(args),
    docs: docEvidence(assembled.readmeText, assembled.packet),
  };
  return { evidence, cleanup: keep || valueAfter(args, '--assemble-dir') !== undefined ? null : assembled.dir };
}

function readinessEvidence(tag: string, gitEvidence: GitEvidence, bundle: ConsumerReleaseBundle): ReadinessEvidence {
  return {
    targetTag: tag,
    repository: RELEASE_REPOSITORY,
    repositoryOwner: RELEASE_REPOSITORY_OWNER,
    git: gitEvidence,
    workflowText: repoFile('.github/workflows/runtime-image.yml'),
    composeText: repoFile('docker-compose.runtime.yml'),
    dockerfileText: repoFile('Dockerfile.runtime'),
    bundle,
    archive: buildConsumerReleaseArchive(bundle),
    presentDocs: CANDIDATE_DOCS.filter((doc) => existsSync(join(REPO_ROOT, doc))),
  };
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('usage: ops:release-rehearsal [--text] [--tag vX.Y.Z] [--evidence ci.json] [--candidate-commit <sha>]');
    console.log('                             [--digest sha256:…] [--assemble-dir <dir>] [--keep] [--out <path>] [--generated-at <iso>]');
    console.log('');
    console.log('Deterministic, offline, non-publishing rehearsal of the first release. Assembles the candidate in a');
    console.log('fresh directory, runs the Phase 250 readiness and Phase 251 integrity verifiers, and validates the');
    console.log('supplied Phase 248/249 CI acceptance references (never fabricating them). Outcomes: HANDOFF_READY,');
    console.log('BLOCKED, INVALID, NOT_RUN. Exit: 0/30/31/32. HANDOFF_READY is evidence for a human, not approval.');
    return 0;
  }

  const generatedAt = valueAfter(args, '--generated-at') ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(generatedAt))) {
    console.error('FAIL: --generated-at must be an ISO-8601 timestamp.');
    return 2;
  }

  let gathered: ReturnType<typeof gatherEvidence>;
  try {
    gathered = gatherEvidence(args);
  } catch (err) {
    console.error(`INVALID: could not assemble or evaluate the rehearsal: ${(err as Error).message}`);
    return REHEARSAL_EXIT_CODES.INVALID;
  }

  const report = evaluateReleaseRehearsal(gathered.evidence, { generatedAt });
  if (gathered.cleanup !== null) rmSync(gathered.cleanup, { recursive: true, force: true });

  let rendered: string;
  try {
    rendered = args.includes('--text') ? renderRehearsalText(report) : renderRehearsalJson(report);
  } catch (err) {
    if (!(err instanceof ReleaseRehearsalError)) throw err;
    console.error(`FAIL: ${err.message}. Nothing was printed.`);
    return 3;
  }

  const out = valueAfter(args, '--out');
  if (out !== undefined) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), Buffer.from(renderRehearsalJson(report), 'utf8'));
  }
  console.log(rendered);
  return REHEARSAL_EXIT_CODES[report.outcome];
}

process.exit(main());
