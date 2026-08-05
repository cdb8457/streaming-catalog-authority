import { createHash } from 'node:crypto';
import type { GateResult } from './media-server-dataplane.js';

// Projection Phase 1 — the real-provider correctness contract.
//
// WHAT §2 OF THE ACCEPTANCE PLAN ASKS FOR, AND WHY IT IS THIS SMALL. The real-provider corpus is "1–3 files
// the operator is legally entitled to", and it exists to answer one question: does the HTTP Range adapter
// work against a real endpoint. That is a CORRECTNESS question. Every quantitative question — amplification,
// concurrency, re-scan, duplicate probes — is answered against the fake corpus, where the harness controls
// the answers and can assert on them. So nothing here is a budget, a rate, or a multiplier, and nothing here
// is a load test. A gate that hammered somebody's provider to produce a number would be measuring the
// provider, and would be doing it with bandwidth the operator pays for.
//
// EVERY VERDICT IS TAKEN HERE, AND EVERY VERDICT IS REDACTION-SAFE BY CONSTRUCTION.
//
// THE HARDEST CONSTRAINT IN THIS FILE IS WHAT MAY NOT BE SAID. A real provider's access material is a signed
// URL: it carries the account, the object, an expiry and a signature, and it is a bearer credential in its
// own right. So no function here accepts a URL, a token, a header, a query string, a provider filename or an
// account identifier, and none can be made to print one — the ONLY identity an object has in this module is
// an operator-chosen LABEL and a digest PREFIX. That is not a redaction pass applied at the end; it is the
// shape of the inputs, so a leak has to get past the type system before it can get past the scrubber.

/** How an object is named in every report line: never its ref, never its provider filename. */
export interface ObjectIdentity {
  /** Operator-chosen, e.g. `object-1`. Asserted to be boring before it is ever printed. */
  readonly label: string;
}

/**
 * One object the operator has supplied, as the gate is allowed to hold it.
 *
 * `ref` IS THE ONE FIELD THAT NEVER REACHES A REPORT. It is the stable reference the product resolves — for a
 * direct endpoint it is appended to a base URL, and for a resolver endpoint it is exchanged for short-lived
 * access material. Either way it identifies somebody's object in somebody's account.
 */
export interface OperatorObject extends ObjectIdentity {
  readonly ref: string;
  readonly sizeBytes: number;
  /** Whole-object digest, where the operator is willing to let the gate read the whole object. */
  readonly sha256?: string;
  /**
   * Approved probe digests, for an object too large or too costly to read whole.
   *
   * WHY THIS EXISTS AT ALL. "Digest recorded outside the mount" is the assertion that stops a gate passing on
   * bytes the mount invented. Against a 40 GB film, reading the whole object to get one is a bandwidth bill
   * the operator did not agree to. So an operator may instead approve N windows, and the gate compares those
   * exact windows through the mount against the same windows fetched directly.
   */
  readonly probeDigests?: readonly ProbeDigest[];
}

export interface ProbeDigest {
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}

export const MIN_OBJECTS = 1;
export const MAX_OBJECTS = 3;

/** A label an operator could not accidentally leak an account name through. */
const LABEL_SHAPE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const SHA256_SHAPE = /^[0-9a-f]{64}$/;

/**
 * The credential file's permission rule, which is the daemon's own and is not restated loosely here.
 *
 * `source.SecretFile` refuses a file whose mode has any group or other bit set (`perm&0o077 != 0`). The gate
 * refuses the same thing BEFORE it starts anything, because the alternative is finding out from a read
 * failure forty seconds into a run against somebody's real account.
 */
export const CREDENTIAL_MAX_MODE = 0o600;
export const CREDENTIAL_MAX_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------------------------------------
// Input validation — fail closed, before anything is contacted
// ---------------------------------------------------------------------------------------------------------

export interface CredentialStat {
  readonly exists: boolean;
  /** POSIX permission bits, or `undefined` where the platform has no such concept. */
  readonly mode?: number;
  readonly sizeBytes: number;
}

/**
 * Everything wrong with the operator's inputs, as sentences an operator can act on.
 *
 * IT IS A LIST RATHER THAN A BOOLEAN ON PURPOSE. An operator assembling three files, a credential and an
 * endpoint description should learn everything that is wrong in one run, not one thing per run against a
 * provider they are being charged to talk to.
 */
