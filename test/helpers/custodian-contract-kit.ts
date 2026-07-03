import type { KeyCustodian } from '../../src/core/crypto/custodian.js';

export type CustodianFactory = () => KeyCustodian;

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

/**
 * Debug/NON-EVIDENCE mode. Default OFF. When `CUSTODIAN_HARNESS_VERBOSE=1`, the harness ALSO prints raw
 * error messages/stacks on a clearly-labelled `[debug/non-evidence]` line — for local debugging ONLY.
 * That raw output MUST NOT be pasted into shareable readiness/acceptance evidence. Read at print time
 * (not import time) so it is testable. The DEFAULT (evidence) output is always redaction-safe.
 */
function harnessVerbose(): boolean { return process.env.CUSTODIAN_HARNESS_VERBOSE === '1'; }

/**
 * ALLOWLIST of error class/category names that are safe to emit verbatim (fixed code identifiers,
 * never secret-bearing): the JS built-ins, Node's assert, and the harness's OWN modelled failure type.
 * Anything else — including an arbitrary adapter/SDK `err.name` that could embed a key ID, request ID,
 * token fragment, secret path, or endpoint — collapses to the generic `UnknownError` bucket.
 */
const SAFE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError',
  'AggregateError', 'AssertionError', 'CustodianTransportError',
]);

/** Safe error class/category: an ALLOWLISTED name only — never the raw `err.name`, so a secret-laden
 *  name cannot leak. Unknown/untrusted names bucket to `UnknownError`. */
function safeClass(err: unknown): string {
  const raw = err instanceof Error ? (err.name || err.constructor?.name || 'Error')
    : err && typeof err === 'object' ? ((err as { constructor?: { name?: string } }).constructor?.name ?? '')
    : '';
  return SAFE_ERROR_NAMES.has(String(raw)) ? String(raw) : 'UnknownError';
}

/**
 * REDACTION-SAFE failure descriptor for shareable evidence. Emits ONLY the error class/category + a
 * stable generic label. NEVER the raw error message, stack, thrown value, tokens, secret paths, DB URLs,
 * key IDs, endpoints, or adapter config — because a real external/KMS custodian error can embed those.
 */
export function formatHarnessFailure(err: unknown): string {
  return `${safeClass(err)} [message redacted — set CUSTODIAN_HARNESS_VERBOSE=1 for non-evidence debug]`;
}

/** Raw detail — ONLY emitted in the gated non-evidence verbose mode. */
function rawDebugDetail(err: unknown): string {
  return (err instanceof Error ? (err.stack ?? err.message) : String(err)) || '(no detail)';
}

