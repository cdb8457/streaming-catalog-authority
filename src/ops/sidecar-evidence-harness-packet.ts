export type SidecarEvidenceReviewReadiness = 'ready-for-review' | 'not-ready-for-review';
export type SidecarEvidenceFindingLevel = 'pass' | 'warn' | 'fail';

export interface SidecarEvidenceManifest {
  readonly runtimeDesignLabel?: string;
  readonly contractKitLabel?: string;
  readonly failureInjectionLabel?: string;
  readonly attestationLabel?: string;
  readonly redactionReviewLabel?: string;
  readonly backupRestoreLabel?: string;
  readonly operatorAcceptanceLabel?: string;
  readonly reviewerAcceptanceLabel?: string;
  readonly sidecarProcessImplemented?: boolean;
  readonly unixSocketBoundaryImplemented?: boolean;
  readonly independentSidecarStateImplemented?: boolean;
  readonly appCannotForgeAttestation?: boolean;
  readonly noRawSecretsInEvidence?: boolean;
  readonly restoreWithoutSidecarFailsClosed?: boolean;
}

export interface SidecarEvidenceFinding {
  readonly level: SidecarEvidenceFindingLevel;
  readonly code: string;
  readonly field: keyof SidecarEvidenceManifest | 'manifest';
  readonly message: string;
}

export interface SidecarEvidenceSummary {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
  readonly total: number;
}

export interface SidecarEvidenceHarnessPacket {
  readonly ok: true;
  readonly code: 'SIDECAR_EVIDENCE_HARNESS_PACKET';
  readonly report: 'phase-100-sidecar-evidence-harness-packet';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly purpose: 'preflight-redacted-sidecar-o4-evidence-manifest';
  readonly manifestValuesEchoed: false;
  readonly reviewReadiness: SidecarEvidenceReviewReadiness;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly requiredLabels: readonly (keyof SidecarEvidenceManifest)[];
  readonly requiredTrueFields: readonly (keyof SidecarEvidenceManifest)[];
  readonly findings: readonly SidecarEvidenceFinding[];
  readonly summary: SidecarEvidenceSummary;
  readonly blockedEvidence: readonly string[];
}

const REQUIRED_LABELS = [
  'runtimeDesignLabel',
  'contractKitLabel',
  'failureInjectionLabel',
  'attestationLabel',
  'redactionReviewLabel',
  'backupRestoreLabel',
  'operatorAcceptanceLabel',
  'reviewerAcceptanceLabel',
] as const satisfies readonly (keyof SidecarEvidenceManifest)[];

const REQUIRED_TRUE_FIELDS = [
  'sidecarProcessImplemented',
  'unixSocketBoundaryImplemented',
  'independentSidecarStateImplemented',
  'appCannotForgeAttestation',
  'noRawSecretsInEvidence',
  'restoreWithoutSidecarFailsClosed',
] as const satisfies readonly (keyof SidecarEvidenceManifest)[];

const BLOCKED_EVIDENCE = [
  'raw key material',
  'raw completion secret',
  'database URL',
  'secret file path',
  'socket path containing host-specific secrets',
  'provider reference',
  'media title',
  'Jellyfin or Plex token',
  'live service response body',
  'backup archive contents',
  'logs that include credentials or identity',
] as const;

export function buildSidecarEvidenceHarnessPacket(manifest: SidecarEvidenceManifest = {}): SidecarEvidenceHarnessPacket {
  const findings = validateSidecarEvidenceManifest(manifest);
  const summary = summarize(findings);
  return {
    ok: true,
    code: 'SIDECAR_EVIDENCE_HARNESS_PACKET',
    report: 'phase-100-sidecar-evidence-harness-packet',
    version: 1,
    redactionSafe: true,
    purpose: 'preflight-redacted-sidecar-o4-evidence-manifest',
    manifestValuesEchoed: false,
    reviewReadiness: summary.fail === 0 ? 'ready-for-review' : 'not-ready-for-review',
    closesO4: false,
    closesO5: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    requiredLabels: [...REQUIRED_LABELS],
    requiredTrueFields: [...REQUIRED_TRUE_FIELDS],
    findings,
    summary,
    blockedEvidence: [...BLOCKED_EVIDENCE],
  };
}

export function validateSidecarEvidenceManifest(manifest: SidecarEvidenceManifest): SidecarEvidenceFinding[] {
  const findings: SidecarEvidenceFinding[] = [];

  for (const field of REQUIRED_LABELS) {
    if (hasLabel(manifest[field])) findings.push(pass(`${toCode(field)}_PRESENT`, field, `${field} is present.`));
    else findings.push(fail(`${toCode(field)}_REQUIRED`, field, `${field} is required before O4 sidecar evidence review.`));
  }

  for (const field of REQUIRED_TRUE_FIELDS) {
    if (manifest[field] === true) findings.push(pass(`${toCode(field)}_DECLARED`, field, `${field} is declared.`));
    else findings.push(fail(`${toCode(field)}_REQUIRED`, field, `${field} must be true before O4 sidecar evidence review.`));
  }

  if (!findings.some((finding) => finding.level === 'fail')) {
    findings.push(warn(
      'O4_STILL_REQUIRES_REVIEW',
      'manifest',
      'Evidence manifest is complete, but O4 remains open/deferred until separate reviewer and operator acceptance.',
    ));
  }
  findings.push(warn('O5_REMAINS_DEFERRED', 'manifest', 'O5 managed KEK custody and scheduling remain open/deferred.'));
  return findings;
}

export function formatSidecarEvidenceHarnessPacketText(report: SidecarEvidenceHarnessPacket = buildSidecarEvidenceHarnessPacket()): string {
  const lines = [
    'Phase 100 Sidecar Evidence Harness Packet',
    `code: ${report.code}`,
    `report: ${report.report}`,
    `redactionSafe: ${report.redactionSafe ? 'true' : 'false'}`,
    `manifestValuesEchoed: ${report.manifestValuesEchoed ? 'true' : 'false'}`,
    `reviewReadiness: ${report.reviewReadiness}`,
    `closesO4: ${report.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${report.closesO5 ? 'true' : 'false'}`,
    `O4 status: ${report.o4Status}`,
    `O5 status: ${report.o5Status}`,
    `FileCustodian: ${report.fileCustodianStatus}`,
    `Summary: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    'Required labels:',
  ];
  for (const field of report.requiredLabels) lines.push(`- ${field}`);
  lines.push('', 'Required true fields:');
  for (const field of report.requiredTrueFields) lines.push(`- ${field}`);
  lines.push('', 'Findings:');
  for (const finding of report.findings) lines.push(`- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`);
  lines.push('', 'Blocked evidence:');
  for (const blocked of report.blockedEvidence) lines.push(`- ${blocked}`);
  return `${lines.join('\n')}\n`;
}

function summarize(findings: readonly SidecarEvidenceFinding[]): SidecarEvidenceSummary {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function hasLabel(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function toCode(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => `_${ch}`).toUpperCase();
}

function pass(code: string, field: SidecarEvidenceFinding['field'], message: string): SidecarEvidenceFinding {
  return { level: 'pass', code, field, message };
}

function warn(code: string, field: SidecarEvidenceFinding['field'], message: string): SidecarEvidenceFinding {
  return { level: 'warn', code, field, message };
}

function fail(code: string, field: SidecarEvidenceFinding['field'], message: string): SidecarEvidenceFinding {
  return { level: 'fail', code, field, message };
}
