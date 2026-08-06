import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  CONTROL_DEADLINE_MS, MAX_ACCESS_REFRESHES_PER_READ, MAX_RETRIES_PER_READ, MOUNT_READ_DEADLINE_MS,
  cleanupResults, controlResults, endpointProblems, findLeaks, findResultLeaks, inputProblems,
  ownCleanupResults,
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
  // A LISTENER REALLY STOOD UP, which is what makes the egress line an assertion rather than a record. The
  // gate script itself passes `false` here and gets a skip; see the test that pins both directions.
  egressObservedAtListener: true,
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

  await test('A LOOPBACK RESOLVER MAY BE PLAINTEXT, AND NOTHING ELSE MAY BE', () => {
    // WHY THIS EXEMPTION EXISTS. A provider adapter may run as a LOOPBACK-ONLY resolver process
    // holding the provider credential, and the daemon reaches it at http://127.0.0.1:N. Requiring
    // TLS there would mean shipping a certificate authority for a socket that never touches a network
    // interface and that nothing off-host can address. The threat TLS answers has no wire to be on.
    //
    // WHY IT IS THIS NARROW. Everything below must still be refused, or the exemption becomes a way to send
    // a real credential in the clear to somewhere that is not this host.
    const torbox: EndpointDescription = {
      id: 'torbox', resolverUrl: 'http://127.0.0.1:8140/resolve',
      allowedOrigins: ['http://127.0.0.1:8140', 'https://cdn.example.invalid'],
    };
    assert(endpointProblems(torbox).length === 0,
      'the loopback resolver arrangement a provider adapter needs was refused');
    for (const [what, endpoint] of [
      ['a non-loopback plaintext resolver', { ...torbox, resolverUrl: 'http://elsewhere.example/resolve' }],
      ['a plaintext directBaseUrl, which names the PROVIDER and is never on this host',
        { id: 'x', directBaseUrl: 'http://127.0.0.1:9/o', allowedOrigins: ['http://127.0.0.1:9'] }],
      ['a non-loopback plaintext allowed origin',
        { ...torbox, allowedOrigins: ['http://cdn.example.invalid'] }],
      ['userinfo smuggled into a loopback URL', { ...torbox, resolverUrl: 'http://a:b@127.0.0.1:8140/r' }],
      ['a hostname that merely resolves to loopback, which is a DNS answer and can change',
        { ...torbox, resolverUrl: 'http://loopback.example/resolve' }],
    ] as const) {
      assert(endpointProblems(endpoint as EndpointDescription).length > 0, what + ' was accepted');
    }
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
    // `cleanup` is the last of these and the only one that runs AFTER the report. It is here rather than in
    // the shell for the same reason the rest are: a gate that decided its own verdicts could quietly decide
    // to pass. It used to be a shell-side report that could not fail the run at all.
    for (const phase of ['preflight', 'control', 'reads', 'verdict', 'report', 'cleanup']) {
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

  // -------------------------------------------------------------------------------------------------------
  // THE PROGRAMS THE GATE WRITES AT RUN TIME, LIFTED OUT AND EXECUTED
  // -------------------------------------------------------------------------------------------------------
  //
  // WHY THIS SECTION EXISTS. Everything this gate does to an operator's corpus, and every number it hands to
  // the verdict above, is produced by small `.cjs` programs embedded in the shell script as heredocs. The
  // tests before this point drive the VERDICT MODULE, which is falsifiable and well covered — but nothing had
  // ever RUN the programs that FEED it. That is how a gate acquires a measurement that is wrong in a way no
  // assertion can see: the module refuses a leaked mountpoint correctly, and the shell hands it a literal
  // zero for ever. Each test below extracts the shipped program and executes it against real fixtures.

  /** The exact program the gate writes at run time, lifted out of its heredoc. */
  function heredoc(gatePath: string, name: string): string {
    const text = repoFile(gatePath);
    const opener = `cat > "$WORK/${name}" <<'`;
    const start = text.indexOf(opener);
    assert(start !== -1, `${gatePath} does not write ${name}`);
    const delimiterEnd = text.indexOf("'", start + opener.length);
    const delimiter = text.slice(start + opener.length, delimiterEnd);
    const bodyStart = text.indexOf('\n', delimiterEnd) + 1;
    const bodyEnd = text.indexOf(`\n${delimiter}\n`, bodyStart);
    assert(bodyEnd !== -1, `${gatePath} never closes the heredoc for ${name}`);
    return text.slice(bodyStart, bodyEnd);
  }

  const GATE = 'deploy/projection-real-provider-gate.sh';

  /** That program, on disk in a scratch directory, ready to run. */
  function extract(name: string, gatePath = GATE): { dir: string; script: string } {
    const dir = mkdtempSync(join(tmpdir(), 'rpgate-'));
    const script = join(dir, name);
    writeFileSync(script, `${heredoc(gatePath, name)}\n`, 'utf8');
    return { dir, script };
  }

  const runNode = (script: string, args: readonly string[]): { code: number; out: string; err: string } => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    return { code: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' };
  };

  await test('THE LEAK SCAN FINDS A LEAK, AND SAYS SO IN A COUNT AND NOTHING ELSE', () => {
    const { dir, script } = extract('scan.cjs');
    const root = join(dir, 'out');
    mkdirSync(root);
    const credential = join(dir, 'credential');
    const secret = 'rp-fixture-credential-0123456789abcdef';
    writeFileSync(credential, `${secret}\n`);

    // NO LEAK: files that do not carry it.
    writeFileSync(join(root, 'results.json'), JSON.stringify({ gate: 'RP1', verdict: 'pass' }));
    const clean = runNode(script, [credential, root]);
    assert(clean.code === 0 && clean.out.trim() === '0', `a clean run did not report 0: ${clean.out}`);

    // A LEAK, PLANTED THE WAY ONE ACTUALLY HAPPENS — inside a log line.
    writeFileSync(join(root, 'daemon.log'), `GET /object authorization: Bearer ${secret}\n`);
    const leaked = runNode(script, [credential, root]);
    assert(leaked.code === 0 && leaked.out.trim() === '1', `a planted leak was not found: ${leaked.out}`);

    // AND THE MEASUREMENT ITSELF MUST NOT LEAK. Only a count reaches stdout: no filename, no matched line,
    // and above all not the needle, which is what a naive `grep -r` implementation would print.
    assert(!leaked.out.includes(secret) && !leaked.err.includes(secret),
      'the leak scan printed the secret it was searching for');
    assert(!leaked.out.includes('daemon.log') && !leaked.err.includes('daemon.log'),
      'the leak scan named the file the secret was found in');
    assert(/^\d+$/.test(leaked.out.trim()), 'stdout must be a bare count the shell can compare');
  });

  await test('A SECRET TOO SHORT TO SEARCH FOR IS REFUSED, NOT REPORTED AS ZERO LEAKS', () => {
    // THE DEFECT, PROVEN BY RUNNING IT. The scan skipped the walk entirely for a needle under 8 bytes
    // and printed `0`. The shell recorded that as `leaseTracesOnDisk: 0` and the verdict passed
    // `RP6-no-lease-on-disk` — whose note says the value was "searched for by the exact high-entropy value
    // the run used". Nothing had been searched for at all. In a real run the OPERATOR supplies this value.
    const { dir, script } = extract('scan.cjs');
    const root = join(dir, 'out');
    mkdirSync(root);
    const credential = join(dir, 'credential');

    writeFileSync(credential, 'short12\n');
    writeFileSync(join(root, 'daemon.log'), 'authorization: Bearer short12\n');
    const short = runNode(script, [credential, root]);
    assert(short.code !== 0,
      `a 7-byte secret present verbatim in a file the run wrote reported "${short.out.trim()}" and exit `
      + `${short.code}; a zero here is indistinguishable from "did not look"`);
    assert(short.out.trim() === '', 'and it must not print a count it cannot stand behind');

    // THE BOUNDARY IS EXACTLY WHERE THE COMMENT SAYS IT IS: 8 BYTES, accepted; 7, refused. Pinned so the
    // prose and the rule cannot drift apart.
    writeFileSync(credential, 'eightby8\n');
    writeFileSync(join(root, 'daemon.log'), 'authorization: Bearer eightby8\n');
    const boundary = runNode(script, [credential, root]);
    assert(boundary.code === 0 && boundary.out.trim() === '1',
      `an 8-byte secret must be searched for, not refused: exit ${boundary.code} "${boundary.out.trim()}"`);

    // AND IT IS BYTES RATHER THAN CHARACTERS, which is the only reading that is safe for a non-ASCII secret:
    // seven accented characters are fourteen bytes, and refusing them would disable the measurement for a
    // credential that is perfectly decisive.
    const sevenCharsFourteenBytes = 'ééééééé';
    assert(sevenCharsFourteenBytes.length === 7
      && Buffer.byteLength(sevenCharsFourteenBytes, 'utf8') === 14, 'the fixture must be 7 chars / 14 bytes');
    writeFileSync(credential, `${sevenCharsFourteenBytes}\n`);
    writeFileSync(join(root, 'daemon.log'),
      Buffer.from(`authorization: Bearer ${sevenCharsFourteenBytes}\n`, 'utf8'));
    const wide = runNode(script, [credential, root]);
    assert(wide.code === 0 && wide.out.trim() === '1',
      `a 7-character, 14-byte secret was refused, so the rule is counting characters: "${wide.out.trim()}"`);

    // THE SAME LEAK, MUCH LONGER, IS FOUND — so the refusal above is about decisiveness and not about
    // the scanner being broken.
    writeFileSync(credential, 'longer-than-eight\n');
    writeFileSync(join(root, 'daemon.log'), 'authorization: Bearer longer-than-eight\n');
    const long = runNode(script, [credential, root]);
    assert(long.code === 0 && long.out.trim() === '1', `the longer secret was not found: ${long.out}`);
  });

  await test('A SCAN THAT COULD EXAMINE NOTHING IS A FAILURE, BECAUSE ITS ZERO WOULD PROVE NOTHING', () => {
    // A misspelled root was walked in silence and printed `0`, which reads exactly like "no leak".
    const { dir, script } = extract('scan.cjs');
    const credential = join(dir, 'credential');
    writeFileSync(credential, 'rp-fixture-credential-0123456789abcdef\n');
    const missing = runNode(script, [credential, join(dir, 'no-such-directory')]);
    assert(missing.code !== 0,
      `a root that does not exist reported "${missing.out.trim()}" instead of failing`);
    assert(missing.out.trim() === '', 'and printed a count for a walk that opened no file');
  });

  await test('A SECRET IN A LARGE FILE IS FOUND, WHERE A 64 MiB CEILING USED TO HIDE IT', () => {
    // THE DEFECT. `if (info.size > 64 * 1024 * 1024) continue;` skipped large files outright, so the same
    // credential was found in a 32 MiB log and invisible in a 64 MiB one. A daemon log over a long run is
    // exactly the file most likely both to be large and to carry a header.
    const { dir, script } = extract('scan.cjs');
    const root = join(dir, 'out');
    mkdirSync(root);
    const credential = join(dir, 'credential');
    const secret = 'rp-fixture-credential-0123456789abcdef';
    writeFileSync(credential, `${secret}\n`);

    const big = Buffer.alloc(64 * 1024 * 1024 + 4096, 0x2e);
    big.write(`authorization: Bearer ${secret}`, 33 * 1024 * 1024);
    writeFileSync(join(root, 'daemon.log'), big);
    const found = runNode(script, [credential, root]);
    assert(found.code === 0 && found.out.trim() === '1',
      `a secret in a ${big.length}-byte file was not found: exit ${found.code}, "${found.out.trim()}"`);
  });

  await test('A SECRET STRADDLING THE READ BOUNDARY IS STILL FOUND, AND A NON-ASCII ONE MATCHES ITSELF', () => {
    // TWO WAYS A CHUNKED SCANNER GOES QUIETLY WRONG. Reading in fixed chunks without carrying a tail misses
    // any needle that spans a boundary; and decoding the haystack as latin1 while the needle was decoded as
    // utf8 — which is what this program used to do — means a secret with any non-ASCII byte can never match
    // itself, however plainly it is written to disk.
    const { dir, script } = extract('scan.cjs');
    const root = join(dir, 'out');
    mkdirSync(root);
    const credential = join(dir, 'credential');

    const secret = 'rp-boundary-straddling-secret-value';
    writeFileSync(credential, `${secret}\n`);
    const CHUNK = 4 * 1024 * 1024;
    const body = Buffer.alloc(CHUNK + 2 * secret.length, 0x2e);
    // PLANTED SO IT SPANS THE BOUNDARY: half before the 4 MiB mark, half after.
    body.write(secret, CHUNK - Math.floor(secret.length / 2));
    writeFileSync(join(root, 'daemon.log'), body);
    const straddled = runNode(script, [credential, root]);
    assert(straddled.code === 0 && straddled.out.trim() === '1',
      `a secret spanning the read boundary was not found: "${straddled.out.trim()}"`);

    const accented = 'crédentiel-très-sécurisé-0123456789';
    writeFileSync(credential, `${accented}\n`);
    writeFileSync(join(root, 'daemon.log'), Buffer.from(`authorization: Bearer ${accented}\n`, 'utf8'));
    const nonAscii = runNode(script, [credential, root]);
    assert(nonAscii.code === 0 && nonAscii.out.trim() === '1',
      `a non-ASCII secret did not match itself: "${nonAscii.out.trim()}"`);
  });

  await test('THE CLEANUP COUNTERS ARE WHAT THE GATE COUNTED, AND A LEAK REACHES THE VERDICT', () => {
    // THE DEFECT. `observations.cjs` wrote `cleanup: { mountpoints: 0, containers: 0, runDirectories: 0 }`
    // as LITERALS. `cleanupResults` refuses a non-zero for each of them — the tests above prove that — so
    // three assertions were being handed a constant they could never fail against. And they were written at
    // a moment when the mount container was still running by design, so `containers: 0` was not merely
    // unmeasured, it was false.
    const { dir, script } = extract('observations.cjs');
    const out = join(dir, 'observations.json');
    const read = (): {
      cleanup: { mountpoints: number; containers: number; runDirectories: number; leaseTracesOnDisk: number };
      egressObservedAtListener: boolean;
    } => JSON.parse(readFileSync(out, 'utf8'));

    // A CLEAN RUN still records zeros — but now because the gate counted zero, not because it said so.
    const clean = runNode(script, [out, 'true', 'true', 'true', 'true', '0', 'fake', '0', '0', '0']);
    assert(clean.code === 0, `observations.cjs failed on a clean run: ${clean.err.slice(0, 200)}`);
    assert(failedGates(cleanupResults('RP6', read().cleanup)).length === 0,
      'a genuinely clean run must still pass RP6');

    // A LEAK OF EACH KIND MUST REACH THE VERDICT. If these were still literals, every one of these would
    // pass, which is precisely what was happening.
    for (const [index, kind] of [[7, 'mountpoints'], [8, 'containers'], [9, 'runDirectories']] as const) {
      const argv = [out, 'true', 'true', 'true', 'true', '0', 'fake', '0', '0', '0'];
      argv[index] = '1';
      assert(runNode(script, argv).code === 0, `observations.cjs failed writing a leaked ${kind}`);
      const record = read();
      assert(record.cleanup[kind] === 1,
        `a leaked ${kind} did not survive into the record; it is still a literal`);
      refuses(cleanupResults('RP6', record.cleanup), `a leaked ${kind} was accepted by the verdict`);
    }

    // AND A COUNT THAT COULD NOT BE TAKEN IS NOT A COUNT OF ZERO. The shell passes the empty string when the
    // host cannot answer at all (no `findmnt`), and that must fail rather than pass — the same rule §6.0
    // applies to the host preflight's three-valued verdicts.
    // AND A COUNT THE HOST COULD NOT TAKE IS NOT A COUNT OF ZERO. The shell passes the empty string when
    // there is no `findmnt` — every Windows host — and that must not read as "nothing was left behind".
    assert(runNode(script, [out, 'true', 'true', 'true', 'true', '0', 'fake', '', '0', '0']).code === 0,
      'observations.cjs failed on an undetermined mountpoint count');
    // NaN HAS NO JSON SPELLING, so it lands as `null` — which is the point: it is not the number 0.
    const undetermined = read().cleanup.mountpoints as number | null;
    assert(undetermined === null,
      `an unanswerable count must not become a zero; it landed as ${JSON.stringify(undetermined)}`);

    // IT SKIPS RATHER THAN PASSING, AND RATHER THAN FAILING. §6.0 settled this for the host preflight's
    // three-valued verdicts: an unanswerable check is reported, is never a pass, and does not fail a gate for
    // a property of the platform. A hard failure here would break every Windows run of a gate §6 already says
    // closes nothing there.
    const undeterminedResults = cleanupResults('RP6', read().cleanup);
    const mountpoints = undeterminedResults.find((result) => result.gate === 'RP6-mountpoints')!;
    assert(mountpoints.verdict === 'skip',
      `an unanswerable mountpoint count must SKIP, not ${mountpoints.verdict}`);
    assert(/SKIP IS NOT A PASS/.test(mountpoints.note ?? ''), 'and must say a skip is not a pass');
    assert(failedGates(undeterminedResults).length === 0,
      'and must not fail the gate for a property of the platform');

    // BUT WHERE THE HOST CAN ANSWER, IT IS STILL A HARD ASSERTION IN BOTH DIRECTIONS.
    const answerable = { mountpoints: 0, containers: 0, runDirectories: 0, leaseTracesOnDisk: 0 };
    assert(cleanupResults('RP6', answerable)
      .find((result) => result.gate === 'RP6-mountpoints')?.verdict === 'pass',
    'a measured zero must still pass');
    refuses(cleanupResults('RP6', { ...answerable, mountpoints: 1 }),
      'a measured leaked mountpoint must still fail');
  });

  await test('THE EGRESS LINE IS A SKIP WHERE NO LISTENER WATCHED, AND AN ASSERTION WHERE ONE DID', () => {
    // THE DEFECT. `disallowedOriginContacts: 0` was a literal, and `RP3-egress-allowlist` asserted it with a
    // note saying it had been "observed at a listener the gate stands up on the origin it deliberately
    // excluded". This gate stands up no such listener — that sentence belongs to the LEASE gate, which does.
    // So a hard PASS was being reported for a property nothing had measured.
    const { dir, script } = extract('observations.cjs');
    const out = join(dir, 'observations.json');
    assert(runNode(script, [out, 'true', 'true', 'true', 'true', '0', 'fake', '0', '0', '0']).code === 0,
      'observations.cjs failed');
    const record = JSON.parse(readFileSync(out, 'utf8')) as Parameters<typeof transportResults>[1];
    assert(record.egressObservedAtListener === false,
      'the gate must declare that it stood up no listener on the excluded origin');

    const egress = (obs: Parameters<typeof transportResults>[1]): { verdict: string; note?: string } =>
      transportResults('RP3', obs).find((result) => result.gate === 'RP3-egress-allowlist')!;

    const unwatched = egress(record);
    assert(unwatched.verdict === 'skip',
      `with no listener the egress line must SKIP, not pass; got ${unwatched.verdict}`);
    assert(/SKIP IS NOT A PASS/.test(unwatched.note ?? ''), 'and must say a skip is not a pass');

    // WHERE A LISTENER REALLY WATCHED, IT IS STILL A HARD ASSERTION IN BOTH DIRECTIONS.
    assert(egress({ ...record, egressObservedAtListener: true }).verdict === 'pass',
      'an observed zero must still pass');
    assert(egress({ ...record, egressObservedAtListener: true, disallowedOriginContacts: 1 }).verdict
      === 'fail', 'and an observed contact must still fail');
  });

  await test('THE DAEMON CONFIG NAMES THE CREDENTIAL BY PATH AND OPENS NO INSECURE DOOR BY DEFAULT', () => {
    // The gate builds the daemon's config from the operator's endpoint description. Two properties matter
    // and neither had ever been executed: the credential is named by PATH and its value is never read here,
    // and the two relaxations default OFF so an endpoint file that says nothing cannot acquire them.
    const { dir, script } = extract('config.cjs');
    const endpointPath = join(dir, 'endpoint.json');
    const out = join(dir, 'config.json');
    writeFileSync(endpointPath, JSON.stringify({
      id: 'provider', directBaseUrl: 'https://cdn.example.invalid/objects',
      allowedOrigins: ['https://cdn.example.invalid'],
    }));
    assert(runNode(script, [endpointPath, out]).code === 0, 'config.cjs failed on a well-formed endpoint');

    const text = readFileSync(out, 'utf8');
    const config = JSON.parse(text) as {
      endpoints: { tokenFile: string; allowInsecureHttp: boolean; allowPrivateAddresses: boolean;
        allowedOrigins: string[]; }[];
    };
    const endpoint = config.endpoints[0]!;
    assert(typeof endpoint.tokenFile === 'string' && endpoint.tokenFile.length > 0,
      'the config must name a credential file');
    assert(endpoint.allowInsecureHttp === false && endpoint.allowPrivateAddresses === false,
      'an endpoint that asks for neither relaxation must not be granted one');
    assert(endpoint.allowedOrigins.length === 1, 'the allowlist must be carried through verbatim');

    // AND THE RELAXATIONS MUST BE OPT-IN BY EXACT VALUE, not by truthiness — `"false"` is a string and a
    // truthy one, which is how a JSON typo becomes an open door.
    writeFileSync(endpointPath, JSON.stringify({
      id: 'provider', directBaseUrl: 'https://cdn.example.invalid/objects',
      allowedOrigins: ['https://cdn.example.invalid'],
      allowInsecureHttp: 'false', allowPrivateAddresses: 'yes',
    }));
    assert(runNode(script, [endpointPath, out]).code === 0, 'config.cjs failed on the typo endpoint');
    const typo = (JSON.parse(readFileSync(out, 'utf8')) as typeof config).endpoints[0]!;
    assert(typo.allowInsecureHttp === false && typo.allowPrivateAddresses === false,
      'a string value was treated as an opt-in; the relaxations must require a real boolean true');
  });

  await test('THE FIXTURE DIGEST FILL REFUSES TO LEAVE A RUN COMPARING AGAINST ZEROS', () => {
    // FAKE MODE fills the fixture manifest's placeholder digest from the CONTROL record, which read the
    // window outside the mount. If nothing matched, the run would compare mount reads against a placeholder
    // of 64 zeros and fail for a reason that has nothing to do with the data plane — so it fails closed
    // instead. Neither branch had ever been executed.
    const { dir, script } = extract('fill-digests.cjs');
    const objectsPath = join(dir, 'objects.json');
    const controlPath = join(dir, 'control.json');
    const digest = 'a'.repeat(64);
    const manifest = [{
      label: 'object-1', ref: 'rp-object-1', sizeBytes: 8 * 1024 * 1024,
      probeDigests: [{ offset: 1, length: 65536, sha256: '0'.repeat(64) }],
    }];

    writeFileSync(objectsPath, JSON.stringify(manifest));
    writeFileSync(controlPath, JSON.stringify({ digests: { 'object-1:1:65536': digest } }));
    const filled = runNode(script, [objectsPath, controlPath]);
    assert(filled.code === 0, `a matching control record was refused: ${filled.err.slice(0, 200)}`);
    const written = JSON.parse(readFileSync(objectsPath, 'utf8')) as typeof manifest;
    assert(written[0]!.probeDigests[0]!.sha256 === digest,
      'the approved digest was not taken from the control record');

    // NOTHING MATCHING: the window key is right in shape and wrong in value, which is exactly the shape of
    // an offset or length that drifted between the two.
    writeFileSync(objectsPath, JSON.stringify(manifest));
    writeFileSync(controlPath, JSON.stringify({ digests: { 'object-1:1:32768': digest } }));
    const unmatched = runNode(script, [objectsPath, controlPath]);
    assert(unmatched.code !== 0,
      'a control record matching no approved probe was accepted, leaving the run to compare against zeros');
    assert(JSON.parse(readFileSync(objectsPath, 'utf8'))[0].probeDigests[0].sha256 === '0'.repeat(64),
      'and the manifest must be left untouched rather than half-filled');

    // AND A MALFORMED DIGEST IS NOT A DIGEST. Accepting a short or non-hex value would put a string into the
    // comparison that can never match anything a hash produces.
    writeFileSync(objectsPath, JSON.stringify(manifest));
    writeFileSync(controlPath, JSON.stringify({ digests: { 'object-1:1:65536': 'not-a-digest' } }));
    assert(runNode(script, [objectsPath, controlPath]).code !== 0,
      'a malformed control digest was accepted as an approved value');
  });

  await test('THE SHIPPED ENDPOINT TEMPLATE IS REFUSED BY THE PREFLIGHT IT IS A NEGATIVE CONTROL FOR', () => {
    // THE DEFECT, AND IT WAS FOUND BY RUNNING THE GATE RATHER THAN BY READING IT.
    //
    // `deploy/projection-real-provider-gate.sh` runs the preflight against this template in FAKE mode as a
    // negative control and dies if it is ACCEPTED — "the preflight accepted the template, which still
    // carries REPLACE-ME placeholders". No such rule existed. The endpoint template is structurally valid by
    // construction — exactly one of resolverUrl/directBaseUrl, https, a non-empty allowlist, both fixture
    // switches false — so every rule in `endpointProblems` was satisfied by the unedited file and preflight
    // answered "PREFLIGHT PASSED — the inputs are well formed".
    //
    // SO THE GATE COULD NOT COMPLETE A SINGLE RUN. `npm run go:real-provider-gate:fake` died at that control
    // on the real Unraid host, at the merge base, before this fix. It is the gate standing between Phase 1
    // and the one requirement it is still open on.
    //
    // AND THE OPERATOR-FACING HALF IS THE WORSE ONE: someone who copies the template, fills in the
    // credential and objects but not the endpoint gets a green preflight telling them their inputs are well
    // formed, and then a run aimed at `https://REPLACE-ME.example.invalid`.
    const template = JSON.parse(repoFile('deploy/real-provider-endpoint.template.json')) as EndpointDescription;
    const problems = endpointProblems(template);
    assert(problems.length > 0, 'the shipped endpoint template is accepted by the preflight it is a control for');
    assert(problems.some((problem) => /REPLACE-ME placeholder/.test(problem)),
      `the refusal must name the placeholder rather than some incidental shape: ${problems.join('; ')}`);

    // EVERY FIELD THE TEMPLATE ASKS AN OPERATOR TO REPLACE IS CHECKED, one at a time, so a rule that only
    // looked at `id` would not pass this.
    const filled: EndpointDescription = {
      ...template, id: 'provider',
      directBaseUrl: 'https://cdn.example.invalid/objects',
      allowedOrigins: ['https://cdn.example.invalid'],
    };
    assert(endpointProblems(filled).length === 0,
      `a properly filled-in endpoint of the template's own shape was refused: ${endpointProblems(filled).join('; ')}`);
    for (const [field, value] of [
      ['id', 'REPLACE-ME-endpoint-id'],
      ['directBaseUrl', 'https://REPLACE-ME.example.invalid/objects'],
    ] as const) {
      assert(endpointProblems({ ...filled, [field]: value }).length > 0,
        `an unreplaced ${field} was accepted`);
    }
    assert(endpointProblems({ ...filled, allowedOrigins: ['https://REPLACE-ME.example.invalid'] }).length > 0,
      'an unreplaced allowed origin was accepted');

    // AND THE MARKER IS MATCHED THE WAY THE TEMPLATES SPELL IT, in either case, so an edit of the template's
    // capitalisation cannot quietly retire the rule.
    assert(endpointProblems({ ...filled, id: 'replace-me-later' }).length > 0,
      'the placeholder check must not be case-sensitive');

    // THE GATE'S CONTROL MUST STILL BE THERE. A rule with nothing exercising it is how this happened.
    const gate = repoFile('deploy/projection-real-provider-gate.sh');
    assert(/--endpoint deploy\/real-provider-endpoint\.template\.json/.test(gate)
      && /accepted the template, which still carries REPLACE-ME placeholders/.test(gate),
    'the gate no longer runs the preflight against the template as a negative control');
  });

  await test('THIS RUN\'S OWN DIRECTORY AND MOUNTS SURVIVING IS A FAILURE, NOT A LINE IN A REPORT', () => {
    // THE GAP. Every other verdict is read out of the run directory, so none of them can require it to be
    // gone — `RP6-foreign-run-directories` bounds only EARLIER runs' leftovers and now says so by name. The
    // one directory most likely to leak was asserted by nothing: `projection_gate_report_cleanliness` runs in
    // the EXIT trap and can only REPORT, because a non-zero return there would overwrite the gate's exit
    // status. So a successful gate could print "1 mountpoint left behind" and still exit 0 — the exact
    // report-versus-assertion gap §6.5 exists to close, reappearing inside the gate that closes it.
    const clean = { mountpoints: 0, runDirectoryPresent: false };
    assert(failedGates(ownCleanupResults('RP7', clean)).length === 0,
      'a run that cleaned up after itself must pass');

    // A SURVIVING RUN DIRECTORY FAILS. This is the assertion that did not exist.
    refuses(ownCleanupResults('RP7', { ...clean, runDirectoryPresent: true }),
      'a run directory that survived the run was accepted');
    // AND A SURVIVING MOUNTPOINT FAILS — §6.5's four dangling mounts, each answering "Transport endpoint is
    // not connected", are what this is for.
    refuses(ownCleanupResults('RP7', { ...clean, mountpoints: 1 }),
      'a mountpoint that survived the run was accepted');

    // THE DIRECTORY CHECK IS UNCONDITIONAL, because every host can answer whether a directory exists. Only
    // the mountpoint count keeps §6.0's three-valued treatment, and a skip is never a pass.
    const undetermined = ownCleanupResults('RP7', { mountpoints: Number.NaN, runDirectoryPresent: false });
    const mounts = undetermined.find((result) => result.gate === 'RP7-own-mountpoints-removed')!;
    assert(mounts.verdict === 'skip', `an unanswerable mountpoint count must skip, got ${mounts.verdict}`);
    assert(/SKIP IS NOT A PASS/.test(mounts.note ?? ''), 'and must say a skip is not a pass');
    refuses(ownCleanupResults('RP7', { mountpoints: Number.NaN, runDirectoryPresent: true }),
      'a host that cannot count mountpoints must still fail on a surviving run directory');

    // AND THE PHASE THE GATE ACTUALLY INVOKES IS EXECUTED, not just the function behind it. A verdict that
    // is correct in the module and wired to a command that exits 0 anyway would leave the gap exactly where
    // it was.
    const cleanupPhase = (mountpoints: string, runDirectoryPresent: string): number => spawnSync(
      'npx', ['tsx', join(HERE, '..', 'src/ops/projection-real-provider-cli.ts'), 'cleanup',
        '--mountpoints', mountpoints, '--run-directory-present', runDirectoryPresent],
      { encoding: 'utf8', shell: process.platform === 'win32' },
    ).status ?? -1;
    assert(cleanupPhase('0', 'false') === 0, 'the cleanup phase failed a run that cleaned up after itself');
    assert(cleanupPhase('0', 'true') !== 0,
      'the cleanup phase exited 0 with this run\'s directory still on disk');
    assert(cleanupPhase('1', 'false') !== 0,
      'the cleanup phase exited 0 with a mountpoint still under the run directory');
    assert(cleanupPhase('', 'false') === 0,
      'the cleanup phase failed a host that simply cannot count its own mountpoints');
    assert(cleanupPhase('', 'true') !== 0,
      'a host that cannot count mountpoints still has to fail on a surviving run directory');

    // AND THE OLD NAME MUST NOT COME BACK. `RP6-run-directories` read as "no run directory survived" while
    // deliberately excluding the only one that could have.
    const foreign = cleanupResults('RP6', {
      mountpoints: 0, containers: 0, runDirectories: 0, leaseTracesOnDisk: 0,
    });
    assert(foreign.some((result) => result.gate === 'RP6-foreign-run-directories'),
      'the foreign-run-directory line must be named for what it counts');
    assert(!foreign.some((result) => result.gate === 'RP6-run-directories'),
      'the misleading `RP6-run-directories` name is back');
    assert(/says nothing about this run's own directory/.test(
      foreign.find((result) => result.gate === 'RP6-foreign-run-directories')?.note ?? ''),
    'and must say plainly what it does not cover');
  });

  await test('THE GATE MAKES ITS OWN CLEANUP A SUCCESS CONDITION, AFTER THE REPORT AND AFTER THE EVIDENCE',
    () => {
      const gate = repoFile('deploy/projection-real-provider-gate.sh');

      // IT IS DECIDED IN THE MODULE, like every other verdict, and driven through the CLI.
      assert(/real_provider cleanup --mountpoints/.test(gate),
        'the gate does not ask the module whether it cleaned up after itself');

      // ORDER: report, then evidence, then cleanup, then the assertion. Requiring the run directory to be
      // gone before the results were printed and copied out would cost the operator the evidence.
      const report = gate.indexOf('real_provider report');
      const evidence = gate.indexOf('"$GATE_ROOT/evidence"');
      const cleanupRun = gate.indexOf('projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true\n\nOWN_MOUNTS_LEFT');
      const assertion = gate.indexOf('real_provider cleanup --mountpoints');
      assert(report !== -1 && evidence !== -1 && cleanupRun !== -1 && assertion !== -1,
        'the success-path cleanup phase is not where this test can see it');
      assert(report < evidence && evidence < cleanupRun && cleanupRun < assertion,
        'the cleanup assertion does not run after the report and the evidence copy');

      // AND FAILING IT ENDS THE RUN NON-ZERO, rather than being printed and shrugged off.
      const tail = gate.slice(assertion);
      assert(/else\s*\n\s*die "the run cleaned up after itself incompletely/.test(tail),
        'a failed cleanup does not fail the gate');

      // THE TRAP IS STILL THERE FOR EVERY FAILURE PATH, and is still a report there.
      assert(/trap cleanup EXIT/.test(gate), 'the EXIT trap has been removed');
      assert(/projection_gate_report_cleanliness/.test(gate),
        'the trap no longer reports what it left behind');
      // AND IT MUST NOT DOUBLE-REPORT OVER AN ASSERTION THAT ALREADY PASSED.
      assert(/CLEANED=0/.test(gate) && /CLEANED=1/.test(gate)
        && /\[ "\$\{CLEANED:-0\}" = "1" \]/.test(gate),
      'the trap does not stand down once the success path has cleaned up and asserted it');

      // THE FOREIGN-DIRECTORY COUNT MUST NOT SWALLOW THE EVIDENCE DIRECTORY IT NOW SITS BESIDE.
      assert(/-name 'run-\*' ! -name "run-\$\$"/.test(gate),
        'the foreign run-directory count would include the evidence directory');
    });

  await test('LOSING THE EVIDENCE IS A FAILURE, BECAUSE THE RUN DIRECTORY IS ABOUT TO BE DELETED', () => {
    // THE DEFECT. The cleanup phase preserves the verdict evidence and then deletes the run directory, which
    // is the only place that evidence exists. The first version copied both files with `|| true` and then
    // printed "evidence kept" unconditionally — so a copy that failed for any reason destroyed the only
    // record of why the run passed, announced that it had kept it, and exited 0. Same class as reporting a
    // measurement that was never taken, applied to the thing that justifies every other measurement.
    //
    // THE SHIPPED FUNCTION IS EXTRACTED AND RUN, not restated. `die` is stubbed so a refusal is observable as
    // an exit status instead of ending the harness.
    const gate = repoFile('deploy/projection-real-provider-gate.sh');
    const start = gate.indexOf('copy_evidence() {');
    assert(start !== -1, 'the gate no longer has an extractable copy_evidence');
    const end = gate.indexOf('\n}\n', start);
    assert(end !== -1, 'copy_evidence is not closed where this test can find it');
    const body = gate.slice(start, end + 3);

    const run = (prepare: (work: string) => void, evidenceDir?: string): { code: number; err: string } => {
      const dir = mkdtempSync(join(tmpdir(), 'rpevidence-'));
      const work = join(dir, 'run');
      mkdirSync(join(work, 'out'), { recursive: true });
      const keep = evidenceDir ?? join(dir, 'evidence');
      if (evidenceDir === undefined) mkdirSync(keep);
      prepare(work);
      const script = join(dir, 'copy.sh');
      writeFileSync(script, [
        'set -uo pipefail',
        'die() { echo "GATE FAILED: $*" >&2; exit 1; }',
        `WORK=${JSON.stringify(work)}`,
        `EVIDENCE_DIR=${JSON.stringify(keep)}`,
        body,
        'copy_evidence "out/results.json" "results-kept.jsonl"',
        'echo COPIED',
      ].join('\n'), 'utf8');
      const result = spawnSync('bash', [script], { encoding: 'utf8' });
      return { code: result.status ?? -1, err: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    };

    // THE HONEST CASE COPIES, and the copy is byte-identical to what the run wrote.
    const good = run((work) => writeFileSync(join(work, 'out/results.json'), '{"gate":"RP1"}\n'));
    assert(good.code === 0, `a well-formed evidence copy failed: ${good.err.slice(0, 200)}`);
    assert(/COPIED/.test(good.err), 'and must reach the line after it');

    // A RESULTS FILE THE VERDICT NEVER WROTE IS A FAILURE, not a silently skipped copy.
    const missing = run(() => { /* nothing written */ });
    assert(missing.code !== 0, 'a missing results file was accepted, and the run directory would be deleted');
    assert(/no verdict evidence to preserve/.test(missing.err),
      `the refusal must name what it could not preserve: ${missing.err.slice(0, 200)}`);

    // AN EMPTY ONE IS TOO — `cp` would happily copy nothing at all.
    const empty = run((work) => writeFileSync(join(work, 'out/results.json'), ''));
    assert(empty.code !== 0, 'an empty results file was accepted as evidence');

    // AND A COPY THAT CANNOT LAND IS A FAILURE. The destination here does not exist, which is what a
    // read-only or full gate root looks like to `cp`.
    const unwritable = run(
      (work) => writeFileSync(join(work, 'out/results.json'), '{"gate":"RP1"}\n'),
      join(tmpdir(), 'rpevidence-absent', 'nested', 'missing'),
    );
    assert(unwritable.code !== 0, 'a copy that could not land was accepted, and the evidence would be gone');

    // AND THE SHIPPED CALL SITES MUST NOT RE-OPT OUT. `|| true` here is exactly what made this silent.
    const phase = gate.slice(gate.indexOf('EVIDENCE_DIR="$GATE_ROOT/evidence"'));
    const calls = [...phase.matchAll(/^copy_evidence "[^"]+" "[^"]+"$/gm)];
    assert(calls.length === 2, `expected both evidence files to be preserved, found ${calls.length}`);
    assert(!/cp "\$WORK[^\n]*\|\| true/.test(gate),
      'an evidence copy is optional again, so a failed one would be swallowed');
    assert(!/mkdir -p "\$EVIDENCE_DIR"[^\n]*\|\| true/.test(gate),
      'the evidence directory is created optionally again');

    // AND IT MUST STILL HAPPEN BEFORE ANYTHING IS DELETED.
    assert(gate.indexOf('copy_evidence "out/results-summary.json"')
      < gate.indexOf('projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true\n\nOWN_MOUNTS_LEFT'),
    'the evidence is preserved after the run directory is deleted, which is no preservation at all');
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
