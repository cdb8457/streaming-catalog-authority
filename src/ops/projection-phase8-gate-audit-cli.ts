#!/usr/bin/env node
// The Phase 8 gate's wiring, audited from its bytes. `src/core/projection/phase8-gate-audit.ts` is the model
// and the reasoning; this is the surface the rehearsal and the offline suite both call, so a wiring defect
// costs seconds on any host instead of an hour of provider traffic on one.
//
// IT READS THE GATE AND THE PUBLISHED BUDGET NAMES AND NOTHING ELSE. No Docker, no daemon, no provider, no
// network — which is what makes it the first thing the rehearsal runs and the first thing that would have
// caught the three unpublished shell names this gate carried before it was ever executed.

import { readFileSync, writeFileSync } from 'node:fs';
import {
  PHASE8_RULES,
  PHASE8_SERVER_IDS,
  PHASE8_STEPS,
  PHASE8_POLL_INTERVAL_MS,
  PHASE8_READ_FAIL_BUDGET_MS,
  phase8BudgetKeyFor,
  requiredCycleGateIds,
  requiredSoakGateIds,
} from '../core/projection/phase8.js';
import {
  collectEmissions,
  expandEmission,
  phase8GateWiringProblems,
} from '../core/projection/phase8-gate-audit.js';

/**
 * The names the contract CLI publishes for the gate to `eval`.
 *
 * IT IS DERIVED FROM THE SAME MODULE THE CLI PUBLISHES FROM, not from a list kept beside it. A budget that
 * stops being published stops appearing here in the same commit, so the audit can never be checking the gate
 * against a set of names the gate is not actually given.
 */
export function publishedShellNames(): string[] {
  return [
    ...Object.keys(PHASE8_RULES).map((key) => `P8_${key}`),
    'P8_STEPS',
    'P8_SERVERS',
    'P8_INHERITED',
    'P8_POLL_INTERVAL_MS',
    'P8_READ_FAIL_BUDGET_MS',
  ];
}

/**
 * A complete, passing soak document, built from the ids and comparisons THE GATE ITSELF WOULD WRITE.
 *
 * WHY IT IS DERIVED AND NOT WRITTEN DOWN. The rehearsal uses this to exercise the closure check, the report
 * and the redaction check without a provider, and to run the five controls that prove each of those refuses
 * what it is supposed to refuse. A hand-written fixture would drift from the gate the first time either
 * changed, and a fixture that has drifted tests a document nothing produces. This one cannot: if the gate
 * stops emitting a required id, the synthesis stops being able to build a closing document, which is itself
 * the finding.
 *
 * EVERY MEASUREMENT IS THE BUDGET ITSELF, which satisfies `le`, `ge` and `eq` alike. It is not an
 * observation and this file is never evidence about anything: it exists to be judged, not to be believed.
 */
function synthesize(gateSource: string): { verdicts: string; cycles: string } {
  const opFor = new Map<string, string>();
  for (const emission of collectEmissions(gateSource)) {
    for (const id of expandEmission(emission)) opFor.set(id, emission.op);
  }
  const required: string[] = [];
  for (let cycle = 1; cycle <= PHASE8_RULES.CYCLES_PER_SOAK; cycle += 1) {
    required.push(...requiredCycleGateIds(cycle));
  }
  required.push(...requiredSoakGateIds());

  const lines: string[] = [];
  for (const gate of required) {
    const key = phase8BudgetKeyFor(gate);
    if (key === undefined) {
      lines.push(JSON.stringify({ gate, verdict: 'pass', note: 'synthetic: not an observation' }));
      continue;
    }
    const budget = PHASE8_RULES[key] as number;
    lines.push(JSON.stringify({
      gate, verdict: 'pass', measured: budget, budget, note: 'synthetic: not an observation',
    }));
  }
  const cycles: string[] = [];
  for (let cycle = 1; cycle <= PHASE8_RULES.CYCLES_PER_SOAK; cycle += 1) {
    cycles.push(JSON.stringify({ index: cycle, cycle }));
  }
  // A REQUIRED ID THE GATE WOULD NEVER WRITE IS A DOCUMENT THIS COULD ONLY FAKE, so it refuses instead.
  const unemitted = required.filter((gate) => !opFor.has(gate));
  if (unemitted.length > 0) {
    throw new Error(`the gate emits none of: ${unemitted.slice(0, 5).join(', ')}`
      + `${unemitted.length > 5 ? ` (and ${unemitted.length - 5} more)` : ''}`);
  }
  return { verdicts: `${lines.join('\n')}\n`, cycles: `${cycles.join('\n')}\n` };
}

function main(): void {
  const [, , ...argv] = process.argv;
  let gatePath = 'deploy/projection-phase8-gate.sh';
  const verbose = argv.includes('--verbose');
  const flag = argv.indexOf('--gate');
  if (flag !== -1 && argv[flag + 1] !== undefined) gatePath = argv[flag + 1] as string;

  const source = readFileSync(gatePath, 'utf8');

  // THE SYNTHESIS IS A SEPARATE ERRAND AND SAYS SO BY EXITING HERE. It writes two files the rehearsal then
  // feeds to the real closure check; it reports no verdict about the gate's wiring and must never be
  // mistaken for one.
  const outAt = argv.indexOf('--synthesize');
  if (outAt !== -1 && argv[outAt + 1] !== undefined) {
    const cyclesAt = argv.indexOf('--synthesize-cycles');
    const built = synthesize(source);
    writeFileSync(argv[outAt + 1] as string, built.verdicts);
    if (cyclesAt !== -1 && argv[cyclesAt + 1] !== undefined) {
      writeFileSync(argv[cyclesAt + 1] as string, built.cycles);
    }
    console.log(`  wrote a synthetic ${PHASE8_RULES.CYCLES_PER_SOAK}-cycle document: `
      + `${built.verdicts.trimEnd().split('\n').length} verdict(s). It is not an observation and no `
      + 'document may cite it.');
    return;
  }

  const report = phase8GateWiringProblems(source, publishedShellNames());

  console.log(`  ${gatePath}: ${source.split('\n').length} line(s), `
    + `${PHASE8_RULES.CYCLES_PER_SOAK} cycle(s) of ${PHASE8_STEPS.length} step(s), `
    + `${PHASE8_SERVER_IDS.length} server(s)`);
  console.log(`  ${report.required.length} id(s) the closure rule requires, `
    + `${report.emitted.length} distinct id(s) the gate would record`);
  console.log(`  the poll interval is ${PHASE8_POLL_INTERVAL_MS} ms and the read-fail budget is `
    + `${PHASE8_READ_FAIL_BUDGET_MS} ms, both imported`);

  if (verbose) for (const id of report.emitted) console.log(`    emits ${id}`);

  if (report.problems.length > 0) {
    console.error(`\n  ${report.problems.length} wiring problem(s):`);
    for (const problem of report.problems) console.error(`    ${problem}`);
    process.exit(1);
  }
  console.log('  the gate\'s wiring is sound: every name it reads is published, every id the closure rule '
    + 'requires is recorded exactly once, and every budgeted id carries a measurement.');
}

main();
