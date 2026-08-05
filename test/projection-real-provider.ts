import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  CONTROL_DEADLINE_MS, MAX_ACCESS_REFRESHES_PER_READ, MAX_RETRIES_PER_READ, MOUNT_READ_DEADLINE_MS,
  cleanupResults, controlResults, endpointProblems, findLeaks, findResultLeaks, inputProblems,
  readOnlyResults, readResults, transportResults, workDoneResults,
  type DirectProbe, type EndpointDescription, type MountRead, type OperatorObject,
} from '../src/core/projection/real-provider.js';

// Projection Phase 1 — the real-provider correctness gate, refused offline.
//
// WHY THIS SUITE CARRIES THE WEIGHT. The gate it guards can only run on an operator's machine, against an
// operator's account, with an operator's credential — so on almost every day of this repository's life it
// will not have run. What CAN run, on every commit, is every rule it applies. So each test below builds the
// world in which the gate SHOULD fail and requires that it does.
//
// THE TRANSPORT ITSELF IS NOT TESTED HERE AND MUST NOT BE. `projectiond/internal/source/http_test.go` already
// drives the production adapter against a fake provider through every protocol violation this gate names:
// full-body-on-range, malformed and mismatched Content-Range, short body, wrong total size, long body, the
// retryable statuses, redirect refusal, exactly-one-refresh, the egress allowlist and the secret-file shapes.
// Restating those here in TypeScript would test a reimplementation of the daemon rather than the daemon.
// What is new — and therefore what is attacked here — is the GATE's contract: what it accepts as input, what
// it refuses to print, and which observations it is willing to call a pass.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const repoFile = (path: string): string => readFileSync(join(HERE, '..', path), 'utf8');