export async function runCustodianContractTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push([name, err]);
    console.log(`  FAIL  ${name}: ${formatHarnessFailure(err)}`);
    if (harnessVerbose()) console.log(`        [debug/non-evidence] ${rawDebugDetail(err)}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}

async function assertThrows(fn: () => Promise<unknown> | unknown, msg: string): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(`expected to throw: ${msg}`);
}

/**
 * Shared custodian conformance kit. Any `KeyCustodian` implementation (InMemory, File, and future
 * external/managed custodians) must pass these. `make()` must return a fresh, isolated custodian on
 * each call. Tests are written to the interface only, with no implementation-specific assumptions.
 */
export async function runCustodianContract(label: string, make: CustodianFactory): Promise<void> {
  await runCustodianContractTest(`${label} — provision returns a keyId + 32-byte DEK; status provisional`, async () => {
    const c = make();
    const { keyId, dek } = await c.provision('op1', 'item-a', 0);
    assert(typeof keyId === 'string' && keyId.length > 0, 'keyId present');
    assertEq(dek.length, 32, 'DEK is 32 bytes');
    assertEq(await c.status(keyId), 'provisional', 'status provisional before commit');
  });

  await runCustodianContractTest(`${label} — commit promotes to active; get returns the same DEK`, async () => {
    const c = make();
    const { keyId, dek } = await c.provision('op1', 'item-a', 0);
    await c.commitProvision('op1');
    const got = await c.get(keyId, 0);
    assertEq(await c.status(keyId), 'active', 'active after commit');
    assert(got.equals(dek), 'get returns the provisioned DEK');
  });

  await runCustodianContractTest(`${label} — get rejects a wrong epoch`, async () => {
    const c = make();
    const { keyId } = await c.provision('op1', 'item-a', 0);
    await c.commitProvision('op1');
    await assertThrows(() => c.get(keyId, 1), 'epoch mismatch rejected');
  });

  await runCustodianContractTest(`${label} — get fails while still provisional (not active)`, async () => {
    const c = make();
    const { keyId } = await c.provision('op1', 'item-a', 0);
    await assertThrows(() => c.get(keyId, 0), 'get before commit rejected');
  });

  await runCustodianContractTest(`${label} — provision is idempotent for an identical operation`, async () => {
    const c = make();
    const a = await c.provision('op1', 'item-a', 0);
    const b = await c.provision('op1', 'item-a', 0);
    assertEq(a.keyId, b.keyId, 'same keyId on retry');
    assert(a.dek.equals(b.dek), 'same DEK on retry');
  });

  await runCustodianContractTest(`${label} — operation_id reused with different inputs is rejected`, async () => {
    const c = make();
    await c.provision('op1', 'item-a', 0);
    await assertThrows(() => c.provision('op1', 'item-b', 0), 'reuse with different inputs rejected');
  });

  await runCustodianContractTest(`${label} — destroy yields a receipt, marks destroyed, and get fails closed`, async () => {
    const c = make();
    const { keyId } = await c.provision('op1', 'item-a', 0);
    await c.commitProvision('op1');
    const r = await c.destroy('d1', keyId);
    assert(r.keyId === keyId && !!r.receiptId && !!r.destroyedAt && !!r.attestation, 'receipt fields present');
    assertEq(await c.status(keyId), 'destroyed', 'status destroyed');
    await assertThrows(() => c.get(keyId, 0), 'get after destroy fails closed');
  });

  await runCustodianContractTest(`${label} — destroy is idempotent on operation_id (stable receipt)`, async () => {
    const c = make();
    const { keyId } = await c.provision('op1', 'item-a', 0);
    await c.commitProvision('op1');
    const r1 = await c.destroy('d1', keyId);
    const r2 = await c.destroy('d1', keyId);
    assertEq(r2.receiptId, r1.receiptId, 'same receipt for the same destroy op');
  });

  await runCustodianContractTest(`${label} — destroy is idempotent on key_id under a new op (stable receipt)`, async () => {
    const c = make();
    const { keyId } = await c.provision('op1', 'item-a', 0);
    await c.commitProvision('op1');
    const r1 = await c.destroy('d1', keyId);
    const r2 = await c.destroy('d2', keyId);
    assertEq(r2.receiptId, r1.receiptId, 'stable receipt across a new destroy op');
  });

  await runCustodianContractTest(`${label} — destroyed is terminal: a late commit cannot reactivate`, async () => {
    const c = make();
    const { keyId } = await c.provision('op1', 'item-a', 0);
    await c.commitProvision('op1');
    await c.destroy('d1', keyId);
    await assertThrows(() => c.commitProvision('op1'), 'commit after destroy rejected');
  });

  await runCustodianContractTest(`${label} — destroy refuses an unknown key (no fabricated tombstone)`, async () => {
    const c = make();
    await assertThrows(() => c.destroy('d1', 'key_nope'), 'destroy(unknown) refused');
    assertEq(await c.status('key_nope'), 'not_found', 'no tombstone fabricated');
  });

  await runCustodianContractTest(`${label} — listStaleProvisioning lists provisional, excludes committed/destroyed`, async () => {
    const c = make();
    const prov = await c.provision('op1', 'item-a', 0);
    const comm = await c.provision('op2', 'item-b', 0);
    await c.commitProvision('op2');
    const dead = await c.provision('op3', 'item-c', 0);
    await c.commitProvision('op3');
    await c.destroy('d3', dead.keyId);
    const stale = await c.listStaleProvisioning();
    const ids = new Set(stale.map((s) => s.keyId));
    assert(ids.has(prov.keyId), 'provisional listed');
    assert(!ids.has(comm.keyId), 'committed not listed');
    assert(!ids.has(dead.keyId), 'destroyed not listed');
  });

  await runCustodianContractTest(`${label} — status of an unseen key is not_found`, async () => {
    assertEq(await make().status('key_never'), 'not_found', 'unseen -> not_found');
  });
}

export function resetCustodianContractResults(): void {
  passed = 0;
  failed = 0;
  failures.length = 0;
}

export function custodianContractResults(): { passed: number; failed: number; failures: Array<[string, unknown]> } {
  return { passed, failed, failures: [...failures] };
}

/** Redaction-safe summary lines (default/evidence mode). Verbose adds gated non-evidence debug lines. */
export function custodianContractSummaryLines(): string[] {
  const lines = [`\n${passed} passed, ${failed} failed.`];
  if (failed > 0) {
    lines.push('\nFailures:');
    for (const [name, err] of failures) {
      lines.push(`  - ${name}: ${formatHarnessFailure(err)}`);
      if (harnessVerbose()) lines.push(`      [debug/non-evidence] ${rawDebugDetail(err)}`);
    }
  }
  return lines;
}

export function reportCustodianContractResults(): void {
  for (const line of custodianContractSummaryLines()) console.log(line);
  if (failed > 0) process.exit(1);
}
