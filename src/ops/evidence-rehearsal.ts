export type EvidenceGate = 'met' | 'operator-provided' | 'deferred' | 'blocked';
export type RetentionExpectation = 'retained-by-operator' | 'not-retained-in-shareable-bundle';

export interface EvidenceRehearsalItem {
  readonly phase22Row: number;
  readonly criterion: string;
  readonly gate: EvidenceGate;
  readonly phase23ArtifactLabel: string;
  readonly expectedEvidenceShape: readonly string[];
  readonly retainedInShareableBundle: RetentionExpectation;
  readonly operatorPrompt: string;
  readonly neverInclude: readonly string[];
  readonly warning?: string;
}

export interface EvidenceRehearsal {
  readonly report: 'phase-26-operator-evidence-rehearsal-check';
  readonly version: 1;
  readonly advisoryOnly: true;
  readonly purpose: string;
  readonly evidenceRootShape: readonly string[];
  readonly items: readonly EvidenceRehearsalItem[];
  readonly deferredGates: readonly string[];
  readonly redactionBoundary: readonly string[];
  readonly staticOnlyBoundary: readonly string[];
}

export const EVIDENCE_REHEARSAL: EvidenceRehearsal = {
  report: 'phase-26-operator-evidence-rehearsal-check',
  version: 1,
  advisoryOnly: true,
  purpose:
    'Static checklist for rehearsing the expected Phase 22/23 production-readiness evidence package shape without reading real evidence or secrets.',
  evidenceRootShape: [
    '<operator-evidence-root>/phase-22-readiness/YYYY-MM-DD/README.redacted.md',
    '<operator-evidence-root>/phase-22-readiness/YYYY-MM-DD/production-readiness-evidence.redacted.md',
  ],
  items: [
    {
      phase22Row: 1,
      criterion: 'Deployment / Unraid config',
      gate: 'met',
      phase23ArtifactLabel: '01-deployment-unraid.redacted.md',
      expectedEvidenceShape: [
        'one-shot CLI topology summary',
        'separate keystore volume confirmation',
        '*_FILE secret wiring confirmation',
        'no published ports confirmation',
      ],
      retainedInShareableBundle: 'retained-by-operator',
      operatorPrompt: 'Confirm only topology status and reviewed file labels; do not capture local paths or overrides.',
      neverInclude: ['secret values', 'database URLs', 'secret file paths', 'private mount names'],
    },
    {
      phase22Row: 2,
      criterion: 'External custodian / KMS (O4)',
      gate: 'deferred',
      phase23ArtifactLabel: '02-external-custodian-o4.redacted.md',
      expectedEvidenceShape: [
        'deterministic acceptance harness status',
        'real adapter validation conclusion only when separately operator-provided',
        'reviewer conclusion',
      ],
      retainedInShareableBundle: 'retained-by-operator',
      operatorPrompt: 'Record redaction-safe status only; leave live raw adapter output outside the shareable bundle.',
      neverInclude: ['KMS credentials', 'API keys', 'tokens', 'request bodies', 'response bodies', 'raw key ids'],
      warning: 'O4 remains open/deferred unless separate real external-custodian evidence proves or accepts it.',
    },
    {
      phase22Row: 3,
      criterion: 'KEK rotation (O5)',
      gate: 'deferred',
      phase23ArtifactLabel: '03-kek-rotation-o5.redacted.md',
      expectedEvidenceShape: [
        'non-mutating rewrap plan counts',
        'rotation record label if a manual rotation occurred',
        'managed custody or residual-risk conclusion',
      ],
      retainedInShareableBundle: 'retained-by-operator',
      operatorPrompt: 'Record counts and conclusion labels only; do not retain mutation logs or key material.',
      neverInclude: ['KEK values', 'wrapping keys', 'age identities', 'private keys', 'secret file paths'],
      warning: 'O5 remains open/deferred unless managed KEK custody plus rotation scheduling evidence proves or accepts it.',
    },
    {
      phase22Row: 4,
      criterion: 'Backup/restore + retention',
      gate: 'operator-provided',
      phase23ArtifactLabel: '04-backup-restore-retention.redacted.md',
      expectedEvidenceShape: [
        'backup verification status',
        'throwaway restore rehearsal status',
        'retention location class',
        'independent media confirmation',
      ],
      retainedInShareableBundle: 'retained-by-operator',
      operatorPrompt: 'Summarize verification and retention decisions; keep backup artifacts out of the evidence bundle.',
      neverInclude: ['backup artifact contents', 'ciphertext payloads', 'row dumps', 'database URLs', 'keystore material'],
    },
    {
      phase22Row: 5,
      criterion: 'ops:doctor / warning gates',
      gate: 'met',
      phase23ArtifactLabel: '05-doctor-warning-gates.redacted.json',
      expectedEvidenceShape: ['PASS count', 'WARN count', 'FAIL count', 'O4/O5 WARN interpretation'],
      retainedInShareableBundle: 'retained-by-operator',
      operatorPrompt: 'Record counts and reviewed warning labels only; preserve O4/O5 as warnings, not closures.',
      neverInclude: ['full environments', 'secret paths', 'database URLs', 'raw logs'],
    },
    {
      phase22Row: 6,
      criterion: 'Scheduled operator tasks',
      gate: 'operator-provided',
      phase23ArtifactLabel: '06-scheduled-operator-tasks.redacted.md',
      expectedEvidenceShape: ['cadence summary', 'alert route class', 'recent execution status'],
      retainedInShareableBundle: 'retained-by-operator',
      operatorPrompt: 'Confirm schedule ownership and alerting without storing token-bearing wrapper output.',
      neverInclude: ['notification tokens', 'webhook URLs', 'local secret paths', 'full shell history'],
    },
    {
      phase22Row: 7,
      criterion: 'Jellyfin validation evidence',
      gate: 'operator-provided',
      phase23ArtifactLabel: '07-jellyfin-validation.redacted.md',
      expectedEvidenceShape: [
        'read-only smoke status',
        'write-smoke status only if intentionally run',
        'cleanup status',
        'mapping remains provisional unless live evidence exists',
      ],
      retainedInShareableBundle: 'retained-by-operator',
      operatorPrompt: 'Use counts and cleanup status only; do not retain live identities or screenshots.',
      neverInclude: ['Jellyfin tokens', 'Jellyfin ids', 'collection handles', 'media titles', 'server URLs', 'provider refs'],
    },
    {
      phase22Row: 8,
      criterion: 'CI / test expectations',
      gate: 'met',
      phase23ArtifactLabel: '08-ci-test-expectations.redacted.md',
      expectedEvidenceShape: ['typecheck result', 'deterministic test result', 'deploy static test result'],
      retainedInShareableBundle: 'retained-by-operator',
      operatorPrompt: 'Record deterministic local outcomes; do not promote opt-in smoke checks into CI.',
      neverInclude: ['network credentials', 'Docker daemon logs', 'live-service output', 'production database credentials'],
    },
    {
      phase22Row: 9,
      criterion: 'Privacy / redaction',
      gate: 'met',
      phase23ArtifactLabel: '09-privacy-redaction.redacted.md',
      expectedEvidenceShape: ['redaction review status', 'bundle contains only labels, counts, dates, statuses, and conclusions'],
      retainedInShareableBundle: 'retained-by-operator',
      operatorPrompt: 'Confirm every evidence sheet uses placeholders or labels instead of sensitive values.',
      neverInclude: [
        'secrets',
        'KEKs',
        'DEKs',
        'completion secrets',
        'HMAC secrets',
        'API keys',
        'tokens',
        'credentials',
        'raw identity',
        'provider refs',
        'media titles',
        'Jellyfin ids',
        'DB URLs',
        'secret paths',
        'artifact contents',
        'full env dumps',
      ],
    },
  ],
  deferredGates: [
    'O4 remains open/deferred unless separate real external-custodian evidence proves or accepts it.',
    'O5 remains open/deferred unless managed KEK custody plus rotation scheduling evidence proves or accepts it.',
    'FileCustodian is a hardened reference harness, not production KMS.',
  ],
  redactionBoundary: [
    'Use artifact labels, status categories, counts, dates, and reviewed conclusions.',
    'Use retained/not-retained placeholders; do not print real evidence values.',
    'Never include secrets, DB URLs, secret file paths, logs, backup contents, ciphertext, raw identity, provider refs, media titles, Jellyfin ids, tokens, or handles.',
  ],
  staticOnlyBoundary: [
    'Does not inspect the filesystem for evidence.',
    'Does not read environment values.',
    'Does not connect to a database.',
    'Does not call the network, Docker, Jellyfin, cloud services, live custodians, or KMS.',
    'Does not run age tooling or validate production readiness.',
  ],
};

