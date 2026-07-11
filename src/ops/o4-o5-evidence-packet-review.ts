import { readFileSync } from 'node:fs';

export const O4_O5_EVIDENCE_PACKET_REVIEW_REPORT = 'phase-172-o4-o5-evidence-packet-review';

export interface O4O5EvidencePacketReviewInput {
  readonly files: readonly string[];
}

export interface O4O5EvidencePacketReviewCheck {
  readonly name: 'json' | 'schema' | 'open-gates' | 'forbidden-boundary' | 'redaction';
  readonly state: 'pass' | 'fail';
  readonly detail: string;
}

export interface O4O5EvidencePacketReviewFileResult {
  readonly file: string;
  readonly state: 'pass' | 'fail';
  readonly checks: readonly O4O5EvidencePacketReviewCheck[];
}

export interface O4O5EvidencePacketReviewReport {
  readonly report: typeof O4_O5_EVIDENCE_PACKET_REVIEW_REPORT;
  readonly ok: boolean;
  readonly reviewed: number;
  readonly passed: number;
  readonly failed: number;
  readonly files: readonly O4O5EvidencePacketReviewFileResult[];
}

const REQUIRED_FORBIDDEN = [
  'no provider contact',
  'no scraping',
  'no downloading',
  'no playback',
] as const;

const REQUIRED_OPEN_GATES = [
  'O4 remains open',
  'O5 remains open',
] as const;

const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /postgres(?:ql)?:\/\//i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bssh-(?:ed25519|rsa)\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/,
  /\b(?:token|password|secret|kek|dek|privateKey|apiKey)\s*[:=]\s*\S+/i,
];

const BOUNDARY_VIOLATIONS: readonly RegExp[] = [
  new RegExp(`request-${'download'}-link`, 'i'),
  new RegExp(`${'magnet'}:`, 'i'),
  /provider mode enabled/i,
  /O4 closed/i,
  /O5 closed/i,
  /playback enabled/i,
  /download(?:ing)? enabled/i,
];

export function reviewO4O5EvidencePackets(input: O4O5EvidencePacketReviewInput): O4O5EvidencePacketReviewReport {
  if (input.files.length === 0) throw new Error('At least one O4/O5 evidence packet file is required.');
  const files = input.files.map((file) => reviewFile(file));
  const passed = files.filter((file) => file.state === 'pass').length;
  const failed = files.length - passed;
  return {
    report: O4_O5_EVIDENCE_PACKET_REVIEW_REPORT,
    ok: failed === 0,
    reviewed: files.length,
    passed,
    failed,
    files,
  };
}

function reviewFile(file: string): O4O5EvidencePacketReviewFileResult {
  const checks: O4O5EvidencePacketReviewCheck[] = [];
  let parsed: unknown;
  let raw = '';

  try {
    raw = readFileSync(file, 'utf8');
    parsed = JSON.parse(raw) as unknown;
    checks.push({ name: 'json', state: 'pass', detail: 'valid JSON' });
  } catch {
    checks.push({ name: 'json', state: 'fail', detail: 'file is missing, unreadable, or invalid JSON' });
  }

  checks.push(isSchemaComplete(parsed)
    ? { name: 'schema', state: 'pass', detail: 'required Phase 166 packet fields present' }
    : { name: 'schema', state: 'fail', detail: 'missing required Phase 166 packet fields' });

  checks.push(hasOpenGates(parsed)
    ? { name: 'open-gates', state: 'pass', detail: 'packet keeps O4 and O5 open' }
    : { name: 'open-gates', state: 'fail', detail: 'packet does not clearly keep O4 and O5 open' });

  checks.push(hasForbiddenBoundary(parsed, raw)
    ? { name: 'forbidden-boundary', state: 'pass', detail: 'packet preserves provider/media forbidden boundary' }
    : { name: 'forbidden-boundary', state: 'fail', detail: 'packet contains or omits forbidden-boundary terms' });

  checks.push(isRedactionSafe(parsed)
    ? { name: 'redaction', state: 'pass', detail: 'packet values match redaction-safe label rules' }
    : { name: 'redaction', state: 'fail', detail: 'packet contains secret-looking or raw evidence values' });

  return {
    file,
    state: checks.every((check) => check.state === 'pass') ? 'pass' : 'fail',
    checks,
  };
}

function isSchemaComplete(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.packetReport !== 'phase-166-o4-o5-evidence-packet') return false;
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) return false;
  if (value.scope !== 'redaction-safe-o4-o5-evidence-index') return false;
  if (!isRecord(value.o4) || !isRecord(value.o5) || !isRecord(value.decision)) return false;
  if (!isLabel(value.o4.descriptorPreflightLabel) || value.o4.custodianBoundary !== 'external-local-sidecar-custodian') return false;
  if (!isReviewStatus(value.o4.reviewStatus)) return false;
  if (!isLabel(value.o5.descriptorPreflightLabel) || !isLabel(value.o5.rewrapPlanLabel)) return false;
  if (!isReviewStatus(value.o5.reviewStatus)) return false;
  if (!isLabel(value.decision.decisionPacketLabel) || value.decision.closureRequested !== false) return false;
  return Array.isArray(value.forbidden) && Array.isArray(value.openGates);
}

function hasOpenGates(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.openGates)) return false;
  const openGates = value.openGates;
  return REQUIRED_OPEN_GATES.every((gate) => openGates.includes(gate))
    && isRecord(value.decision)
    && value.decision.closureRequested === false;
}

function hasForbiddenBoundary(value: unknown, raw: string): boolean {
  if (BOUNDARY_VIOLATIONS.some((pattern) => pattern.test(raw))) return false;
  if (!isRecord(value) || !Array.isArray(value.forbidden)) return false;
  const forbidden = value.forbidden;
  return REQUIRED_FORBIDDEN.every((entry) => forbidden.includes(entry));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLabel(value: unknown): boolean {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && /^[a-z0-9._-]+$/i.test(value);
}

function isReviewStatus(value: unknown): boolean {
  return value === 'pending' || value === 'ready-for-review' || value === 'accepted' || value === 'rejected';
}
