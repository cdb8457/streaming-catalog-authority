#!/usr/bin/env node
// Projection Phase 8s CLI: the thresholds, the closure check, the report, the redaction check and the
// nonclaims. It is Phase 7s CLI in the same shape, for the same reasons, over Phase 8s own contract —
// with the arm loop replaced by a CYCLE loop, because a soak is three cycles rather than six arms.
//
// WHAT IT DELIBERATELY DOES NOT DO. It records no verdict. The gate writes those with a tiny embedded
// program, one `node` process per verdict, because several hundred `npx tsx` starts per run is minutes of
// interpreter startup and a gate nobody runs twice.
//
// THE BUDGETS LEAVE HERE AS SHELL ASSIGNMENTS AND THE GATE `eval`s THEM ONCE. That is what stops the gate
// carrying a second copy of a number the contract derives, and `test/projection-phase7.ts` asserts that the
// gate contains no literal spelling of any of them.

import { existsSync, readFileSync } from 'node:fs';
import {
  PHASE8_STEPS,
  PHASE8_STEP_TITLES,
  PHASE8_RULES,
  PHASE8_NONCLAIMS,
  PHASE8_INHERITED_BETWEEN_CYCLES,
  PHASE8_SERVER_IDS,
      THE_SOAK_IS_FRESH_AND_THE_CYCLES_ARE_NOT,
  phase8ClosureProblems,
  type Phase8Results,
} from '../core/projection/phase8.js';
import { findRedactionProblems, type GateResult } from '../core/projection/media-server-dataplane.js';

class GateFailure extends Error {}
const fail = (message: string): never => { throw new GateFailure(message); };

interface Args { readonly command: string; readonly flags: Map<string, string>; readonly bare: Set<string> }

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  const bare = new Set<string>();
  const [command = '', ...rest] = argv;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) { bare.add(name); continue; }
    flags.set(name, next);
    index += 1;
  }
  return { command, flags, bare };
}

const need = (args: Args, name: string): string => args.flags.get(name) ?? fail(`--${name} is required`);

/**
 * Read the two JSON Lines files the gate has been appending to.
 *
 * A LINE THAT DOES NOT PARSE IS A FAILURE, NEVER A SKIP. Dropping unreadable lines would turn a truncated
 * write — the exact thing JSON Lines is chosen to survive — into a shorter run that passed.
 */
function readResults(resultsPath: string, cyclesPath: string): Phase8Results {
  const parseLines = <T>(path: string, what: string): T[] => {
    if (!existsSync(path)) fail(`${what} (${path}) does not exist; the run wrote nothing to judge`);
    const out: T[] = [];
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      if (line.trim() === '') return;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        fail(`line ${index + 1} of ${what} is not JSON; a truncated record is a failed run, not a short one`);
      }
    });
    return out;
  };
  return {
    results: parseLines<GateResult>(resultsPath, 'the verdict log'),
    cycles: parseLines<{ index: number; cycle: number }>(cyclesPath, 'the cycle log'),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    // -----------------------------------------------------------------------------------------------------
    case 'budgets': {
      const shell = args.bare.has('sh');
      for (const [key, value] of Object.entries(PHASE8_RULES)) {
        if (shell) console.log(`P8_${key}=${String(value)}`);
        else console.log(`  ${key.padEnd(34)} ${String(value)}`);
      }
      if (shell) {
        console.log(`P8_STEPS='${PHASE8_STEPS.join(' ')}'`);
        console.log(`P8_SERVERS='${PHASE8_SERVER_IDS.join(' ')}'`);
        console.log(`P8_INHERITED='${PHASE8_INHERITED_BETWEEN_CYCLES.length}'`);
      }
      // THE DERIVED FACT THIS CONTRACT DEPENDS ON, CHECKED WHERE THE BUDGETS ARE PUBLISHED — so the gate
      // cannot even load its thresholds once the freshness inversion has stopped holding.
      if (!THE_SOAK_IS_FRESH_AND_THE_CYCLES_ARE_NOT) {
        fail('the soak no longer inherits between cycles, so every budget below would be measured against '
          + 'three fresh runs wearing the name of a soak');
      }
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'steps': {
      for (const step of PHASE8_STEPS) console.log(`  ${step}  ${PHASE8_STEP_TITLES[step]}`);
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'close': {
      const document = readResults(need(args, 'results'), need(args, 'cycles-log'));
      const problems = phase8ClosureProblems(document);
      const passed = document.results.filter((result) => result.verdict === 'pass').length;
      const failed = document.results.filter((result) => result.verdict === 'fail').length;
      const skipped = document.results.filter((result) => result.verdict === 'skip').length;
      console.log(`  ${document.cycles.length} cycle(s), ${document.results.length} verdict(s): `
        + `${passed} pass, ${failed} fail, ${skipped} skip`);
      if (problems.length > 0) {
        for (const problem of problems.slice(0, 60)) console.error(`  ${problem}`);
        if (problems.length > 60) console.error(`  ...and ${problems.length - 60} more`);
        fail(`the run does not satisfy the predeclared closure rule (${problems.length} problem(s))`);
      }
      console.log('  every predeclared cycle, step and budget is present, terminal and passing');
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'report': {
      const document = readResults(need(args, 'results'), need(args, 'cycles-log'));
      console.log('  the steps of every cycle:');
      for (const step of PHASE8_STEPS) {
        console.log(`  ${step.padEnd(4)} ${PHASE8_STEP_TITLES[step]}`);
      }
      console.log(`  cycles recorded: ${document.cycles.map((c) => c.cycle).join(', ')}`);
      console.log('  measured figures:');
      for (const result of document.results) {
        if (typeof result.measured !== 'number') continue;
        console.log(`    ${result.gate.padEnd(46)} ${String(result.measured).padStart(9)}`
          + ` / ${String(result.budget ?? '-')}  ${result.verdict}`);
      }
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'redaction-check': {
      const path = need(args, 'file');
      if (!existsSync(path)) fail('a kept artifact does not exist');
      const problems = readFileSync(path, 'utf8').split('\n')
        .filter((line) => line.trim() !== '')
        .flatMap((line, index) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            return [{ kind: 'a line that is not JSON, so it was never checked', at: `line ${index + 1}` }];
          }
          return findRedactionProblems(parsed, `line ${index + 1}`);
        });
      if (problems.length > 0) {
        for (const problem of problems.slice(0, 20)) console.error(`  ${problem.kind} at ${problem.at}`);
        fail('a kept artifact is not redaction-safe');
      }
      console.log('  redaction-safe');
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'nonclaims': {
      for (const line of PHASE8_NONCLAIMS) console.log(`  - ${line}`);
      return;
    }

    default:
      fail(`unknown command: ${args.command || '(none)'}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`projection-phase8: ${(error as Error).message}`);
  process.exit(1);
}