export function formatEvidenceRehearsalText(report: EvidenceRehearsal = EVIDENCE_REHEARSAL): string {
  const lines: string[] = [];
  lines.push('Phase 26 operator evidence rehearsal check');
  lines.push('');
  lines.push(report.purpose);
  lines.push('');
  lines.push(`Advisory only: ${report.advisoryOnly ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('Expected package shape:');
  for (const entry of report.evidenceRootShape) lines.push(`- ${entry}`);
  lines.push('- <operator-evidence-root>/phase-22-readiness/YYYY-MM-DD/<01-09 redacted artifact labels>');
  lines.push('');
  lines.push('Checklist:');
  for (const item of report.items) {
    lines.push(`${item.phase22Row}. ${item.criterion}`);
    lines.push(`   gate: ${item.gate}`);
    lines.push(`   artifact: ${item.phase23ArtifactLabel}`);
    lines.push(`   shape: ${item.expectedEvidenceShape.join('; ')}`);
    lines.push(`   retention: ${item.retainedInShareableBundle}`);
    lines.push(`   operator prompt: ${item.operatorPrompt}`);
    lines.push(`   never include: ${item.neverInclude.join('; ')}`);
    if (item.warning) lines.push(`   warning: ${item.warning}`);
  }
  lines.push('');
  lines.push('Deferred gates:');
  for (const warning of report.deferredGates) lines.push(`- ${warning}`);
  lines.push('');
  lines.push('Redaction boundary:');
  for (const boundary of report.redactionBoundary) lines.push(`- ${boundary}`);
  lines.push('');
  lines.push('Static-only boundary:');
  for (const boundary of report.staticOnlyBoundary) lines.push(`- ${boundary}`);
  return `${lines.join('\n')}\n`;
}

export function formatEvidenceRehearsalJson(report: EvidenceRehearsal = EVIDENCE_REHEARSAL): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
