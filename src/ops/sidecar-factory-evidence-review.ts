import { readFileSync } from 'node:fs';

export const SIDECAR_FACTORY_EVIDENCE_REVIEW_REPORT = 'phase-190-sidecar-factory-evidence-review';

export interface SidecarFactoryEvidenceReviewInput {
  readonly files: readonly string[];
}

export interface SidecarFactoryEvidenceReviewCheck {
  readonly name: 'json' | 'schema' | 'pass-state' | 'boundary' | 'redaction';
  readonly state: 'pass' | 'fail';
  readonly detail: string;
}

export interface SidecarFactoryEvidenceReviewFileResult {
  readonly file: string;
  readonly state: 'pass' | 'fail';
  readonly checks: readonly SidecarFactoryEvidenceReviewCheck[];
}

export interface SidecarFactoryEvidenceReviewReport {
  readonly report: typeof SIDECAR_FACTORY_EVIDENCE_REVIEW_REPORT;
  readonly ok: boolean;
  readonly reviewed: number;
  readonly passed: number;
  readonly failed: number;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly files: readonly SidecarFactoryEvidenceReviewFileResult[];
}

const REQUIRED_PASS_CHECKS = [
  'daemon-wrapper-started',
  'factory-parsed-sidecar-mode',
  'app-held-secret-rejected-for-sidecar',
  'factory-sidecar-round-trip',
  'destroyed-fails-closed',
  'redaction-safe-evidence',
] as const;

const REQUIRED_TRUE_FLAGS = [
  'ok',
  'redactionSafe',
  'daemonWrapperExercised',
  'custodianFactorySidecarModeExercised',
  'localSocketOnly',
] as const;

const REQUIRED_FALSE_FLAGS = [
  'appHeldCompletionSecretRequired',
  'appHeldKekRequired',
  'serviceInstallAllowed',
  'composeChangeAllowed',
  'runtimeCutoverAllowed',
  'providerContactAllowed',
  'playbackAllowed',
  'mediaServerMutationAllowed',
  'closesO4',
  'closesO5',
] as const;

const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /postgres(?:ql)?:\/\//i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bssh-(?:ed25519|rsa)\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/,
  /\b(?:token|password|secret|kek|dek|privateKey|apiKey)\s*[:=]\s*\S+/i,
  /phase-189-sidecar-factory-secret/i,
  /wrappedHex|dekBase64|privateKey/i,
];

const BOUNDARY_VIOLATIONS: readonly RegExp[] = [
  new RegExp(`${'magnet'}:`, 'i'),
  new RegExp(`request-${'download'}-link`, 'i'),
  new RegExp(`provider ${'mode'} enabled`, 'i'),
  /playback enabled/i,
  /download(?:ing)? enabled/i,
  /media-server mutation enabled/i,
  /runtime cutover enabled/i,
  /compose change allowed/i,
  /service install allowed/i,
  new RegExp(`O4 ${'closed'}`, 'i'),
  new RegExp(`O5 ${'closed'}`, 'i'),
];

export function reviewSidecarFactoryEvidence(input: SidecarFactoryEvidenceReviewInput): SidecarFactoryEvidenceReviewReport {
  if (input.files.length === 0) throw new Error('At least one Phase 189 sidecar factory evidence JSON file is required.');
  const files = input.files.map((file) => reviewFile(file));
  const passed = files.filter((file) => file.state === 'pass').length;
  const failed = files.length - passed;
  return {
    report: SIDECAR_FACTORY_EVIDENCE_REVIEW_REPORT,
    ok: failed === 0,
    reviewed: files.length,
    passed,
    failed,
    closesO4: false,
    closesO5: false,
    files,
  };
}

export function formatSidecarFactoryEvidenceReviewText(report: SidecarFactoryEvidenceReviewReport): string {
  const lines = [
    `report=${report.report}`,
    `ok=${report.ok}`,
    `reviewed=${report.reviewed} passed=${report.passed} failed=${report.failed}`,
    `closesO4=${report.closesO4}`,
    `closesO5=${report.closesO5}`,
  ];
  for (const file of report.files) {
    lines.push(`${file.state.toUpperCase()} ${file.file}`);
    for (const check of file.checks) lines.push(`  ${check.state.toUpperCase()} ${check.name}: ${check.detail}`);
  }
  return `${lines.join('\n')}\n`;
}

