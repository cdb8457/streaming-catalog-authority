import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGateCoverage } from './promotion-gate-coverage.js';

// Offline gate coverage completeness CLI. Proves every Phase 230 op/gate/blocker/doc wiring has test
// coverage. Never promotes, never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-gate-coverage [--out <coverage.json>]',
    '',
    'Local, non-live: GATE_COVERAGE_COMPLETE when every op is fully wired, every gate node is in the local',
    'suite, every gate blocker is catalogued, and every taxonomy op is a gate node. It authorizes NOTHING',
    'live and does not authorize Phase 231. Exit 0 = COMPLETE, 1 = INCOMPLETE.',
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
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
  const coverage = buildGateCoverage(projectRoot);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(coverage, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-gate-coverage-capture',
    overall: coverage.overall,
    authorization: coverage.authorization,
    redactionSafe: true,
    opCount: coverage.opCount,
    gateNodeCount: coverage.gateNodeCount,
    blockerCodeCount: coverage.blockerCodeCount,
    dimensions: coverage.dimensions,
    gaps: coverage.gaps,
    coverageDigest: coverage.coverageDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return coverage.overall === 'GATE_COVERAGE_COMPLETE' ? 0 : 1;
}

process.exit(main());
