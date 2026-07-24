import { createHash } from 'node:crypto';
import type { ReadinessOutcome } from './release-readiness.js';
import type { IntegrityOutcome } from './release-verification.js';

// Phase 252 — the final first-release rehearsal and human handoff.
//
// Everything through Phase 251 built and proved a releasable candidate: an image, a consumer bundle, a
// browser acceptance, a lifecycle acceptance, a read-only readiness proof, and an offline integrity packet.
// Phase 252 is the last thing before a human decides: ONE deterministic, non-publishing rehearsal that
// assembles the exact candidate, runs every offline verifier, and REQUIRES — as explicit inputs, never
// fabricated here — references to the Phase 248 real-browser and Phase 249 lifecycle CI acceptances, which
// this offline tool cannot run itself. It then emits a concise handoff packet a human reads before taking the
// single release action that remains.
//
// Outcomes, most severe first: INVALID > BLOCKED > NOT_RUN > HANDOFF_READY.
//   * HANDOFF_READY — the candidate assembled, every offline verifier passed, and passing CI acceptances are
//     referenced for THIS commit. Evidence that a human MAY now decide to release. It is NOT approval and
//     publishes nothing.
//   * BLOCKED — a gate found a real problem: a verifier blocked, or a referenced acceptance failed or is for a
//     different commit (stale/contradictory).
//   * INVALID — an input could not be interpreted (an evidence reference is malformed).
//   * NOT_RUN — a required piece of evidence was not supplied (a CI acceptance reference is absent, or there is
//     no Git here to tie evidence to). Readiness is never claimed on incomplete evidence; a skip is not a pass.

export type GateStatus = 'PASS' | 'BLOCK' | 'INVALID' | 'NOT_RUN';

export type RehearsalOutcome = 'HANDOFF_READY' | 'BLOCKED' | 'INVALID' | 'NOT_RUN';

/** Fixed, documented exit codes. A caller scripts against these, so they never move. */
export const REHEARSAL_EXIT_CODES: Readonly<Record<RehearsalOutcome, number>> = {
  HANDOFF_READY: 0,
  BLOCKED: 30,
  INVALID: 31,
  NOT_RUN: 32,
};

export class ReleaseRehearsalError extends Error {
  readonly code = 'RELEASE_REHEARSAL_REDACTION_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseRehearsalError';
  }
}

export interface RehearsalGate {
  readonly id: string;
  readonly title: string;
  readonly status: GateStatus;
  /** A fixed or coordinate-derived sentence. Never a secret, a raw path, or an environment dump. */
  readonly detail: string;
}

/** A reference to a CI acceptance run — supplied by CI or a human, VALIDATED here, never invented. */
export interface CiEvidenceRef {
  readonly ref: string;
  readonly commit: string;
  readonly conclusion: string;
}

/** The evidence as it arrives — possibly absent or malformed, so the validator can report NOT_RUN/INVALID. */
export interface CiEvidenceInput {
  readonly phase248?: unknown;
  readonly phase249?: unknown;
}

export interface CandidateCoordinates {
  readonly tag: string;
  readonly imageRepository: string;
  readonly imageRef: string;
  readonly imageDigest: string | null;
  readonly archiveName: string;
  readonly archiveSha256: string;
  readonly bundleVersion: string;
  readonly sourceRevision: string;
  /** The commit this candidate is cut from, or null when there is no Git to establish it. */
  readonly candidateCommit: string | null;
}

export interface DocEvidence {
  readonly installDocumented: boolean;
  readonly upgradeDocumented: boolean;
  readonly rollbackDocumented: boolean;
  readonly verifyDocumented: boolean;
  readonly linuxCommand: boolean;
  readonly macosCommand: boolean;
  readonly windowsCommand: boolean;
}

export interface RehearsalEvidence {
  readonly candidate: CandidateCoordinates;
  /** True when the candidate was assembled into a genuinely empty directory, not reused from a stale build. */
  readonly assembledInFreshDir: boolean;
  /** Phase 250 read-only readiness outcome, gathered by the CLI. */
  readonly readinessOutcome: ReadinessOutcome;
  /** Phase 251 offline integrity outcome for the assembled archive, gathered by the CLI. */
  readonly verificationOutcome: IntegrityOutcome;
  readonly ci: CiEvidenceInput;
  readonly docs: DocEvidence;
}

