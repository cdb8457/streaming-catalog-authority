export type TorBoxLiveSmokePacketManifestInputErrorCode =
  | 'PACKET_MANIFEST_FILE_READ_FAILED'
  | 'PACKET_MANIFEST_FILE_TOO_LARGE'
  | 'PACKET_MANIFEST_JSON_MALFORMED'
  | 'PACKET_MANIFEST_OBJECT_REQUIRED'
  | 'PACKET_MANIFEST_INPUT_REQUIRED';

export interface TorBoxLiveSmokePacketManifestFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field?: string;
  readonly message: string;
}

export interface TorBoxLiveSmokePacketManifestReport {
  readonly report: 'phase-53-torbox-live-smoke-packet-manifest-preflight';
  readonly version: 1;
  readonly purpose: 'verify-redaction-safe-live-smoke-packet-manifest';
  readonly source: 'single-operator-supplied-packet-manifest-json-file';
  readonly redactionSafe: true;
  readonly manifestValuesEchoed: false;
  readonly artifactContentsIncluded: false;
  readonly credentialValuesIncluded: false;
  readonly credentialPathsIncluded: false;
  readonly rawRefsIncluded: false;
  readonly providerPayloadsIncluded: false;
  readonly liveTorBoxContact: false;
  readonly commandExecution: false;
  readonly closesLiveSmokeReview: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly reviewReadiness: 'ready-for-review' | 'not-ready-for-review';
  readonly requiredArtifactKinds: readonly string[];
  readonly optionalArtifactKinds: readonly string[];
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly TorBoxLiveSmokePacketManifestFinding[];
}

const REQUIRED_ARTIFACT_KINDS = [
  'phase-43-service-status-report',
  'phase-43-hoster-metadata-report',
  'phase-44-service-status-preflight',
  'phase-44-hoster-metadata-preflight',
  'phase-49-summary-pack',
  'phase-51-review-gate',
] as const;

const OPTIONAL_ARTIFACT_KINDS = [
  'phase-43-cache-availability-report',
  'phase-44-cache-availability-preflight',
] as const;

export function buildTorBoxLiveSmokePacketManifestReport(
  manifest: Record<string, unknown>,
): TorBoxLiveSmokePacketManifestReport {
  const findings: TorBoxLiveSmokePacketManifestFinding[] = [];
  findings.push(...requiredLiteral(manifest, 'report', 'phase-53-torbox-live-smoke-packet-manifest', 'MANIFEST_REPORT_VALID'));
  findings.push(...requiredLiteral(manifest, 'redactionSafe', true, 'MANIFEST_REDACTION_SAFE'));
  findings.push(...requiredLiteral(manifest, 'artifactContentsIncluded', false, 'MANIFEST_NO_ARTIFACT_CONTENTS'));
  findings.push(...requiredLiteral(manifest, 'credentialValuesIncluded', false, 'MANIFEST_NO_CREDENTIAL_VALUES'));
  findings.push(...requiredLiteral(manifest, 'credentialPathsIncluded', false, 'MANIFEST_NO_CREDENTIAL_PATHS'));
  findings.push(...requiredLiteral(manifest, 'rawRefsIncluded', false, 'MANIFEST_NO_RAW_REFS'));
  findings.push(...requiredLiteral(manifest, 'providerPayloadsIncluded', false, 'MANIFEST_NO_PROVIDER_PAYLOADS'));
  findings.push(...requiredLiteral(manifest, 'liveTorBoxContact', false, 'MANIFEST_NON_LIVE'));
  findings.push(...requiredLiteral(manifest, 'commandExecution', false, 'MANIFEST_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(manifest, 'closesLiveSmokeReview', false, 'MANIFEST_DOES_NOT_CLOSE_REVIEW'));
  findings.push(...requiredLiteral(manifest, 'o4Status', 'open/deferred', 'O4_STILL_OPEN'));
  findings.push(...requiredLiteral(manifest, 'o5Status', 'open/deferred', 'O5_STILL_OPEN'));
  findings.push(...requiredLiteral(manifest, 'fileCustodianStatus', 'reference-harness-not-production-kms', 'FILE_CUSTODIAN_BOUNDARY'));

  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : null;
  findings.push(artifacts ? pass('MANIFEST_ARTIFACTS_ARRAY_PRESENT', 'artifacts', 'manifest has an artifacts array.') : fail('MANIFEST_ARTIFACTS_ARRAY_REQUIRED', 'artifacts', 'manifest must have an artifacts array.'));
  findings.push(...artifactFindings(artifacts));

  findings.push(warn('REVIEWER_STILL_REQUIRED', 'review', 'This manifest preflight prepares review and does not close live-smoke review.'));
  findings.push(warn('O4_REMAINS_DEFERRED', 'review', 'O4 production file custodian acceptance remains open/deferred.'));
  findings.push(warn('O5_REMAINS_DEFERRED', 'review', 'O5 managed KEK custody/scheduling remains open/deferred.'));
  findings.push(warn('FILE_CUSTODIAN_NOT_PRODUCTION_KMS', 'review', 'FileCustodian remains a hardened reference harness, not production KMS.'));

  return fromFindings(findings);
}

export function buildTorBoxLiveSmokePacketManifestInputErrorReport(
  code: TorBoxLiveSmokePacketManifestInputErrorCode,
): TorBoxLiveSmokePacketManifestReport {
  const messages: Record<TorBoxLiveSmokePacketManifestInputErrorCode, string> = {
    PACKET_MANIFEST_FILE_READ_FAILED: 'A supplied packet manifest JSON file could not be read.',
    PACKET_MANIFEST_FILE_TOO_LARGE: 'A supplied packet manifest JSON file exceeds the preflight input size limit.',
    PACKET_MANIFEST_JSON_MALFORMED: 'A supplied packet manifest input is not valid JSON.',
    PACKET_MANIFEST_OBJECT_REQUIRED: 'A supplied packet manifest JSON value must be an object, not an array or primitive.',
    PACKET_MANIFEST_INPUT_REQUIRED: 'One packet manifest input is required.',
  };
  return fromFindings([fail(code, 'manifest', messages[code])]);
}

export function parseTorBoxLiveSmokePacketManifestJson(
  jsonText: string,
): Record<string, unknown> | TorBoxLiveSmokePacketManifestInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'PACKET_MANIFEST_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'PACKET_MANIFEST_JSON_MALFORMED';
  }
}

