import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildNoLiveAuthorizationGuard, type NoLiveAuthorizationGuardInput } from './promotion-no-live-authorization-guard.js';

// Offline final no-live-authorization guard CLI. Fails closed on any artifact claiming a live authorization
// (APPROVED/EXECUTE/LIVE_READY/PHASE_231_AUTHORIZED/GRANTED) unless it is an explicit PENDING human gate doc.
// Never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-no-live-authorization-guard --artifacts <bundle.json> [--out <report.json>]',
    '',
    'bundle.json is a JSON array of artifacts. Local, non-live: NO_LIVE_AUTHORIZATION_CLEAN only when NO',
    'artifact claims a live authorization (APPROVED/EXECUTE/LIVE_READY/PHASE_231_AUTHORIZED/GRANTED) except an',
    'explicit PENDING human gate doc. It authorizes NOTHING and does not authorize Phase 231. Exit 0 = CLEAN,',
    '1 = VIOLATED.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const input: NoLiveAuthorizationGuardInput = {};
  try {
    const artifacts = valueAfter(args, '--artifacts');
    if (artifacts !== undefined) (input as Record<string, unknown>).artifacts = JSON.parse(readFileSync(artifacts, 'utf8'));
  } catch { console.error('artifacts file is missing or not valid JSON'); return 2; }
  const report = buildNoLiveAuthorizationGuard(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-no-live-authorization-guard-capture',
    overall: report.overall,
    authorization: report.authorization,
    redactionSafe: true,
    artifactCount: report.artifactCount,
    verdicts: report.verdicts,
    blockers: report.blockers,
    noLiveDigest: report.noLiveDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return report.overall === 'NO_LIVE_AUTHORIZATION_CLEAN' ? 0 : 1;
}

process.exit(main());