export interface HandoffPacket {
  readonly candidate: CandidateCoordinates;
  readonly passedGates: readonly string[];
  readonly blockedGates: readonly string[];
  readonly notRunGates: readonly string[];
  readonly evidenceReferences: { readonly browserAcceptance: string | null; readonly lifecycleAcceptance: string | null };
  readonly knownLimitations: readonly string[];
  readonly rollbackFacts: readonly string[];
  readonly remainingHumanAction: string;
}

export interface ReleaseRehearsalReport {
  readonly report: 'phase-252-release-rehearsal';
  readonly generatedAt: string;
  readonly outcome: RehearsalOutcome;
  readonly outcomeIsNotApproval: true;
  readonly authorityNote: string;
  readonly candidate: CandidateCoordinates;
  readonly gates: readonly RehearsalGate[];
  readonly counts: { readonly pass: number; readonly block: number; readonly invalid: number; readonly notRun: number };
  readonly handoff: HandoffPacket;
  readonly humanChecklist: readonly string[];
  readonly decisionRecordTemplate: readonly string[];
  readonly boundaries: readonly string[];
  readonly selfDigest: string;
}

const AUTHORITY_NOTE =
  'HANDOFF_READY is EVIDENCE that the candidate assembled, every offline verifier passed, and passing CI '
  + 'acceptances are referenced for this commit. It is NOT release approval, an authorization, or a decision. '
  + 'It publishes, pushes, tags and deploys nothing. Exactly one action remains, and only a human may take it.';

const KNOWN_LIMITATIONS: readonly string[] = [
  'This rehearsal is offline: it cannot confirm that the tag or release exists on GitHub, that the published '
  + 'image digest matches, or that the registry state is what it should be — those are the human/CI steps this '
  + 'rehearsal precedes.',
  'It cannot run the real-browser (Phase 248) or the Compose lifecycle (Phase 249) acceptances itself; those '
  + 'need a daemon and a browser. It REQUIRES references to their CI runs as inputs and refuses to fabricate a '
  + 'green result — absent evidence is NOT_RUN, never a pass.',
  'A VERIFIED integrity result proves the assembled bytes match the packet; it does not establish publisher '
  + 'identity, which requires verifying the signed attestation against the published image after release.',
];

const ROLLBACK_FACTS: readonly string[] = [
  'The stack is pinned by an immutable digest or version tag, never `latest`, so rolling back is re-pinning to '
  + 'the previous version and restarting — a deterministic, documented step.',
  'Data lives in a named volume and persists across upgrade and rollback; the Phase 249 lifecycle acceptance '
  + 'proves fresh, restart, upgrade and rollback all preserve it.',
  'Rolling the image back does NOT roll data back. A schema or data change made by a newer version is not '
  + 'undone by starting the older image.',
];

const HUMAN_CHECKLIST: readonly string[] = [
  'I have read this handoff packet and the candidate coordinates below.',
  'I confirm the offline readiness (Phase 250) and integrity (Phase 251) gates passed.',
  'I have opened the referenced Phase 248 browser-acceptance CI run and confirmed it passed for this commit.',
  'I have opened the referenced Phase 249 lifecycle-acceptance CI run and confirmed it passed for this commit.',
  'I understand HANDOFF_READY is evidence, not approval, and that this tool published nothing.',
  'I understand the rollback facts, including that rolling the image back does not roll data back.',
  'I am the human taking the single remaining release action, and I accept responsibility for it.',
];

const DECISION_RECORD_TEMPLATE: readonly string[] = [
  'Catalog Authority — first release decision record (Phase 252)',
  'candidate tag:      __________  (must equal the tag below)',
  'archive sha256:     __________  (must equal the sha below)',
  'source commit:      __________',
  'rehearsal outcome:  __________  (HANDOFF_READY required)',
  'rehearsal self-digest: __________',
  'checklist complete: [ ] yes',
  'decision:           [ ] APPROVE release   [ ] HOLD',
  'approver:           __________            date: __________',
];

const BOUNDARIES: readonly string[] = [
  'assembles the candidate in a fresh directory and runs offline verifiers only; contacts no network',
  'never publishes, pushes, tags, merges, or deploys, and holds no write permission',
  'never uses a credential or contacts GitHub, Jellyfin, or any provider',
  'never runs a promotion, reads the Movies library, or authorizes Phase 231',
  'requires CI acceptance references as inputs and never fabricates a passing result',
];

const SELF_DIGEST_SCOPE = 'phase-252-release-rehearsal';