export function formatTorBoxLiveSmokePacketManifestJson(report: TorBoxLiveSmokePacketManifestReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatTorBoxLiveSmokePacketManifestText(report: TorBoxLiveSmokePacketManifestReport): string {
  const lines = [
    'Phase 53 TorBox live smoke packet manifest preflight',
    '',
    `Review readiness: ${report.reviewReadiness}`,
    `Redaction-safe: ${report.redactionSafe ? 'yes' : 'no'}`,
    `Manifest values echoed: ${report.manifestValuesEchoed ? 'yes' : 'no'}`,
    `Artifact contents included: ${report.artifactContentsIncluded ? 'true' : 'false'}`,
    `Live TorBox contact: ${report.liveTorBoxContact ? 'true' : 'false'}`,
    `Command execution: ${report.commandExecution ? 'true' : 'false'}`,
    `Closes live smoke review: ${report.closesLiveSmokeReview ? 'true' : 'false'}`,
    `Required artifact kinds: ${report.requiredArtifactKinds.join(',')}`,
    `Optional artifact kinds: ${report.optionalArtifactKinds.join(',')}`,
    `O4 status: ${report.o4Status}`,
    `O5 status: ${report.o5Status}`,
    `FileCustodian: ${report.fileCustodianStatus}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => {
      const field = finding.field ? ` field=${finding.field}` : '';
      return `- ${finding.level.toUpperCase()} ${finding.code}${field}: ${finding.message}`;
    }),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function torBoxLiveSmokePacketManifestHasFailures(report: TorBoxLiveSmokePacketManifestReport): boolean {
  return report.summary.fail > 0;
}

function artifactFindings(artifacts: unknown[] | null): TorBoxLiveSmokePacketManifestFinding[] {
  const findings: TorBoxLiveSmokePacketManifestFinding[] = [];
  for (const kind of REQUIRED_ARTIFACT_KINDS) findings.push(kindPresentOnce(artifacts, kind, true));
  const cacheReport = countKind(artifacts, 'phase-43-cache-availability-report');
  const cachePreflight = countKind(artifacts, 'phase-44-cache-availability-preflight');
  if (cacheReport === 0 && cachePreflight === 0) {
    findings.push(warn('OPTIONAL_CACHE_ARTIFACTS_ABSENT', 'artifacts', 'optional cache-availability artifacts are absent.'));
  } else if (cacheReport === 1 && cachePreflight === 1) {
    findings.push(pass('OPTIONAL_CACHE_ARTIFACTS_PAIRED', 'artifacts', 'optional cache-availability artifacts are paired.'));
  } else {
    findings.push(fail('OPTIONAL_CACHE_ARTIFACTS_UNPAIRED', 'artifacts', 'optional cache-availability report and preflight must be retained together.'));
  }
  return findings;
}

function kindPresentOnce(artifacts: unknown[] | null, kind: string, required: boolean): TorBoxLiveSmokePacketManifestFinding {
  const count = countKind(artifacts, kind);
  const code = kind.toUpperCase().replace(/-/g, '_');
  if (count === 1) return pass(`${code}_PRESENT`, 'artifacts', `${kind} artifact is present exactly once.`);
  return required
    ? fail(`${code}_REQUIRED`, 'artifacts', `${kind} artifact must be present exactly once.`)
    : warn(`${code}_ABSENT`, 'artifacts', `${kind} artifact is absent.`);
}

function countKind(artifacts: unknown[] | null, kind: string): number {
  if (!artifacts) return 0;
  return artifacts.filter((artifact) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return false;
    return (artifact as { kind?: unknown }).kind === kind;
  }).length;
}

function fromFindings(findings: readonly TorBoxLiveSmokePacketManifestFinding[]): TorBoxLiveSmokePacketManifestReport {
  const summary = summarize(findings);
  return {
    report: 'phase-53-torbox-live-smoke-packet-manifest-preflight',
    version: 1,
    purpose: 'verify-redaction-safe-live-smoke-packet-manifest',
    source: 'single-operator-supplied-packet-manifest-json-file',
    redactionSafe: true,
    manifestValuesEchoed: false,
    artifactContentsIncluded: false,
    credentialValuesIncluded: false,
    credentialPathsIncluded: false,
    rawRefsIncluded: false,
    providerPayloadsIncluded: false,
    liveTorBoxContact: false,
    commandExecution: false,
    closesLiveSmokeReview: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    reviewReadiness: summary.fail === 0 ? 'ready-for-review' : 'not-ready-for-review',
    requiredArtifactKinds: REQUIRED_ARTIFACT_KINDS,
    optionalArtifactKinds: OPTIONAL_ARTIFACT_KINDS,
    summary,
    findings,
  };
}

function summarize(findings: readonly TorBoxLiveSmokePacketManifestFinding[]): TorBoxLiveSmokePacketManifestReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): TorBoxLiveSmokePacketManifestFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): TorBoxLiveSmokePacketManifestFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): TorBoxLiveSmokePacketManifestFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): TorBoxLiveSmokePacketManifestFinding {
  return { level: 'warn', code, field, message };
}
