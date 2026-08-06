import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { GateResult } from '../core/projection/media-server-dataplane.js';
import {
  CONTROL_DEADLINE_MS, cleanupResults, controlResults, endpointProblems, findLeaks, findResultLeaks,
  inputProblems, ownCleanupResults, readOnlyResults, readResults, sha256Of, transportResults,
  workDoneResults,
  type CredentialStat, type DirectProbe, type EndpointDescription, type MountRead, type OperatorObject,
} from '../core/projection/real-provider.js';

// Projection Phase 1 — the real-provider correctness gate, from the command line.
//
// NOTHING IN THIS FILE TAKES A URL, A TOKEN OR A REFERENCE ON THE COMMAND LINE. Every one of those arrives
// from a FILE whose path is given instead, because argv is world-readable on a normal Linux host: `ps` shows
// it to any user, and a gate that accepted a credential as a flag VALUE would leak it to every
// process on the machine for as long as the run lasted.
//
//   preflight  --objects F --credential F --endpoint F [--fixture-endpoint] [--json F]
//                validates shape and permissions and CONTACTS NOTHING
//   control    --objects F --credential F --endpoint F --out F
//                one direct HTTPS Range request per object, outside the daemon
//   reads      --objects F --mount D --control F --out F
//                the reads through the mount, digested
//   verdict    --objects F --control F --reads F --observations F --results F
//                [--fixture-endpoint] — skips the TLS assertions, and says so as a SKIP
//   report     --results F [--json F]

class GateFailure extends Error {}

function fail(message: string): never {
  console.error(`projection-real-provider: ${message}`);
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

/**
 * ARGV IS CHECKED FOR LEAKS BEFORE ANYTHING ELSE RUNS.
 *
 * The rule that no URL or credential reaches the command line is only worth having if it is enforced. An
 * operator following a template cannot leak one; an operator improvising can, and the failure is silent and
 * permanent — it is in the shell history and in every process listing taken while the gate ran.
 */
function refuseLeakyArgv(): void {
  const leaks = findLeaks(process.argv.slice(2).join(' '), 'argv');
  if (leaks.length > 0) {
    console.error('projection-real-provider: the command line carries something that must never be there:');
    for (const leak of leaks) console.error(`  ${leak.kind}`);
    console.error('  Every URL, reference and credential is passed as a FILE PATH. argv is world-readable.');
    process.exit(1);
  }
}

function readJson<T>(path: string, what: string): T {
  if (!existsSync(path)) fail(`the ${what} file does not exist; this gate fails closed rather than `
    + 'inventing a default');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fail(`the ${what} file is not valid JSON`);
  }
}