function reviewFile(file: string): SidecarFactoryEvidenceReviewFileResult {
  const checks: SidecarFactoryEvidenceReviewCheck[] = [];
  let parsed: unknown;
  let raw = '';

  try {
    raw = readFileSync(file, 'utf8');
    parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown;
    checks.push({ name: 'json', state: 'pass', detail: 'valid JSON' });
  } catch {
    checks.push({ name: 'json', state: 'fail', detail: 'file is missing, unreadable, or invalid JSON' });
  }

  checks.push(isSchemaComplete(parsed)
    ? { name: 'schema', state: 'pass', detail: 'required Phase 189 evidence fields present' }
    : { name: 'schema', state: 'fail', detail: 'missing or incorrect Phase 189 evidence fields' });

  checks.push(hasPassingEvidence(parsed)
    ? { name: 'pass-state', state: 'pass', detail: 'overall evidence and every required check passed' }
    : { name: 'pass-state', state: 'fail', detail: 'overall evidence or a required check failed' });

  checks.push(hasSafeBoundary(parsed, raw)
    ? { name: 'boundary', state: 'pass', detail: 'review keeps sidecar evidence local and non-mutating' }
    : { name: 'boundary', state: 'fail', detail: 'evidence requests or implies forbidden runtime/provider/media behavior' });

  checks.push(isRedactionSafe(parsed)
    ? { name: 'redaction', state: 'pass', detail: 'evidence contains redaction-safe labels only' }
    : { name: 'redaction', state: 'fail', detail: 'evidence contains secret-looking or raw operational values' });

  return {
    file,
    state: checks.every((check) => check.state === 'pass') ? 'pass' : 'fail',
    checks,
  };
}

function isSchemaComplete(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.report !== 'phase-189-sidecar-factory-evidence') return false;
  if (value.code !== 'SIDECAR_FACTORY_EVIDENCE') return false;
  if (value.version !== 1) return false;
  if (value.purpose !== 'exercise-sidecar-daemon-through-custodian-factory-without-runtime-cutover') return false;
  if (value.o4Status !== 'open/deferred' || value.o5Status !== 'open/deferred') return false;
  if (!Array.isArray(value.checks)) return false;
  return REQUIRED_TRUE_FLAGS.every((field) => value[field] === true)
    && REQUIRED_FALSE_FLAGS.every((field) => value[field] === false);
}

function hasPassingEvidence(value: unknown): boolean {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.checks)) return false;
  const checks = value.checks.filter(isEvidenceCheck);
  if (checks.length !== value.checks.length) return false;
  return REQUIRED_PASS_CHECKS.every((id) => checks.some((check) => check.id === id && check.status === 'pass'));
}

function hasSafeBoundary(value: unknown, raw: string): boolean {
  if (BOUNDARY_VIOLATIONS.some((pattern) => pattern.test(raw))) return false;
  if (!isRecord(value)) return false;
  return value.serviceInstallAllowed === false
    && value.composeChangeAllowed === false
    && value.runtimeCutoverAllowed === false
    && value.providerContactAllowed === false
    && value.playbackAllowed === false
    && value.mediaServerMutationAllowed === false
    && value.closesO4 === false
    && value.closesO5 === false;
}

function isRedactionSafe(value: unknown): boolean {
  const strings: string[] = [];
  collectStrings(value, strings);
  return strings.every((entry) => {
    if (entry.length > 256) return false;
    if (/https?:\/\//i.test(entry)) return false;
    if (/[A-Z]:\\|\/mnt\/user\/|\/boot\/config\//.test(entry)) return false;
    return !SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(entry));
  });
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

function isEvidenceCheck(value: unknown): value is { readonly id: string; readonly status: string; readonly label: string } {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
    && (value.status === 'pass' || value.status === 'fail');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
