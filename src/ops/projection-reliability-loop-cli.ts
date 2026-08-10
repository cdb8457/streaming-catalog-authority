#!/usr/bin/env node
// The Phase 3 reliability loop's CLI: the thresholds, the closure check, the report and the nonclaims.
//
// WHAT IT DELIBERATELY DOES NOT DO. It records no verdict. The gate writes those with a tiny embedded
// program, one `node` process per verdict, because ~250 `npx tsx` starts per run is six minutes of
// interpreter startup and a gate nobody runs twice. What comes through here is the small number of things
// that must not be restated in a shell script: the budgets themselves, and the judgement over them.
//
// THE BUDGETS LEAVE HERE AS SHELL ASSIGNMENTS AND THE GATE `eval`s THEM ONCE. That is what stops the gate
// carrying a second copy of a number the contract derives, and `test/projection-reliability-loop.ts` asserts
// the gate contains no literal spelling of any of them.

import { existsSync, readFileSync } from 'node:fs';
import {
  RELIABILITY_LOOP_ARMS,
  RELIABILITY_ARM_TITLES,
  RELIABILITY_LOOP_RULES,
  RELIABILITY_LOOP_NONCLAIMS,
  RELIABILITY_SERVER_IDS,
  RELIABILITY_POLL_INTERVAL_MS,
  ROTATION_REFUSAL_BELOW_BREAKER,
  reliabilityClosureProblems,
  type ReliabilityResults,
} from '../core/projection/reliability-loop.js';
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

const need = (args: Args, name: string): string =>
  args.flags.get(name) ?? fail(`--${name} is required`);

/**
 * Read the results document the gate has been appending to.
 *
 * IT IS TWO FILES ON DISK AND ONE DOCUMENT HERE. The verdicts are JSON Lines because a shell appending to a
 * JSON array is a shell rewriting a file two hundred times, and a run killed mid-rewrite leaves neither the
 * old document nor the new one. The cycle list is the same shape for the same reason.
 *
 * A LINE THAT DOES NOT PARSE IS A FAILURE, NEVER A SKIP. Dropping unreadable lines would turn a truncated
 * write — the exact thing JSON Lines is chosen to survive — into a shorter run that passed.
 */
function readResults(resultsPath: string, cyclesPath: string): ReliabilityResults {
  const parseLines = <T>(path: string, what: string): T[] => {
    if (!existsSync(path)) fail(`${what} (${path}) does not exist; the run wrote nothing to judge`);
    const out: T[] = [];
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
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
    cycles: parseLines<{ cycle: number; arm: string }>(cyclesPath, 'the cycle log'),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    // -----------------------------------------------------------------------------------------------------
    case 'budgets': {
      // THE ONE PLACE THE NUMBERS LEAVE THE MODULE. `--sh` emits assignments a POSIX shell can `eval`; the
      // default emits them one per line for a human.
      const shell = args.bare.has('sh');
      const entries = Object.entries(RELIABILITY_LOOP_RULES);
      for (const [key, value] of entries) {
        if (shell) console.log(`RL_${key}=${String(value)}`);
        else console.log(`  ${key.padEnd(30)} ${String(value)}`);
      }
      if (shell) {
        console.log(`RL_ARMS='${RELIABILITY_LOOP_ARMS.join(' ')}'`);
        console.log(`RL_SERVERS='${RELIABILITY_SERVER_IDS.join(' ')}'`);
        // THE POLL INTERVAL TRAVELS WITH THE BUDGETS BECAUSE `READY_BUDGET_MS` IS DERIVED FROM IT. A gate
        // that configured its daemon with one interval while the budget was derived from another would be
        // measuring against a ceiling nothing on the run had agreed to.
        console.log(`RL_POLL_INTERVAL_MS=${RELIABILITY_POLL_INTERVAL_MS}`);
      }
      // A DERIVED FACT THE CONTRACT DEPENDS ON, CHECKED WHERE IT IS PUBLISHED. If A5's refusal half could
      // reach the breaker threshold, the arm would be measuring A4 under A5's name — so the gate cannot even
      // load its budgets when that stops holding.
      if (!ROTATION_REFUSAL_BELOW_BREAKER) {
        fail('the rotation refusal bound is no longer strictly under the breaker threshold; A5 would open '
          + 'the breaker A4 is about, and the two arms would no longer be measuring different things');
      }
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'arms': {
      for (const arm of RELIABILITY_LOOP_ARMS) console.log(`  ${arm}  ${RELIABILITY_ARM_TITLES[arm]}`);
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'close': {
      // WHERE A RUN EITHER CLOSED OR DID NOT, AND NOTHING ELSE DECIDES IT.
      const document = readResults(need(args, 'results'), need(args, 'cycles'));
      const problems = reliabilityClosureProblems(document);
      const passed = document.results.filter((result) => result.verdict === 'pass').length;
      const failed = document.results.filter((result) => result.verdict === 'fail').length;
      const skipped = document.results.filter((result) => result.verdict === 'skip').length;
      console.log(`  ${document.cycles.length} cycle(s), ${document.results.length} verdict(s): `
        + `${passed} pass, ${failed} fail, ${skipped} skip`);
      if (problems.length > 0) {
        for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);
        if (problems.length > 40) console.error(`  ...and ${problems.length - 40} more`);
        fail(`the run does not satisfy the predeclared closure rule (${problems.length} problem(s))`);
      }
      console.log('  every predeclared cycle, arm, phase and budget is present, terminal and passing');
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'report': {
      const document = readResults(need(args, 'results'), need(args, 'cycles'));
      console.log('  cycle  arm  what it was');
      for (const record of document.cycles) {
        const arm = record.arm as keyof typeof RELIABILITY_ARM_TITLES;
        console.log(`  ${String(record.cycle).padStart(5)}  ${record.arm}   `
          + `${RELIABILITY_ARM_TITLES[arm] ?? 'an arm this contract does not define'}`);
      }
      // THE NUMBERS, EVERY ONE OF THEM, AGAINST THE BUDGET IT WAS MEASURED AGAINST. §7 of the acceptance plan
      // asks for the measured figure and not for a verdict, because a verdict hides a measurement that has
      // been creeping toward its ceiling.
      console.log('  measured figures:');
      for (const result of document.results) {
        if (typeof result.measured !== 'number') continue;
        console.log(`    ${result.gate.padEnd(44)} ${String(result.measured).padStart(9)}`
          + ` / ${String(result.budget ?? '-')}  ${result.verdict}`);
      }
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'redaction-check': {
      const path = need(args, 'file');
      if (!existsSync(path)) fail('a kept artifact does not exist');
      // EVERY LINE OF THE VERDICT LOG, not the file as one blob: it is JSON Lines, so `JSON.parse` over the
      // whole thing throws and a `catch` that shrugged would report a clean artifact it never read.
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
      for (const line of RELIABILITY_LOOP_NONCLAIMS) console.log(`  - ${line}`);
      return;
    }

    default:
      fail(`unknown command: ${args.command || '(none)'}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`projection-reliability-loop: ${(error as Error).message}`);
  process.exit(1);
}