function credentialStat(path: string): CredentialStat {
  if (!existsSync(path)) return { exists: false, sizeBytes: 0 };
  const info = statSync(path);
  // ON WINDOWS THE MODE IS NOT A PERMISSION, so it is reported as undetermined rather than as compliant.
  // `undefined` makes the permission check inapplicable; it never makes it pass.
  const mode = process.platform === 'win32' ? undefined : info.mode & 0o777;
  return { exists: true, mode, sizeBytes: info.size };
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

const recordAll = (args: Args, results: readonly GateResult[]): void => {
  for (const result of results) record(args, result);
};

// ---------------------------------------------------------------------------------------------------------
// The direct control: one HTTPS Range request per object, with the daemon nowhere in the path
// ---------------------------------------------------------------------------------------------------------

interface ControlOutcome { readonly probe: DirectProbe; readonly body: Buffer }

/**
 * https for a real provider, http for the offline fixture — chosen from the URL and from nothing else.
 *
 * THE CHOICE IS NOT A POLICY DECISION AND MUST NOT BECOME ONE. Whether plaintext is ACCEPTABLE is decided in
 * `endpointProblems`, which refuses it for any real endpoint before a request is ever made. By the time a URL
 * reaches here it has already been authorised; all that is left is to dial it with the right client.
 */
const requestFor = (url: URL): typeof httpsRequest =>
  (url.protocol === 'http:' ? httpRequest : httpsRequest) as typeof httpsRequest;


/**
 * One ranged GET, straight at the provider.
 *
 * REDIRECTS ARE NOT FOLLOWED, AND THAT IS THE MEASUREMENT. `node:https` does not follow them on its own, so
 * a 3xx arrives here as a status and is recorded as one. The daemon refuses redirects outright; the control
 * exists to say whether the provider emits any, so "the daemon failed" and "the provider redirects, which
 * this product declines to follow" can be told apart in the report.
 */
function probeOnce(options: {
  readonly label: string; readonly url: URL; readonly headers: Record<string, string>;
  readonly offset: number; readonly length: number;
}): Promise<ControlOutcome> {
  return new Promise<ControlOutcome>((resolve, reject) => {
    const started = Date.now();
    const last = options.offset + options.length - 1;
    const req = requestFor(options.url)({
      protocol: options.url.protocol,
      hostname: options.url.hostname,
      port: options.url.port === '' ? (options.url.protocol === 'http:' ? 80 : 443)
        : Number(options.url.port),
      path: `${options.url.pathname}${options.url.search}`,
      method: 'GET',
      // THE SYSTEM TRUST STORE, UNMODIFIED. No `rejectUnauthorized: false`, no pinned certificate, no
      // operator-supplied CA: a control that trusted anything would prove nothing about the provider's TLS.
      headers: { ...options.headers, Range: `bytes=${options.offset}-${last}` },
      timeout: CONTROL_DEADLINE_MS,
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        // BOUNDED. A provider that ignores the range and streams the whole object cannot make this control
        // consume memory without limit; the excess is counted and discarded.
        total += chunk.length;
        if (total <= options.length) chunks.push(chunk);
      });
      response.on('end', () => {
        const socket = req.socket as TLSSocket;
        const status = response.statusCode ?? 0;
        const contentRange = parseContentRange(response.headers['content-range']);
        const declared = response.headers['content-length'];
        resolve({
          probe: {
            label: options.label,
            // AN ABSENT TLS LAYER REPORTS AS ABSENT, NEVER AS COMPLIANT. A plaintext socket has neither
            // method, and reading `undefined` as "fine" is how a gate passes a connection that had no TLS.
            tlsProtocol: typeof socket.getProtocol === 'function' ? (socket.getProtocol() ?? '') : '',
            tlsAuthorized: socket.authorized === true,
            status,
            contentRange,
            contentLength: declared === undefined ? undefined : Number(declared),
            bodyBytes: total,
            requestedOffset: options.offset,
            requestedLength: options.length,
            redirected: status >= 300 && status < 400,
            elapsedMs: Date.now() - started,
          },
          body: Buffer.concat(chunks),
        });
      });
      response.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('the control request exceeded its finite deadline')); });
    req.on('error', reject);
    req.end();
  });
}

function parseContentRange(value: string | string[] | undefined):
{ start: number; end: number; total: number } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value.trim());
  if (match === null) return undefined;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

/**
 * Turns a stable reference into something dialable, exactly the way the product does.
 *
 * TWO SHAPES, AND THE PRODUCT'S OWN RULE FOR CHOOSING. A resolver endpoint exchanges the reference for
 * short-lived access material; a direct endpoint appends the reference to a base URL as one path segment.
 * `EndpointConfig` says the resolver wins when both are set — and `endpointProblems` refuses a configuration
 * that sets both, so this never has to guess.
 */
async function accessFor(endpoint: EndpointDescription, object: OperatorObject, credential: string):
Promise<{ url: URL; headers: Record<string, string>; expiring: boolean }> {
  if ((endpoint.directBaseUrl ?? '') !== '') {
    const base = endpoint.directBaseUrl as string;
    return {
      url: new URL(`${base.replace(/\/+$/, '')}/${encodeURIComponent(object.ref)}`),
      headers: { Authorization: `Bearer ${credential}` },
      expiring: false,
    };
  }
  const resolved = await resolveRef(endpoint.resolverUrl as string, object.ref, credential);
  return { url: new URL(resolved.url), headers: resolved.headers, expiring: true };
}

function resolveRef(resolverUrl: string, ref: string, credential: string):
Promise<{ url: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const target = new URL(resolverUrl);
    const payload = JSON.stringify({ objectRef: ref });
    const req = requestFor(target)({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port === '' ? (target.protocol === 'http:' ? 80 : 443) : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: CONTROL_DEADLINE_MS,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          // THE STATUS, AND NOT THE BODY. A resolver's error body routinely echoes the reference back.
          reject(new Error(`the resolver answered ${response.statusCode ?? 0}`));
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as
            { url: string; headers?: Record<string, string> };
          resolve({ url: body.url, headers: body.headers ?? {} });
        } catch {
          reject(new Error('the resolver answered 200 with a body that is not the expected JSON'));
        }
      });
      response.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('the resolution exceeded its finite deadline')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------------------------------------
// Reads through the mount
// ---------------------------------------------------------------------------------------------------------

