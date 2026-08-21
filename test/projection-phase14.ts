import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  PHASE14_CLAIMS,
  PHASE14_CONFIRMATION_IDS,
  PHASE14_REQUIREMENTS,
  buildPhase14Preflight,
  parsePhase14Descriptor,
} from '../src/core/projection/phase14.js';

const h = createHarness('Projection Phase 14 — redaction-safe operator preflight');
const { test } = h;
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const allTrue = Object.fromEntries(PHASE14_CONFIRMATION_IDS.map((id) => [id, true]));

h.section('entry is all-or-nothing');

test('an empty descriptor blocks every confirmation and closes nothing', () => {
  const report = buildPhase14Preflight({});
  assertEq(report.status, 'BLOCKED', 'empty status');
  assertEq(report.missing.length, PHASE14_CONFIRMATION_IDS.length, 'all confirmations missing');
  assertEq(report.openClaims.join(','), PHASE14_CLAIMS.join(','), 'all claims remain open');
  assertEq(report.claimsClosed.length, 0, 'preflight closed a claim');
  assertEq(report.phase14Entered, false, 'preflight entered Phase 14');
  assertEq(report.contactsMade, 0, 'preflight contacted something');
  assertEq(report.valuesEchoed, false, 'preflight echoes values');
});

test('every confirmation is independently required', () => {
  for (const id of PHASE14_CONFIRMATION_IDS) {
    const descriptor = { ...allTrue, [id]: false };
    const report = buildPhase14Preflight(descriptor);
    assertEq(report.status, 'BLOCKED', `${id} did not block`);
    assertEq(report.missing.length, 1, `${id} did not produce one finding`);
    assertEq(report.missing[0]?.id, id, `${id} finding`);
  }
});

test('all shapes confirmed means READY to request authorization, never GO', () => {
  const report = buildPhase14Preflight(allTrue);
  assertEq(report.status, 'READY', 'ready status');
  assertEq(report.missing.length, 0, 'ready report has missing rows');
  assert(report.meaning.includes('separate live-run authorization'), 'READY looks like run authorization');
  assertEq(report.phase14Entered, false, 'READY entered the phase');
  assertEq(report.claimsClosed.length, 0, 'READY closed claims');
});

h.section('closed boolean-only schema');

test('unknown fields and values are refused, not ignored or coerced', () => {
  for (const bad of [{ secret: true }, { phase13Go: 'yes' }, { phase13Go: 1 }, [], null]) {
    let refused = false;
    try { parsePhase14Descriptor(bad); } catch { refused = true; }
    assert(refused, `descriptor was accepted: ${JSON.stringify(bad)}`);
  }
});

test('requirements are complete, unique, fixed and useful', () => {
  assertEq(PHASE14_REQUIREMENTS.length, PHASE14_CONFIRMATION_IDS.length, 'requirement count');
  assertEq(new Set(PHASE14_REQUIREMENTS.map((r) => r.id)).size, PHASE14_REQUIREMENTS.length, 'duplicate id');
  for (const row of PHASE14_REQUIREMENTS) {
    assert(row.requiredShape.length > 10 && row.purpose.length > 8 && row.confirmation.length > 10, `${row.id} is vague`);
    assert(row.unblocks.length > 0, `${row.id} unblocks nothing`);
    for (const claim of row.unblocks) assert(PHASE14_CLAIMS.includes(claim), `${row.id} names foreign claim ${claim}`);
  }
});

test('the report cannot carry operator values because the descriptor accepts booleans only', () => {
  const text = JSON.stringify(buildPhase14Preflight(allTrue));
  for (const forbidden of ['http://', 'https://', 'api_key', 'password', '.nzb', '/mnt/', '\\media\\']) {
    assert(!text.toLowerCase().includes(forbidden.toLowerCase()), `report contains ${forbidden}`);
  }
});

h.section('document, CLI and inventory');

test('the document names every confirmation and claim and preserves non-entry', () => {
  const doc = read('docs/PROJECTION_PHASE_14_USENET_MIXED_ACCEPTANCE.md');
  for (const id of PHASE14_CONFIRMATION_IDS) assert(doc.includes(`\`${id}\``), `document misses ${id}`);
  for (const id of PHASE14_CLAIMS) assert(doc.includes(`\`${id}\``), `document misses ${id}`);
  assert(doc.includes('PHASE 14 IS NOT RUN AND NOT ENTERED'), 'document overclaims entry');
  assert(doc.includes('never induced'), 'document permits induced outage');
});

test('CLI is blocked by default, ready on booleans, and never prints descriptor values', () => {
  const cli = join(root, 'src/ops/projection-phase14-preflight-cli.ts');
  const blocked = spawnSync(process.execPath, ['--import', 'tsx', cli, '--json'], { cwd: root, encoding: 'utf8' });
  assertEq(blocked.status, 3, 'default preflight exit');
  assertEq(JSON.parse(blocked.stdout).status, 'BLOCKED', 'default report');
  const dir = mkdtempSync(join(tmpdir(), 'projection-p14-'));
  try {
    const descriptor = join(dir, 'descriptor.json');
    writeFileSync(descriptor, JSON.stringify(allTrue));
    const ready = spawnSync(process.execPath, ['--import', 'tsx', cli, '--descriptor', descriptor, '--json'], { cwd: root, encoding: 'utf8' });
    assertEq(ready.status, 0, `ready exit: ${ready.stderr}`);
    assertEq(JSON.parse(ready.stdout).status, 'READY', 'ready report');
    assert(!ready.stdout.includes(descriptor), 'CLI echoes descriptor path');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('suite and scripts are wired', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:projection-phase14'], 'tsx test/projection-phase14.ts', 'test script');
  assertEq(pkg.scripts['ops:projection-phase14-preflight'], 'tsx src/ops/projection-phase14-preflight-cli.ts', 'ops script');
  assert(AGGREGATE_SUITE_COMMAND.includes('test/projection-phase14.ts'), 'suite not in aggregate');
});

await h.finish();

