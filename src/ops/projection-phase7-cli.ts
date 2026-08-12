#!/usr/bin/env node
// Projection Phase 7's CLI: the thresholds, the closure check, the report, the redaction check and the
// nonclaims. It is Phase 3's CLI in the same shape, for the same reasons, over Phase 7's own contract.
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
  PHASE7_ARMS,
  PHASE7_ARM_TITLES,
  PHASE7_RULES,
  PHASE7_NONCLAIMS,
  PHASE7_SERVER_IDS,
  PHASE7_POLL_INTERVAL_MS,
  PHASE7_ACTIONABLE_ARMS,
  RECOVERY_SUSTAIN_OUTLASTS_THE_FAULT_HOLD,
  THE_LAYER_FLOOR_IS_A_FLOOR_THE_PRODUCT_PROMISES,
  phase7ClosureProblems,
  type Phase7Results,
} from '../core/projection/phase7.js';
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
function readResults(resultsPath: string, armsPath: string): Phase7Results {
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
    arms: parseLines<{ index: number; arm: string }>(armsPath, 'the arm log'),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    // -----------------------------------------------------------------------------------------------------
    case 'budgets': {
      const shell = args.bare.has('sh');
      for (const [key, value] of Object.entries(PHASE7_RULES)) {
        if (shell) console.log(`P7_${key}=${String(value)}`);
        else console.log(`  ${key.padEnd(34)} ${String(value)}`);
      }
      if (shell) {
        console.log(`P7_ARMS='${PHASE7_ARMS.join(' ')}'`);
        console.log(`P7_ACTIONABLE_ARMS='${PHASE7_ACTIONABLE_ARMS.join(' ')}'`);
        console.log(`P7_SERVERS='${PHASE7_SERVER_IDS.join(' ')}'`);
        console.log(`P7_POLL_INTERVAL_MS=${PHASE7_POLL_INTERVAL_MS}`);
      }
      // TWO DERIVED FACTS THE CONTRACT DEPENDS ON, CHECKED WHERE THE BUDGETS ARE PUBLISHED — so the gate
      // cannot even load its thresholds once either has stopped holding.
      if (!RECOVERY_SUSTAIN_OUTLASTS_THE_FAULT_HOLD) {
        fail('the recovery sustain no longer outlasts the fault hold, so the recovery budgets below describe '
          + 'an order of events that no longer happens');
      }
      if (!THE_LAYER_FLOOR_IS_A_FLOOR_THE_PRODUCT_PROMISES) {
        fail('the product no longer promises to leave the anchor mount alone, so counting layers ABOVE it is '
          + 'counting above a floor that can move');
      }
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'arms': {
      for (const arm of PHASE7_ARMS) console.log(`  ${arm}  ${PHASE7_ARM_TITLES[arm]}`);
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'close': {
      const document = readResults(need(args, 'results'), need(args, 'arms-log'));
      const problems = phase7ClosureProblems(document);
      const passed = document.results.filter((result) => result.verdict === 'pass').length;
      const failed = document.results.filter((result) => result.verdict === 'fail').length;
      const skipped = document.results.filter((result) => result.verdict === 'skip').length;
      console.log(`  ${document.arms.length} arm(s), ${document.results.length} verdict(s): `
        + `${passed} pass, ${failed} fail, ${skipped} skip`);
      if (problems.length > 0) {
        for (const problem of problems.slice(0, 60)) console.error(`  ${problem}`);
        if (problems.length > 60) console.error(`  ...and ${problems.length - 60} more`);
        fail(`the run does not satisfy the predeclared closure rule (${problems.length} problem(s))`);
      }
      console.log('  every predeclared arm, stage, phase and budget is present, terminal and passing');
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'report': {
      const document = readResults(need(args, 'results'), need(args, 'arms-log'));
      console.log('  arm  what it was');
      for (const record of document.arms) {
        const arm = record.arm as keyof typeof PHASE7_ARM_TITLES;
        console.log(`  ${record.arm}   ${PHASE7_ARM_TITLES[arm] ?? 'an arm this contract does not define'}`);
      }
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
      for (const line of PHASE7_NONCLAIMS) console.log(`  - ${line}`);
      return;
    }

    default:
      fail(`unknown command: ${args.command || '(none)'}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`projection-phase7: ${(error as Error).message}`);
  process.exit(1);
}