/**
 * The largest buffer any read here allocates, whatever window it was asked for.
 *
 * WHY A WINDOW IS NOT ALLOCATED WHOLE. This used to `Buffer.alloc(length)` and then read into it, which is
 * fine for the 64 KiB probe windows and is a crash for the one window that is not bounded: the WHOLE-OBJECT
 * read taken whenever an operator supplies `sha256`. Nothing stops that being a 40 GB film — `probeDigests`
 * exist for exactly that case but are not compulsory — and a 40 GB allocation fails with a message about a
 * typed array length, halfway through a run, after the provider has already been charged for the bytes. The
 * digest is streamed instead, so the memory cost of reading an object is the same whatever its size.
 */
const READ_CHUNK_BYTES = 1024 * 1024;

/** Reads a window through the mount and digests it as it goes, never holding more than one chunk. */
function digestWindow(path: string, offset: number, length: number):
{ bytesRead: number; sha256: string; elapsedMs: number } {
  const started = Date.now();
  const fd = openSync(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(length, READ_CHUNK_BYTES));
    let filled = 0;
    while (filled < length) {
      const want = Math.min(buffer.length, length - filled);
      const got = readSync(fd, buffer, 0, want, offset + filled);
      if (got === 0) break;
      hash.update(buffer.subarray(0, got));
      filled += got;
    }
    return { bytesRead: filled, sha256: hash.digest('hex'), elapsedMs: Date.now() - started };
  } finally {
    closeSync(fd);
  }
}

