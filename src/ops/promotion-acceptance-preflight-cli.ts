import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildAcceptancePreflight, type AcceptancePreflightInput, type PreflightContext } from './promotion-acceptance-preflight.js';

// Offline acceptance preflight CLI. Deterministic ready/not-ready report for coordinator review: which
// machine gates passed, which human gates remain. Approves nothing, merges nothing, live-promotes nothing.
// Reads the context from a file -- invokes no git. Never touches the real Movies root or Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-acceptance-preflight --reviewerpack <f> --context <f> [--out <preflight.json>]',
    '',
    'The context file is { branch, base, head, commits:[{sha,subject}], requiredTests:[...] }.',
    'Local, non-live: PREFLIGHT_READY only when the reviewer pack is READY + digest-bound and the context is',
    'well-formed. approvalsGranted is always empty; it does not approve/merge/live-promote and does not',
    'authorize Phase 231. Exit 0 = READY, 1 = NOT_READY.',
  ].join('\n');
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
  const input: AcceptancePreflightInput = {};
  try {
    const rp = valueAfter(args, '--reviewerpack');
    if (rp !== undefined) (input as { reviewerPack?: unknown }).reviewerPack = readJson(rp, 'reviewerPack');
    const ctx = valueAfter(args, '--context');
    if (ctx !== undefined) (input as { context?: PreflightContext }).context = readJson(ctx, 'context') as PreflightContext;
  } catch (err) { console.error((err as Error).message); return 2; }
  const preflight = buildAcceptancePreflight(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(preflight, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-acceptance-preflight-capture',
    overall: preflight.overall,
    authorization: preflight.authorization,
    redactionSafe: true,
    approvalsGranted: preflight.approvalsGranted,
    base: preflight.base,
    head: preflight.head,
    commitCount: preflight.commitCount,
    machineGates: preflight.machineGates,
    humanGatesRemaining: preflight.humanGatesRemaining,
    blockers: preflight.blockers,
    preflightDigest: preflight.preflightDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return preflight.overall === 'PREFLIGHT_READY' ? 0 : 1;
}

process.exit(main());
