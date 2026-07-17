import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildTranscriptVerification, type TranscriptVerifierInput } from './promotion-transcript-verifier.js';

// Offline review-transcript verifier (v2) CLI. Binds a transcript to exact commands/exit codes/head and
// records the full-npm-test caveat. Never promotes, never touches the real Movies root, never contacts
// Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-transcript-verifier --transcript <f> --head <sha> --command <cmd> [--command <cmd> ...] [--out <verification.json>]',
    '',
    'Local, non-live: TRANSCRIPT_VERIFIED only when the reviewed commit equals head and every expected',
    'command ran with exit 0. It authorizes NOTHING live and does not authorize Phase 231.',
    'Exit 0 = VERIFIED, 1 = UNVERIFIED.',
  ].join('\n');
}

function collectValues(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1]!);
  return out;
}
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}
function readJson(path: string, label: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} file is missing or not valid JSON`); }
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const input: TranscriptVerifierInput = {};
  try {
    const tr = valueAfter(args, '--transcript');
    if (tr !== undefined) (input as { transcript?: unknown }).transcript = readJson(tr, 'transcript');
  } catch (err) { console.error((err as Error).message); return 2; }
  (input as { head?: unknown }).head = valueAfter(args, '--head');
  (input as { expectedCommands?: unknown }).expectedCommands = collectValues(args, '--command');
  const verification = buildTranscriptVerification(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(verification, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-transcript-verification-capture',
    overall: verification.overall,
    authorization: verification.authorization,
    redactionSafe: true,
    head: verification.head,
    commandResults: verification.commandResults,
    checks: verification.checks,
    blockers: verification.blockers,
    verificationDigest: verification.verificationDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return verification.overall === 'TRANSCRIPT_VERIFIED' ? 0 : 1;
}

process.exit(main());