async function main(): Promise<void> {
  refuseLeakyArgv();
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    // -----------------------------------------------------------------------------------------------------
    case 'preflight': {
      // THE WHOLE POINT IS THAT THIS CONTACTS NOTHING. An operator assembling three files, a credential and
      // an endpoint description finds out here whether the shape is right — before a single request is made
      // against an account they are being charged for, and before a credential with the wrong mode is
      // discovered by a read failure forty seconds into a run.
      const objects = readJson<OperatorObject[]>(need(args, 'objects'), 'object manifest');
      const endpoint = readJson<EndpointDescription>(need(args, 'endpoint'), 'endpoint description');
      const credential = credentialStat(need(args, 'credential'));
      // --fixture-endpoint relaxes ONLY the three real-provider rules, and only when asked for.
      // Omitted, it defaults to a REAL endpoint, so an operator can never get the relaxation by
      // accident and a forgotten flag fails closed rather than open.
      const realEndpoint = args.flags.get('fixture-endpoint') !== 'true';
      const problems = [...inputProblems({ objects, credential, endpoint, realEndpoint })];

      // The manifest itself must not carry anything unprintable, because the gate prints labels from it.
      // THE STRUCTURAL FIELDS ARE MASKED BEFORE THE SCAN, and getting this wrong made every valid manifest
      // fail. A sha256 is 64 hex characters, which is exactly the shape the scrubber calls "a long opaque
      // string that may be a credential" -- so a correctly written objects.json, with the digests the gate
      // REQUIRES, was refused by its own preflight. The digests are not secrets: they are validated by their
      // own shape check above, and the whole point of recording them is that they get compared.
      //
      // The ref stays masked because it IS sensitive, and masking is the right treatment for both: what the
      // scan is looking for is a URL or a credential somewhere it does not belong, not a field the schema
      // put there.
      const raw = readFileSync(need(args, 'objects'), 'utf8')
        .replace(/"ref"\s*:\s*"[^"]*"/g, '"ref":"<redacted>"')
        .replace(/"sha256"\s*:\s*"[0-9a-fA-F]{64}"/g, '"sha256":"<digest>"');
      for (const leak of findLeaks(raw, 'objects')) {
        problems.push(`the object manifest carries ${leak.kind} outside its ref field`);
      }

      console.log(`  ${objects.length} object(s), endpoint ${endpoint.id}`);
      if (problems.length > 0) {
        console.error('projection-real-provider: the supplied inputs are not usable:');
        for (const problem of problems) console.error(`  - ${problem}`);
        process.exit(1);
      }
      console.log('  PREFLIGHT PASSED — and nothing was contacted. This says the inputs are well formed and');
      console.log('  the credential is protected. It says NOTHING about the provider, which has not been');
      console.log('  asked anything yet.');
      const out = args.flags.get('json');
      if (out !== undefined) {
        writeFileSync(out, `${JSON.stringify({ objects: objects.length, endpointId: endpoint.id }, null, 2)}\n`);
      }
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'control': {
      const objects = readJson<OperatorObject[]>(need(args, 'objects'), 'object manifest');
      const endpoint = readJson<EndpointDescription>(need(args, 'endpoint'), 'endpoint description');
      const credentialPath = need(args, 'credential');
      const stat = credentialStat(credentialPath);
      const realEndpoint = args.flags.get('fixture-endpoint') !== 'true';
      const problems = inputProblems({ objects, credential: stat, endpoint, realEndpoint });
      if (problems.length > 0) fail(`the inputs are not usable; run preflight (${problems.length} problem(s))`);
      const credential = readFileSync(credentialPath, 'utf8').trim();

      const probes: DirectProbe[] = [];
      const digests: Record<string, string> = {};
      for (const object of objects) {
        // A SMALL WINDOW, AT AN OFFSET THAT IS NOT ZERO. Zero is the one offset a server that ignores ranges
        // still answers correctly by accident, so it proves the least.
        const length = Math.min(CONTROL_WINDOW_BYTES, Math.max(1, object.sizeBytes - 1));
        const offset = Math.min(1, Math.max(0, object.sizeBytes - length));
        const access = await accessFor(endpoint, object, credential);
        const outcome = await probeOnce({
          label: object.label, url: access.url, headers: access.headers, offset, length,
        });
        probes.push(outcome.probe);
        digests[`${object.label}:${offset}:${length}`] = sha256Of(outcome.body);
        console.log(`  ${object.label}: status ${outcome.probe.status}, `
          + `${outcome.probe.bodyBytes} byte(s), ${outcome.probe.tlsProtocol || 'no TLS'}`);
      }
      writeFileSync(need(args, 'out'), `${JSON.stringify({ probes, digests }, null, 2)}\n`);
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'reads': {
      const objects = readJson<OperatorObject[]>(need(args, 'objects'), 'object manifest');
      const mount = need(args, 'mount');
      const reads: MountRead[] = [];
      let bytesTotal = 0;

      for (const object of objects) {
        const path = `${mount}/${object.label}.bin`;
        if (!existsSync(path)) fail(`"${object.label}" is not visible through the mount`);

        // The approved probe windows, in the order the operator gave them.
        for (const probe of object.probeDigests ?? []) {
          const got = digestWindow(path, probe.offset, probe.length);
          reads.push({
            label: object.label, kind: 'probe', offset: probe.offset, length: probe.length,
            bytesRead: got.bytesRead, sha256: got.sha256, elapsedMs: got.elapsedMs,
          });
          bytesTotal += got.bytesRead;
        }

        // PAST 90% OF THE OBJECT, which is where a container index often lives and where an implementation
        // that can only stream forward from zero falls over.
        const tailOffset = Math.floor(object.sizeBytes * 0.91);
        const tailLength = Math.min(TAIL_WINDOW_BYTES, object.sizeBytes - tailOffset);
        const tail = digestWindow(path, tailOffset, tailLength);
        reads.push({
          label: object.label, kind: 'tail', offset: tailOffset, length: tailLength,
          bytesRead: tail.bytesRead, sha256: tail.sha256, elapsedMs: tail.elapsedMs,
        });
        bytesTotal += tail.bytesRead;

        // AND THEN BACKWARDS. This read is deliberately at a LOWER offset than the one just performed: it is
        // the seek a player makes when somebody scrubs back, and it is what a forward-only implementation
        // gets wrong while passing every sequential test.
        const backLength = Math.min(TAIL_WINDOW_BYTES, Math.max(1, tailOffset));
        const back = digestWindow(path, 0, backLength);
        reads.push({
          label: object.label, kind: 'backward', offset: 0, length: backLength,
          bytesRead: back.bytesRead, sha256: back.sha256, elapsedMs: back.elapsedMs,
        });
        bytesTotal += back.bytesRead;

        if (object.sha256 !== undefined) {
          // STREAMED, NOT ALLOCATED. An operator is allowed to record a whole-object digest for an object of
          // any size, and this is the one read whose length the gate does not choose.
          const whole = digestWindow(path, 0, object.sizeBytes);
          reads.push({
            label: object.label, kind: 'whole', offset: 0, length: object.sizeBytes,
            bytesRead: whole.bytesRead, sha256: whole.sha256, elapsedMs: whole.elapsedMs,
          });
          bytesTotal += whole.bytesRead;
        }
        console.log(`  ${object.label}: ${reads.filter((r) => r.label === object.label).length} read(s)`);
      }
      writeFileSync(need(args, 'out'), `${JSON.stringify({ reads, bytesTotal }, null, 2)}\n`);
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'verdict': {
      const objects = readJson<OperatorObject[]>(need(args, 'objects'), 'object manifest');
      const control = readJson<{ probes: DirectProbe[] }>(need(args, 'control'), 'control record');
      const reads = readJson<{ reads: MountRead[]; bytesTotal: number }>(need(args, 'reads'), 'read record');
      const obs = readJson<Parameters<typeof transportResults>[1] & {
        readOnly: Parameters<typeof readOnlyResults>[1];
        cleanup: Parameters<typeof cleanupResults>[1];
      }>(need(args, 'observations'), 'observation record');

      const realEndpoint = args.flags.get('fixture-endpoint') !== 'true';
      recordAll(args, controlResults('RP1', control.probes, objects, realEndpoint));
      recordAll(args, readResults('RP2', reads.reads, objects));
      recordAll(args, transportResults('RP3', obs));
      recordAll(args, readOnlyResults('RP4', obs.readOnly));
      recordAll(args, workDoneResults('RP5', {
        objectsRead: new Set(reads.reads.map((read) => read.label)).size,
        bytesFromProvider: reads.bytesTotal,
        expectedObjects: objects.length,
      }));
      recordAll(args, cleanupResults('RP6', obs.cleanup));
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    // THE LAST ASSERTION, AND THE ONLY ONE THAT RUNS AFTER THE REPORT
    // -----------------------------------------------------------------------------------------------------
    //
    // Every other verdict is decided while the run directory must still exist, because they are read out of
    // it. That left the one thing most likely to leak — this run's own directory and the mounts under it —
    // asserted by nothing: the EXIT trap's cleanliness check is a REPORT by construction, since a non-zero
    // return there would overwrite the gate's exit status. So the gate cleans up explicitly once the report
    // has been printed and the evidence copied out, and then asks this command whether anything survived.
    // It is decided here rather than in the shell for the same reason every other verdict is.
    case 'cleanup': {
      const mountpointsRaw = args.flags.get('mountpoints') ?? '';
      const results = ownCleanupResults('RP7', {
        // EMPTY MEANS THE HOST COULD NOT ANSWER, and NaN is not zero: the module skips that line rather than
        // passing it. Anything else is taken at face value and asserted.
        mountpoints: mountpointsRaw === '' ? Number.NaN : Number(mountpointsRaw),
        runDirectoryPresent: args.flags.get('run-directory-present') === 'true',
      });
      for (const result of results) {
        const measured = result.measured === undefined ? '' : ` ${result.measured}/${result.budget}`;
        console.log(`  ${result.verdict.padEnd(4)} ${result.gate}${measured}`);
      }
      const failed = results.filter((result) => result.verdict === 'fail');
      if (failed.length > 0) {
        for (const result of failed) console.error(`  ${result.gate}: ${result.note}`);
        fail('the run did not clean up after itself');
      }
      return;
    }

    // -----------------------------------------------------------------------------------------------------
    case 'report': {
      const path = need(args, 'results');
      if (!existsSync(path)) fail('there are no results to report, which is itself a failure');
      const results = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as GateResult);
      if (results.length === 0) fail('there are no results to report, which is itself a failure');

      // THE SCRUBBER RUNS BEFORE THE REPORT IS PRINTED, not after. A leak that reached a terminal has already
      // reached a scrollback buffer, a CI log and whatever the operator pasted it into.
      const leaks = findResultLeaks(results);
      if (leaks.length > 0) {
        console.error('the gate report would have leaked:');
        for (const leak of leaks.slice(0, 20)) console.error(`  ${leak.kind} at ${leak.at}`);
        fail('the report is not redaction-safe');
      }

      const failed = results.filter((result) => result.verdict === 'fail');
      const skipped = results.filter((result) => result.verdict === 'skip');
      console.log('');
      console.log(`Projection Phase 1 — real-provider correctness: ${results.length} assertions, `
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

/** Small enough to cost the operator nothing, large enough that a short body is unambiguous. */
const CONTROL_WINDOW_BYTES = 65_536;
const TAIL_WINDOW_BYTES = 65_536;

export { parseContentRange, credentialStat };

main().catch((error: unknown) => {
  if (error instanceof GateFailure) {
    console.error(`projection-real-provider: ${error.message}`);
    process.exit(1);
  }
  // THE MESSAGE IS SCRUBBED. A thrown network error routinely carries the host it failed to reach, and
  // against a real provider that host is a signed URL's origin.
  const message = (error as Error).message ?? 'unknown failure';
  const safe = findLeaks(message, 'error').length > 0 ? '<a failure whose message was redacted>' : message;
  console.error(`projection-real-provider: ${safe}`);
  process.exit(1);
});
