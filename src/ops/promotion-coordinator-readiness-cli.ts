import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildCoordinatorReadiness, type CoordinatorReadinessInput } from './promotion-coordinator-readiness.js';

// Offline final coordinator readiness manifest CLI. Confirms the machine-side hardening evidence is
// complete for coordinator review -- never an approval, merge, or live promotion. Never touches the real
// Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-coordinator-readiness --preflight <f> --failurematrix <f> --reportschema <f> --boundaryaudit <f> --cliergonomics <f> [--out <readiness.json>]',
    '',
    'Local, non-live: COORDINATOR_READINESS_CONFIRMED only when every hardening input is present, valid,',
    'green, and digest-bound. CONFIRMED is NOT an approval and does not authorize Phase 231 or any merge.',
    'Exit 0 = CONFIRMED, 1 = NOT_CONFIRMED.',
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
  const map: Array<[keyof CoordinatorReadinessInput, string]> = [
    ['acceptancePreflight', '--preflight'], ['failureMatrix', '--failurematrix'], ['reportSchema', '--reportschema'],
    ['boundaryAudit', '--boundaryaudit'], ['cliErgonomics', '--cliergonomics'],
  ];
  const input: CoordinatorReadinessInput = {};
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const readiness = buildCoordinatorReadiness(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(readiness, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-coordinator-readiness-manifest-capture',
    overall: readiness.overall,
    authorization: readiness.authorization,
    redactionSafe: true,
    components: readiness.components,
    boundDigests: readiness.boundDigests,
    humanGates: readiness.humanGates,
    blockers: readiness.blockers,
    readinessDigest: readiness.readinessDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return readiness.overall === 'COORDINATOR_READINESS_CONFIRMED' ? 0 : 1;
}

process.exit(main());
