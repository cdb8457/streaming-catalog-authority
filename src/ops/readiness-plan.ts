export type ReadinessStatus = 'met' | 'operator-provided' | 'deferred' | 'blocked';

export interface ReadinessPlanRow {
  readonly number: number;
  readonly criterion: string;
  readonly status: ReadinessStatus;
  readonly artifactLabel: string;
  readonly commandShapes: readonly string[];
  readonly operatorAction: string;
  readonly warning?: string;
}

export interface ReadinessPlan {
  readonly report: 'phase-25-readiness-rehearsal-plan';
  readonly version: 1;
  readonly purpose: string;
  readonly statuses: readonly ReadinessStatus[];
  readonly rows: readonly ReadinessPlanRow[];
  readonly warnings: readonly string[];
  readonly redactionReminders: readonly string[];
  readonly nonRequirements: readonly string[];
}

export const READINESS_PLAN: ReadinessPlan = {
  report: 'phase-25-readiness-rehearsal-plan',
  version: 1,
  purpose:
    'Static rehearsal skeleton for checking the Phase 22/23 evidence package shape before a real readiness review.',
  statuses: ['met', 'operator-provided', 'deferred', 'blocked'],
  rows: [
    {
      number: 1,
      criterion: 'Deployment / Unraid config',
      status: 'met',
      artifactLabel: '01-deployment-unraid.redacted.md',
      commandShapes: [
        'npm run test:deploy',
        'review docker-compose.deploy.yml and deploy/unraid-catalog-authority.xml',
      ],
      operatorAction: 'Summarize one-shot CLI topology, separate keystore volume, *_FILE secret wiring, and no ports.',
    },
    {
      number: 2,
      criterion: 'External custodian / KMS (O4)',
      status: 'deferred',
      artifactLabel: '02-external-custodian-o4.redacted.md',
      commandShapes: [
        'npm run test:custodian-acceptance',
        'operator-run live adapter validation per Phase 16/21 when a real adapter exists',
      ],
      operatorAction: 'Record only redaction-safe acceptance status and reviewer conclusion.',
      warning: 'O4 remains open/deferred unless separate real external-custodian evidence proves or accepts it.',
    },
    {
      number: 3,
      criterion: 'KEK rotation (O5)',
      status: 'deferred',
      artifactLabel: '03-kek-rotation-o5.redacted.md',
      commandShapes: ['npm run ops:rewrap-kek -- --plan --json'],
      operatorAction: 'Record non-mutating preflight counts and any separate manual rotation record.',
      warning: 'O5 remains open/deferred unless managed KEK custody plus rotation scheduling evidence proves or accepts it.',
    },
    {
      number: 4,
      criterion: 'Backup/restore + retention',
      status: 'operator-provided',
      artifactLabel: '04-backup-restore-retention.redacted.md',
      commandShapes: [
        'npm run ops:backup -- dump <backup-artifact-label>',
        'npm run ops:verify-backup -- <backup-artifact-label>',
        'npm run ops:rehearse-restore -- <backup-artifact-label> using a throwaway rehearsal database',
      ],
      operatorAction: 'Summarize verification, restore rehearsal result, and retention on independent media.',
    },
    {
      number: 5,
      criterion: 'ops:doctor / warning gates',
      status: 'met',
      artifactLabel: '05-doctor-warning-gates.redacted.json',
      commandShapes: ['npm run ops:doctor -- --json'],
      operatorAction: 'Record PASS/WARN/FAIL counts and explicitly preserve the O4/O5 WARN interpretation.',
    },
    {
      number: 6,
      criterion: 'Scheduled operator tasks',
      status: 'operator-provided',
      artifactLabel: '06-scheduled-operator-tasks.redacted.md',
      commandShapes: ['operator-owned Unraid User Scripts or cron based on Phase 20'],
      operatorAction: 'Record cadence, alert routing, and recent redaction-safe execution status.',
    },
    {
      number: 7,
      criterion: 'Jellyfin validation evidence',
      status: 'operator-provided',
      artifactLabel: '07-jellyfin-validation.redacted.md',
      commandShapes: [
        'npm run smoke:jellyfin -- <kind> <opaque-id>',
        'npm run smoke:jellyfin -- --write <kind> <opaque-id> only for intentional live round trips',
      ],
      operatorAction: 'Complete the Jellyfin evidence template with counts and cleanup status only.',
      warning: 'Mapping remains provisional until operator live evidence exists; smoke commands are never CI requirements.',
    },
    {
      number: 8,
      criterion: 'CI / test expectations',
      status: 'met',
      artifactLabel: '08-ci-test-expectations.redacted.md',
      commandShapes: ['npm run ci', 'npm run typecheck', 'npm run test:deploy'],
      operatorAction: 'Record deterministic local check outcomes; do not promote opt-in smoke checks into CI.',
    },
    {
      number: 9,
      criterion: 'Privacy / redaction',
      status: 'met',
      artifactLabel: '09-privacy-redaction.redacted.md',
      commandShapes: ['review completed evidence sheets against Phase 23 redaction rules'],
      operatorAction: 'Confirm the bundle contains only statuses, counts, dates, labels, and reviewed summaries.',
    },
  ],
  warnings: [
    'O4 remains open/deferred unless separate real external-custodian evidence proves or accepts it.',
    'O5 remains open/deferred unless managed KEK custody plus rotation scheduling evidence proves or accepts it.',
    'FileCustodian is a hardened reference harness, not production KMS.',
  ],
  redactionReminders: [
    'Do not include secret values, KEKs, DEKs, wrapping keys, completion secrets, HMAC secrets, API keys, tokens, credentials, or private keys.',
    'Do not include DB URLs, secret paths, full env dumps, raw logs, backup artifact contents, ciphertext payloads, or screenshots with identity.',
    'Do not include raw identity, provider refs, media titles, Jellyfin ids, collection handles, or Jellyfin tokens.',
  ],
  nonRequirements: [
    'This command is static and local only.',
    'It does not connect to a database, scan evidence files, read backup artifacts, call a network service, run Docker, contact Jellyfin, or contact a custodian/cloud/KMS.',
    'It does not create, modify, or validate real operator evidence.',
  ],
};

export function formatReadinessPlanText(plan: ReadinessPlan = READINESS_PLAN): string {
  const lines: string[] = [];
  lines.push('Phase 25 readiness rehearsal plan');
  lines.push('');
  lines.push(plan.purpose);
  lines.push('');
  lines.push(`Status categories: ${plan.statuses.join(', ')}`);
  lines.push('');
  lines.push('Rows:');
  for (const row of plan.rows) {
    lines.push(`${row.number}. ${row.criterion}`);
    lines.push(`   status: ${row.status}`);
    lines.push(`   artifact: ${row.artifactLabel}`);
    lines.push(`   command shapes: ${row.commandShapes.join('; ')}`);
    lines.push(`   rehearsal note: ${row.operatorAction}`);
    if (row.warning) lines.push(`   warning: ${row.warning}`);
  }
  lines.push('');
  lines.push('Warnings:');
  for (const warning of plan.warnings) lines.push(`- ${warning}`);
  lines.push('');
  lines.push('Redaction reminders:');
  for (const reminder of plan.redactionReminders) lines.push(`- ${reminder}`);
  lines.push('');
  lines.push('Non-requirements:');
  for (const nonRequirement of plan.nonRequirements) lines.push(`- ${nonRequirement}`);
  return `${lines.join('\n')}\n`;
}

export function formatReadinessPlanJson(plan: ReadinessPlan = READINESS_PLAN): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}
