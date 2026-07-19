import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildClosureSummaryV3, type ClosureSummaryV3Input } from './promotion-closure-summary-v3.js';

// Offline closure summary v3 CLI. Summarizes the local-only Phase 230 closure state from authoritative
// bounded inputs (review-authorization + coordinator-readiness) plus a locally observed-state record, with
// exact commit/test visibility, and fails closed on missing observed state / unbound context / unverified
// digest / any live-boundary escape. status stays PENDING and authorization NONE; it does not authorize
// Phase 231 or any live action. Never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-closure-summary-v3 --reviewauthorization <f> --coordinatorreadiness <f> \\',
    '         --observedstate <f> --anchors <bundle.json> [--out <summary.json>]',
    '',
    'anchors is a JSON array of the actual underlying reports RA/CR claim to bind. Local, non-live:',
    'CLOSURE_SUMMARY_READY only when both bounded contexts recompute, are authoritative in shape, and every',
    'claimed binding EXACTLY equals a recomputed anchor digest; an observed-state record bound to the reviewed',
    'head is present; every component digest verifies; and no live-boundary escape is found. authorization',
    'stays NONE / status PENDING; it does NOT authorize Phase 231. Exit 0 = READY, 1 = BLOCKED.',
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
  const input: ClosureSummaryV3Input = {};
  const map: Array<[keyof ClosureSummaryV3Input, string]> = [
    ['reviewAuthorization', '--reviewauthorization'], ['coordinatorReadiness', '--coordinatorreadiness'], ['observedState', '--observedstate'], ['anchorReports', '--anchors'],
  ];
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const summary = buildClosureSummaryV3(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-closure-summary-v3-capture',
    overall: summary.overall,
    authorization: summary.authorization,
    status: summary.status,
    redactionSafe: true,
    observedStatePresent: summary.observedStatePresent,
    commitVisibility: summary.commitVisibility,
    testVisibility: summary.testVisibility,
    failureEvidence: summary.failureEvidence,
    blockers: summary.blockers,
    summaryV3Digest: summary.summaryV3Digest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return summary.overall === 'CLOSURE_SUMMARY_READY' ? 0 : 1;
}

process.exit(main());
