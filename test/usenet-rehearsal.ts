import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  REHEARSAL_GATE_IDS,
  createRehearsalNamespace,
  rehearsalTorBoxEntry,
  rehearse,
  renderRehearsal,
} from '../src/ops/usenet-rehearsal.js';
import { PHASE9_PROVIDER_REQUIRED_GATE_IDS } from '../src/core/projection/phase9.js';
import { isProviderBackedEntry, mixedNamespaceCensus } from '../src/core/usenet/manifest-bridge.js';
import { sealedProblems } from '../src/core/usenet/sealed.js';
import { validateManifestV1 } from '../src/core/projection/manifest-v1.js';

// Projection Phase 9 §3, EIGHTH DELIVERABLE — the provider-free mixed rehearsal, run as a suite.
//
// WHY THIS IS AN OFFLINE SUITE AND NOT ONLY A GATE SCRIPT. The rehearsal contacts nothing but a loopback
// listener it starts itself, so there is no reason for it to need Docker, a database or an operator. Running
// it in the ordinary offline aggregate means the whole mixed sequence — submit, observe, admit, compare the
// namespace, restart, survive an outage — is exercised on every commit rather than only when somebody
// remembers to run a shell script.
//
// AND IT ASSERTS THE THING THE GATE SCRIPT CANNOT: that the rehearsal STILL LEAVES THE PHASE OPEN. A
// provider-free run that reported nothing remaining would mean the boundary between "we rehearsed it" and "we
// proved it" had quietly moved, which is the one failure that would make every other assertion in this
// tranche worth less than it looks.

const h = createHarness('Projection Phase 9 — the provider-free mixed rehearsal');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

// The rehearsal is run ONCE and every test reads its report: it starts a real HTTP listener and runs the
// whole sequence, and running it per-test would be eight listeners for one set of facts.
//
// `offlineSuitesVerified` IS SET HERE BECAUSE THIS FILE IS ONE OF THE SUITES IT NAMES. §5.1 and §5.8 are
// claims about offline suite runs, and this assertion is running inside one; the gate script makes the same
// assertion after running both suite sets. What the flag must NOT do is default to true — a driver that
// claimed §5.1 with nothing measured is the vacuous verdict the section below drives directly.
const report = await rehearse({ offlineSuitesVerified: true });

h.section('the sequence');

test('every rehearsed step passed', () => {
  for (const step of report.steps) {
    assert(step.ok, `${step.id} failed: ${step.detail}`);
  }
  assert(report.ok, 'the rehearsal reported an overall failure');
});

test('the eight steps are the eight the sequence is made of, in order', () => {
  assertEq(report.steps.map((step) => step.id.split('-')[0]).join(' '), 'R1 R2 R3 R4 R5 R6 R7 R8', 'the step order');
});

test('a job the worker still holds publishes nothing, and a completed one publishes exactly once', () => {
  const inFlight = report.steps.find((step) => step.id === 'R2-in-flight-publishes-nothing');
  const admitted = report.steps.find((step) => step.id === 'R3-admitted-exactly-once');
  assert(inFlight?.ok === true, 'an in-flight job published');
  assert(admitted?.ok === true, `a completed job was not admitted exactly once: ${admitted?.detail}`);
  assert((admitted?.detail ?? '').includes('publishes=1'), `publishes: ${admitted?.detail}`);
});

test('the restart submitted nothing and lost nothing', () => {
  const restart = report.steps.find((step) => step.id === 'R7-restart-no-duplicate-no-loss');
  assert(restart?.ok === true, `the restart moved something: ${restart?.detail}`);
  assert((restart?.detail ?? '').includes('submissions=1'), `submissions: ${restart?.detail}`);
});

test('the TorBox half did not move, during the publish or during the outage', () => {
  for (const id of ['R5-torbox-unchanged', 'R6-outage-changes-nothing']) {
    const step = report.steps.find((candidate) => candidate.id === id);
    assert(step?.ok === true, `${id}: ${step?.detail}`);
  }
});

h.section('the verdicts, and the boundary they respect');

test('every verdict the rehearsal emits is stamped as a rehearsal', () => {
  for (const result of report.results) {
    assertEq(result.rehearsal, true,
      `${result.gate} was emitted without the rehearsal stamp, so it would count as a real verdict`);
  }
});

test('the rehearsal emits verdicts ONLY for provider-free claims', () => {
  for (const result of report.results) {
    assert(!PHASE9_PROVIDER_REQUIRED_GATE_IDS.includes(result.gate as never),
      `${result.gate} needs a real Usenet provider and this rehearsal contacted none`);
    assert((REHEARSAL_GATE_IDS as readonly string[]).includes(result.gate), `${result.gate} is not a rehearsable claim`);
  }
});

test('it emits a verdict for every provider-free claim, so the rehearsal is not quietly partial', () => {
  const emitted = new Set(report.results.map((result) => result.gate));
  for (const id of REHEARSAL_GATE_IDS) {
    assert(emitted.has(id), `${id} is rehearsable and this rehearsal did not answer it`);
  }
});

test('THE REHEARSAL STILL LEAVES THE PHASE OPEN, and names exactly the four claims it cannot answer', () => {
  assert(report.closureProblemsRemaining.length > 0,
    'a provider-free rehearsal reported that nothing remains open, which would mean Phase 9 could close '
    + 'without a Usenet provider ever being contacted');
  for (const id of PHASE9_PROVIDER_REQUIRED_GATE_IDS) {
    assert(report.closureProblemsRemaining.some((problem) => problem.includes(id)), `${id} is not reported open`);
  }
  assertEq(report.closureProblemsRemaining.length, PHASE9_PROVIDER_REQUIRED_GATE_IDS.length,
    'the rehearsal leaves open something other than exactly the provider-required claims');
});