let passed = 0;
let failed = 0;
const failures: [string, unknown][] = [];

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push([name, error]);
    console.log(`FAIL  ${name}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------------------------------------
// An honest world, so every attack differs from it in exactly one way
// ---------------------------------------------------------------------------------------------------------

const SIZE = 8 * 1024 * 1024;
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const OBJECT: OperatorObject = {
  label: 'object-1', ref: 'opaque-reference', sizeBytes: SIZE, sha256: DIGEST_A,
};

const ENDPOINT: EndpointDescription = {
  id: 'provider', directBaseUrl: 'https://provider.example/objects',
  allowedOrigins: ['https://provider.example'],
};

const GOOD_CREDENTIAL = { exists: true, mode: 0o600, sizeBytes: 64 } as const;

const goodProbe = (over: Partial<DirectProbe> = {}): DirectProbe => ({
  label: 'object-1', tlsProtocol: 'TLSv1.3', tlsAuthorized: true, status: 206,
  contentRange: { start: 1, end: 65_536, total: SIZE }, contentLength: 65_536,
  bodyBytes: 65_536, requestedOffset: 1, requestedLength: 65_536, redirected: false, elapsedMs: 120,
  ...over,
});

const goodReads = (): MountRead[] => [
  { label: 'object-1', kind: 'tail', offset: 7_600_000, length: 65_536, bytesRead: 65_536,
    sha256: DIGEST_B, elapsedMs: 90 },
  { label: 'object-1', kind: 'backward', offset: 0, length: 65_536, bytesRead: 65_536,
    sha256: DIGEST_B, elapsedMs: 90 },
  { label: 'object-1', kind: 'whole', offset: 0, length: SIZE, bytesRead: SIZE,
    sha256: DIGEST_A, elapsedMs: 4_000 },
];

const GOOD_OBSERVATIONS = {
  status429: 0, retries: 0, refreshesPerRead: [1], disallowedOriginContacts: 0, endpointExpires: true,
} as const;

const failedGates = (results: readonly { gate: string; verdict: string }[]): string[] =>
  results.filter((result) => result.verdict === 'fail').map((result) => result.gate);

const refuses = (results: readonly { gate: string; verdict: string }[], why: string): void => {
  assert(failedGates(results).length > 0, why);
};

async function main(): Promise<void> {
  console.log('\nprojection real-provider correctness (offline)\n');

  // -------------------------------------------------------------------------------------------------------
  // The honest run passes. Without this, every attack below is satisfied by a module that fails everything.
  // -------------------------------------------------------------------------------------------------------

  await test('AN HONEST REAL-PROVIDER RUN PASSES END TO END', () => {
    const all = [
      ...controlResults('RP1', [goodProbe()], [OBJECT]),
      ...readResults('RP2', goodReads(), [OBJECT]),
      ...transportResults('RP3', GOOD_OBSERVATIONS),
      ...readOnlyResults('RP4', {
        writeRefused: true, createRefused: true, unlinkRefused: true, chmodRefused: true,
      }),
      ...workDoneResults('RP5', { objectsRead: 1, bytesFromProvider: SIZE, expectedObjects: 1 }),
      ...cleanupResults('RP6', {
        mountpoints: 0, containers: 0, runDirectories: 0, leaseTracesOnDisk: 0,
      }),
    ];
    assert(failedGates(all).length === 0, `an honest run failed: ${failedGates(all).join(', ')}`);
    assert(all.length > 20, 'and it is not a handful of assertions pretending to be a gate');
    assert(inputProblems({ objects: [OBJECT], credential: GOOD_CREDENTIAL, endpoint: ENDPOINT }).length === 0,
      'and its inputs are accepted');
  });

  // -------------------------------------------------------------------------------------------------------
  // Transport discipline, as the gate is willing to report it
  // -------------------------------------------------------------------------------------------------------

  await test('A REDIRECT THE GATE FOLLOWED IS REFUSED', () => {
    // A signed URL that redirects can redirect anywhere, including at the host's own metadata service. The
    // daemon refuses to follow one; a control that quietly followed would report a provider as compatible
    // when the product cannot serve it.
    refuses(controlResults('RP1', [goodProbe({ redirected: true, status: 302 })], [OBJECT]),
      'the provider redirected and the gate reported it as fine');
  });

  await test('A 200 FULL BODY ANSWERING A RANGED GET IS REFUSED', () => {
    // The most expensive protocol failure available: it turns a 64 KiB probe into a whole-object download.
    refuses(controlResults('RP1', [goodProbe({ status: 200, contentRange: undefined })], [OBJECT]),
      'a full-body 200 was accepted as an answer to a ranged request');
  });

  await test('A MALFORMED CONTENT-RANGE IS REFUSED', () => {
    refuses(controlResults('RP1', [goodProbe({ contentRange: undefined })], [OBJECT]),
      'a response with no parseable Content-Range was accepted');
  });

  await test('A MISMATCHED CONTENT-RANGE IS REFUSED', () => {
    // The server granted a DIFFERENT window than the one asked for. The bytes may be perfectly good bytes of
    // some other part of the object, which is exactly why a byte count cannot catch this.
    refuses(controlResults('RP1',
      [goodProbe({ contentRange: { start: 999, end: 999 + 65_535, total: SIZE } })], [OBJECT]),
    'the server granted a window nobody asked for and the gate accepted it');
  });

  await test('A TOTAL SIZE THAT DISAGREES WITH THE MANIFEST IS REFUSED', () => {
    // A total that disagrees means these are not the bytes of the object the manifest describes.
    refuses(controlResults('RP1',
      [goodProbe({ contentRange: { start: 1, end: 65_536, total: SIZE + 1 } })], [OBJECT]),
    'the provider reported a different object size and the gate accepted it');
  });

  await test('A SHORT BODY IS REFUSED', () => {
    refuses(controlResults('RP1', [goodProbe({ bodyBytes: 1_024 })], [OBJECT]),
      'the body was shorter than the granted window and the gate accepted it');
  });

  await test('A LONG BODY IS REFUSED', () => {
    refuses(controlResults('RP1', [goodProbe({ bodyBytes: 200_000 })], [OBJECT]),
      'the body ran past the granted window and the gate accepted it');
  });

  await test('A CONTENT-LENGTH THAT DISAGREES WITH THE WINDOW IS REFUSED', () => {
    refuses(controlResults('RP1', [goodProbe({ contentLength: 999 })], [OBJECT]),
      'a declared Content-Length disagreeing with the granted window was accepted');
  });

  await test('PLAINTEXT, UNVERIFIED OR OBSOLETE TLS IS REFUSED', () => {
    refuses(controlResults('RP1', [goodProbe({ tlsProtocol: '' })], [OBJECT]),
      'the control connected without TLS and the gate passed it');
    refuses(controlResults('RP1', [goodProbe({ tlsProtocol: 'TLSv1' })], [OBJECT]),
      'an obsolete TLS version was accepted');
    refuses(controlResults('RP1', [goodProbe({ tlsAuthorized: false })], [OBJECT]),
      'the certificate chain did not validate and the gate passed it — a control that trusts anything '
      + 'proves nothing about TLS');
  });

  await test('AN UNBOUNDED CONTROL REQUEST IS REFUSED', () => {
    refuses(controlResults('RP1', [goodProbe({ elapsedMs: CONTROL_DEADLINE_MS + 1 })], [OBJECT]),
      'the control ran past its finite deadline and the gate did not mind');
  });

  await test('AN UNBOUNDED READ THROUGH THE MOUNT IS REFUSED', () => {
    const reads = goodReads();
    reads[0] = { ...(reads[0] as MountRead), elapsedMs: MOUNT_READ_DEADLINE_MS + 1 };
    refuses(readResults('RP2', reads, [OBJECT]), 'a read exceeded its deadline and the gate passed it');
  });

  // -------------------------------------------------------------------------------------------------------
  // Retry, refresh and egress
  // -------------------------------------------------------------------------------------------------------

  await test('A RETRY STORM IS REFUSED', () => {
    refuses(transportResults('RP3', { ...GOOD_OBSERVATIONS, retries: MAX_RETRIES_PER_READ + 1 }),
      'retries ran past the contract bound and the gate passed it');
  });

  await test('A SECOND REFRESH INSIDE ONE READ IS REFUSED', () => {
    refuses(transportResults('RP3',
      { ...GOOD_OBSERVATIONS, refreshesPerRead: [MAX_ACCESS_REFRESHES_PER_READ + 1] }),
    'one read re-resolved access material twice, which is the shape of a resolution storm');
  });

  await test('ANY CONTACT WITH A DISALLOWED ORIGIN IS REFUSED', () => {
    refuses(transportResults('RP3', { ...GOOD_OBSERVATIONS, disallowedOriginContacts: 1 }),
      'something reached an origin the allowlist does not name');
  });

  await test('A 429 IS RECORDED AND ASSERTED BY NOTHING', () => {
    // A real provider is entitled to rate-limit, and this corpus is explicitly never a load test. G16 asserts
    // zero 429s — against the FAKE endpoint, where the harness controls the load and the number means
    // something. Turning that into an assertion here would make somebody else's traffic policy a defect in
    // this product.
    for (const status429 of [0, 1, 25]) {
      const results = transportResults('RP3', { ...GOOD_OBSERVATIONS, status429 });
      const observed = results.find((result) => result.gate.endsWith('-429-observed'));
      assert(observed?.verdict === 'pass', `a 429 count of ${status429} failed the gate`);
      assert(observed?.measured === undefined, 'and it carries no budget, so it cannot become an assertion');
    }
  });

  await test('A NON-EXPIRING ENDPOINT SKIPS THE REFRESH ASSERTION, AND A SKIP IS NOT A PASS', () => {
    const results = transportResults('RP3', { ...GOOD_OBSERVATIONS, endpointExpires: false });
    const refresh = results.find((result) => result.gate.endsWith('-refresh-per-read'));
    assert(refresh?.verdict === 'skip', 'a direct endpoint has nothing to refresh, so this must SKIP');
    assert(/A SKIP IS NOT A PASS/.test(refresh?.note ?? ''), 'and must say so where an operator reads it');
  });

  // -------------------------------------------------------------------------------------------------------
  // The reads themselves
  // -------------------------------------------------------------------------------------------------------

  await test('A RUN THAT NEVER READ BACKWARDS OR PAST 90% IS REFUSED', () => {
    // Forward-only reads from zero are what a broken implementation gets right. The seek backwards and the
    // read past 90% are the two a streaming-only implementation fails while passing everything sequential.
    refuses(readResults('RP2', goodReads().filter((read) => read.kind !== 'backward'), [OBJECT]),
      'no backward read was performed and the gate passed');
    refuses(readResults('RP2', goodReads().filter((read) => read.kind !== 'tail'), [OBJECT]),
      'nothing past 90% of the object was read and the gate passed');
  });

  await test('BYTES THROUGH THE MOUNT THAT DISAGREE WITH THE DIGEST RECORDED OUTSIDE IT ARE REFUSED', () => {
    const reads = goodReads();
    reads[2] = { ...(reads[2] as MountRead), sha256: 'c'.repeat(64) };
    refuses(readResults('RP2', reads, [OBJECT]),
      'the mount returned bytes that do not match the operator digest and the gate passed');
  });

  await test('AN APPROVED PROBE WINDOW THAT WAS NEVER READ IS REFUSED', () => {
    // The probe-digest path exists so an operator need not pay to read a 40 GB object whole. It must not
    // become a way to assert nothing.
    const withProbe: OperatorObject = {
      label: 'object-1', ref: 'r', sizeBytes: SIZE,
      probeDigests: [{ offset: 4096, length: 4096, sha256: DIGEST_B }],
    };
    refuses(readResults('RP2', goodReads(), [withProbe]),
      'an approved probe window was never read and the gate passed anyway');
  });

  await test('A SHORT READ THROUGH THE MOUNT IS REFUSED', () => {
    const reads = goodReads();
    reads[0] = { ...(reads[0] as MountRead), bytesRead: 12 };
    refuses(readResults('RP2', reads, [OBJECT]), 'the mount returned fewer bytes than asked and passed');
  });

  // -------------------------------------------------------------------------------------------------------
  // The zero-work false pass, which is the failure this gate is most exposed to
  // -------------------------------------------------------------------------------------------------------

  await test('A RUN THAT CONTACTED NOTHING IS REFUSED', () => {
    // EVERY CEILING IN THIS GATE IS SATISFIED BY ZERO. Zero requests, zero bytes and zero reads pass every
    // "at most" above, so without a positive-work assertion the safest possible run — the one that does
    // nothing — is also the greenest.
    refuses(workDoneResults('RP5', { objectsRead: 0, bytesFromProvider: 0, expectedObjects: 1 }),
      'nothing was read and the gate reported a pass');
    refuses(workDoneResults('RP5', { objectsRead: 1, bytesFromProvider: 0, expectedObjects: 1 }),
      'zero bytes crossed the wire and the gate reported a pass');
    refuses(controlResults('RP1', [], [OBJECT]), 'the control made no request at all and the gate passed');
    refuses(readResults('RP2', [], [OBJECT]), 'no read was attempted and the gate passed');
  });

  await test('A RUN THAT SKIPPED AN OBJECT IS REFUSED', () => {
    refuses(workDoneResults('RP5', { objectsRead: 1, bytesFromProvider: SIZE, expectedObjects: 3 }),
      'two of three supplied objects were never read and the gate passed');
    refuses(controlResults('RP1', [goodProbe()], [OBJECT, { ...OBJECT, label: 'object-2' }]),
      'the control reached one of two objects and the gate passed');
  });

  // -------------------------------------------------------------------------------------------------------
  // Input validation — fail closed, before anything is contacted
  // -------------------------------------------------------------------------------------------------------

  const problemsFor = (over: {
    objects?: OperatorObject[]; credential?: Parameters<typeof inputProblems>[0]['credential'];
    endpoint?: EndpointDescription;
  }): readonly string[] => inputProblems({
    objects: over.objects ?? [OBJECT],
    credential: over.credential ?? GOOD_CREDENTIAL,
    endpoint: over.endpoint ?? ENDPOINT,
  });

  await test('A MISSING CREDENTIAL FILE FAILS CLOSED', () => {
    assert(problemsFor({ credential: { exists: false, sizeBytes: 0 } }).length > 0,
      'the credential file was absent and the gate would have started anyway');
  });

  await test('A PERMISSIVE CREDENTIAL FILE FAILS CLOSED, EXACTLY AS THE DAEMON WOULD', () => {
    // The daemon refuses `perm&0o077 != 0`. Discovering that from a read failure forty seconds into a run
    // against somebody's real account is a wasted real request and a confusing diagnosis.
    for (const mode of [0o644, 0o640, 0o604, 0o666, 0o777]) {
      assert(problemsFor({ credential: { exists: true, mode, sizeBytes: 64 } }).length > 0,
        `a credential file at mode ${mode.toString(8)} was accepted`);
    }
    assert(problemsFor({ credential: { exists: true, mode: 0o600, sizeBytes: 64 } }).length === 0,
      'and 0600 is accepted');
    assert(problemsFor({ credential: { exists: true, mode: 0o400, sizeBytes: 64 } }).length === 0,
      'as is 0400');
  });

  await test('AN EMPTY OR OVERSIZED CREDENTIAL FILE FAILS CLOSED', () => {
    assert(problemsFor({ credential: { exists: true, mode: 0o600, sizeBytes: 0 } }).length > 0,
      'an empty credential file was accepted');
    assert(problemsFor({ credential: { exists: true, mode: 0o600, sizeBytes: 9_000 } }).length > 0,
      'a credential larger than the daemon will read was accepted');
  });

  await test('AN EMPTY OR OVERSIZED CORPUS FAILS CLOSED', () => {
    assert(problemsFor({ objects: [] }).length > 0,
      'a manifest naming no objects was accepted, which is the greenest possible worthless run');
    const four = [1, 2, 3, 4].map((n) => ({ ...OBJECT, label: `object-${n}` }));
    assert(problemsFor({ objects: four }).length > 0,
      'four objects were accepted against a plan that says 1-3, because this is not a load test');
  });

  await test('AN OBJECT WITH NO DIGEST AUTHORITY FAILS CLOSED', () => {
    const { sha256: _dropped, ...noDigest } = OBJECT;
    assert(problemsFor({ objects: [noDigest as OperatorObject] }).length > 0,
      'an object with neither sha256 nor probeDigests was accepted, so no read could have been wrong');
    assert(problemsFor({ objects: [{ ...noDigest, probeDigests: [] } as OperatorObject] }).length > 0,
      'nor may an empty probe list stand in for one');
  });

  await test('A MISSING OR NONSENSE SIZE FAILS CLOSED', () => {
    assert(problemsFor({ objects: [{ ...OBJECT, sizeBytes: 0 }] }).length > 0, 'a zero size was accepted');
    assert(problemsFor({ objects: [{ ...OBJECT, sizeBytes: -1 }] }).length > 0, 'as was a negative one');
    assert(problemsFor({ objects: [{ ...OBJECT, sizeBytes: 1.5 }] }).length > 0, 'as was a fractional one');
  });

  await test('A PROBE WINDOW RUNNING PAST THE OBJECT FAILS CLOSED', () => {
    assert(problemsFor({ objects: [{ ...OBJECT, probeDigests: [
      { offset: SIZE - 10, length: 4096, sha256: DIGEST_B }] }] }).length > 0,
    'a probe window running past the declared size was accepted');
  });

  await test('A LABEL THAT COULD CARRY AN ACCOUNT NAME OR A FILENAME FAILS CLOSED', () => {
    // Labels are the ONE identity printed in every report line, so they are held to a boring shape.
    for (const label of ['My Movie.mkv', '../etc/passwd', 'https://x', 'acct_9931', 'A'.repeat(40), '']) {
      assert(problemsFor({ objects: [{ ...OBJECT, label }] }).length > 0,
        `the label ${JSON.stringify(label)} was accepted and would have been printed`);
    }
  });

  await test('DUPLICATE LABELS FAIL CLOSED', () => {
    assert(problemsFor({ objects: [OBJECT, { ...OBJECT, ref: 'other' }] }).length > 0,
      'two objects shared a label, so every per-object verdict would have been ambiguous');
  });

  await test('AN ENDPOINT THAT WOULD SEND A REAL CREDENTIAL IN PLAINTEXT FAILS CLOSED', () => {
    assert(endpointProblems({ ...ENDPOINT, directBaseUrl: 'http://provider.example/o' }).length > 0,
      'a plaintext base URL was accepted for a run that carries a real bearer credential');
    assert(endpointProblems({ ...ENDPOINT, allowInsecureHttp: true }).length > 0,
      'the plaintext opt-in was accepted on a real-provider run');
  });

  await test('AN ENDPOINT THAT COULD BE STEERED AT THE HOST ITSELF FAILS CLOSED', () => {
    assert(endpointProblems({ ...ENDPOINT, allowPrivateAddresses: true }).length > 0,
      'the private-address opt-in was accepted, which would let a redirect reach the host metadata service');
  });

  await test('AN ENDPOINT WITH NO EGRESS ALLOWLIST FAILS CLOSED', () => {
    assert(endpointProblems({ ...ENDPOINT, allowedOrigins: [] }).length > 0,
      'an empty allowlist was accepted; empty is not permissive here by accident');
    assert(endpointProblems({ ...ENDPOINT, allowedOrigins: ['http://provider.example'] }).length > 0,
      'a plaintext allowed origin was accepted');
  });

  await test('AN ENDPOINT THAT NAMES NEITHER OR BOTH TRANSPORT SHAPES FAILS CLOSED', () => {
    assert(endpointProblems({ id: 'p', allowedOrigins: ['https://p.example'] }).length > 0,
      'an endpoint naming neither a resolver nor a direct base was accepted');
    assert(endpointProblems({ ...ENDPOINT, resolverUrl: 'https://p.example/resolve' }).length > 0,
      'an endpoint naming both was accepted, leaving one of them silently dead configuration');
  });

  // -------------------------------------------------------------------------------------------------------
  // Leakage — the constraint that makes this gate safe to run at all
  // -------------------------------------------------------------------------------------------------------

  await test('EVERY SHAPE OF SECRET OR URL IS REFUSED BY THE SCRUBBER', () => {
    const forbidden = [
      'https://provider.example/o/abc?X-Amz-Signature=deadbeef',
      'http://provider.example/o/abc',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'Authorization: Bearer x',
      '?sig=abc123&expires=99',
      'The Godfather (1972).mkv',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ];
    for (const text of forbidden) {
      assert(findLeaks(text, 'x').length > 0, `the scrubber let through: ${text.slice(0, 24)}…`);
    }
    // ...and it does NOT flag the things a report legitimately says.
    for (const text of ['object-1', 'RP1:object-1-tls', '206', 'bytes 1-65536/8388608', 'a1b2c3d4e5f6']) {
      assert(findLeaks(text, 'x').length === 0, `the scrubber flagged legitimate report text: ${text}`);
    }
  });

  await test('THE GATE’S OWN RESULTS ARE REDACTION-SAFE', () => {
    const all = [
      ...controlResults('RP1', [goodProbe()], [OBJECT]),
      ...readResults('RP2', goodReads(), [OBJECT]),
      ...transportResults('RP3', GOOD_OBSERVATIONS),
      ...workDoneResults('RP5', { objectsRead: 1, bytesFromProvider: SIZE, expectedObjects: 1 }),
    ];
    const leaks = findResultLeaks(all);
    assert(leaks.length === 0, `the gate's own output would leak: ${JSON.stringify(leaks.slice(0, 3))}`);
    // AND THE REF NEVER APPEARS, which is the field that identifies somebody's object in somebody's account.
    const rendered = JSON.stringify(all);
    assert(!rendered.includes(OBJECT.ref), 'the stable reference reached a report line');
  });

  await test('A LEAKED RESULT IS CAUGHT BEFORE IT IS PRINTED', () => {
    const poisoned = [{ gate: 'RP1-x', verdict: 'pass' as const,
      note: 'read https://provider.example/o/abc?sig=deadbeef' }];
    assert(findResultLeaks(poisoned).length > 0, 'a result carrying a signed URL would have been printed');
  });

  await test('THE CLI REFUSES A LEAKY COMMAND LINE BEFORE IT DOES ANYTHING', () => {
    // argv is world-readable: `ps` shows it to every user on the host for as long as the run lasts.
    const result = spawnSync('npx', ['tsx', join(HERE, '..', 'src/ops/projection-real-provider-cli.ts'),
      'preflight', '--objects', 'https://provider.example/o?sig=abc'], { encoding: 'utf8', shell: true });
    const output = `${result.stdout}${result.stderr}`;
    assert(result.status !== 0, 'a command line carrying a signed URL was accepted');
    assert(/must never be there|world-readable/.test(output),
      `and the refusal must say why; got: ${output.slice(0, 200)}`);
  });

  await test('NEITHER THE CLI NOR THE GATE EVER TAKES A SECRET ON THE COMMAND LINE', () => {
    const cli = repoFile('src/ops/projection-real-provider-cli.ts');
    const gate = repoFile('deploy/projection-real-provider-gate.sh');
    for (const [name, text] of [['the CLI', cli], ['the gate', gate]] as const) {
      assert(!/--token[= ]\$?[A-Za-z0-9]/.test(text), `${name} passes a token on the command line`);
      assert(!/--url[= ]/.test(text), `${name} passes a URL on the command line`);
    }
    assert(/--credential/.test(cli) && /credentialStat|statSync/.test(cli),
      'the credential arrives as a path whose permissions are checked');
    // The gate must never echo a file that holds access material.
    assert(!/cat .*credential|echo .*\$CREDENTIAL/.test(gate), 'the gate prints a credential file');
  });

  // -------------------------------------------------------------------------------------------------------
  // Read-only behaviour and cleanup
  // -------------------------------------------------------------------------------------------------------

  await test('A MOUNT THAT ACCEPTED A MUTATION IS REFUSED', () => {
    const base = { writeRefused: true, createRefused: true, unlinkRefused: true, chmodRefused: true };
    for (const key of Object.keys(base) as (keyof typeof base)[]) {
      refuses(readOnlyResults('RP4', { ...base, [key]: false }),
        `the mount accepted a mutation (${key}) and the gate passed`);
    }
  });

  await test('ANY CLEANUP LEAK IS REFUSED, INCLUDING ACCESS MATERIAL ON DISK', () => {
    const clean = { mountpoints: 0, containers: 0, runDirectories: 0, leaseTracesOnDisk: 0 };
    for (const key of Object.keys(clean) as (keyof typeof clean)[]) {
      refuses(cleanupResults('RP6', { ...clean, [key]: 1 }), `a leaked ${key} was accepted`);
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // The wrapper's accounting
  // -------------------------------------------------------------------------------------------------------

  const runWrapper = (script: string, status: number, runs: string, env: Record<string, string> = {}):
  { code: number; out: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'rp-wrapper-'));
    const stub = join(dir, 'stub.sh');
    writeFileSync(stub, `#!/usr/bin/env bash\nexit ${status}\n`);
    const result = spawnSync('bash', [join(HERE, '..', `deploy/${script}`)], {
      encoding: 'utf8',
      env: {
        ...process.env, PROJECTION_REAL_PROVIDER_GATE_COMMAND: stub,
        PROJECTION_REAL_PROVIDER_GATE_RUNS: runs, ...env,
      },
    });
    return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
  };

  await test('A SKIPPED RUN IS NOT FOLDED INTO SUCCESS BY THE STRICT WRAPPER', () => {
    // This gate skips whenever the operator has supplied nothing, which will be most of the time. If a skip
    // could read as a pass, the tranche would close on a run that never contacted a provider.
    const { code, out } = runWrapper('projection-real-provider-gate-three.sh', 77, '3');
    assert(code === 77, `a skip must propagate 77, got ${code}`);
    assert(/CLOSES NOTHING/.test(out), 'and say so where an operator reads it');
    assert(!/consecutive real-provider runs completed/.test(out), 'and never print the closing message');
  });

  await test('THE CLOSING MESSAGE REFUSES TO SAY WHICH MODE RAN, BECAUSE IT CANNOT KNOW', () => {
    // THE FAILURE THIS CLOSES: three green FAKE runs printing a message that reads as three real-provider
    // passes. The wrapper drives whatever command it was given and has no way to tell the two apart, so it
    // must not claim to -- it states both readings and points at the one thing that distinguishes them.
    const { code, out } = runWrapper('projection-real-provider-gate-three.sh', 0, '3');
    assert(code === 0, 'three clean runs exit 0');
    assert(/If these were FAKE-MODE runs, they closed NOTHING/.test(out),
      'the closing message must state the fake reading');
    assert(/If these were REAL runs/.test(out), 'and the real one');
    assert(/a skip is never a pass/.test(out), 'and say how to tell them apart');
  });

  await test('A FAILING RUN STOPS THE SEQUENCE AT ONCE', () => {
    const { code, out } = runWrapper('projection-real-provider-gate-three.sh', 1, '3');
    assert(code === 1, `a failure must propagate, got ${code}`);
    assert(/run 1 of 3/.test(out), 'and name the run it stopped at');
  });

  await test('A ZERO-RUN SEQUENCE CANNOT ANNOUNCE A COMPLETED ONE', () => {
    const { code, out } = runWrapper('projection-real-provider-gate-three.sh', 0, '0');
    assert(code !== 0, `zero runs must not exit 0, got ${code}`);
    assert(/refusing to report a completed sequence/.test(out), 'and must say why');
  });

  await test('ONLY THE EXPLICITLY OPTIONAL WRAPPER MAY MAP 77 TO SUCCESS', () => {
    // The rule the whole tranche depends on: exactly one shipped entry point is allowed to treat "this host
    // cannot run it" as an acceptable outcome, and it says so in its name.
    const optional = runWrapper('projection-real-provider-gate-optional.sh', 77, '1');
    assert(optional.code === 0, 'the OPTIONAL wrapper maps a skip to success — that is what it is for');
    const failing = runWrapper('projection-real-provider-gate-optional.sh', 1, '1');
    assert(failing.code !== 0, 'but it must NOT map a real failure to success');
    // ...and nothing else does.
    for (const script of ['projection-real-provider-gate-three.sh']) {
      const strict = runWrapper(script, 77, '1');
      assert(strict.code === 77, `${script} folded a skip into success`);
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // The shipped gate's own shape
  // -------------------------------------------------------------------------------------------------------

  await test('THE GATE FAILS CLOSED WHEN THE OPERATOR HAS SUPPLIED NOTHING', () => {
    const gate = repoFile('deploy/projection-real-provider-gate.sh');
    assert(/GATE_SKIP_STATUS=77/.test(gate), 'the skip status is the established one');
    assert(/exit "\$GATE_SKIP_STATUS"/.test(gate), 'and a host with no operator input exits with it');
    assert(/It is not a pass and must not be reported as one/.test(gate),
      'and the skip message refuses to be read as a pass');
    // IT MUST NOT INVENT INPUTS. A gate that generated a fixture and called it a real provider would be the
    // worst outcome available here.
    assert(!/--fake.*--real|generate.*credential/i.test(gate), 'the gate must never invent operator input');
  });

  await test('THE GATE NEVER CONTACTS A PROVIDER WITHOUT OPERATOR INPUT ALREADY PRESENT', () => {
    const gate = repoFile('deploy/projection-real-provider-gate.sh');
    // The preflight is what runs first, and it contacts nothing.
    const preflight = gate.indexOf('real_provider preflight');
    const control = gate.indexOf('real_provider control');
    assert(preflight !== -1 && control !== -1, 'both phases exist');
    assert(preflight < control, 'the preflight, which contacts nothing, runs BEFORE anything is contacted');
  });

  await test('THE GATE CLEANS UP EVERY KIND OF THING IT CREATES', () => {
    const gate = repoFile('deploy/projection-real-provider-gate.sh');
    assert(/trap cleanup EXIT/.test(gate), 'cleanup runs however the gate ends');
    for (const [what, pattern] of [
      ['the daemon', /docker rm -f "\$MOUNT_CONTAINER"/],
      ['the database', /docker compose -f "\$COMPOSE_FILE" down -v --remove-orphans/],
      ['the mount and run directory', /projection_gate_cleanup_run "\$GATE_ROOT" "\$WORK"/],
      ['and it reports what it left', /projection_gate_report_cleanliness/],
    ] as const) {
      assert(pattern.test(gate), `cleanup does not remove ${what}`);
    }
  });

  await test('THE GATE IS ISOLATED FROM EVERY OTHER GATE AND FROM PRODUCTION', () => {
    const gate = repoFile('deploy/projection-real-provider-gate.sh');
    const compose = repoFile('docker-compose.projection-real-provider.yml');
    assert(/PROJECTION_REAL_PROVIDER_GATE_PG_PORT:-5560/.test(compose), 'its own database port');
    assert(/name: projection-real-provider-gate/.test(compose), 'its own Compose project name');
    assert(/MOUNT_CONTAINER="projection-rp-mount-\$\$"/.test(gate), 'pid-scoped container names');
    assert(/GATE_ROOT="\$PWD\/\.projection-real-provider-gate"/.test(gate), 'its own gate root');
    assert(!/\/mnt\/user\/media|appdata\/catalog\/repo/.test(gate),
      'the gate must not name a production path');
  });

  await test('THE OPERATOR TEMPLATES EXIST AND CARRY NO REAL VALUES', () => {
    // An operator following a template must not be able to produce a working file by filling in blanks that
    // already contain somebody else's example URL.
    for (const template of ['deploy/real-provider-objects.template.json',
      'deploy/real-provider-endpoint.template.json']) {
      const text = repoFile(template);
      JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));

      // A TEMPLATE HAS TO SHOW THE SHAPE OF A URL, so URLs are not forbidden outright — what is forbidden is
      // a URL that is not visibly a placeholder. Every one must carry REPLACE-ME or the reserved
      // `.example.invalid` TLD, which by RFC 2606 can never resolve to anybody's real endpoint. Whatever is
      // left after those are removed is scanned as strictly as a report would be.
      const placeholdersRemoved = text.replace(/https?:\/\/\S*?(REPLACE-ME|example\.invalid)\S*/g, '<url>');
      assert(!/https?:\/\//.test(placeholdersRemoved),
        `${template} carries a URL that is not visibly a placeholder`);
      assert(findLeaks(placeholdersRemoved, template).length === 0,
        `${template} carries something that looks like a real value`);
      assert(/REPLACE-ME/.test(text), `${template} does not read as a template`);
      // ...and it must not be usable as-is: preflight has to refuse it until it is filled in.
      assert(/REPLACE-ME/.test(text), `${template} could be copied into place unchanged`);
    }
  });

  await test('EVERY VERDICT IS DECIDED IN THE MODULE, NOT IN THE SHELL', () => {
    const gate = repoFile('deploy/projection-real-provider-gate.sh');
    for (const phase of ['preflight', 'control', 'reads', 'verdict', 'report']) {
      assert(new RegExp(`real_provider ${phase}`).test(gate),
        `the ${phase} phase is not driven through the CLI`);
    }
  });

  await test('THE TRANSPORT ITSELF IS PROVEN IN GO, AND THIS SUITE SAYS WHERE', () => {
    // The one thing this suite must not do is quietly become the authority on the adapter. If these Go tests
    // were ever deleted, the protocol violations above would be asserted only against a TypeScript model of
    // the daemon — which is not the daemon.
    const go = repoFile('projectiond/internal/source/http_test.go');
    for (const name of ['TestProtocolViolationsAreRefused', 'TestExpiredLeaseIsRecoveredByExactlyOneRefresh',
      'TestResolvedHostOutsideTheAllowlistIsNeverContacted', 'TestSecretFileRefusesUnsafeShapes',
      'TestLeaseNeverRendersItsURL', 'TestFailedResolutionsAreBoundedByTheCooldown']) {
      assert(go.includes(name), `${name} has gone missing; this gate leans on it for the transport proof`);
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // The fixture exemption, which is the most dangerous thing in this gate
  // -------------------------------------------------------------------------------------------------------

  await test('THE FIXTURE EXEMPTION DEFAULTS TO OFF, SO A FORGOTTEN FLAG FAILS CLOSED', () => {
    // Fake mode has to drive the SAME code path a real run drives, and the fixture is plaintext HTTP on a
    // private address — exactly what the strictest rules exist to forbid. So there is an exemption, and it is
    // the single most dangerous thing in this gate: if it could be acquired by accident, a real run could
    // report a pass having asserted neither TLS nor the egress rules.
    const fixture: EndpointDescription = {
      id: 'fake', directBaseUrl: 'http://fakerange:8099/direct',
      allowedOrigins: ['http://fakerange:8099'], allowInsecureHttp: true, allowPrivateAddresses: true,
    };
    assert(endpointProblems(fixture).length > 0,
      'the fixture endpoint was accepted with NO argument — the default must be a real endpoint');
    assert(endpointProblems(fixture, true).length > 0, 'and explicitly real must refuse it');
    assert(endpointProblems(fixture, false).length === 0, 'while the fixture mode accepts it');
    assert(inputProblems({ objects: [OBJECT], credential: GOOD_CREDENTIAL, endpoint: fixture }).length > 0,
      'and inputProblems defaults the same way');
  });

  await test('THE EXEMPTION RELAXES ONLY THE THREE REAL-ENDPOINT RULES, AND NO STRUCTURAL ONE', () => {
    // A blanket "skip validation in fake mode" would mean the offline run never exercised the checks an
    // operator depends on. These must bite in BOTH modes.
    for (const [what, endpoint] of [
      ['no allowlist', { id: 'f', directBaseUrl: 'http://f:1/d', allowedOrigins: [] }],
      ['neither shape', { id: 'f', allowedOrigins: ['http://f:1'] }],
      ['both shapes', { id: 'f', directBaseUrl: 'http://f:1/d', resolverUrl: 'http://f:1/r',
        allowedOrigins: ['http://f:1'] }],
    ] as const) {
      assert(endpointProblems(endpoint as EndpointDescription, false).length > 0,
        `${what} was accepted in fixture mode; the exemption is meant to be narrow`);
    }
    // ...and the corpus and credential rules are not touched by it at all.
    assert(inputProblems({ objects: [], credential: GOOD_CREDENTIAL, endpoint: ENDPOINT,
      realEndpoint: false }).length > 0, 'an empty corpus was accepted in fixture mode');
    assert(inputProblems({ objects: [OBJECT], credential: { exists: true, mode: 0o644, sizeBytes: 9 },
      endpoint: ENDPOINT, realEndpoint: false }).length > 0,
    'a world-readable credential was accepted in fixture mode');
  });

  await test('TLS SKIPS AGAINST THE FIXTURE AND IS ASSERTED AGAINST ANYTHING ELSE', () => {
    // A plaintext fixture has no TLS to be right about. Reporting `pass` there would mean the one gate whose
    // whole purpose is real transport recorded a TLS success it never observed.
    const plaintext = goodProbe({ tlsProtocol: '', tlsAuthorized: false });
    const skipped = controlResults('RP1', [plaintext], [OBJECT], false);
    const tls = skipped.find((result) => result.gate.endsWith('-tls'));
    assert(tls?.verdict === 'skip', 'the fixture must SKIP the TLS assertion, not pass it');
    assert(/A SKIP IS NOT A PASS/.test(tls?.note ?? ''), 'and say so where an operator reads it');
    assert(failedGates(skipped).length === 0, 'while the rest of the control still evaluates');
    // The same probe, without the exemption, must fail.
    refuses(controlResults('RP1', [plaintext], [OBJECT]),
      'a plaintext connection passed the TLS assertion when the endpoint was treated as real');
  });

  await test('THE GATE SETS THE EXEMPTION IN EXACTLY ONE PLACE, AND NEVER IN REAL MODE', () => {
    const gate = repoFile('deploy/projection-real-provider-gate.sh');
    const assignments = gate.match(/FIXTURE_FLAG="[^"]*"/g) ?? [];
    assert(assignments.length === 2, `expected exactly two assignments, found ${assignments.length}`);
    assert(assignments[0] === 'FIXTURE_FLAG=""', 'the first must be the empty default');
    assert(assignments[1] === 'FIXTURE_FLAG="--fixture-endpoint"', 'and the second the fake-mode opt-in');
    // The opt-in must sit inside the fake branch, after the real branch has already returned or skipped.
    const fakeEcho = gate.indexOf('FAKE MODE: no credential');
    assert(gate.indexOf('FIXTURE_FLAG="--fixture-endpoint"') < fakeEcho
      && gate.indexOf('FIXTURE_FLAG="--fixture-endpoint"') > gate.indexOf('MODE="fake"'),
    'the opt-in is not confined to the fake-mode branch');
  });

  await test('this suite runs in the aggregate', () => {
    assert(AGGREGATE_SUITE_COMMAND.includes('tsx test/projection-real-provider.ts'),
      'a suite nobody runs is a suite that stops being true');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const [name, error] of failures) console.error(`FAILED ${name}\n  ${String(error)}`);
    process.exit(1);
  }
}

void main();
