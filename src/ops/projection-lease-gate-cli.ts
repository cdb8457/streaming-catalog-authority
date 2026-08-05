import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { findRedactionProblems, type GateResult } from '../core/projection/media-server-dataplane.js';
import {
  LEASE_GATE_BUDGETS, PINNED_IDENTITY_FIELDS, REFRESHED_RESPONSE_FAULTS,
  allowlistResults, cooldownResults, cooldownSetupResults, leaseExpiryResults, refreshedResponseResults, stampedeResults,
  type CounterSnapshot, type RefreshedResponseObservation,
} from '../core/projection/lease-gates.js';

// Projection Phase 1 — G24, G25 and G26 from the command line.
//
// THE SHELL DRIVES THE WORLD AND THIS DECIDES WHAT IT MEANT. The gate script stands up the daemon, the
// endpoint and the readers, because those are containers; every verdict is taken here, against the rules in
// `core/projection/lease-gates.ts`, so the gate cannot quietly hold a different number than the contract does.
//
//   counters        --url U --out F                       snapshot the endpoint's counters
//   g24             --before F --after F --digest-ok B --identity-before F --identity-after F
//   g25-stampede    --before F --after F --opens N
//   g25-cooldown-setup --before F --after F --failed B
//   g25-cooldown    --before F --after F --failed B --elapsed-ms N --cooldown-ms N --namespace-ok B
//   g26-refreshed   --observations F
//   g26-allowlist   --requests N --failed B --resolutions N
//   report          --results F [--json F]

class GateFailure extends Error {}

function fail(message: string): never {
  console.error(`projection-lease-gate: ${message}`);
  process.exit(1);
}

interface Args { readonly command: string; readonly flags: ReadonlyMap<string, string> }