test('A DRIVER THAT MEASURED NO SUITE CLAIMS NO SUITE, and §5.1 and §5.8 stay open when it did not', async () => {
  // THE VACUOUS-VERDICT CASE, DRIVEN RATHER THAN REASONED ABOUT. §5.1 ("every offline boundary, redaction,
  // path-safety, idempotency and restart test passes") and §5.8 ("the existing focused regression gates
  // remain green") are claims about test runs that the rehearsal driver does not perform — it starts a fake
  // worker and drives one sequence. Both are on the provider-free list, so `phase9ClosureProblems` ACCEPTS a
  // rehearsal verdict for them: a driver that emitted `pass` unconditionally would close two of §5's eleven
  // claims having measured neither. So the default is to answer neither, and this drives the default.
  const bare = await rehearse();
  const emitted = new Set(bare.results.map((result) => result.gate));
  assert(!emitted.has('P9-1-offline-boundary-suite'),
    'the driver claimed the offline boundary suite passed without any suite having been run for it');
  assert(!emitted.has('P9-8-existing-regression-gates-green'),
    'the driver claimed the existing regression gates were green without having run one');
  for (const id of ['P9-1-offline-boundary-suite', 'P9-8-existing-regression-gates-green']) {
    assert(bare.closureProblemsRemaining.some((problem) => problem.includes(id) && problem.includes('no verdict')),
      `${id} was neither answered nor reported open, so it would read as closed`);
  }
  // AND THE SEQUENCE STILL PASSED. The absent verdicts are a statement about what was not measured, not a
  // failure of what was — a driver that failed outright would make the distinction impossible to use.
  assert(bare.steps.every((step) => step.ok), 'the unflagged rehearsal failed a step it should still pass');
});

h.section('what it produced');

test('the rehearsal namespace is genuinely mixed and its entries are valid manifest entries', () => {
  const namespace = createRehearsalNamespace();
  const before = namespace.entries();
  assertEq(before.length, 1, 'the namespace starts with the synthetic TorBox entry');
  assert(isProviderBackedEntry(before[0] as never), 'the synthetic entry is not provider-backed');

  const manifest = {
    format: 'catalog-authority.projection-manifest',
    version: 1,
    generation: {
      generationId: `gen_${'a'.repeat(32)}`,
      sequence: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      predecessor: null,
      provenance: {
        producer: 'catalog-authority', producerVersion: '1.2.6', controlPlaneSchemaVersion: 1,
        sourceSnapshotDigest: `sha256:${'0'.repeat(64)}`, probeWindowBytes: 1_048_576,
      },
      admission: { intent: 'routine', entryCount: 1, deletions: [], deletionGuardAcknowledged: false, deletionGuardDigest: null },
    },
    entries: [rehearsalTorBoxEntry()],
  };
  const validation = validateManifestV1(manifest);
  assert(validation.ok, 'the synthetic TorBox entry is not a valid manifest entry: '
    + validation.problems.map((problem) => `${problem.code} at ${problem.at}`).join('; '));
});

test('a census over the rehearsal\'s namespace reports one of each', () => {
  const detail = report.steps.find((step) => step.id === 'R4-mixed-namespace')?.detail ?? '';
  assert(detail.includes('torbox=1'), `torbox count: ${detail}`);
  assert(detail.includes('usenet=1'), `usenet count: ${detail}`);
  // And the census function itself agrees about what "mixed" means.
  assert(!mixedNamespaceCensus([rehearsalTorBoxEntry()]).mixed, 'a TorBox-only namespace is reported mixed');
});

h.section('what it may not carry');

test('the whole report carries no URL, no completed path and no worker job id', () => {
  assertEq(sealedProblems(report, 'report').length, 0,
    `the rehearsal report carries identity: ${sealedProblems(report, 'report').join('; ')}`);
  const text = JSON.stringify(report);
  assert(!text.includes('rehearsal.invalid'), 'the report carries the NZB source');
  assert(!text.includes('SABnzbd_nzo'), 'the report carries the worker job id');
});

test('the rendered output says what was proved AND what was not, in that order', () => {
  const lines = renderRehearsal(report).join('\n');
  assert(lines.includes('provider-free mixed rehearsal'), 'the heading');
  assert(lines.includes('still open'), 'the rendering does not say what remains open');
  assert(lines.indexOf('verdicts') < lines.indexOf('still open'),
    'the still-open claims must come last, where a reader stops');
  assert(!lines.includes('rehearsal.invalid'), 'the rendering carries the source');
});

test('it leaves nothing behind', () => {
  assertEq(report.residue, 0, 'the rehearsal reported residue');
});

h.section('wiring');

test('the rehearsal CLI refuses to exit zero if it ever stops leaving the phase open', () => {
  const source = read('src/ops/usenet-rehearsal-cli.ts');
  assert(source.includes('closureProblemsRemaining.length === 0'),
    'the CLI does not check that the rehearsal still leaves the phase open');
  assert(source.includes('REFUSED'), 'the CLI does not refuse a rehearsal that reads as a closure');
});

test('the rehearsal contacts nothing but a loopback listener it started itself', () => {
  const source = read('src/ops/usenet-rehearsal.ts');
  assert(source.includes('startFakeSabnzbd'), 'the rehearsal does not start its own fake worker');
  assert(!/api\.torbox\.app|newshosting|usenet[a-z]*\.(com|net)/i.test(source), 'the rehearsal names a real provider');
  assert(!/process\.env\./.test(source), 'the rehearsal reads the environment, where an operator credential might be');
});

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/usenet-rehearsal.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'usenet-rehearsal.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();