export function inputProblems(input: {
  readonly objects: readonly OperatorObject[];
  readonly credential: CredentialStat;
  readonly endpoint: EndpointDescription;
  /** False ONLY for the offline fixture. Defaults to a real endpoint, so an omission fails closed. */
  readonly realEndpoint?: boolean;
}): readonly string[] {
  const problems: string[] = [];

  // --- the corpus -----------------------------------------------------------------------------------------
  if (input.objects.length < MIN_OBJECTS) {
    problems.push('the object manifest names no objects; the gate refuses to report a pass having read '
      + 'nothing, which is the single most likely way this gate could be green and worthless');
  }
  if (input.objects.length > MAX_OBJECTS) {
    problems.push(`the object manifest names ${input.objects.length} objects; §2 of the acceptance plan says `
      + `1–3, because this is a correctness corpus and not a load test`);
  }

  const labels = new Set<string>();
  for (const object of input.objects) {
    if (!LABEL_SHAPE.test(object.label)) {
      problems.push('an object label is not a plain lower-case slug; labels are printed in reports, so they '
        + 'must not be able to carry a filename, an account name or a URL');
      continue;
    }
    if (labels.has(object.label)) problems.push(`two objects share the label "${object.label}"`);
    labels.add(object.label);

    if (object.ref === '') problems.push(`"${object.label}" has an empty stable reference`);
    if (!Number.isSafeInteger(object.sizeBytes) || object.sizeBytes <= 0) {
      problems.push(`"${object.label}" has no positive integer sizeBytes; the manifest size is what the `
        + `provider's own total is checked against, so a missing one disables that check silently`);
    }

    // AT LEAST ONE DIGEST AUTHORITY, ALWAYS. Without one, "the bytes through the mount are correct" degrades
    // to "the mount returned some bytes", and every read assertion below becomes unfalsifiable.
    const whole = object.sha256 !== undefined;
    const probes = object.probeDigests !== undefined && object.probeDigests.length > 0;
    if (!whole && !probes) {
      problems.push(`"${object.label}" carries neither sha256 nor probeDigests; with no digest recorded `
        + `outside the mount there is nothing for a read through the mount to be wrong against`);
    }
    if (whole && !SHA256_SHAPE.test(object.sha256 as string)) {
      problems.push(`"${object.label}" has a sha256 that is not 64 lower-case hex characters`);
    }
    for (const probe of object.probeDigests ?? []) {
      if (!SHA256_SHAPE.test(probe.sha256)) {
        problems.push(`"${object.label}" has a probe digest that is not 64 lower-case hex characters`);
      }
      if (!Number.isSafeInteger(probe.offset) || probe.offset < 0
        || !Number.isSafeInteger(probe.length) || probe.length <= 0) {
        problems.push(`"${object.label}" has a probe window that is not a positive byte range`);
      }
      if (Number.isSafeInteger(object.sizeBytes) && probe.offset + probe.length > object.sizeBytes) {
        problems.push(`"${object.label}" has a probe window running past the declared size`);
      }
    }
  }

  // --- the credential -------------------------------------------------------------------------------------
  if (!input.credential.exists) {
    problems.push('the credential file does not exist at the approved path; the gate never takes a token '
      + 'from argv, from an environment variable or from an interactive prompt');
  } else {
    if (input.credential.sizeBytes === 0) problems.push('the credential file is empty');
    if (input.credential.sizeBytes > CREDENTIAL_MAX_BYTES) {
      problems.push(`the credential file is larger than ${CREDENTIAL_MAX_BYTES} bytes; a secret is a token, `
        + `not a payload, and the daemon refuses this too`);
    }
    // THE PERMISSION RULE IS THE DAEMON'S, RESTATED SO THE GATE FAILS FIRST. A 0644 credential is one the
    // daemon correctly refuses — and finding that out mid-run against a real provider wastes a real request.
    if (input.credential.mode !== undefined && (input.credential.mode & 0o077) !== 0) {
      problems.push('the credential file is readable by group or other; the daemon refuses a credential whose '
        + 'mode has any of 0o077 set, and so does this gate, before anything is contacted');
    }
  }

  problems.push(...endpointProblems(input.endpoint, input.realEndpoint ?? true));
  return problems;
}

export interface EndpointDescription {
  readonly id: string;
  readonly resolverUrl?: string;
  readonly directBaseUrl?: string;
  readonly allowedOrigins: readonly string[];
  readonly allowInsecureHttp?: boolean;
  readonly allowPrivateAddresses?: boolean;
}