function parseArgs(argv: readonly string[]): Args {
  const command = argv[0] ?? '';
  const flags = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`);
    const eq = token.indexOf('=');
    if (eq !== -1) { flags.set(token.slice(2, eq), token.slice(eq + 1)); continue; }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) { flags.set(token.slice(2), 'true'); continue; }
    flags.set(token.slice(2), next);
    index += 1;
  }
  return { command, flags };
}

function need(args: Args, name: string): string {
  const value = args.flags.get(name);
  if (value === undefined || value === '') fail(`--${name} is required`);
  return value;
}

function boolFlag(args: Args, name: string): boolean {
  return need(args, name) === 'true';
}

function readJson(path: string): CounterSnapshot {
  return JSON.parse(readFileSync(path, 'utf8')) as CounterSnapshot;
}

function appendResult(path: string, result: GateResult): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = `${JSON.stringify(result)}\n`;
  writeFileSync(path, existsSync(path) ? readFileSync(path, 'utf8') + line : line);
}

function record(args: Args, result: GateResult): void {
  const path = args.flags.get('results');
  if (path !== undefined) appendResult(path, result);
  const measured = result.measured === undefined ? '' : ` measured=${result.measured} budget=${result.budget}`;
  console.log(`  ${result.verdict.toUpperCase()}  ${result.gate}${measured}`
    + `${result.note ? ` — ${result.note}` : ''}`);
  if (result.verdict === 'fail') throw new GateFailure(`${result.gate} failed`);
}

function recordAll(args: Args, results: readonly GateResult[]): void {
  for (const result of results) record(args, result);
}

/**
 * Which of the pinned identity fields moved across a refresh.
 *
 * A MISSING FIELD IS A DRIFTED FIELD, NOT AN ABSENT COMPARISON. If either side does not carry one of the
 * seven, the gate cannot say it was unchanged — and "we could not tell" must never be recorded as "it held".
 */
function identityDrift(before: CounterSnapshot, after: CounterSnapshot): readonly string[] {
  const drifted: string[] = [];
  for (const field of PINNED_IDENTITY_FIELDS) {
    const left = before[field];
    const right = after[field];
    if (left === undefined || right === undefined) { drifted.push(`${field} (not reported)`); continue; }
    if (String(left) !== String(right)) drifted.push(field);
  }
  return drifted;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'counters': {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(need(args, 'url'), { signal: controller.signal })
        .finally(() => clearTimeout(timer));
      if (!response.ok) fail(`the counters endpoint answered ${response.status}`);
      const snapshot = await response.json() as CounterSnapshot;
      writeFileSync(need(args, 'out'), `${JSON.stringify(snapshot, null, 2)}\n`);
      console.log(`  counters recorded (${String(snapshot.bodiesInFlight ?? '?')} body/bodies still writing)`);
      return;
    }

    case 'g24': {
      recordAll(args, leaseExpiryResults('G24', readJson(need(args, 'before')), readJson(need(args, 'after')), {
        bytesMatchedDigest: boolFlag(args, 'digest-ok'),
        identityUnchanged: identityDrift(readJson(need(args, 'identity-before')),
          readJson(need(args, 'identity-after'))),
      }));
      return;
    }

    case 'g25-stampede': {
      recordAll(args, stampedeResults('G25', readJson(need(args, 'before')), readJson(need(args, 'after')), {
        opensObserved: Number(need(args, 'opens')),
      }));
      return;
    }

    case 'g25-cooldown-setup': {
      recordAll(args, cooldownSetupResults('G25-cooldown-setup', readJson(need(args, 'before')),
        readJson(need(args, 'after')), { readFailed: boolFlag(args, 'failed') }));
      return;
    }

    case 'g25-cooldown': {
      recordAll(args, cooldownResults('G25-cooldown', readJson(need(args, 'before')),
        readJson(need(args, 'after')), {
          readFailed: boolFlag(args, 'failed'),
          elapsedMs: Number(need(args, 'elapsed-ms')),
          cooldownMs: Number(need(args, 'cooldown-ms')),
          namespaceUnchanged: boolFlag(args, 'namespace-ok'),
        }));
      return;
    }

    case 'g26-refreshed': {
      const observations = JSON.parse(readFileSync(need(args, 'observations'), 'utf8')) as
        RefreshedResponseObservation[];
      recordAll(args, refreshedResponseResults('G26', observations));
      return;
    }

    case 'g26-allowlist': {
      recordAll(args, allowlistResults('G26-allowlist', {
        requestsToDisallowedHost: Number(need(args, 'requests')),
        readFailed: boolFlag(args, 'failed'),
        resolutionsObserved: Number(need(args, 'resolutions')),
      }));
      return;
    }

    case 'budgets': {
      // What a reader tracing a number back to its clause needs, printed rather than described.
      console.log(JSON.stringify({
        ...LEASE_GATE_BUDGETS,
        REFRESHED_RESPONSE_FAULTS,
        PINNED_IDENTITY_FIELDS,
      }, null, 2));
      return;
    }

    case 'report': {
      const path = need(args, 'results');
      if (!existsSync(path)) fail('there are no results to report, which is itself a failure');
      const results = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as GateResult);
      if (results.length === 0) fail('there are no results to report, which is itself a failure');

      const failed = results.filter((result) => result.verdict === 'fail');
      const skipped = results.filter((result) => result.verdict === 'skip');

      // THE REDACTION RULE IS APPLIED BEFORE THE REPORT IS PRINTED. These gates handle access material, so
      // this matters more here than anywhere else in the suite.
      const problems = findRedactionProblems(results);
      if (problems.length > 0) {
        console.error('the gate report would have leaked:');
        for (const problem of problems.slice(0, 20)) console.error(`  ${problem.kind} at ${problem.at}`);
        fail('the report is not redaction-safe');
      }

      console.log('');
      console.log(`Projection Phase 1 — lease gates G24-G26: ${results.length} assertions, `
        + `${failed.length} failed, ${skipped.length} skipped.`);
      for (const result of results) {
        const measured = result.measured === undefined ? '' : ` ${result.measured}/${result.budget}`;
        console.log(`  ${result.verdict.padEnd(4)} ${result.gate}${measured}`);
      }
      const jsonOut = args.flags.get('json');
      if (jsonOut !== undefined) writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
      if (failed.length > 0) process.exit(1);
      return;
    }

    default:
      fail(`unknown command: ${args.command || '(none)'}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof GateFailure) { console.error(`projection-lease-gate: ${error.message}`); process.exit(1); }
  console.error(`projection-lease-gate: ${(error as Error).message}`);
  process.exit(1);
});
