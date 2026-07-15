import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildApprovalAttestation,
  validateApprovalAttestation,
  type ApprovalWorkflowInput,
  type ApprovalEvidence,
} from './promotion-approval.js';

// Offline approval-attestation workflow CLI. Two subcommands:
//   build    — produce the approval JSON + redaction-safe evidence for a test-library item
//   validate — check an existing approval JSON binds to the given run + emit evidence
// It never runs a promotion, never touches the real Movies root, never calls Jellyfin.

function usage(): string {
  return [
    'usage:',
    '  ops:promotion-approval build --approval-out <approval.json> --evidence-out <evidence.json> \\',
    '      --item-id <uuid> --title <title> --source-file <path> [--year <year>] \\',
    '      [--test-library-root <path>] [--target-root <path>] [--approval-id <id>]',
    '',
    '  ops:promotion-approval validate --approval-file <approval.json> --evidence-out <evidence.json> \\',
    '      --item-id <uuid> --title <title> --source-file <path> [--year <year>] \\',
    '      [--test-library-root <path>] [--target-root <path>]',
    '',
    'Local, non-live only: reads the test-library source to hash it and computes a destination path string.',
    'It does not promote, does not write to /mnt/user/media/Movies, and does not contact Jellyfin.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function writeSecret(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 });
}

function commonInput(args: readonly string[]): { input: ApprovalWorkflowInput; error?: string } {
  const itemId = valueAfter(args, '--item-id');
  const title = valueAfter(args, '--title');
  const sourceFile = valueAfter(args, '--source-file');
  const yearRaw = valueAfter(args, '--year');
  const testLibraryRoot = valueAfter(args, '--test-library-root');
  const targetRoot = valueAfter(args, '--target-root');
  const approvalId = valueAfter(args, '--approval-id');
  if (!itemId || !title || !sourceFile) return { input: { itemId: '', title: '', sourceFile: '' }, error: 'missing required --item-id, --title, or --source-file' };
  let year: number | undefined;
  if (yearRaw !== undefined) {
    year = Number(yearRaw);
    if (!Number.isInteger(year) || year < 0) return { input: { itemId, title, sourceFile }, error: 'invalid --year: expected a non-negative integer' };
  }
  return {
    input: {
      itemId,
      title,
      sourceFile,
      ...(year !== undefined ? { year } : {}),
      ...(testLibraryRoot !== undefined ? { testLibraryRoot } : {}),
      ...(targetRoot !== undefined ? { targetRoot } : {}),
      ...(approvalId !== undefined ? { approvalId } : {}),
    },
  };
}

function emitCapture(mode: 'build' | 'validate', evidence: ApprovalEvidence, evidenceOut: string, approvalOut?: string): void {
  console.log(JSON.stringify({
    report: 'phase-230-promotion-approval-capture',
    mode,
    ok: evidence.ok,
    status: evidence.status,
    redactionSafe: true,
    problems: evidence.problems,
    evidenceDigest: evidence.evidenceDigest,
    evidenceFile: evidenceOut,
    ...(approvalOut ? { approvalFile: approvalOut } : {}),
  }, null, 2));
}

function main(): number {
  const args = process.argv.slice(2);
  const sub = args[0];

  if (sub === 'build') {
    const approvalOut = valueAfter(args, '--approval-out');
    const evidenceOut = valueAfter(args, '--evidence-out');
    const { input, error } = commonInput(args);
    if (error || !approvalOut || !evidenceOut) {
      console.error(error ?? 'missing --approval-out or --evidence-out');
      console.error(usage());
      return 2;
    }
    const result = buildApprovalAttestation(input);
    writeSecret(evidenceOut, `${JSON.stringify(result.evidence, null, 2)}\n`);
    if (result.ok && result.approval) writeSecret(approvalOut, `${JSON.stringify(result.approval, null, 2)}\n`);
    emitCapture('build', result.evidence, evidenceOut, result.ok ? approvalOut : undefined);
    return result.ok ? 0 : 1;
  }

  if (sub === 'validate') {
    const approvalFile = valueAfter(args, '--approval-file');
    const evidenceOut = valueAfter(args, '--evidence-out');
    const { input, error } = commonInput(args);
    if (error || !approvalFile || !evidenceOut) {
      console.error(error ?? 'missing --approval-file or --evidence-out');
      console.error(usage());
      return 2;
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(readFileSync(approvalFile, 'utf8'));
    } catch {
      console.error('approval file is missing or not valid JSON');
      return 2;
    }
    const result = validateApprovalAttestation(candidate, input);
    writeSecret(evidenceOut, `${JSON.stringify(result.evidence, null, 2)}\n`);
    emitCapture('validate', result.evidence, evidenceOut);
    return result.ok ? 0 : 1;
  }

  console.error(usage());
  return 2;
}

process.exit(main());