/**
 * The endpoint rules that matter when the other end is REAL and not a fixture in a container.
 *
 * WHY THERE IS A FIXTURE EXEMPTION AT ALL, AND WHY IT IS SHAPED LIKE THIS. Fake mode has to drive the SAME
 * code path a real run drives -- a gate whose real mode ran code no offline run had ever executed would be a
 * gate first tested against somebody production account. But the fake endpoint is plaintext HTTP on a private
 * address, which is exactly what the three strictest rules here exist to forbid.
 *
 * So the exemption is NARROW, EXPLICIT AND FAILS CLOSED. It is a parameter that defaults to `true` (real),
 * it relaxes ONLY the three rules that are about the other end being a real provider carrying a real
 * credential, and it relaxes none of the structural ones -- an endpoint with no allowlist, or naming both
 * transport shapes, or naming neither, is refused in both modes. An offline test requires that every one of
 * the relaxed rules still bites when `realEndpoint` is true.
 */
export function endpointProblems(endpoint: EndpointDescription,
  realEndpoint = true): readonly string[] {
  const problems: string[] = [];
  const resolver = endpoint.resolverUrl ?? '';
  const direct = endpoint.directBaseUrl ?? '';

  if (resolver === '' && direct === '') {
    problems.push('the endpoint names neither a resolverUrl nor a directBaseUrl, so there is no way to turn '
      + 'a stable reference into bytes');
  }
  if (resolver !== '' && direct !== '') {
    problems.push('the endpoint names both a resolverUrl and a directBaseUrl; the product uses the resolver '
      + 'when one is present, so the other would be silently dead configuration');
  }

  // TLS IS NOT OPTIONAL AGAINST A REAL PROVIDER, and neither switch that would relax it may be set. These are
  // two separate permissions in the product for a good reason, and a real-provider run needs neither.
  //
  // THESE THREE, AND ONLY THESE THREE, ARE WHAT THE FIXTURE EXEMPTION RELAXES.
  if (realEndpoint) {
    for (const [name, value] of [['resolverUrl', resolver], ['directBaseUrl', direct]] as const) {
      if (value !== '' && !value.startsWith('https://')) {
        problems.push(`${name} is not https; a real-provider run carries a real credential and will not `
          + `send it in plaintext`);
      }
    }
    if (endpoint.allowInsecureHttp === true) {
      problems.push('allowInsecureHttp is set; that is a fixture switch and has no place in a run that '
        + 'carries a real credential');
    }
    if (endpoint.allowPrivateAddresses === true) {
      problems.push('allowPrivateAddresses is set; that authorises the daemon to dial loopback and '
        + 'link-local addresses, which against a real provider means a redirect could steer it at the host '
        + 'itself');
    }
  }

  if (endpoint.allowedOrigins.length === 0) {
    problems.push('allowedOrigins is empty; the egress allowlist is what stops a resolved URL pointing '
      + 'somewhere the operator never authorised, and an empty list is not a permissive one by accident here');
  }
  for (const origin of endpoint.allowedOrigins) {
    if (realEndpoint && !origin.startsWith('https://')) {
      problems.push('an allowed origin is not https');
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// Redaction — the check that runs before anything is printed
// ---------------------------------------------------------------------------------------------------------

/**
 * Text that must never appear in a report, a log line, an argv or a file the gate writes.
 *
 * THIS IS DELIBERATELY BROADER THAN "THE TOKEN". A signed access URL leaks the account and the object even
 * with the signature removed; a `Bearer` header leaks the credential; a provider filename leaks what the
 * operator is entitled to. So the scrubber refuses URL shapes, credential shapes and query strings outright,
 * rather than trying to recognise any particular provider's spelling of them.
 */
const FORBIDDEN: readonly (readonly [RegExp, string])[] = Object.freeze([
  [/https?:\/\/[^\s"']+/i, 'a URL'],
  [/[?&](x-amz-|sig=|signature=|token=|expires=|se=|sp=|sv=|sr=)/i, 'a signed query parameter'],
  [/\bBearer\s+\S+/i, 'a bearer credential'],
  [/\bAuthorization\b\s*:/i, 'an Authorization header'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/, 'a long opaque string that may be a credential'],
  [/\.(mkv|mp4|avi|mov|m4v|ts|wmv|flac|mp3)\b/i, 'a media filename'],
]);

export interface LeakProblem { readonly kind: string; readonly at: string }

/** Every forbidden shape in `text`, described without quoting the offending substring back. */
export function findLeaks(text: string, at: string): readonly LeakProblem[] {
  const found: LeakProblem[] = [];
  for (const [pattern, kind] of FORBIDDEN) {
    if (pattern.test(text)) found.push({ kind, at });
  }
  return found;
}

/** Every forbidden shape across a set of results, checked as one string per field. */
export function findResultLeaks(results: readonly GateResult[]): readonly LeakProblem[] {
  const found: LeakProblem[] = [];
  for (const result of results) {
    found.push(...findLeaks(result.gate, `gate ${result.gate}`));
    if (result.note !== undefined) found.push(...findLeaks(result.note, `note of ${result.gate}`));
  }
  return found;
}

/**
 * A digest prefix, which is how an object is identified where a label is not specific enough.
 *
 * TWELVE HEX CHARACTERS IS ENOUGH TO TELL THREE OBJECTS APART AND USELESS FOR ANYTHING ELSE. The whole digest
 * of an object an operator holds is itself a weak identifier of that object across systems.
 */
export const digestPrefix = (sha256: string): string => sha256.slice(0, 12);

export const sha256Of = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------------------------------------
// The verdicts
// ---------------------------------------------------------------------------------------------------------

const pass = (gate: string, note: string): GateResult => ({ gate, verdict: 'pass', note });

const exactly = (gate: string, measured: number, budget: number, note: string): GateResult => ({
  gate, verdict: measured === budget ? 'pass' : 'fail', measured, budget, note,
});

const atMost = (gate: string, measured: number, budget: number, note: string): GateResult => ({
  gate, verdict: measured <= budget ? 'pass' : 'fail', measured, budget, note,
});

/** What one direct HTTPS Range request against the provider told the gate. */
export interface DirectProbe {
  readonly label: string;
  /** Negotiated TLS protocol, e.g. `TLSv1.3`. Empty means the connection was not TLS. */
  readonly tlsProtocol: string;
  /** True when the certificate chain validated against the system trust store, with no pinning and no skip. */
  readonly tlsAuthorized: boolean;
  readonly status: number;
  /** Parsed `Content-Range`, or undefined where the header was absent or unparseable. */
  readonly contentRange?: { readonly start: number; readonly end: number; readonly total: number };
  readonly contentLength?: number;
  readonly bodyBytes: number;
  readonly requestedOffset: number;
  readonly requestedLength: number;
  /** Whether the response was a redirect the gate declined to follow. */
  readonly redirected: boolean;
  readonly elapsedMs: number;
}

/**
 * The control: what the provider itself does, established outside the daemon.
 *
 * WHY A CONTROL IS NEEDED AT ALL. Every other assertion in this gate is about the daemon. If the daemon
 * fails a read, "the product is broken" and "the provider does not do byte ranges" are indistinguishable
 * from inside — and the second one is not a defect in anything this repository ships. So the gate asks the
 * provider directly, first, and records what it is. A provider that answers a ranged GET with `200` is a
 * provider this product correctly refuses to use; that has to be reported as such rather than as a failure.
 */
export function controlResults(gate: string, probes: readonly DirectProbe[],
  objects: readonly OperatorObject[], realEndpoint = true): readonly GateResult[] {
  const results: GateResult[] = [];
  if (probes.length === 0) {
    return [{ gate: `${gate}-control-ran`, verdict: 'fail', measured: 0, budget: 1,
      note: 'the control made no request at all, so nothing below is evidence about a provider' }];
  }
  results.push(exactly(`${gate}-control-ran`, probes.length, objects.length,
    'one direct control request per supplied object, so no object is asserted about without being reached'));

  for (const probe of probes) {
    const at = `${gate}:${probe.label}`;

    // --- real TLS -----------------------------------------------------------------------------------------
    //
    // AGAINST THE OFFLINE FIXTURE THESE SKIP, AND A SKIP IS NOT A PASS. The fixture is plaintext HTTP on
    // loopback and has no TLS to assert anything about; reporting `pass` there would mean the one gate whose
    // entire purpose is REAL transport recorded a TLS success it never observed. The default is a real
    // endpoint, so a forgotten flag fails closed — it asserts TLS and fails — rather than silently skipping.
    if (!realEndpoint) {
      results.push({
        gate: `${at}-tls`, verdict: 'skip',
        note: 'SKIPPED, AND A SKIP IS NOT A PASS: this ran against the offline fixture, which is plaintext '
          + 'HTTP on loopback. Real TLS is asserted only against a real endpoint, and this run closes '
          + 'nothing about one',
      });
    } else {
      results.push(exactly(`${at}-tls`, probe.tlsProtocol.startsWith('TLSv1.2')
        || probe.tlsProtocol.startsWith('TLSv1.3') ? 1 : 0, 1,
      `the connection negotiated ${probe.tlsProtocol || 'no TLS at all'}; TLS 1.2 is the floor`));
      results.push(exactly(`${at}-tls-authorized`, probe.tlsAuthorized ? 1 : 0, 1,
        'and the certificate chain validated against the system trust store — no pinning, no skipped '
        + 'verification, no operator-supplied CA, because a run that trusted anything proves nothing '
        + 'about TLS'));
    }

    // --- redirects ----------------------------------------------------------------------------------------
    results.push(exactly(`${at}-no-redirect`, probe.redirected ? 1 : 0, 0,
      probe.redirected
        ? 'the provider answered a ranged GET with a redirect. The daemon REFUSES to follow one, so this '
          + 'endpoint cannot be served by this product as configured — that is a provider incompatibility to '
          + 'report to the operator, not a defect to work around by following it'
        : 'the provider answered directly, with no redirect for the daemon to refuse'));

    // --- 206 and Content-Range discipline -----------------------------------------------------------------
    results.push(exactly(`${at}-status-206`, probe.status, 206,
      probe.status === 206 ? 'a ranged GET was answered 206, which is the only acceptable answer'
        : probe.status === 200
          ? 'the provider answered 200 with a full body. The daemon refuses this and reads zero bytes from '
            + 'it, because accepting one turns a 1 MiB probe into a whole-object download'
          : `the provider answered ${probe.status}`));

    const range = probe.contentRange;
    results.push(exactly(`${at}-content-range-parses`, range === undefined ? 0 : 1, 1,
      'Content-Range is present and is exactly `bytes <start>-<end>/<total>`'));
    if (range !== undefined) {
      results.push(exactly(`${at}-content-range-exact`,
        range.start === probe.requestedOffset && range.end === probe.requestedOffset + probe.requestedLength - 1
          ? 0 : 1, 0,
        'and it grants EXACTLY the window that was asked for, not a larger one the server preferred'));

      const declared = objects.find((object) => object.label === probe.label)?.sizeBytes;
      results.push(exactly(`${at}-size-agrees`, declared !== undefined && range.total === declared ? 0 : 1, 0,
        'and the total it reports agrees with the operator manifest. A total that disagrees means these are '
        + 'not the bytes of the object the manifest describes, and the daemon refuses the read on that basis'));
    }

    results.push(exactly(`${at}-body-exact`, probe.bodyBytes, probe.requestedLength,
      'the body carried exactly the granted window — neither short nor long'));
    if (probe.contentLength !== undefined) {
      results.push(exactly(`${at}-content-length-agrees`, probe.contentLength, probe.requestedLength,
        'and a declared Content-Length that disagreed with the window would already have failed the read'));
    }

    // --- finite deadlines ---------------------------------------------------------------------------------
    results.push(atMost(`${at}-finite-deadline`, probe.elapsedMs, CONTROL_DEADLINE_MS,
      'the control request completed inside a finite deadline. An unbounded one would let a slow provider '
      + 'hang the gate rather than fail it, and a gate that can hang is a gate that never reports'));
  }
  return results;
}

/** The control's own ceiling. Generous, because it bounds a real network, but finite. */
export const CONTROL_DEADLINE_MS = 30_000;

/** What a read through the mount produced. */
export interface MountRead {
  readonly label: string;
  readonly kind: 'whole' | 'probe' | 'backward' | 'tail';
  readonly offset: number;
  readonly length: number;
  readonly bytesRead: number;
  readonly sha256: string;
  readonly elapsedMs: number;
}

/**
 * The reads through the mount, against digests recorded outside it.
 *
 * "OUTSIDE THE MOUNT" IS THE WHOLE ASSERTION. A digest computed from what the mount returned, compared against
 * itself, is satisfied by a mount that returns anything at all consistently. The expected digests here come
 * either from the operator's manifest or from the gate's own direct control — both established without the
 * daemon in the path.
 */
export function readResults(gate: string, reads: readonly MountRead[],
  objects: readonly OperatorObject[]): readonly GateResult[] {
  const results: GateResult[] = [];
  if (reads.length === 0) {
    return [{ gate: `${gate}-reads-happened`, verdict: 'fail', measured: 0, budget: 1,
      note: 'no read through the mount was attempted, so every assertion below would be vacuous' }];
  }

  for (const object of objects) {
    const mine = reads.filter((read) => read.label === object.label);
    const at = `${gate}:${object.label}`;

    // EVERY OBJECT IS READ IN ALL THREE SHAPES. A gate that read only forwards from zero would never exercise
    // the seek path, which is the one a media server actually uses.
    for (const kind of ['backward', 'tail'] as const) {
      results.push(exactly(`${at}-${kind}-read`, mine.filter((read) => read.kind === kind).length, 1,
        kind === 'backward'
          ? 'a BACKWARD read was performed — an offset lower than one already read, which is what a seek '
            + 'backwards in a player does and what a forward-only cache gets wrong'
          : 'and a read starting past 90% of the object, which is where a container index often lives and '
            + 'where an implementation that streams from zero falls over'));
    }

    for (const read of mine) {
      results.push(exactly(`${at}-${read.kind}-bytes`, read.bytesRead, read.length,
        'the read returned exactly the bytes asked for'));
      results.push(atMost(`${at}-${read.kind}-deadline`, read.elapsedMs, MOUNT_READ_DEADLINE_MS,
        'inside a finite deadline'));
    }

    // --- the digest authority -----------------------------------------------------------------------------
    const whole = mine.find((read) => read.kind === 'whole');
    if (object.sha256 !== undefined && whole !== undefined) {
      results.push(exactly(`${at}-whole-digest`, whole.sha256 === object.sha256 ? 0 : 1, 0,
        `the whole object read through the mount digests to ${digestPrefix(whole.sha256)}…, and the operator `
        + `manifest recorded ${digestPrefix(object.sha256)}… outside the mount before the run`));
    }
    for (const probe of object.probeDigests ?? []) {
      const match = mine.find((read) => read.kind === 'probe'
        && read.offset === probe.offset && read.length === probe.length);
      results.push(exactly(`${at}-probe-${probe.offset}-digest`,
        match !== undefined && match.sha256 === probe.sha256 ? 0 : 1, 0,
        match === undefined
          ? 'the approved probe window was never read through the mount'
          : `the approved window digests to ${digestPrefix(match.sha256)}…, against `
            + `${digestPrefix(probe.sha256)}… recorded outside the mount`));
    }
  }
  return results;
}

export const MOUNT_READ_DEADLINE_MS = 120_000;

/** Counters the gate can observe without a fixture on the other end. */
export interface TransportObservations {
  /** 429s the daemon reported meeting. Recorded, and bounded — never provoked. */
  readonly status429: number;
  /** Retries the daemon made after a retryable failure. */
  readonly retries: number;
  /** Access-material refreshes performed during a single read. */
  readonly refreshesPerRead: readonly number[];
  /** Connections that reached an origin the allowlist does not name. */
  readonly disallowedOriginContacts: number;
  /** Whether the endpoint resolves references before reading, so refresh assertions apply at all. */
  readonly endpointExpires: boolean;
}

/**
 * Retry, refresh and egress, as things to bound rather than to provoke.
 *
 * NOTHING HERE GENERATES LOAD. §2 says this corpus is never a load test, so the gate does not manufacture a
 * 429 by hammering somebody's provider — it bounds what happens if one arrives. A 429 met and backed off from
 * is correct behaviour; a 429 met and retried without bound is a defect, and the difference is a count.
 */
export function transportResults(gate: string, observed: TransportObservations): readonly GateResult[] {
  const results: GateResult[] = [
    atMost(`${gate}-retries-bounded`, observed.retries, MAX_RETRIES_PER_READ,
      'retries after a retryable failure stayed inside the contract bound. This is NOT a load test and no '
      + '429 was provoked: what is asserted is that meeting one is bounded, not that one was made to happen'),
    exactly(`${gate}-egress-allowlist`, observed.disallowedOriginContacts, 0,
      'nothing reached an origin the allowlist does not name, observed at a listener the gate stands up on '
      + 'the origin it deliberately excluded'),
  ];

  results.push({
    gate: `${gate}-429-observed`, verdict: 'pass',
    note: `RECORDED, ASSERTED BY NOTHING — the provider answered 429 ${observed.status429} time(s). A real `
      + 'provider is entitled to rate-limit and this gate does not treat that as a defect; G16 asserts zero '
      + '429s, and it does so against the FAKE endpoint where the harness controls the load',
  });

  // --- one refresh per read, and only where the endpoint has expiring access material ---------------------
  if (!observed.endpointExpires) {
    results.push({
      gate: `${gate}-refresh-per-read`, verdict: 'skip',
      note: 'SKIPPED, AND A SKIP IS NOT A PASS: the supplied endpoint serves stable references directly and '
        + 'has no expiring access material, so there is nothing to refresh. G24–G26 assert the refresh '
        + 'contract in full against the fake endpoint, which does have it',
    });
  } else {
    const worst = observed.refreshesPerRead.length === 0 ? 0 : Math.max(...observed.refreshesPerRead);
    results.push(atMost(`${gate}-refresh-per-read`, worst, MAX_ACCESS_REFRESHES_PER_READ,
      'a read that met expired access material re-resolved it AT MOST once. A second refresh inside one read '
      + 'is the shape of a resolution storm, and the product terminalises it rather than looping'));
  }
  return results;
}

export const MAX_RETRIES_PER_READ = 3;
export const MAX_ACCESS_REFRESHES_PER_READ = 1;

/** The mount is a read-only projection, and a real provider does not make it otherwise. */
export function readOnlyResults(gate: string, refusals: {
  readonly writeRefused: boolean; readonly createRefused: boolean;
  readonly unlinkRefused: boolean; readonly chmodRefused: boolean;
}): readonly GateResult[] {
  return [
    exactly(`${gate}-write-refused`, refusals.writeRefused ? 0 : 1, 0, 'a write into the mount is refused'),
    exactly(`${gate}-create-refused`, refusals.createRefused ? 0 : 1, 0, 'as is creating a file'),
    exactly(`${gate}-unlink-refused`, refusals.unlinkRefused ? 0 : 1, 0, 'as is unlinking one'),
    exactly(`${gate}-chmod-refused`, refusals.chmodRefused ? 0 : 1, 0, 'as is changing a mode'),
  ];
}

/** Nothing survives the run: not a mount, not a container, not a byte of access material. */
export function cleanupResults(gate: string, left: {
  readonly mountpoints: number; readonly containers: number;
  readonly runDirectories: number; readonly leaseTracesOnDisk: number;
}): readonly GateResult[] {
  return [
    exactly(`${gate}-mountpoints`, left.mountpoints, 0, 'no mountpoint survived the run'),
    exactly(`${gate}-containers`, left.containers, 0, 'no container survived it'),
    exactly(`${gate}-run-directories`, left.runDirectories, 0, 'and no run directory'),
    exactly(`${gate}-no-lease-on-disk`, left.leaseTracesOnDisk, 0,
      'and no access material reached disk — searched for by the exact high-entropy value the run used, '
      + 'across every file the run wrote, because "we do not log it" is a claim and this is a measurement'),
  ];
}

/**
 * The run really happened, which is the assertion every other one here depends on.
 *
 * A GATE WHOSE PROVIDER WAS NEVER CONTACTED PASSES EVERYTHING ABOVE. Zero control probes, zero mount reads
 * and zero bytes satisfy every "at most" in this file. So the count of bytes that actually crossed the wire
 * is asserted to be positive, per object, and the gate says so in the report rather than leaving a reader to
 * infer it from the absence of a failure.
 */
export function workDoneResults(gate: string, work: {
  readonly objectsRead: number; readonly bytesFromProvider: number; readonly expectedObjects: number;
}): readonly GateResult[] {
  return [
    exactly(`${gate}-objects-read`, work.objectsRead, work.expectedObjects,
      'every supplied object was actually read through the mount'),
    {
      gate: `${gate}-bytes-from-provider`,
      verdict: work.bytesFromProvider > 0 ? 'pass' : 'fail',
      measured: work.bytesFromProvider,
      budget: 1,
      note: 'and a positive number of bytes genuinely crossed the wire. Zero satisfies every ceiling in this '
        + 'file, so without this assertion a run that contacted nothing would report a clean pass',
    },
  ];
}