// -----------------------------------------------------------------------------------------------------------
// Redaction: the report is controlled text and must be safe to paste anywhere. It names Jellyfin, providers
// and the Movies library in its boundary prose to state what it never touches, so the backstop scans for
// leaked live DATA (a secret, a credential, an absolute host path, the Movies path), not the mere mention.
// -----------------------------------------------------------------------------------------------------------

const FORBIDDEN_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bghp_[A-Za-z0-9]{20,}\b/, 'a GitHub token'],
  [/postgres(?:ql)?:\/\/[^\s:@/]+:[^\s:@/]{6,}@/i, 'a database URL with a password'],
  [/(?:^|[^\w./-])\/(?:home|root|Users|mnt|opt|srv)\//, 'an absolute host filesystem path'],
  [/\b[A-Za-z]:\\Users\\/, 'a Windows user path'],
  [/\/mnt\/user\/media\/Movies/i, 'the Movies library path'],
];

export function assertRehearsalReportIsRedactionSafe(rendered: string): void {
  for (const [pattern, what] of FORBIDDEN_SHAPES) {
    if (pattern.test(rendered)) throw new ReleaseRehearsalError(`refusing to emit a rehearsal report: it contains ${what}`);
  }
}

// -----------------------------------------------------------------------------------------------------------
// Gates. Each returns exactly one RehearsalGate with a fixed or coordinate-derived detail.
// -----------------------------------------------------------------------------------------------------------

function pass(id: string, title: string, detail: string): RehearsalGate { return { id, title, status: 'PASS', detail }; }
function block(id: string, title: string, detail: string): RehearsalGate { return { id, title, status: 'BLOCK', detail }; }
function invalid(id: string, title: string, detail: string): RehearsalGate { return { id, title, status: 'INVALID', detail }; }
function notRun(id: string, title: string, detail: string): RehearsalGate { return { id, title, status: 'NOT_RUN', detail }; }

/** Parse and validate one CI acceptance reference. Absent -> NOT_RUN, malformed -> INVALID, non-success or a
 *  commit that is not the candidate's -> BLOCK. Never invents a passing result. */
export function validateCiEvidence(input: unknown, candidateCommit: string | null, id: string, title: string): { gate: RehearsalGate; ref: CiEvidenceRef | null } {
  if (input === undefined || input === null) {
    return { gate: notRun(id, title, 'no CI acceptance reference was supplied — a real, human-reviewed run is required, never fabricated'), ref: null };
  }
  if (typeof input !== 'object') {
    return { gate: invalid(id, title, 'the CI acceptance reference is malformed'), ref: null };
  }
  const raw = input as { ref?: unknown; commit?: unknown; conclusion?: unknown };
  if (typeof raw.ref !== 'string' || raw.ref.trim() === '' || typeof raw.commit !== 'string' || typeof raw.conclusion !== 'string') {
    return { gate: invalid(id, title, 'the CI acceptance reference is missing a ref, commit, or conclusion'), ref: null };
  }
  if (!/^[0-9a-f]{40}$/.test(raw.commit)) {
    return { gate: invalid(id, title, 'the CI acceptance reference commit is not a 40-hex commit'), ref: null };
  }
  const ref: CiEvidenceRef = { ref: raw.ref, commit: raw.commit, conclusion: raw.conclusion };
  if (raw.conclusion !== 'success') {
    return { gate: block(id, title, `the referenced acceptance did not pass (conclusion: ${sanitiseConclusion(raw.conclusion)})`), ref };
  }
  if (candidateCommit === null) {
    return { gate: notRun(id, title, 'the candidate commit is unknown here, so the acceptance cannot be tied to it'), ref };
  }
  if (raw.commit !== candidateCommit) {
    return { gate: block(id, title, 'the referenced acceptance is for a different commit than the candidate (stale evidence)'), ref };
  }
  return { gate: pass(id, title, 'a passing CI acceptance is referenced for the candidate commit'), ref };
}

/** Conclusions are short GitHub enums; keep the detail to a safe, bounded token. */
function sanitiseConclusion(value: string): string {
  return /^[a-z_]{1,32}$/.test(value) ? value : 'not a recognised conclusion';
}

