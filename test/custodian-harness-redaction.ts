import {
  runCustodianContractTest, resetCustodianContractResults, custodianContractSummaryLines, formatHarnessFailure,
} from './helpers/custodian-contract-kit.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

// Sentinel "secret material" a real KMS/client error could embed in its message AND stack.
const TOKEN = 'tok_LIVE_sentinel_abcdef123456';
const ENDPOINT = 'https://kms.internal:8443/v1/keys/key_9999';
const DBURL = 'postgres://user:p@ssw0rd@db.internal:5432/catalog';
const SENTINELS = [TOKEN, ENDPOINT, DBURL, 'key_9999', 'kms.internal', 'p@ssw0rd', '/run/secrets/kek'];

/** A KMS-style error with sentinel secrets in BOTH message and stack. */
function leakyError(): Error {
  const e = new Error(`KMS request failed token=${TOKEN} endpoint=${ENDPOINT} ${DBURL} keyPath=/run/secrets/kek`);
  e.name = 'KmsClientError';
  Object.defineProperty(e, 'stack', { value: `KmsClientError: token=${TOKEN}\n    at kms (${ENDPOINT})\n    at load (/run/secrets/kek)`, configurable: true });
  return e;
}

/** Capture console.log output while running `fn`. */
async function capture(fn: () => Promise<void> | void): Promise<string> {
  const orig = console.log;
  const buf: string[] = [];
  console.log = (...a: unknown[]): void => { buf.push(a.map(String).join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return buf.join('\n');
}
const noSentinel = (s: string): boolean => SENTINELS.every((x) => !s.includes(x));

async function main(): Promise<void> {
  console.log('Running custodian-harness redaction suite:\n');

  await test('formatHarnessFailure — class/category only; no message, stack, or secret material', () => {
    const out = formatHarnessFailure(leakyError());
    assert(noSentinel(out), 'no sentinel secret in the formatted failure');
    assert(out.includes('KmsClientError'), 'includes the safe error class');
    assert(/redacted/i.test(out), 'states the message is redacted');
  });

  await test('DEFAULT harness FAIL line — a leaky adapter error is redacted (no sentinel)', async () => {
    delete process.env.CUSTODIAN_HARNESS_VERBOSE;
    resetCustodianContractResults();
    const out = await capture(() => runCustodianContractTest('leaky adapter', () => { throw leakyError(); }));
    assert(noSentinel(out), 'the default FAIL line must not leak any sentinel');
    assert(/FAIL {2}leaky adapter/.test(out) && out.includes('KmsClientError'), 'redacted FAIL line present');
  });

  await test('DEFAULT summary lines — redaction-safe (no sentinel)', async () => {
    delete process.env.CUSTODIAN_HARNESS_VERBOSE;
    resetCustodianContractResults();
    await capture(() => runCustodianContractTest('leaky adapter', () => { throw leakyError(); }));
    const summary = custodianContractSummaryLines().join('\n');
    assert(noSentinel(summary), 'the default summary must not leak any sentinel');
    assert(summary.includes('1 failed') && summary.includes('KmsClientError'), 'redacted summary present');
  });

  await test('non-string thrown value is also redacted (no raw dump)', async () => {
    delete process.env.CUSTODIAN_HARNESS_VERBOSE;
    resetCustodianContractResults();
    const weird = { secret: TOKEN, url: ENDPOINT };
    const out = await capture(() => runCustodianContractTest('weird throw', () => { throw weird; }));
    assert(noSentinel(out), 'a non-Error thrown value must not be dumped raw');
  });

  await test('VERBOSE debug mode (gated) — raw detail is shown but labeled [debug/non-evidence]', async () => {
    process.env.CUSTODIAN_HARNESS_VERBOSE = '1';
    resetCustodianContractResults();
    const failLine = await capture(() => runCustodianContractTest('leaky adapter', () => { throw leakyError(); }));
    const summary = custodianContractSummaryLines().join('\n');
    assert(failLine.includes(TOKEN) || summary.includes(TOKEN), 'verbose mode DOES surface raw detail for local debugging');
    assert(/\[debug\/non-evidence\]/.test(failLine) && /\[debug\/non-evidence\]/.test(summary), 'raw detail is clearly labelled non-evidence');
    delete process.env.CUSTODIAN_HARNESS_VERBOSE;
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('\nFailures:'); for (const [n, e] of failures) console.log(`  - ${n}: ${(e as Error).stack ?? e}`); process.exit(1); }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
