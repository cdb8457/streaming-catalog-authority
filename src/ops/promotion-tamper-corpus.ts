import { createHash } from 'node:crypto';
import { replayFixtureBundle } from './promotion-bundle-replay.js';
import { validateArtifactSchemas } from './promotion-artifact-schema.js';
import { buildAcceptanceDashboard } from './promotion-dashboard.js';

// Local, non-live tamper corpus generator. From one clean fixture evidence bundle it derives a corpus
// of deliberately-tampered inputs, each paired with the generic failure code the appropriate offline
// verifier (replay / schema / dashboard) must report. It then runs each entry and confirms the expected
// failure occurs. It reads parsed JSON only; it performs no promotion, never touches the real Movies
// root, never contacts Jellyfin, and authorizes nothing live.

export type TamperVerifier = 'replay' | 'schema' | 'dashboard';

export interface TamperEntry {
  readonly kind: string;
  readonly verifier: TamperVerifier;
  readonly input: unknown;
  readonly expectedCode: string;
}

export interface TamperEntryResult {
  readonly kind: string;
  readonly verifier: TamperVerifier;
  readonly expectedCode: string;
  readonly matched: boolean;
}

export interface TamperCorpusReport {
  readonly report: 'phase-230-promotion-tamper-corpus';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly ok: boolean;
  readonly entries: readonly TamperEntryResult[];
  readonly corpusDigest: string;
}

export function generateTamperCorpus(bundle: unknown): TamperEntry[] {
  const base = asObject(bundle);
  const artifactBundle = (b: Record<string, unknown>) => ({
    approvalEvidence: asObject(b.artifacts).approvalEvidence,
    promotionEvidence: asObject(b.artifacts).promotionEvidence,
    evidenceReview: asObject(b.artifacts).evidenceReview,
    readiness: asObject(b.artifacts).readiness,
    acceptancePacket: asObject(b.artifacts).acceptancePacket,
  });
  const reports = (b: Record<string, unknown>) => asObject(b.reports);

  const entries: TamperEntry[] = [];

  // 1. Missing artifact -> replay.
  {
    const b = clone(base);
    delete asObject(b.artifacts).acceptancePacket;
    entries.push({ kind: 'missing-artifact', verifier: 'replay', input: b, expectedCode: 'ACCEPTANCE_PACKET_MISSING' });
  }
  // 2. Wrong stored report -> replay.
  {
    const b = clone(base);
    asObject(reports(b).integrity).report = 'not-an-integrity-report';
    entries.push({ kind: 'wrong-report', verifier: 'replay', input: b, expectedCode: 'INTEGRITY_REPORT_WRONG' });
  }
  // 3. Bundle self-digest -> replay.
  {
    const b = clone(base);
    b.bundleDigest = '9'.repeat(64);
    entries.push({ kind: 'bundle-self-digest', verifier: 'replay', input: b, expectedCode: 'BUNDLE_SELF_DIGEST_MISMATCH' });
  }
  // 4. Matrix self-digest -> replay.
  {
    const b = clone(base);
    asObject(reports(b).matrix).outcome = 'MATRIX_FAIL';
    entries.push({ kind: 'matrix-self-digest', verifier: 'replay', input: b, expectedCode: 'MATRIX_SELF_DIGEST_MISMATCH' });
  }
  // 5. Manifest stage mismatch -> replay.
  {
    const b = clone(base);
    asObject(asObject(b.artifacts).promotionEvidence).evidenceDigest = '2'.repeat(64);
    entries.push({ kind: 'manifest-stage', verifier: 'replay', input: b, expectedCode: 'MANIFEST_STAGE_MISMATCH' });
  }
  // 6. Schema failed-state -> schema (re-self-digested REFUSED acceptance).
  {
    const b = clone(base);
    const packet = asObject(asObject(b.artifacts).acceptancePacket);
    packet.status = 'ACCEPTANCE_REFUSED';
    packet.accepted = false;
    reseal(packet, 'sealDigest', 'phase-230-acceptance-seal');
    entries.push({ kind: 'schema-failed-state', verifier: 'schema', input: artifactBundle(b), expectedCode: 'ACCEPTANCE_PACKET_STATUS_INVALID' });
  }
  // 7. Dashboard blocked -> dashboard (a not-ok integrity gate).
  {
    const b = clone(base);
    const notOkIntegrity = { report: 'phase-230-promotion-artifact-integrity', ok: false, integrityDigest: 'a'.repeat(64) };
    entries.push({
      kind: 'dashboard-blocked', verifier: 'dashboard',
      input: { matrix: reports(b).matrix, integrity: notOkIntegrity, schema: reports(b).schema, handoff: reports(b).handoff },
      expectedCode: 'INTEGRITY_NOT_OK',
    });
  }

  return entries;
}

export function runTamperEntry(entry: TamperEntry): TamperEntryResult {
  let problems: readonly string[];
  if (entry.verifier === 'replay') problems = replayFixtureBundle(entry.input).problems;
  else if (entry.verifier === 'schema') problems = validateArtifactSchemas(entry.input as never).problems;
  else problems = buildAcceptanceDashboard(entry.input as never).blockers;
  return { kind: entry.kind, verifier: entry.verifier, expectedCode: entry.expectedCode, matched: problems.includes(entry.expectedCode) };
}

export function verifyTamperCorpus(bundle: unknown): TamperCorpusReport {
  const entries = generateTamperCorpus(bundle).map(runTamperEntry);
  const ok = entries.length > 0 && entries.every((e) => e.matched);
  const withoutDigest: Omit<TamperCorpusReport, 'corpusDigest'> = {
    report: 'phase-230-promotion-tamper-corpus',
    version: 1,
    redactionSafe: true,
    ok,
    entries,
  };
  return { ...withoutDigest, corpusDigest: digest('phase-230-tamper-corpus', JSON.stringify(withoutDigest)) };
}

function clone(v: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
}
function reseal(obj: Record<string, unknown>, field: string, scope: string): void {
  const without: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) if (k !== field) without[k] = obj[k];
  obj[field] = digest(scope, JSON.stringify(without));
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