function readinessGate(outcome: ReadinessOutcome): RehearsalGate {
  const id = 'offline-readiness';
  const title = 'The Phase 250 read-only readiness proof is READY';
  switch (outcome) {
    case 'READY_FOR_HUMAN_RELEASE_DECISION': return pass(id, title, 'the readiness proof reports the coordinates line up and the publish path is safe');
    case 'BLOCKED': return block(id, title, 'the readiness proof found a real problem');
    case 'INVALID': return invalid(id, title, 'the readiness proof could not interpret an input');
    case 'NOT_RUN': return notRun(id, title, 'the readiness proof could not gather its evidence offline');
  }
}

function integrityGate(outcome: IntegrityOutcome): RehearsalGate {
  const id = 'offline-integrity';
  const title = 'The Phase 251 offline integrity verifier is VERIFIED';
  switch (outcome) {
    case 'VERIFIED': return pass(id, title, 'the assembled archive verifies against its generated packet');
    case 'INVALID': return invalid(id, title, 'the assembled archive did not match its packet');
    case 'UNVERIFIED': return notRun(id, title, 'integrity could not be confirmed offline');
  }
}

function assembledGate(fresh: boolean): RehearsalGate {
  const id = 'candidate-assembled';
  const title = 'The candidate artifacts were assembled in a fresh directory';
  return fresh
    ? pass(id, title, 'the bundle, archive and packet were assembled from scratch into an empty directory')
    : block(id, title, 'the assembly directory was not empty — a stale artifact may have been reused');
}

function docsGate(docs: DocEvidence): RehearsalGate {
  const id = 'install-documentation';
  const title = 'Install, upgrade, rollback and verification are documented';
  const missing: string[] = [];
  if (!docs.installDocumented) missing.push('install');
  if (!docs.upgradeDocumented) missing.push('upgrade');
  if (!docs.rollbackDocumented) missing.push('rollback');
  if (!docs.verifyDocumented) missing.push('verification');
  return missing.length === 0
    ? pass(id, title, 'the bundle documents install, upgrade, rollback and how to verify the download')
    : block(id, title, `the bundle documentation is missing: ${missing.join(', ')}`);
}

function commandPathsGate(docs: DocEvidence): RehearsalGate {
  const id = 'command-paths';
  const title = 'Windows, macOS and Linux verification commands are provided';
  const missing: string[] = [];
  if (!docs.linuxCommand) missing.push('Linux');
  if (!docs.macosCommand) missing.push('macOS');
  if (!docs.windowsCommand) missing.push('Windows');
  return missing.length === 0
    ? pass(id, title, 'copy-paste verification commands are provided for Linux, macOS and Windows')
    : block(id, title, `verification commands are missing for: ${missing.join(', ')}`);
}

// -----------------------------------------------------------------------------------------------------------
// Evaluation
// -----------------------------------------------------------------------------------------------------------

function deriveOutcome(gates: readonly RehearsalGate[]): RehearsalOutcome {
  if (gates.some((g) => g.status === 'INVALID')) return 'INVALID';
  if (gates.some((g) => g.status === 'BLOCK')) return 'BLOCKED';
  if (gates.some((g) => g.status === 'NOT_RUN')) return 'NOT_RUN';
  return 'HANDOFF_READY';
}

function remainingHumanAction(candidate: CandidateCoordinates): string {
  return `Create and publish the GitHub Release for tag ${candidate.tag}, which triggers the gated publish `
    + 'workflow that builds, signs and attaches the tested image and asset. Nothing in this rehearsal does '
    + 'this; it is the single human-controlled release action that remains.';
}

function computeSelfDigest(body: Omit<ReleaseRehearsalReport, 'selfDigest' | 'generatedAt'>): string {
  const canonical = JSON.stringify({
    scope: SELF_DIGEST_SCOPE,
    outcome: body.outcome,
    candidate: body.candidate,
    gates: body.gates.map((g) => ({ id: g.id, status: g.status })),
  });
  return createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
}

export interface EvaluateRehearsalOptions {
  /** Passed in, never read from the clock, so the same evidence renders the same report. */
  readonly generatedAt: string;
}

export function evaluateReleaseRehearsal(evidence: RehearsalEvidence, options: EvaluateRehearsalOptions): ReleaseRehearsalReport {
  const { candidate } = evidence;
  const browser = validateCiEvidence(evidence.ci.phase248, candidate.candidateCommit, 'browser-acceptance-evidence', 'A passing Phase 248 real-browser acceptance is referenced for this commit');
  const lifecycle = validateCiEvidence(evidence.ci.phase249, candidate.candidateCommit, 'lifecycle-acceptance-evidence', 'A passing Phase 249 lifecycle acceptance is referenced for this commit');

  const gates: RehearsalGate[] = [
    assembledGate(evidence.assembledInFreshDir),
    readinessGate(evidence.readinessOutcome),
    integrityGate(evidence.verificationOutcome),
    browser.gate,
    lifecycle.gate,
    docsGate(evidence.docs),
    commandPathsGate(evidence.docs),
  ];

  const outcome = deriveOutcome(gates);
  const counts = {
    pass: gates.filter((g) => g.status === 'PASS').length,
    block: gates.filter((g) => g.status === 'BLOCK').length,
    invalid: gates.filter((g) => g.status === 'INVALID').length,
    notRun: gates.filter((g) => g.status === 'NOT_RUN').length,
  };

  const handoff: HandoffPacket = {
    candidate,
    passedGates: gates.filter((g) => g.status === 'PASS').map((g) => g.id),
    blockedGates: gates.filter((g) => g.status === 'BLOCK' || g.status === 'INVALID').map((g) => g.id),
    notRunGates: gates.filter((g) => g.status === 'NOT_RUN').map((g) => g.id),
    evidenceReferences: {
      browserAcceptance: browser.ref?.ref ?? null,
      lifecycleAcceptance: lifecycle.ref?.ref ?? null,
    },
    knownLimitations: KNOWN_LIMITATIONS,
    rollbackFacts: ROLLBACK_FACTS,
    remainingHumanAction: remainingHumanAction(candidate),
  };

  const bodyWithoutDigest = {
    report: 'phase-252-release-rehearsal' as const,
    outcome,
    outcomeIsNotApproval: true as const,
    authorityNote: AUTHORITY_NOTE,
    candidate,
    gates,
    counts,
    handoff,
    humanChecklist: HUMAN_CHECKLIST,
    decisionRecordTemplate: DECISION_RECORD_TEMPLATE,
    boundaries: BOUNDARIES,
  };
  const selfDigest = computeSelfDigest(bodyWithoutDigest);
  return { ...bodyWithoutDigest, generatedAt: options.generatedAt, selfDigest };
}

// -----------------------------------------------------------------------------------------------------------
// Rendering, checked for redaction safety before it is returned.
// -----------------------------------------------------------------------------------------------------------

export function renderRehearsalJson(report: ReleaseRehearsalReport): string {
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  assertRehearsalReportIsRedactionSafe(rendered);
  return rendered;
}

const STATUS_MARK: Record<GateStatus, string> = { PASS: 'PASS ', BLOCK: 'BLOCK', INVALID: 'INVAL', NOT_RUN: 'NOTRN' };

export function renderRehearsalText(report: ReleaseRehearsalReport): string {
  const lines: string[] = [
    'Catalog Authority — final first-release rehearsal and handoff',
    `report:        ${report.report}`,
    `generated:     ${report.generatedAt}`,
    `outcome:       ${report.outcome}`,
    '',
    'Candidate',
    `  tag:         ${report.candidate.tag}`,
    `  image:       ${report.candidate.imageRef}`,
    `  digest:      ${report.candidate.imageDigest ?? '(version-pinned, no digest yet)'}`,
    `  archive:     ${report.candidate.archiveName}`,
    `  archive sha: ${report.candidate.archiveSha256}`,
    `  bundle ver:  ${report.candidate.bundleVersion}`,
    `  commit:      ${report.candidate.candidateCommit ?? '(no git here)'}`,
    '',
    `Gates (${report.counts.pass} pass, ${report.counts.block} block, ${report.counts.invalid} invalid, ${report.counts.notRun} not-run)`,
    ...report.gates.map((g) => `  ${STATUS_MARK[g.status]}  ${g.title} — ${g.detail}`),
    '',
    'Known limitations',
    ...report.handoff.knownLimitations.map((l) => `  - ${l}`),
    '',
    'Rollback facts',
    ...report.handoff.rollbackFacts.map((r) => `  - ${r}`),
    '',
    'The single remaining human action',
    `  ${report.handoff.remainingHumanAction}`,
    '',
    'Human checklist',
    ...report.humanChecklist.map((c) => `  [ ] ${c}`),
    '',
    ...report.decisionRecordTemplate,
    '',
    `self-digest:   ${report.selfDigest}`,
    '',
    report.authorityNote,
    '',
  ];
  const rendered = lines.join('\n');
  assertRehearsalReportIsRedactionSafe(rendered);
  return rendered;
}
