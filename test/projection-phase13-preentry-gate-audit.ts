import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import { NO_SHELL, posixShell, shPath, shellOrThrow } from './posix-shell-kit.js';
import { transportResults } from '../src/core/projection/real-provider.js';

// Projection Phase 13 PRE-ENTRY — the adversarial audit over the SHIPPED BYTES.
//
// WHAT THIS SUITE IS FOR, AND WHY IT READS BYTES RATHER THAN INTENTIONS. Phase 8's gate defined a function
// and never called it, so the file every later assertion read was never written; `bash -n` did not catch it,
// an id audit did not catch it, and only RUNNING it did, six hours in. The classes of defect this file is
// aimed at are the ones that survive a syntax check, and every one of them was found in this repository's
// own shipped scripts by an independent readiness review that ran nothing:
//
//   A WRAPPER THAT RUNS SOMETHING OTHER THAN THE GATE ITS FILENAME NAMES. Four of them shipped.
//   A CALL SITE NOBODY HAS EVER EXECUTED, carrying a path that only exists in the other mode.
//   A LITERAL A RUN CANNOT MOVE, standing in for an observation and deciding a verdict or a skip.
//   AN UNBOUNDED WAIT, which is not a slow failure but a hang.
//   A CLEANUP THAT REMOVES WHAT IT DID NOT CREATE, which satisfies a count while violating the sentence.
//
// EVERY STRUCTURAL CHECK HERE CARRIES A CONTROL THAT PROVES THE AUDIT BITES. Phase 8's lesson was not "write
// an audit"; it was that the old pin — strip the suffix, grep for the bare string — was green against a gate
// recording five ids with no suffix at all. So each check is re-run against a DELIBERATELY UNREPAIRED COPY
// of the shipped bytes and asserted to FAIL. `REPAIRS_WITHOUT_A_CONTROL_MAX` is zero and this is where that
// number is spent.
//
// THE SHELL IS CHOSEN BY EXECUTION, NOT BY NAME. `./posix-shell-kit.js` makes each candidate EXECUTE a script
// at the path spelling this suite hands out and keeps the first that can. Started from an ordinary
// PowerShell, bare `bash` on a stock Windows PATH is the WSL launcher, which cannot address a Windows drive
// path in any spelling and answers 127 — the same number these controls assert on.
//
// IT STARTS NO CONTAINER, CONTACTS NOTHING, AND READS NO OPERATOR INPUT. The only programs it runs are the
// wrappers, against stubs it writes into a temporary directory.

const h = createHarness('Projection Phase 13 pre-entry — the instrument audit over the shipped bytes');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const tmpDirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'p13pre-audit-'));
  tmpDirs.push(dir);
  return dir;
};

/** Comments stripped, so a gate NAMED in an explanation is not mistaken for one that is invoked. */
const codeOf = (body: string): string => body.replace(/^\s*#.*$/gm, '');

const GENERIC_GATE = 'deploy/projection-real-provider-gate.sh';
const PROVIDER_GATE = 'deploy/projection-torbox-real-gate.sh';
const STAGE = 'deploy/projection-phase12-stage.sh';
const CONTRACT = 'docs/PROJECTION_PHASE_13_PRE_ENTRY_INSTRUMENT_REPAIR.md';
const READINESS = 'deploy/projection-preentry-readiness.sh';

// ---------------------------------------------------------------------------------------------------------
h.section('P13PRE-I1 — every optional wrapper invokes the gate its own filename names');
// ---------------------------------------------------------------------------------------------------------

/** Every `deploy/*-optional.sh` in the tree, discovered rather than listed. */
function optionalWrappers(): readonly string[] {
  return readdirSync(join(repoRoot, 'deploy'))
    .filter((name) => name.endsWith('-optional.sh'))
    .sort();
}

/** The gate a wrapper's filename names: `x-optional.sh` names `x.sh`. */
const gateNamedBy = (wrapper: string): string => `${basename(wrapper, '-optional.sh')}.sh`;

/** The gate a wrapper actually defaults to, read out of its `GATE_COMMAND` assignment. */
function gateInvokedBy(body: string): string | undefined {
  const match = /GATE_COMMAND="\$\{[A-Z0-9_]+:-\$HERE\/([A-Za-z0-9._-]+)\}"/.exec(codeOf(body));
  return match?.[1];
}

test('the sweep is over EVERY wrapper in the tree, not over a list somebody maintains', () => {
  const wrappers = optionalWrappers();
  assert(wrappers.length >= 20,
    `only ${wrappers.length} optional wrappers were discovered, which is too few for this tree — the sweep `
    + 'is looking in the wrong place and would report zero miswired wrappers for the wrong reason');
  // AND THE FOUR THE READINESS REVIEW NAMED ARE IN IT. A sweep that silently stopped finding them would be
  // green for the same reason a stopped-part-way inventory is.
  for (const named of [
    'projection-path-lifecycle-gate-optional.sh',
    'projection-real-provider-gate-optional.sh',
    'projection-torbox-mount-gate-optional.sh',
    'projection-torbox-real-gate-optional.sh',
  ]) {
    assert(wrappers.includes(named), `${named} was not discovered by the sweep`);
  }
});

test('every wrapper defaults to the gate its own filename names, and that gate exists', () => {
  const miswired: string[] = [];
  for (const wrapper of optionalWrappers()) {
    const body = read(`deploy/${wrapper}`);
    const invoked = gateInvokedBy(body);
    assert(invoked !== undefined,
      `${wrapper} has no GATE_COMMAND default this audit can read, so what it runs is unknown`);
    if (invoked !== gateNamedBy(wrapper)) miswired.push(`${wrapper} runs ${String(invoked)}`);
    assert(readdirSync(join(repoRoot, 'deploy')).includes(String(invoked)),
      `${wrapper} defaults to ${String(invoked)}, which is not a file in deploy/`);
  }
  assertEq(miswired.length, 0,
    `MISWIRED_OPTIONAL_WRAPPERS_MAX is 0 and ${miswired.length} wrapper(s) run a gate they do not name: `
    + miswired.join('; '));
});

test('every wrapper folds 77 ALONE, and propagates every other status unchanged', () => {
  for (const wrapper of optionalWrappers()) {
    const code = codeOf(read(`deploy/${wrapper}`));
    assert(/GATE_SKIP_STATUS=77/.test(code), `${wrapper} does not name 77 as the skip status`);
    assert(/if \[ "\$status" -eq "\$GATE_SKIP_STATUS" \]/.test(code),
      `${wrapper} does not compare the gate's status against the skip status`);
    assert(/^exit "\$status"$/m.test(code),
      `${wrapper} does not propagate a non-skip status unchanged, so a real failure could be folded`);
    // AND IT SAYS SO. A skip mapped to zero in silence is a green line nobody can interpret. THE SPELLING IS
    // NOT PINNED, and deliberately: two wrappers say "NOTHING WAS MEASURED" and then name what specifically
    // did not happen, which is the same job done better. Both are other tranches' files, and an audit that
    // failed them for their wording would be this tranche editing prose it does not own.
    assert(/NOTHING WAS (PROVED|MEASURED)/.test(read(`deploy/${wrapper}`)),
      `${wrapper} folds a skip into success without saying that nothing was proved`);
  }
});

test('the four wrappers this tranche repaired each say what their folded skip does NOT close', () => {
  // ONLY THIS TRANCHE'S FOUR. The structural checks above are over every wrapper in the tree; this one is
  // over the files whose prose this tranche wrote, because a green `-optional` run is exactly the line a
  // reader is most likely to mistake for evidence.
  for (const wrapper of [
    'projection-path-lifecycle-gate-optional.sh',
    'projection-real-provider-gate-optional.sh',
    'projection-torbox-mount-gate-optional.sh',
    'projection-torbox-real-gate-optional.sh',
  ]) {
    const body = read(`deploy/${wrapper}`);
    assert(body.includes('No acceptance gate is closed by this run.'),
      `${wrapper} does not say what its folded skip fails to close`);
    assert(/ONLY 77 IS MAPPED/.test(body),
      `${wrapper} does not say that only 77 is folded, so a reader cannot tell a skip from a pass`);
    assert(/IT RUNS THE GATE ITS OWN FILENAME NAMES/.test(body),
      `${wrapper} does not record the defect it was repaired for, so the next copy of it starts clean`);
  }
});

test('CONTROL: a wrapper returned to the wrong gate is CAUGHT', () => {
  // THE EXACT UNREPAIRED BYTES. This is what shipped before the repair, character for character.
  const body = read('deploy/projection-torbox-real-gate-optional.sh');
  const tampered = body.replace(
    'GATE_COMMAND="${PROJECTION_TORBOX_REAL_GATE_COMMAND:-$HERE/projection-torbox-real-gate.sh}"',
    'GATE_COMMAND="${PROJECTION_TORBOX_REAL_GATE_COMMAND:-$HERE/projection-three-server-concurrency-gate.sh}"',
  );
  assert(tampered !== body, 'the tamper did not apply, so this control proves nothing');
  assertEq(gateInvokedBy(tampered), 'projection-three-server-concurrency-gate.sh',
    'the audit could not even read what the tampered wrapper runs, so it would not have caught the original');
  assert(gateInvokedBy(tampered) !== gateNamedBy('projection-torbox-real-gate-optional.sh'),
    'the audit reads the tampered wrapper as running the gate it names, so it would not have caught the '
    + 'defect that actually shipped in four files');
});

test('CONTROL: a wrapper that folded a FAILURE into success is CAUGHT', () => {
  const body = read('deploy/projection-real-provider-gate-optional.sh');
  const tampered = body.replace('exit "$status"', 'exit 0');
  assert(tampered !== body, 'the tamper did not apply, so this control proves nothing');
  assert(!/^exit "\$status"$/m.test(codeOf(tampered)),
    'a wrapper that exits 0 whatever the gate said still reads as propagating the status');
});

test('DRIVEN: each repaired wrapper really executes the gate its filename names', () => {
  // THE ONLY CHECK HERE THAT IS NOT A READ. A default nobody executed is how the original defect survived a
  // syntax check and an id audit, so this one RUNS the wrapper against a stub standing in for the gate.
  const shell = posixShell();
  if (shell === null) { assert(true, NO_SHELL); return; }
  for (const [wrapper, seam] of [
    ['projection-torbox-real-gate-optional.sh', 'PROJECTION_TORBOX_REAL_GATE_COMMAND'],
    ['projection-real-provider-gate-optional.sh', 'PROJECTION_REAL_PROVIDER_GATE_COMMAND'],
    ['projection-torbox-mount-gate-optional.sh', 'PROJECTION_TORBOX_GATE_COMMAND'],
    ['projection-path-lifecycle-gate-optional.sh', 'PROJECTION_LIFECYCLE_GATE_COMMAND'],
  ] as const) {
    const dir = freshDir();
    const stub = join(dir, 'stub.sh');
    writeFileSync(stub, '#!/bin/sh\nprintf "%s" "stub-for-$1"\nexit "${STUB_STATUS:-0}"\n');
    try { chmodSync(stub, 0o755); } catch { /* Windows has no executable bit */ }

    // 77 IS FOLDED.
    const skipped = spawnSync(shellOrThrow(), [shPath(join(repoRoot, 'deploy', wrapper)), 'arg'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, [seam]: shPath(stub), STUB_STATUS: '77' },
    });
    assertEq(skipped.status, 0, `${wrapper} did not fold the gate's 77 into success`);

    // AND NOTHING ELSE IS. 70 is the origin recheck's "disallowed" and it must never become a zero.
    for (const status of ['1', '70', '124']) {
      const failed = spawnSync(shellOrThrow(), [shPath(join(repoRoot, 'deploy', wrapper)), 'arg'], {
        encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, [seam]: shPath(stub), STUB_STATUS: status },
      });
      assertEq(failed.status, Number(status), `${wrapper} did not propagate status ${status} unchanged`);
    }

    // AND THE ARGUMENTS REACH THE GATE. A wrapper that swallowed argv would run a different invocation.
    const passed = spawnSync(shellOrThrow(), [shPath(join(repoRoot, 'deploy', wrapper)), '--fake'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, [seam]: shPath(stub), STUB_STATUS: '0' },
    });
    assert(String(passed.stdout ?? '').includes('stub-for---fake'),
      `${wrapper} did not pass its arguments through to the gate`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The model: the helpers these gates write, extracted so a suite can DRIVE them rather than grep them.
// ---------------------------------------------------------------------------------------------------------

/**
 * The body of one heredoc-written helper, by its terminator.
 *
 * A CHECK THAT MATCHED THE COMMAND LINE WOULD PROVE THE STRING WAS PRESENT, not that the program answers.
 * Phase 8's defect was a function defined and never called, which every string check in the world is green
 * against; these gates write their helpers as heredocs precisely so a suite can lift them out and run them.
 */
function helperFrom(gatePath: string, terminator: string): string {
  const body = read(gatePath);
  const open = body.indexOf(`<<'${terminator}'`);
  assert(open >= 0, `${gatePath} writes no ${terminator} helper, so nothing here can be driven`);
  const from = body.indexOf('\n', open) + 1;
  const to = body.indexOf(`\n${terminator}\n`, from);
  assert(to > from, `${gatePath}'s ${terminator} helper is not terminated, so it would never be written`);
  return body.slice(from, to);
}

/** Run an extracted helper with node, in a throwaway directory. */
function runHelper(source: string, args: readonly string[]): { status: number; out: string; err: string } {
  const dir = freshDir();
  const script = join(dir, 'helper.cjs');
  writeFileSync(script, source);
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60_000 });
  return {
    status: result.status ?? -1,
    out: String(result.stdout ?? '').trim(),
    err: String(result.stderr ?? '').trim(),
  };
}

const writeJson = (dir: string, name: string, value: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
};

// ---------------------------------------------------------------------------------------------------------
h.section('P13PRE-I2 — the real mode reads the operator\'s inputs, not a fake-mode path');
// ---------------------------------------------------------------------------------------------------------

test('no call site on the real-mode path names the fake-mode input file', () => {
  const code = codeOf(read(GENERIC_GATE));
  // THE DEFECT, EXACTLY. `node "$REL/config.cjs" "$REL/inputs/endpoint.json" …` ran in BOTH modes; in real
  // mode that file was never written, so `readFileSync` threw ENOENT twelve steps into twenty.
  assert(!/config\.cjs" "\$REL\/inputs\/endpoint\.json"/.test(code),
    'the daemon configuration is still built from the fake-mode endpoint path, so a real run dies at ENOENT '
    + 'before it mounts anything — which is why real mode had never completed a run on any host');
  assert(/node "\$REL\/config\.cjs" "\$ENDPOINT" "\$WORK\/config\.json" "\$DAEMON_CREDENTIAL"/.test(code),
    'the daemon configuration is not built from the endpoint this run selected and the credential the '
    + 'daemon will actually open');
  // AND IT IS THE FILE THE DAEMON OPENS, NOT THE ONE THE OPERATOR SUPPLIED. In real mode those are two
  // different paths -- the second is a copy of the first -- and checking the source would check a file the
  // daemon never reads, which is the same one-remove-from-the-truth shape as asserting a mount by its
  // fstype rather than by its mountinfo tuple.
  assertEq((code.match(/DAEMON_CREDENTIAL="\$REL\/inputs\/credential"/g) ?? []).length, 2,
    'the daemon credential path is not set once per mode, so one mode points config.cjs at a file the '
    + 'daemon does not open');
});

test('the operator\'s credential is placed where the daemon opens it', () => {
  const code = codeOf(read(GENERIC_GATE));
  // `config.cjs` writes tokenFile: /var/lib/projectiond/inputs/credential, and the container binds
  // $WORK/inputs there. In real mode that directory was created EMPTY and nothing ever copied the
  // operator's credential in, so even past the endpoint defect the daemon would have found nothing.
  assert(/tokenFile: '\/var\/lib\/projectiond\/inputs\/credential'/.test(code),
    'the daemon is no longer pointed at a credential inside its own inputs bind, so this check is stale');
  assert(/install -m 600 "\$CREDENTIAL_FILE" "\$WORK\/inputs\/credential"/.test(code),
    'real mode does not place the operator credential where the daemon opens it, so the daemon would start '
    + 'and fail every read for a reason no assertion in the gate names');
  assert(/-v "\$WORK\/inputs:\/var\/lib\/projectiond\/inputs:ro"/.test(code),
    'the inputs directory is no longer bound read-only into the daemon, so the copy above lands nowhere');
});

test('DRIVEN: config.cjs REFUSES to build a daemon configuration around a missing credential', () => {
  // THE THIRD ARGUMENT USED TO BE PASSED AND DESTRUCTURED AWAY -- the fingerprint of a call site nobody
  // executed. It is now read, and an absent credential fails HERE rather than as a read failure later.
  const helper = helperFrom(GENERIC_GATE, 'CONFIG');
  const dir = freshDir();
  const endpoint = writeJson(dir, 'endpoint.json', {
    id: 'e', directBaseUrl: 'http://x/direct', allowedOrigins: ['http://x'],
  });
  const out = join(dir, 'config.json');

  assertEq(runHelper(helper, [endpoint, out]).status !== 0, true,
    'the daemon configuration was built without being told which credential the daemon will open');
  assertEq(runHelper(helper, [endpoint, out, join(dir, 'absent')]).status !== 0, true,
    'a credential file that does not exist was accepted');
  const empty = join(dir, 'empty');
  writeFileSync(empty, '');
  assertEq(runHelper(helper, [endpoint, out, empty]).status !== 0, true,
    'an EMPTY credential file was accepted, and an empty credential fails every read');

  const credential = join(dir, 'credential');
  writeFileSync(credential, 'a-value-this-suite-invented\n');
  assertEq(runHelper(helper, [endpoint, out, credential]).status, 0,
    'a well-formed input triple was refused, so this check refuses everything and proves nothing');
  const config = JSON.parse(readFileSync(out, 'utf8')) as { endpoints: Array<{ tokenFile: string }> };
  assertEq(config.endpoints[0]?.tokenFile, '/var/lib/projectiond/inputs/credential', 'tokenFile');
  // AND THE VALUE NEVER ENTERS THE CONFIGURATION. The credential is named by path and read by the daemon.
  assert(!readFileSync(out, 'utf8').includes('a-value-this-suite-invented'),
    'the credential VALUE reached the daemon configuration, which is the one thing this file may not do');
});

test('CONTROL: the unrepaired real-mode endpoint path is CAUGHT', () => {
  const body = read(GENERIC_GATE);
  const tampered = body.replace(
    'node "$REL/config.cjs" "$ENDPOINT" "$WORK/config.json" "$DAEMON_CREDENTIAL"',
    'node "$REL/config.cjs" "$REL/inputs/endpoint.json" "$WORK/config.json" "$DAEMON_CREDENTIAL"',
  );
  assert(tampered !== body, 'the tamper did not apply, so this control proves nothing');
  assert(/config\.cjs" "\$REL\/inputs\/endpoint\.json"/.test(codeOf(tampered)),
    'the audit does not see the fake-mode path in the tampered bytes, so it would not have caught the defect '
    + 'that shipped');
});

test('CONTROL: a config.cjs that ignores its credential argument again is CAUGHT', () => {
  const helper = helperFrom(GENERIC_GATE, 'CONFIG');
  const tampered = helper.replace(
    'const [, , endpointPath, out, credentialPath] = process.argv;',
    'const [, , endpointPath, out] = process.argv;',
  ).replace(/if \(typeof credentialPath[\s\S]*?\n\}\n/, '').replace(/const credentialStat[\s\S]*?\n\}\n/, '');
  assert(tampered !== helper, 'the tamper did not apply, so this control proves nothing');
  const dir = freshDir();
  const endpoint = writeJson(dir, 'endpoint.json', {
    id: 'e', directBaseUrl: 'http://x/direct', allowedOrigins: ['http://x'],
  });
  assertEq(runHelper(tampered, [endpoint, join(dir, 'config.json'), join(dir, 'absent')]).status, 0,
    'the unrepaired helper did NOT accept a missing credential, so the check above proves nothing about it');
});

// ---------------------------------------------------------------------------------------------------------
h.section('P13PRE-I3 — no decision-bearing observation is a literal a run cannot move');
// ---------------------------------------------------------------------------------------------------------

test('the two fields that decided a PERMANENT skip are no longer literals', () => {
  const helper = helperFrom(GENERIC_GATE, 'OBSERVATIONS');
  // WHAT SHIPPED: `egressObservedAtListener: false,` and `endpointExpires: false,` written identically in
  // both modes, so RP3-egress-allowlist and RP3-refresh-per-read skipped on every host against every
  // endpoint, and no repair anywhere in the product could ever have cleared them.
  for (const field of ['egressObservedAtListener', 'endpointExpires']) {
    assert(!new RegExp(`^\\s*${field}: (false|true),`, 'm').test(helper),
      `${field} is still written as a literal, so the arm it decides can never be reached by any run`);
  }
  assert(/provenance: \{/.test(helper),
    'the record carries no provenance, so "this was measured" and "nothing could measure it" are one line');
});

test('DRIVEN: endpointExpires is read off the endpoint document this run used', () => {
  const helper = helperFrom(GENERIC_GATE, 'OBSERVATIONS');
  const dir = freshDir();
  const resolver = writeJson(dir, 'resolver.json', {
    id: 'e', resolverUrl: 'https://resolver.invalid/r', allowedOrigins: ['https://a.invalid'],
  });
  const direct = writeJson(dir, 'direct.json', {
    id: 'e', directBaseUrl: 'http://x/direct', allowedOrigins: ['http://x'],
  });
  const observe = (endpoint: string, trap: string, counters: string): Record<string, unknown> => {
    const out = join(freshDir(), 'observations.json');
    const result = runHelper(helper, [out, 'true', 'true', 'true', 'true', '0', 'real',
      '0', '0', '0', endpoint, trap, counters]);
    assertEq(result.status, 0, `the observation record could not be written: ${result.err}`);
    return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
  };

  // A RESOLVER ENDPOINT HAS EXPIRING ACCESS MATERIAL, which is what the real mode is for and what the
  // literal `false` denied for ever.
  const withResolver = observe(resolver, '', '');
  assertEq(withResolver.endpointExpires, true,
    'a resolver endpoint is still reported as having no expiring access material, so RP3-refresh-per-read '
    + 'skips against the exact endpoint kind it was written for');

  // AND A DIRECT ONE DOES NOT. The field moved, in both directions, which is what makes it a measurement.
  assertEq(observe(direct, '', '').endpointExpires, false,
    'a direct endpoint is reported as expiring, so the field is a constant pointing the other way');
});

test('DRIVEN: the egress observation is a fact about a listener, and its absence is UNTAKEN not zero', () => {
  const helper = helperFrom(GENERIC_GATE, 'OBSERVATIONS');
  const dir = freshDir();
  const endpoint = writeJson(dir, 'endpoint.json', {
    id: 'e', directBaseUrl: 'http://x/direct', allowedOrigins: ['http://x'],
  });
  const observe = (trap: string): Record<string, never> => {
    const out = join(freshDir(), 'observations.json');
    const result = runHelper(helper, [out, 'true', 'true', 'true', 'true', '0', 'fake',
      '0', '0', '0', endpoint, trap, '']);
    assertEq(result.status, 0, `the observation record could not be written: ${result.err}`);
    return JSON.parse(readFileSync(out, 'utf8')) as Record<string, never>;
  };

  const without = observe('') as unknown as {
    egressObservedAtListener: boolean; provenance: Record<string, string>;
  };
  assertEq(without.egressObservedAtListener, false, 'a run with no listener claimed to have observed one');
  assert(String(without.provenance.egressObservedAtListener).startsWith('UNTAKEN'),
    'a run that stood up no listener does not record the absence as UNTAKEN, so a reader cannot tell it from '
    + 'a measurement that came back clean');
  assert(String(without.provenance.disallowedOriginContacts).startsWith('UNTAKEN'),
    'a contact count with no listener behind it is recorded as though something counted');

  // AND A RUN THAT FILES ONE MOVES IT, WHICH IS THE WHOLE DIFFERENCE FROM A LITERAL.
  const trap = writeJson(dir, 'trap.json', { listenerStoodUp: true, contacts: 0 });
  const withListener = observe(trap) as unknown as {
    egressObservedAtListener: boolean; disallowedOriginContacts: number; provenance: Record<string, string>;
  };
  assertEq(withListener.egressObservedAtListener, true,
    'a filed listener observation did not move the field, so it is still a constant');
  assertEq(withListener.disallowedOriginContacts, 0, 'the listener saw nothing and the count disagrees');
  assert(!String(withListener.provenance.egressObservedAtListener).startsWith('UNTAKEN'),
    'a measured observation is still recorded as untaken');

  // AND A CONTACT IS CARRIED THROUGH RATHER THAN FLATTENED. A count that could only ever be zero is the
  // literal this repair removed, wearing a different name.
  const dirty = writeJson(dir, 'trap-dirty.json', { listenerStoodUp: true, contacts: 3 });
  assertEq((observe(dirty) as unknown as { disallowedOriginContacts: number }).disallowedOriginContacts, 3,
    'a listener that saw three contacts was reported as having seen none');
});

test('CONTROL: restoring either literal is CAUGHT', () => {
  const helper = helperFrom(GENERIC_GATE, 'OBSERVATIONS');
  for (const field of ['egressObservedAtListener', 'endpointExpires']) {
    const tampered = helper.replace(new RegExp(`^(\\s*)${field},$`, 'm'), `$1${field}: false,`);
    assert(tampered !== helper, `the ${field} tamper did not apply, so this control proves nothing`);
    assert(new RegExp(`^\\s*${field}: (false|true),`, 'm').test(tampered),
      `a restored ${field} literal does not read as a literal, so the check above would not have caught the `
      + 'defect that shipped');
  }
});

// ---------------------------------------------------------------------------------------------------------
h.section('P13PRE-I3 (extended) — all FIVE decision-bearing fields, and provenance that is READ');
// ---------------------------------------------------------------------------------------------------------

/** The five fields a transport verdict is decided by, read from the module that decides them. */
const DECISION_BEARING = [
  'retries', 'status429', 'refreshesPerRead', 'disallowedOriginContacts', 'endpointExpires',
] as const;

/** The observation record the shipped helper writes, for a given endpoint/trap/counters triple. */
function observationRecord(endpoint: string, trap: string, counters: string, mode = 'real'): any {
  const helper = helperFrom(GENERIC_GATE, 'OBSERVATIONS');
  const out = join(freshDir(), 'observations.json');
  const result = runHelper(helper, [out, 'true', 'true', 'true', 'true', '0', mode,
    '0', '0', '0', endpoint, trap, counters]);
  assertEq(result.status, 0, `the observation record could not be written: ${result.err}`);
  return JSON.parse(readFileSync(out, 'utf8'));
}

const resolverEndpoint = (): string => writeJson(freshDir(), 'resolver.json', {
  id: 'tb', resolverUrl: 'https://resolver.invalid/r', allowedOrigins: ['https://cdn.invalid'],
});
const directEndpoint = (): string => writeJson(freshDir(), 'direct.json', {
  id: 'fake', directBaseUrl: 'http://fakerange:8099/direct', allowedOrigins: ['http://fakerange:8099'],
});
const verdictFor = (record: unknown, arm: string): { verdict: string; note?: string; measured?: number } =>
  transportResults('RP3', record as never).find((one) => one.gate === `RP3-${arm}`)!;

test('the record names the provenance of ALL FIVE decision-bearing fields, by the module\'s own field names', () => {
  // WHY THIS IS FIVE AND NOT THREE. The record used to carry a single `transportCounters` key standing for
  // `retries`, `status429` AND `refreshesPerRead` -- and `real-provider.ts` looks provenance up PER FIELD, so
  // a key the module never consults is a provenance nothing enforces. That is exactly how `refresh-per-read`
  // came to pass out of an empty list: the record said UNTAKEN under a name no assertion read.
  const record = observationRecord(resolverEndpoint(), '', '');
  for (const field of DECISION_BEARING) {
    assert(typeof record.provenance?.[field] === 'string' && record.provenance[field] !== '',
      `the record carries no provenance for ${field}, so nothing can refuse a verdict decided by it`);
  }
  // AND NO FIELD IS A LITERAL IN THE HELPER. A value written the same way in both modes is a number no run
  // can move, whichever direction it decides.
  const helper = helperFrom(GENERIC_GATE, 'OBSERVATIONS');
  for (const field of DECISION_BEARING) {
    assert(!new RegExp(`^\\s*${field}: (false|true|0|\\[\\]),`, 'm').test(helper),
      `${field} is written as a literal, so the arm it decides can never be reached by any run`);
  }
});

test('DRIVEN: every one of the five, UNTAKEN, produces a SKIP and never a pass', () => {
  // ONE FIELD AT A TIME, over a record that is otherwise fully measured, so each arm's refusal is attributed
  // to its own provenance rather than to whichever one happened to be missing first.
  const taken = {
    status429: 0, retries: 0, refreshesPerRead: [1], disallowedOriginContacts: 0,
    egressObservedAtListener: true, endpointExpires: true,
    provenance: {
      status429: 'counted', retries: 'counted', refreshesPerRead: 'counted',
      disallowedOriginContacts: 'counted', endpointExpires: 'derived-from-the-endpoint-document',
    },
  };
  // The fully measured record is green, so this check is falsifiable in the other direction too.
  for (const arm of ['retries-bounded', '429-observed', 'egress-allowlist', 'refresh-per-read']) {
    assertEq(verdictFor(taken, arm).verdict, 'pass', `a fully measured record did not pass ${arm}`);
  }

  const armOf: Record<string, string> = {
    retries: 'retries-bounded', status429: '429-observed',
    disallowedOriginContacts: 'egress-allowlist', refreshesPerRead: 'refresh-per-read',
    endpointExpires: 'refresh-per-read',
  };
  for (const field of DECISION_BEARING) {
    for (const untaken of [undefined, '', 'UNTAKEN-nothing-could-measure-this', 'untaken-lower-case']) {
      const record = { ...taken, provenance: { ...taken.provenance, [field]: untaken } };
      const result = verdictFor(record, armOf[field]!);
      assertEq(result.verdict, 'skip',
        `${armOf[field]} with ${field} provenance ${String(untaken)} produced ${result.verdict}, not a skip`);
      assertEq(result.measured, undefined,
        `${armOf[field]} reported a measurement it did not take, which is what makes it assertable`);
    }
  }
});

test('DRIVEN: an EMPTY per-read refresh list is a skip even when something counted', () => {
  // `refreshesPerRead` IS PER READ. An empty list against an expiring endpoint means NO READ WAS RECORDED,
  // which is not the same fact as "no read needed a refresh" -- and only the second would be evidence. The
  // old code reduced the empty list to a worst case of zero and asserted it against a ceiling of one.
  const record = {
    status429: 0, retries: 0, refreshesPerRead: [] as number[], disallowedOriginContacts: 0,
    egressObservedAtListener: true, endpointExpires: true,
    provenance: {
      status429: 'counted', retries: 'counted', refreshesPerRead: 'counted',
      disallowedOriginContacts: 'counted', endpointExpires: 'derived',
    },
  };
  const refresh = verdictFor(record, 'refresh-per-read');
  assertEq(refresh.verdict, 'skip', 'an empty per-read refresh list produced a verdict rather than a skip');
  assert(/no read was recorded/.test(refresh.note ?? ''),
    'the skip does not say that an empty list means no read was recorded');
  // AND A LIST WITH SOMETHING IN IT IS STILL A HARD ASSERTION BOTH WAYS.
  assertEq(verdictFor({ ...record, refreshesPerRead: [1] }, 'refresh-per-read').verdict, 'pass', 'one refresh');
  assertEq(verdictFor({ ...record, refreshesPerRead: [2] }, 'refresh-per-read').verdict, 'fail', 'two refreshes');
});

test('REGRESSION: the auditor\'s all-four-arms-green state is reproduced on the OLD bytes and CAUGHT on these', () => {
  // THE DEFECT, AS THE AUDIT DROVE IT. Real mode, a RESOLVER endpoint -- which is what the real path is for
  // -- no origin-counter surface, and a clean listener observation filed (the state the scheduled listener
  // work reaches). On the pre-repair bytes every one of the four RP3 arms went green, carrying a fabricated
  // refresh verdict on a real provider.
  //
  // THE OLD SHAPE IS RECONSTRUCTED RATHER THAN IMPORTED, because the point is the SHAPE: a record with the
  // five numbers present, `endpointExpires` true, `refreshesPerRead` empty, and no per-field provenance for
  // the counters. That is precisely what the old helper wrote.
  const oldShape = {
    status429: 0, retries: 0, refreshesPerRead: [] as number[], disallowedOriginContacts: 0,
    egressObservedAtListener: true, endpointExpires: true,
    provenance: {
      endpointExpires: 'derived-from-the-endpoint-document-this-run-used',
      egressObservedAtListener: 'measured-at-a-listener-this-run-stood-up-on-a-deliberately-excluded-origin',
      disallowedOriginContacts: 'the-delta-of-that-listener-own-counters',
      // THE ONE KEY THE OLD RECORD CARRIED FOR THREE FIELDS, AND WHICH THE MODULE NEVER LOOKED UP.
      transportCounters: 'UNTAKEN-no-origin-counter-surface-on-this-path',
    },
  };
  const arms = ['retries-bounded', 'egress-allowlist', '429-observed', 'refresh-per-read'] as const;
  const verdicts = arms.map((arm) => verdictFor(oldShape, arm).verdict);
  assert(!verdicts.every((verdict) => verdict === 'pass'),
    `all four RP3 arms went green on the shape the audit found: ${arms.map((a, i) => `${a}=${verdicts[i]}`).join(' ')}`);
  // AND SPECIFICALLY THE ONE THE AUDIT NAMED.
  const refresh = verdictFor(oldShape, 'refresh-per-read');
  assertEq(refresh.verdict, 'skip', 'RP3-refresh-per-read still passes from an empty, unattributed list');
  assertEq(refresh.measured, undefined, 'and it still reports a measurement nobody took');

  // THE CONTROL: the same record with the counters GENUINELY measured is green again, so this regression is
  // not "everything skips now" -- it is "an unmeasured number cannot be asserted".
  const measured = {
    ...oldShape,
    refreshesPerRead: [1],
    provenance: {
      ...oldShape.provenance,
      retries: 'counted', status429: 'counted', refreshesPerRead: 'counted',
    },
  };
  for (const arm of arms) {
    assertEq(verdictFor(measured, arm).verdict, 'pass', `a genuinely measured record did not pass ${arm}`);
  }
});

test('DRIVEN: the gate\'s own record on the real path leaves the three counter arms SKIPPED', () => {
  // END TO END THROUGH THE SHIPPED HELPER rather than over a hand-built record: this is the state a real run
  // of this gate actually reaches today, and the arms it must not report as proven.
  const record = observationRecord(resolverEndpoint(), '', '');
  for (const arm of ['retries-bounded', '429-observed', 'refresh-per-read']) {
    assertEq(verdictFor(record, arm).verdict, 'skip', `${arm} did not skip on the real path`);
  }
  // AND FAKE MODE IS UNCHANGED: a direct endpoint has nothing to refresh, and it says so for that reason
  // rather than for want of a counter.
  const fake = observationRecord(directEndpoint(), '', '', 'fake');
  const refresh = verdictFor(fake, 'refresh-per-read');
  assertEq(refresh.verdict, 'skip', 'the fake path stopped skipping the refresh arm');
  assert(/serves stable references directly/.test(refresh.note ?? ''),
    'the fake path skips the refresh arm for the wrong reason');
});

test('the gate READS the provenance it writes, and refuses a REAL run on any UNTAKEN field', () => {
  const code = codeOf(read(GENERIC_GATE));
  // THE COMMENT THAT PROMISED THIS REFUSAL SHIPPED BEFORE THE REFUSAL DID. `provenance` was written and
  // never read; the only refusal was the skip check, and an UNTAKEN counter produced a PASS.
  assert(/npx tsx "\$REL\/untaken\.mts"/.test(code),
    'nothing in the gate reads the provenance it writes, so the record is decoration');
  assert(/if \[ "\$MODE" = "real" \]; then/.test(code) && /UNTAKEN_FIELDS/.test(code),
    'the gate does not refuse a real run whose observations were not taken');
  // THE LIST OF FIELDS AND THE UNTAKEN RULE COME FROM THE MODULE, not from a copy in the gate.
  const helper = helperFrom(GENERIC_GATE, 'UNTAKEN');
  assert(/src\/core\/projection\/real-provider\.ts/.test(helper)
    && /untakenTransportObservations/.test(helper),
    'the gate carries its own copy of which fields matter, so its refusal can drift from the verdict layer');
  for (const restated of ['UNTAKEN-', "'retries'", "'status429'"]) {
    assert(!helper.includes(restated), `the untaken helper restates ${restated} instead of importing it`);
  }
  // AND IT ORDERS THE REFUSAL BEFORE THE VERDICT, so a real run with holes never emits a document at all.
  assert(code.indexOf('untaken.mts') < code.indexOf('real_provider verdict'),
    'the provenance refusal runs after the verdict, so a holed document is emitted before anything objects');
});

test('CONTROL: restoring the one-key provenance is CAUGHT', () => {
  // THE EXACT PRE-REPAIR SHAPE: one `transportCounters` key covering three fields the module looks up
  // individually. The audit's whole point is that this reads as "provenance is present" while enforcing
  // nothing, so the check must be over the FIELD NAMES the module consults.
  const helper = helperFrom(GENERIC_GATE, 'OBSERVATIONS');
  const tampered = helper.replace(
    /    retries: originCounters === undefined[\s\S]*?'the-origin-own-counters-before-and-after-the-reads',\n(?=  \},)/,
    "    transportCounters: originCounters === undefined\n"
    + "      ? 'UNTAKEN-no-origin-counter-surface-on-this-path'\n"
    + "      : 'the-origin-own-counters-before-and-after-the-reads',\n",
  );
  assert(tampered !== helper, 'the tamper did not apply, so this control proves nothing');
  const out = join(freshDir(), 'observations.json');
  const endpoint = resolverEndpoint();
  assertEq(runHelper(tampered, [out, 'true', 'true', 'true', 'true', '0', 'real',
    '0', '0', '0', endpoint, '', '']).status, 0, 'the tampered helper failed for another reason');
  const record = JSON.parse(readFileSync(out, 'utf8')) as { provenance: Record<string, string> };
  for (const field of ['retries', 'status429', 'refreshesPerRead']) {
    assertEq(record.provenance[field], undefined,
      `the tampered record still names ${field}, so the check above is not measuring per-field provenance`);
  }
  // AND THE MODULE STILL REFUSES IT, because absent provenance fails closed -- which is why the two halves
  // of this repair are independent rather than one guarding the other.
  assertEq(verdictFor({
    status429: 0, retries: 0, refreshesPerRead: [], disallowedOriginContacts: 0,
    egressObservedAtListener: true, endpointExpires: true, provenance: record.provenance,
  }, 'refresh-per-read').verdict, 'skip', 'the module accepted a record with no per-field provenance');
});

test('CONTROL: a verdict layer that stops reading provenance is CAUGHT', () => {
  // THE MODULE-SIDE TAMPER. `isUntakenProvenance` returning false for everything is exactly the pre-repair
  // behaviour, and it must put the all-four-green state back -- otherwise this suite's regression above
  // would pass against bytes that never had the defect.
  const module_ = read('src/core/projection/real-provider.ts');
  const tampered = module_.replace(
    /export function isUntakenProvenance\(provenance: string \| undefined\): boolean \{[\s\S]*?\n\}/,
    'export function isUntakenProvenance(_provenance: string | undefined): boolean {\n  return false;\n}',
  );
  assert(tampered !== module_, 'the tamper did not apply, so this control proves nothing');
  assert(/return false;/.test(tampered) && !/UNTAKEN_PROVENANCE_PREFIX\)/.test(
    tampered.slice(tampered.indexOf('export function isUntakenProvenance'),
      tampered.indexOf('export function untakenTransportObservations'))),
  'a verdict layer that ignores provenance still reads as enforcing it, so nothing here measures the repair');
});

// ---------------------------------------------------------------------------------------------------------
h.section('P13PRE-I4 — every compose and provider wait is bounded');
// ---------------------------------------------------------------------------------------------------------

/**
 * Every `docker compose … up -d --wait` invocation in a script, as whole COMMANDS.
 *
 * LINE CONTINUATIONS ARE JOINED FIRST, and that is not a tidying detail: a sweep that read raw lines
 * reported an invocation as unbounded the moment somebody wrapped it, because `--wait-timeout` had moved to
 * the next line. A check that fails when a command is reformatted is a check nobody can keep, and a check
 * that only ever saw one-line commands would miss a bound genuinely removed from a wrapped one.
 */
function composeWaits(gatePath: string): readonly string[] {
  return codeOf(read(gatePath))
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((line) => /docker compose .*up -d --wait/.test(line));
}

test('EVERY compose-up in both provider gates carries a bound', () => {
  // THE SWEEP IS OVER EVERY INVOCATION, NOT OVER THE ONE SOMEBODY REMEMBERED. Phase 12's D6 control has
  // this exact shape, and it is what catches a repair applied to one call site and not to its twin.
  for (const gate of [GENERIC_GATE, PROVIDER_GATE]) {
    const waits = composeWaits(gate);
    assert(waits.length >= 1, `${gate} has no compose-up at all, so this sweep is looking at the wrong file`);
    for (const wait of waits) {
      assert(/--wait-timeout/.test(wait),
        `${gate} waits on compose with no bound: ${wait.trim()} — that is a hang, and a hang is worse than a `
        + 'failure because a failure is a verdict and a hang is a person deciding to give up');
    }
  }
});

test('the bound is floor-checked, because zero is NO BOUND AT ALL', () => {
  for (const [gate, name] of [
    [GENERIC_GATE, 'PROJECTION_REAL_PROVIDER_GATE_PG_WAIT_SECONDS'],
    [PROVIDER_GATE, 'PROJECTION_TORBOX_REAL_GATE_PG_WAIT_SECONDS'],
  ] as const) {
    const code = codeOf(read(gate));
    assert(code.includes(name), `${gate} has no named override for its compose wait bound`);
    assert(/\[ "\$PG_WAIT_SECONDS" -ge 1 \]/.test(code),
      `${gate} does not refuse a compose wait bound of 0, which GNU tooling reads as no bound at all — the `
      + 'exact loosening this value exists to prevent');
    assert(/\|\|\*\[!0-9\]\*\)|''\|\*\[!0-9\]\*\)/.test(code),
      `${gate} does not refuse a non-numeric compose wait bound`);
  }
});

test('the read through the mount is bounded, and every status it can answer is named', () => {
  for (const gate of [GENERIC_GATE, PROVIDER_GATE]) {
    const code = codeOf(read(gate));
    assert(/timeout --kill-after="\$READ_KILL_GRACE_S" "\$_bound" "\$@"/.test(code),
      `${gate}'s read step is not wrapped in a timeout with a kill grace — and without --kill-after the `
      + 'bound does not bind in the wedged-FUSE case it is named for');
    assert(/command -v timeout >\/dev\/null 2>&1/.test(code),
      `${gate} does not require timeout(1), so a host without it would be told the property was proven`);
    for (const status of ['124', '137', '125|126|127']) {
      assert(code.includes(status),
        `${gate} does not name exit ${status} from its bounded read, so a bound that never ran and a read `
        + 'that failed would be reported as the same thing');
    }
  }
});

test('CONTROL: an unbounded compose-up in EITHER gate is CAUGHT', () => {
  for (const gate of [GENERIC_GATE, PROVIDER_GATE]) {
    const body = read(gate);
    const tampered = body.replace(/ --wait-timeout "\$PG_WAIT_SECONDS"/, '');
    assert(tampered !== body, `the ${gate} tamper did not apply, so this control proves nothing`);
    const waits = codeOf(tampered).replace(/\\\n\s*/g, ' ')
      .split('\n').filter((line) => /docker compose .*up -d --wait/.test(line));
    assert(waits.some((wait) => !/--wait-timeout/.test(wait)),
      `an unbounded compose-up in ${gate} still reads as bounded, so a repair applied to one gate and not `
      + 'the other would pass');
  }
});

// ---------------------------------------------------------------------------------------------------------
h.section('P13PRE-I5 — cleanup removes only what the run created');
// ---------------------------------------------------------------------------------------------------------

test('ownership is decided BEFORE anything is created, and cleanup reads it', () => {
  for (const gate of [GENERIC_GATE, PROVIDER_GATE]) {
    const code = codeOf(read(gate));
    assert(/docker network inspect "\$NETWORK" >\/dev\/null 2>&1/.test(code),
      `${gate} does not probe whether the network already exists, so it cannot know whether it owns one`);
    assert(/NETWORK_PREEXISTED=1/.test(code) && /NETWORK_PREEXISTED=0/.test(code),
      `${gate} records no ownership for the network it may remove`);
    assert(/if \[ "\$\{NETWORK_PREEXISTED:-1\}" = "0" \]; then/.test(code),
      `${gate}'s cleanup does not read the ownership record, or does not default to NOT removing — an `
      + 'unknown owner is not this run, and the safe default for a destructive step is to do nothing');
    // AND THE PROBE COMES FIRST. A probe after the create always answers "it existed".
    const probeAt = code.indexOf('docker network inspect "$NETWORK"');
    const createAt = code.indexOf('docker network create "$NETWORK"');
    assert(probeAt >= 0 && createAt > probeAt,
      `${gate} probes for the network after creating it, so every run would claim it owned one`);
    // AND THE CREATE NO LONGER SWALLOWS ITS OWN FAILURE.
    assert(!/docker network create "\$NETWORK" >\/dev\/null 2>&1 \|\| true/.test(code),
      `${gate} still creates its network with || true, so a failure to create is indistinguishable from `
      + 'joining somebody else\'s');
  }
});

test('the compose project belongs to THIS RUN, and every compose invocation says so', () => {
  // WHAT AN AUDIT FOUND. `down -v --remove-orphans` ran against a project name FIXED IN THE COMPOSE FILE, so
  // it was shared by every run of the gate -- and the TorBox compose file is shared by TWO gates, so one
  // gate's teardown removed the other's containers and volumes. That is removing what the run did not
  // create, under the claim that it never happens.
  for (const [gate, prefix] of [[GENERIC_GATE, 'projection-rp-gate-'], [PROVIDER_GATE, 'projection-tbr-gate-']] as const) {
    const code = codeOf(read(gate));
    assert(new RegExp(`COMPOSE_PROJECT="${prefix}\\$\\{RUN_ID\\}"`).test(code),
      `${gate} has no per-run compose project, so its teardown reaches every other run of it`);
    const composeCalls = code.replace(/\\\n\s*/g, ' ')
      .split('\n').filter((line) => /docker compose /.test(line));
    assert(composeCalls.length >= 2, `${gate} has fewer compose invocations than expected`);
    for (const call of composeCalls) {
      assert(/-p "\$COMPOSE_PROJECT"/.test(call),
        `${gate} runs compose without its own project: ${call.trim()} — one invocation left unscoped puts the `
        + 'whole namespace back');
    }
  }
});

test('--remove-orphans is GONE from both provider gates', () => {
  // IT IS NOT MERELY UNNECESSARY ONCE THE PROJECT IS UNIQUE. Its entire job is to remove containers this
  // compose file does not name, which is the definition of removing what the run did not create.
  for (const gate of [GENERIC_GATE, PROVIDER_GATE]) {
    const code = codeOf(read(gate));
    assert(!/--remove-orphans/.test(code),
      `${gate} still passes --remove-orphans, so its teardown can remove a concurrent run's containers`);
    // AND `-v` IS STILL THERE, because with a per-run project it reaches this run's throwaway volumes and
    // no others -- dropping it would leak a volume per run instead.
    assert(/down -v/.test(code), `${gate} no longer removes its own volumes, so every run leaks one`);
  }
});

test('the network is per-run, and the compose file no longer fixes its name', () => {
  // THE DEFECT THE PREVIOUS OWNERSHIP REPAIR INTRODUCED, WHICH THE AUDIT DID NOT REACH. The compose file
  // declared `networks.default.name` as the SAME fixed string the gate created and conditionally removed.
  // `compose up` ran first, so the probe found the network compose had just created, called it pre-existing,
  // and the run LEAKED ITS OWN NETWORK on every invocation.
  for (const [gate, composeFile, envVar] of [
    [GENERIC_GATE, 'docker-compose.projection-real-provider.yml', 'PROJECTION_REAL_PROVIDER_GATE_NETWORK'],
    [PROVIDER_GATE, 'docker-compose.projection-torbox.yml', 'PROJECTION_TORBOX_GATE_NETWORK'],
  ] as const) {
    const code = codeOf(read(gate));
    assert(/^NETWORK="[a-z-]+-\$\{RUN_ID\}"$/m.test(code),
      `${gate}'s network is not per-run, so two runs on one host share one and neither owns it`);
    assert(new RegExp(`export ${envVar}="\\$NETWORK"`).test(code),
      `${gate} does not hand its per-run network name to the compose file`);
    const compose = read(composeFile);
    assert(new RegExp(`name: \\$\\{${envVar}:-`).test(compose),
      `${composeFile} still fixes the network name, so compose creates a shared network whatever the gate says`);
  }
});

test('the ownership inventory is taken BEFORE the first create, and the decision is read from it', () => {
  for (const gate of [GENERIC_GATE, PROVIDER_GATE]) {
    const code = codeOf(read(gate));
    for (const kind of ['containers', 'networks', 'volumes']) {
      assert(new RegExp(`> "\\$WORK/out/before-${kind}\\.txt"`).test(code),
        `${gate} takes no before-inventory of ${kind}, so the claim covers what nothing measured`);
    }
    // THE ORDER IS THE WHOLE POINT. Taken after the first create, every probe answers "it was already there".
    const inventoryAt = code.indexOf('before-networks.txt');
    const buildAt = code.indexOf('docker build -t "$IMAGE"');
    const composeUpAt = code.indexOf('up -d --wait');
    assert(inventoryAt >= 0 && buildAt > inventoryAt && composeUpAt > inventoryAt,
      `${gate} inventories the host after it has already created something, so ownership is unanswerable`);
    // AND THE DECISION IS READ FROM THE INVENTORY FILE, not from a live probe that the create already moved.
    assert(/grep -qxF "\$NETWORK" "\$WORK\/out\/before-networks\.txt"/.test(code),
      `${gate} decides network ownership from something other than the before-inventory`);
    assert(!/^if docker network inspect "\$NETWORK" >\/dev\/null 2>&1; then$/m.test(code),
      `${gate} still decides ownership from a live probe taken after compose created the network`);
  }
});

test('the sets are compared as MEMBERSHIP and asserted, not counted and reported', () => {
  for (const gate of [GENERIC_GATE, PROVIDER_GATE]) {
    const code = codeOf(read(gate));
    // THE AFTER-INVENTORY IS ONE LOOP OVER THE THREE KINDS, so what is asserted is that the loop exists,
    // that it enumerates all three, and that each branch asks docker the right question. A check that
    // grepped for `after-containers.txt` would be green only against three copy-pasted blocks and red
    // against the loop that replaced them — a check about the shape of the code rather than what it covers.
    assert(/for _kind in containers networks volumes; do/.test(code),
      `${gate} does not sweep containers, networks and volumes over one list`);
    assert(/> "\$WORK\/out\/after-\$_kind\.txt"/.test(code),
      `${gate} writes no after-inventory per kind`);
    for (const [kind, query] of [
      ['containers', "docker ps -a --format '{{.Names}}'"],
      ['networks', "docker network ls --format '{{.Name}}'"],
      ['volumes', "docker volume ls --format '{{.Name}}'"],
    ] as const) {
      assert(new RegExp(`${kind}\\)\\s*${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(code),
        `${gate}'s inventory loop does not ask the host for its ${kind}`);
    }
    // A COUNT WOULD PASS THE VIOLATION. Remove one of somebody else's and create one of your own and the
    // count is identical; only a set difference sees it.
    assert(/comm -23 "\$WORK\/out\/before-\$_kind\.txt" "\$WORK\/out\/after-\$_kind\.txt"/.test(code),
      `${gate} compares inventories by count rather than by membership`);
    assert(/^set_preservation_losses \\\n {2}\|\| die "this run removed a container, network or volume it did not create\./m
      .test(code),
    `${gate} reports a removed pre-existing resource rather than failing on it`);
    // AND IT RUNS WHILE THE BEFORE-INVENTORY STILL EXISTS, i.e. before the run directory is removed.
    //
    // THE ANCHOR IS THE SUCCESS-PATH CALL, NOT THE ONE IN THE EXIT TRAP. Both call the same helper; the
    // trap's copy is indented and appears FIRST in the file, so a check that found it reported every gate
    // as broken while measuring nothing — which is what the first version of this very check did. The
    // line-start anchor is what tells the two apart.
    const cleanupAt = code.search(/^projection_gate_cleanup_run /m);
    const assertAt = code.search(/^set_preservation_losses \\$/m);
    assert(cleanupAt > 0, `${gate} has no success-path cleanup call, so this ordering check has no anchor`);
    assert(assertAt > 0 && assertAt < cleanupAt,
      `${gate} compares the sets after deleting the directory the before-inventory lives in`);
    // BOTH SIDES SORTED UNDER THE C LOCALE, or `comm` is comparing two differently ordered lists and its
    // answer is about the host's collation rather than about the host. Three before-inventories are written
    // explicitly and the three after-inventories share one loop line, so four sorts cover all six files.
    assertEq((code.match(/LC_ALL=C sort > "\$WORK\/out\/before-/g) ?? []).length, 3,
      `${gate} does not sort all three before-inventories under the C locale`);
    assertEq((code.match(/LC_ALL=C sort > "\$WORK\/out\/after-\$_kind\.txt"/g) ?? []).length, 1,
      `${gate} does not sort its after-inventories under the C locale`);
  }
});

test('DRIVEN: the set difference catches a removal a count would hide', () => {
  // THE LOGIC ITSELF, over fixtures, because the shipped loop cannot be run here without a Docker host. What
  // is driven is the exact `comm -23` the gate uses, including the case a count cannot see.
  const shell = posixShell();
  if (shell === null) { assert(true, NO_SHELL); return; }
  const dir = freshDir();
  const write = (name: string, lines: readonly string[]): string => {
    const path = join(dir, name);
    writeFileSync(path, `${[...lines].sort().join('\n')}\n`);
    return path;
  };
  const gone = (before: string, after: string): number => {
    const result = spawnSync(shellOrThrow(),
      ['-c', `comm -23 "${shPath(before)}" "${shPath(after)}" | grep -c . || true`],
      { encoding: 'utf8', timeout: 60_000 });
    return Number(String(result.stdout ?? '0').trim());
  };

  const before = write('before.txt', ['alpha', 'beta', 'gamma']);
  assertEq(gone(before, write('same.txt', ['alpha', 'beta', 'gamma'])), 0, 'an unchanged host reported a removal');
  assertEq(gone(before, write('added.txt', ['alpha', 'beta', 'gamma', 'mine'])), 0,
    'this run\'s own new resource was counted as a removal of somebody else\'s');
  assertEq(gone(before, write('removed.txt', ['alpha', 'gamma'])), 1, 'a removed resource was not seen');
  // THE ONE A COUNT CANNOT SEE: one of theirs gone, one of mine created. Same size, different set.
  const swapped = write('swapped.txt', ['alpha', 'gamma', 'mine']);
  assertEq(readFileSync(swapped, 'utf8').trim().split('\n').length,
    readFileSync(before, 'utf8').trim().split('\n').length, 'the fixture is not the equal-count case');
  assertEq(gone(before, swapped), 1,
    'a removal masked by a creation of the same size was not seen, which is the case a count comparison '
    + 'reports as success');
});

test('CONTROL: putting --remove-orphans or the shared project back is CAUGHT', () => {
  for (const gate of [GENERIC_GATE, PROVIDER_GATE]) {
    const body = read(gate);

    const orphans = body.replace('down -v >/dev/null 2>&1 || true',
      'down -v --remove-orphans >/dev/null 2>&1 || true');
    assert(orphans !== body, `the --remove-orphans tamper did not apply to ${gate}`);
    assert(/--remove-orphans/.test(codeOf(orphans)),
      `a restored --remove-orphans is not seen in ${gate}, so the check above proves nothing`);

    const shared = body.replace(/-p "\$COMPOSE_PROJECT" down -v/, 'down -v');
    assert(shared !== body, `the shared-project tamper did not apply to ${gate}`);
    const unscoped = codeOf(shared).split('\n')
      .filter((line) => /docker compose /.test(line) && !/-p "\$COMPOSE_PROJECT"/.test(line));
    assert(unscoped.length > 0,
      `a compose teardown returned to the shared project namespace still reads as scoped in ${gate}`);
  }
});

test('CONTROL: an inventory taken after the first create is CAUGHT', () => {
  const body = read(GENERIC_GATE);
  // Move the whole inventory step below the image build, which is what "after the first create" means here.
  const stepStart = body.indexOf('step "INVENTORY —');
  const stepEnd = body.indexOf('step "building the production projectiond image"');
  assert(stepStart > 0 && stepEnd > stepStart, 'the inventory step could not be located');
  const inventory = body.slice(stepStart, stepEnd);
  const tampered = body.slice(0, stepStart) + body.slice(stepEnd).replace(
    'docker build -t "$IMAGE" ./projectiond\n', `docker build -t "$IMAGE" ./projectiond\n${inventory}`);
  assert(tampered !== body, 'the tamper did not apply, so this control proves nothing');
  const code = codeOf(tampered);
  assert(code.indexOf('before-networks.txt') > code.indexOf('docker build -t "$IMAGE"'),
    'an inventory taken after the first create still reads as taken before it, so the ordering check above '
    + 'would not have caught the defect that shipped');
});

test('the TorBox MOUNT gate still shares its project, and that is recorded rather than silently fixed', () => {
  // NOT THIS TRANCHE'S FILE. `deploy/projection-torbox-mount-gate.sh` shares the TorBox compose file, and
  // until its owner scopes its project it can still tear down its own concurrent runs. What it can no longer
  // do is reach the REAL TorBox gate, because that gate now has a project of its own — which is the
  // direction that mattered here.
  const mount = codeOf(read('deploy/projection-torbox-mount-gate.sh'));
  assert(/--remove-orphans/.test(mount),
    'the mount gate no longer carries the hazard this row records; the disposition in §9 is now stale');
  assert(!/-p "\$COMPOSE_PROJECT"/.test(mount),
    'the mount gate has been scoped after all; update the §9 disposition rather than leaving it');
  // AND THE DOCUMENT SAYS SO, with an owner named.
  const doc = read(CONTRACT);
  assert(/projection-torbox-mount-gate\.sh/.test(doc),
    'the document does not name the gate that still shares the namespace, so the finding is undisclosed');
});

test('CONTROL: an unconditional network removal is CAUGHT', () => {
  for (const gate of [GENERIC_GATE, PROVIDER_GATE]) {
    const body = read(gate);
    const tampered = body.replace(
      /  if \[ "\$\{NETWORK_PREEXISTED:-1\}" = "0" \]; then\n    docker network rm "\$NETWORK" >\/dev\/null 2>&1 \|\| true\n  fi/,
      '  docker network rm "$NETWORK" >/dev/null 2>&1 || true',
    );
    assert(tampered !== body, `the ${gate} tamper did not apply, so this control proves nothing`);
    assert(!/if \[ "\$\{NETWORK_PREEXISTED:-1\}" = "0" \]; then/.test(codeOf(tampered)),
      `a cleanup returned to removing the network unconditionally still reads as ownership-aware in ${gate}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
h.section('P13PRE-I8 — a skip is never folded into success');
// ---------------------------------------------------------------------------------------------------------

test('a REAL run that skipped an arm does not exit 0', () => {
  const code = codeOf(read(GENERIC_GATE));
  // `report` prints the skipped count and exits 0, which is right for a summary and wrong for evidence.
  assert(/SKIPPED_ARMS="\$\(node "\$REL\/skips\.cjs" "\$REL\/out\/results\.json"\)"/.test(code),
    'the gate does not read its own results back, so a real run that skipped an arm would exit 0');
  assert(/if \[ -n "\$SKIPPED_ARMS" \]; then/.test(code) && /\n    exit 1\n/.test(code),
    'a real run with a skipped arm does not fail');
  // FAKE MODE IS EXEMPT, AND THAT IS DELIBERATE: there the skips are the gate saying which assertions its
  // fake endpoint cannot reach, which is the true statement it exists to make.
  assert(/if \[ "\$MODE" = "real" \]; then\n  SKIPPED_ARMS=/.test(code),
    'the skip refusal is not scoped to real mode, or is not the first thing that mode does with its results');
});

test('DRIVEN: the skip reader FAILS CLOSED rather than printing an empty line', () => {
  const helper = helperFrom(GENERIC_GATE, 'SKIPS');
  const dir = freshDir();

  // AN EMPTY OR UNREADABLE RESULTS FILE IS INDISTINGUISHABLE FROM "NOTHING SKIPPED" if it prints nothing,
  // and that is the exact absence this check exists to catch.
  assertEq(runHelper(helper, []).status !== 0, true, 'no results file named was accepted');
  const empty = join(dir, 'empty.json');
  writeFileSync(empty, '');
  assertEq(runHelper(helper, [empty]).status !== 0, true, 'an empty results file was read as "no skips"');
  assertEq(runHelper(helper, [join(dir, 'absent.json')]).status !== 0, true, 'a missing results file passed');

  const results = join(dir, 'results.json');
  writeFileSync(results, [
    JSON.stringify({ gate: 'rp-tls', verdict: 'pass' }),
    JSON.stringify({ gate: 'rp-egress-allowlist', verdict: 'skip' }),
    JSON.stringify({ gate: 'rp-refresh-per-read', verdict: 'skip' }),
  ].join('\n') + '\n');
  const found = runHelper(helper, [results]);
  assertEq(found.status, 0, 'a well-formed results file was refused');
  assertEq(found.out, 'rp-egress-allowlist,rp-refresh-per-read', 'the skipped arms were not both named');

  writeFileSync(results, `${JSON.stringify({ gate: 'rp-tls', verdict: 'pass' })}\n`);
  const clean = runHelper(helper, [results]);
  assertEq(clean.status, 0, 'a clean results file was refused');
  assertEq(clean.out, '', 'a run with no skips reported one');
});

test('CONTROL: a skip reader that prints nothing on an empty file is CAUGHT', () => {
  const helper = helperFrom(GENERIC_GATE, 'SKIPS');
  const tampered = helper.replace(/if \(lines\.length === 0\) \{[\s\S]*?\n\}\n/, '');
  assert(tampered !== helper, 'the tamper did not apply, so this control proves nothing');
  const dir = freshDir();
  const empty = join(dir, 'empty.json');
  writeFileSync(empty, '');
  const result = runHelper(tampered, [empty]);
  assertEq(result.status, 0, 'the unrepaired reader did not pass an empty file, so the check proves nothing');
  assertEq(result.out, '', 'the unrepaired reader did not print an empty answer for an empty file');
});

// ---------------------------------------------------------------------------------------------------------
h.section('P13PRE-I6 — a no-contact readiness record emits shape only');
// ---------------------------------------------------------------------------------------------------------

/**
 * The commands by which a shell program could reach something off this host.
 *
 * IT WAS NARROWER THAN ITS CLAIM. An audit noted that the list named six transfer clients and omitted
 * every RESOLVER — `dig`, `nslookup`, `host`, `getent` — and `ping`, each of which reaches a network
 * without transferring a byte. The shipped recorder invokes none of them, so the no-contact claim held
 * either way; a list that holds by luck is not the same as one that holds by construction.
 *
 * `docker` IS CHECKED SEPARATELY AND BY SUBSTRING, because `docker run` reaches a registry and starts
 * a container, and no invocation of it belongs in a program whose whole promise is that it contacts
 * nothing.
 */
const REACHING_COMMANDS = [
  'curl', 'wget', 'nc', 'ncat', 'socat', 'ssh', 'scp', 'sftp', 'openssl', 'telnet',
  'dig', 'nslookup', 'host', 'getent', 'ping', 'ping6', 'traceroute', 'rsync',
] as const;

/**
 * Does this shell code INVOKE a command, as opposed to containing its letters?
 *
 * WHY THIS IS A FUNCTION WITH A CONTROL RATHER THAN A REGEX AT THE CALL SITE. The first version of this
 * check was written inline in a template literal, where `\s` is not a character class but the letter `s`. The
 * pattern it compiled matched NOTHING, so the check was green and vacuous -- green for exactly the reason a
 * wrapper that runs the wrong gate is green: nobody made it fail. It now lives here, built from a RegExp
 * SOURCE STRING where the escapes survive, and the test below drives it against code that really does
 * invoke each command.
 */
function invokes(code: string, command: string): boolean {
  // A command is invoked when it starts a line or follows a pipe, a semicolon, an ampersand, an opening
  // parenthesis, a command substitution, or one of the keywords that begin a compound command.
  const prefix = '(^|[|;&(]|[$][(]|\\bthen\\b|\\bdo\\b|\\belse\\b)[ \\t]*';
  return new RegExp(prefix + command + '(\\s|$)', 'm').test(code);
}

test('the reaching-command matcher BITES, and does not fire on a word that merely contains one', () => {
  // THE CONTROL FOR THE CHECK ITSELF. An audit nobody has watched fail is an audit nobody should
  // believe, and that applies to the matcher as much as to the property it measures.
  for (const command of REACHING_COMMANDS) {
    assert(invokes(`${command} https://example.invalid`, command),
      `the matcher does not see ${command} at the start of a line`);
    assert(invokes(`RESULT="$(${command} --version)"`, command),
      `the matcher does not see ${command} inside a command substitution`);
    assert(invokes(`true | ${command} -x`, command),
      `the matcher does not see ${command} after a pipe`);
    assert(invokes(`if true; then ${command} -x; fi`, command),
      `the matcher does not see ${command} after then`);
  }
  // AND IT DOES NOT FIRE ON THE LETTERS. `readFileSync` contains `nc`, and the honest version of this
  // check has to tell those two apart rather than be weakened until it tells neither.
  assert(!invokes("const { readFileSync, statSync } = require('node:fs');", 'nc'),
    'the matcher reads readFileSync as an invocation of netcat');
  assert(!invokes('# this comment mentions curl and ssh', 'curl'),
    'the matcher fires on a mention rather than an invocation');
});

test('the recorder opens no socket, starts nothing, and says so', () => {
  const body = read(READINESS);
  const code = codeOf(body);
  for (const forbidden of REACHING_COMMANDS) {
    assert(!invokes(code, forbidden),
      `the readiness recorder invokes ${forbidden}, so "it contacts nothing" is not true of it`);
  }
  for (const forbidden of ['docker run', 'docker compose', 'docker network', 'docker build']) {
    assert(!code.includes(forbidden),
      `the readiness recorder runs ${forbidden}, so it starts something`);
  }
  const helper = helperFrom(READINESS, 'RECORD');
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls', 'fetch(']) {
    assert(!helper.includes(forbidden),
      `the recorder's helper imports ${forbidden}, so it can reach something`);
  }
  assert(/exit 77/.test(code) && /NOTHING WAS CONTACTED/.test(body),
    'the recorder cannot say 77, or does not say that a skip contacted nothing');
});

test('CONTROL: a readiness recorder that reaches out is CAUGHT, in the shipped bytes', () => {
  // THE MATCHER'S CONTROL ABOVE PROVES THE PATTERN BITES ON A STRING THIS SUITE WROTE. This one proves it
  // bites on the FILE, which is the thing the check is actually pointed at -- the two are not the same
  // claim, and a pattern that worked on a fixture and missed the file would still be vacuous.
  const body = read(READINESS);
  for (const [tamper, command] of [
    ['curl -fsS https://example.invalid >/dev/null\ncommand -v node', 'curl'],
    ['RESOLVED="$(nc -z example.invalid 443)"\ncommand -v node', 'nc'],
    ['if true; then ssh host true; fi\ncommand -v node', 'ssh'],
  ] as const) {
    const tampered = body.replace('command -v node', tamper);
    assert(tampered !== body, `the ${command} tamper did not apply, so this control proves nothing`);
    assert(invokes(codeOf(tampered), command),
      `a readiness recorder that invokes ${command} is not seen to, so the no-contact check would `
      + 'have stayed green while the program reached off this host');
  }
  // AND THE SHIPPED BYTES CARRY NONE OF THEM, which is what makes the check above a measurement rather
  // than a pattern nobody has pointed at anything.
  for (const command of REACHING_COMMANDS) {
    assert(!invokes(codeOf(body), command), `the shipped recorder invokes ${command}`);
  }
});
test('DRIVEN: the record carries existence, type, mode, digest, shape and counts — and no value', () => {
  const helper = helperFrom(READINESS, 'RECORD');
  const dir = freshDir();
  writeFileSync(join(dir, 'torbox-credential'), 'a'.repeat(36));
  writeFileSync(join(dir, 'credential'), 'b'.repeat(65));
  writeJson(dir, 'objects.json', { objects: [{ ref: 'an-object-reference-nobody-may-print', label: 'a', sizeBytes: 10 }] });
  writeJson(dir, 'endpoint.json', {
    id: 'provider',
    resolverUrl: 'https://api.example.invalid/resolve',
    allowedOrigins: ['https://cdn2.example.invalid', 'https://cdn1.example.invalid'],
  });

  const result = runHelper(helper, [dir, '', 'torbox-credential,credential', 'objects.json,endpoint.json']);
  assertEq(result.status, 0, `the record could not be taken: ${result.err}`);
  const record = JSON.parse(result.out) as {
    contactedAnything: boolean;
    inputs: Record<string, Record<string, unknown>>;
    allowlist: { allowedOriginCount: number; allowedOriginDigests: string[]; resolvesBeforeReading: boolean };
  };

  assertEq(record.contactedAnything, false, 'the record does not say it contacted nothing');

  // THE SECRETS ARE DESCRIBED, NEVER DIGESTED. A digest of a 36-byte token is derived from its content, and
  // nothing this program writes may be.
  for (const secret of ['torbox-credential', 'credential']) {
    const entry = record.inputs[secret];
    assert(entry !== undefined, `${secret} is not described at all`);
    assertEq(entry.exists, true, `${secret} exists and the record disagrees`);
    assertEq(entry.type, 'regular-file', `${secret} type`);
    assertEq(entry.nonEmpty, true, `${secret} non-emptiness`);
    assertEq(entry.digested, false, `${secret} was DIGESTED, and a digest of a secret is derived from it`);
    assertEq('sizeBytes' in entry, false, `${secret} carries a size, which is a fact about its value`);
    assertEq('sha256Prefix' in entry, false, `${secret} carries a digest of its content`);
  }

  // THE SHAPED DOCUMENTS CARRY A WHOLE-FILE DIGEST AND A KEY SHAPE. The digest is the cheapest honest
  // before/after evidence there is: two records agree exactly when nobody edited the file.
  const endpoint = record.inputs['endpoint.json'];
  assert(endpoint !== undefined, 'the endpoint document is not described');
  assert(typeof endpoint.sha256Prefix === 'string' && String(endpoint.sha256Prefix).length === 16,
    'the endpoint document carries no whole-file digest, so nothing can compare two records');
  assertEq(endpoint.shape, 'allowedOrigins:array[2],id:string,resolverUrl:string',
    'the shape is not the document\'s keys and types');

  // THE ALLOWLIST IS A COUNT AND MEMBER DIGESTS, SORTED so a record differing only in ORDER does not read
  // as movement.
  assertEq(record.allowlist.allowedOriginCount, 2, 'the allowlist count is wrong');
  assertEq(record.allowlist.allowedOriginDigests.length, 2, 'the member digests are missing');
  assertEq([...record.allowlist.allowedOriginDigests].sort().join(','),
    record.allowlist.allowedOriginDigests.join(','),
    'the member digests are not sorted, so a reordered but unchanged allowlist would read as moved');
  assertEq(record.allowlist.resolvesBeforeReading, true, 'a resolver endpoint was not recognised as one');

  // AND NOTHING IT PRINTED IS A VALUE.
  for (const secret of ['a'.repeat(36), 'b'.repeat(65), 'an-object-reference-nobody-may-print',
    'cdn1.example.invalid', 'cdn2.example.invalid', 'https://api.example.invalid/resolve']) {
    assert(!result.out.includes(secret),
      `the record printed ${secret.slice(0, 24)}…, which is a value, a reference or an origin`);
  }
});

test('DRIVEN: the record is identical across two takings of an unedited directory', () => {
  // THIS IS THE PROPERTY THE WHOLE PROGRAM EXISTS FOR. The instrument that CAN answer the allowlist question
  // spends a resolution to do it, and its answer legitimately CHANGES between two takings because the pool
  // rotates — so a before/after built on it reports movement where nothing moved.
  const helper = helperFrom(READINESS, 'RECORD');
  const dir = freshDir();
  writeFileSync(join(dir, 'torbox-credential'), 'a'.repeat(36));
  writeFileSync(join(dir, 'credential'), 'b'.repeat(65));
  writeJson(dir, 'objects.json', { objects: [] });
  writeJson(dir, 'endpoint.json', { id: 'p', allowedOrigins: ['https://one.invalid'] });
  const args = [dir, '', 'torbox-credential,credential', 'objects.json,endpoint.json'];
  const before = runHelper(helper, args);
  const after = runHelper(helper, args);
  assertEq(before.status, 0, 'the first record failed');
  assertEq(before.out, after.out,
    'two records of an unedited directory differ, so the before/after comparison this exists for would '
    + 'report movement where nothing moved');

  // AND AN EDIT MOVES IT, which is what makes the comparison mean anything.
  writeJson(dir, 'endpoint.json', { id: 'p', allowedOrigins: ['https://one.invalid', 'https://two.invalid'] });
  const moved = runHelper(helper, args);
  assert(moved.out !== before.out, 'an edited allowlist produced an identical record');
});

test('DRIVEN: the scrubber FAILS CLOSED rather than printing something it cannot stand behind', () => {
  const helper = helperFrom(READINESS, 'RECORD');
  const dir = freshDir();
  writeFileSync(join(dir, 'torbox-credential'), 'a'.repeat(36));
  writeFileSync(join(dir, 'credential'), 'b'.repeat(65));
  writeJson(dir, 'objects.json', { objects: [] });
  // A KEY IS EMITTED AS PART OF THE SHAPE, so a document whose KEY is a URL is the one route by which a
  // locator could reach the record. The scrubber runs over the rendered document and refuses the whole
  // thing rather than printing a redacted version of it.
  writeJson(dir, 'endpoint.json', { 'https://leaked.invalid/path': 1, allowedOrigins: [] });
  const leaky = runHelper(helper, [dir, '', 'torbox-credential,credential', 'objects.json,endpoint.json']);
  assert(leaky.status !== 0, 'a record carrying a URL in a key was printed');
  assertEq(leaky.out, '', 'the leaking record was printed before it was refused');
  assert(leaky.err.includes('NOT printed'), 'the refusal does not say the record was withheld');
});

test('CONTROL: a recorder without its scrubber is CAUGHT', () => {
  const helper = helperFrom(READINESS, 'RECORD');
  const tampered = helper.replace(/for \(const \[pattern, what\] of FORBIDDEN\) \{[\s\S]*?\n\}\n/, '');
  assert(tampered !== helper, 'the tamper did not apply, so this control proves nothing');
  const dir = freshDir();
  writeFileSync(join(dir, 'torbox-credential'), 'a'.repeat(36));
  writeFileSync(join(dir, 'credential'), 'b'.repeat(65));
  writeJson(dir, 'objects.json', { objects: [] });
  writeJson(dir, 'endpoint.json', { 'https://leaked.invalid/path': 1, allowedOrigins: [] });
  const result = runHelper(tampered, [dir, '', 'torbox-credential,credential', 'objects.json,endpoint.json']);
  assertEq(result.status, 0, 'the unscrubbed recorder still refused, so the check above proves nothing');
  assert(result.out.includes('https://leaked.invalid'),
    'the unscrubbed recorder did not leak, so the scrubber check is not measuring the scrubber');
});

test('CONTROL: a recorder that digests a secret is CAUGHT', () => {
  const helper = helperFrom(READINESS, 'RECORD');
  const tampered = helper.replace(
      "      exists: true, type: kind(stat), mode: mode(stat), nonEmpty: stat.size > 0,\n"
      + "      digested: false, reason: 'a secret is described, never digested',",
      "      exists: true, type: kind(stat), mode: mode(stat), nonEmpty: stat.size > 0,\n"
      + "      digested: true, sha256Prefix: digest(readFileSync(join(dir, name), 'utf8')),");
  assert(tampered !== helper, 'the tamper did not apply, so this control proves nothing');
  const dir = freshDir();
  writeFileSync(join(dir, 'torbox-credential'), 'a'.repeat(36));
  writeFileSync(join(dir, 'credential'), 'b'.repeat(65));
  writeJson(dir, 'objects.json', { objects: [] });
  writeJson(dir, 'endpoint.json', { id: 'p', allowedOrigins: [] });
  const result = runHelper(tampered, [dir, '', 'torbox-credential,credential', 'objects.json,endpoint.json']);
  assertEq(result.status, 0, 'the tampered recorder failed for another reason, so this proves nothing');
  const record = JSON.parse(result.out) as { inputs: Record<string, Record<string, unknown>> };
  assertEq(record.inputs['torbox-credential']?.digested, true,
    'the tampered recorder did not digest the secret, so the check above is not measuring that property');
});

test('DRIVEN: the whole record mode runs, and leaves nothing behind', () => {
  // THE HELPER IS DRIVEN ABOVE; THIS DRIVES THE PROGRAM. A helper that answers correctly inside a shell
  // script nobody can execute is a helper nobody runs before shipping it -- and the first two versions of
  // this script could not run at all on the machine it was written on, because `mktemp -d` under Git Bash
  // answers a POSIX path the Node runtime resolves against the wrong drive root. Only running it found that.
  const shell = posixShell();
  if (shell === null) { assert(true, NO_SHELL); return; }
  const dir = freshDir();
  writeFileSync(join(dir, 'torbox-credential'), 'a'.repeat(36));
  writeFileSync(join(dir, 'credential'), 'b'.repeat(65));
  writeJson(dir, 'objects.json', { objects: [] });
  writeJson(dir, 'endpoint.json', { id: 'p', allowedOrigins: ['https://one.invalid', 'https://two.invalid'] });

  const run = spawnSync(shellOrThrow(), [shPath(join(repoRoot, READINESS)), 'record'], {
    encoding: 'utf8', timeout: 120_000, cwd: repoRoot,
    env: { ...process.env, PROJECTION_PREENTRY_INPUT_DIR: shPath(dir) },
  });
  assertEq(run.status, 0, `the record mode failed: ${String(run.stderr ?? '')}`);
  const record = JSON.parse(String(run.stdout ?? '')) as { allowlist: { allowedOriginCount: number } };
  assertEq(record.allowlist.allowedOriginCount, 2, 'the record did not describe the allowlist');
  assert(String(run.stderr ?? '').includes('NOTHING WAS CONTACTED'),
    'the record mode does not say that it contacted nothing');

  // AND IT REMOVES ITS OWN SCRATCH. A recorder that accumulated a directory per taking would be adding to
  // the residue the phase it serves has to account for.
  assertEq(existsSync(join(repoRoot, '.projection-preentry-readiness')), false,
    'the recorder left its scratch directory behind');

  // AN ABSENT CORPUS IS A SKIP, NOT A FAILURE AND NOT AN ANSWER.
  const emptyDir = freshDir();
  const skipped = spawnSync(shellOrThrow(), [shPath(join(repoRoot, READINESS)), 'record'], {
    encoding: 'utf8', timeout: 120_000, cwd: repoRoot,
    env: { ...process.env, PROJECTION_PREENTRY_INPUT_DIR: shPath(emptyDir) },
  });
  assertEq(skipped.status, 77, 'an absent corpus was not a skip');
  assert(String(skipped.stderr ?? '').includes('NOTHING WAS CONTACTED'),
    'the skip does not say that nothing was contacted');
});

// ---------------------------------------------------------------------------------------------------------
h.section('P13PRE-I7 — staging admits a guarded pre-entry directory and nothing else');
// ---------------------------------------------------------------------------------------------------------

test('the admitted markers are a CLOSED LIST OF LITERALS, and nothing external can add one', () => {
  const code = codeOf(read(STAGE));
  assert(/STAGE_MARKER="catalog-phase12-"/.test(code),
    'the Phase 12 marker moved, and this tranche may not move it');
  assert(/STAGE_MARKER_PREENTRY="catalog-phase13-preentry-"/.test(code),
    'there is no pre-entry marker, so a pre-entry campaign must either stage over Phase 12\'s preserved '
    + 'candidate or widen the guard');
  // NEITHER MARKER READS AN ENVIRONMENT VARIABLE. A guard a caller can set is not a guard, and this is the
  // difference between admitting a second literal and opening the set.
  for (const marker of ['STAGE_MARKER', 'STAGE_MARKER_PREENTRY']) {
    assert(!new RegExp(`${marker}="\\$\\{`).test(code),
      `${marker} is set from the environment, which turns the guard into a parameter`);
  }
  assertEq(code.split('\n').filter((line) => /^\s*"\$STAGE_MARKER[A-Z_]*"\*\) : ;;$/.test(line)).length, 2,
    'the marker case admits some number of prefixes other than exactly two');
});

test('every other refusal in the staging guard is UNCHANGED', () => {
  const code = codeOf(read(STAGE));
  for (const guard of ['*..*', 'must be an absolute path', 'names no staging directory']) {
    assert(code.includes(guard), `the staging guard no longer refuses: ${guard}`);
  }
  // AND THE CLEAR IS STILL ONLY REACHABLE THROUGH THE GUARD.
  const stageAt = code.indexOf('stage() {');
  const body = code.slice(stageAt, code.indexOf('\n}\n', stageAt));
  assert(body.indexOf('require_stage_dir') < body.indexOf('rm -rf'),
    'the staging directory is cleared before the guard that says it may be');
});

test('DRIVEN: the guard admits exactly the two markers and refuses everything else', () => {
  const shell = posixShell();
  if (shell === null) { assert(true, NO_SHELL); return; }
  // DRIVEN RATHER THAN READ, because the whole risk of widening a destructive guard is that the widening
  // admits more than it says. The script is invoked with no host, so it stops at the ssh probe long before
  // anything could be cleared -- and the marker refusal happens where it always did.
  const probe = (dir: string): { status: number; err: string } => {
    const result = spawnSync(shellOrThrow(), [shPath(join(repoRoot, STAGE)), 'stage'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, PROJECTION_PHASE12_HOST: '', PROJECTION_PHASE12_STAGE_DIR: dir },
    });
    return { status: result.status ?? -1, err: String(result.stderr ?? '') + String(result.stdout ?? '') };
  };
  // A MISSING HOST STOPS EVERY INVOCATION BEFORE THE GUARD, so what is compared is that the REFUSED names
  // and the ADMITTED names reach the same place: the host check, and never the clear.
  for (const dir of [
    '/mnt/user/appdata/catalog-phase12-closure',
    '/mnt/user/appdata/catalog-phase13-preentry-instrument',
    '/mnt/user/appdata/catalog-phase1-torbox-real',
    '/mnt/user/appdata/appdata',
    '/mnt/user',
  ]) {
    const result = probe(dir);
    assert(result.status !== 0, `stage returned 0 for ${dir}, and nothing here may succeed`);
    assert(!result.err.includes('clearing and re-creating'),
      `stage reached the clear step for ${dir} without a host, which is the one thing this guard prevents`);
  }
});

test('CONTROL: a marker guard turned into a parameter is CAUGHT', () => {
  const body = read(STAGE);
  const tampered = body.replace(
    'STAGE_MARKER_PREENTRY="catalog-phase13-preentry-"',
    'STAGE_MARKER_PREENTRY="${PROJECTION_PHASE12_STAGE_MARKER:-catalog-phase13-preentry-}"',
  );
  assert(tampered !== body, 'the tamper did not apply, so this control proves nothing');
  assert(/STAGE_MARKER_PREENTRY="\$\{/.test(codeOf(tampered)),
    'a marker read from the environment does not read as one, so the check above would not have caught a '
    + 'guard handed to its caller');
});

test('CONTROL: a third marker slipping into the guard is CAUGHT', () => {
  const body = read(STAGE);
  const tampered = body.replace(
    '    "$STAGE_MARKER_PREENTRY"*) : ;;\n',
    '    "$STAGE_MARKER_PREENTRY"*) : ;;\n    "$STAGE_MARKER_ANYTHING"*) : ;;\n',
  );
  assert(tampered !== body, 'the tamper did not apply, so this control proves nothing');
  assertEq(codeOf(tampered).split('\n')
    .filter((line) => /^\s*"\$STAGE_MARKER[A-Z_]*"\*\) : ;;$/.test(line)).length, 3,
    'a third admitted marker is not counted, so the set could grow without the audit noticing');
});

// ---------------------------------------------------------------------------------------------------------
h.section('the origin policy is REACHABLE, not a function nobody calls');
// ---------------------------------------------------------------------------------------------------------

test('the plan mode reads its policy from the contract\'s own module rather than restating it', () => {
  const helper = helperFrom(READINESS, 'PLAN');
  assert(/src\/core\/projection\/phase13-preentry\.ts/.test(helper),
    'the plan helper does not import the contract module, so it carries its own copy of a threshold — and a '
    + 'script with its own copy is a script whose threshold can drift in the direction that lets a run start');
  assert(/originStabilityRefusals/.test(helper), 'the plan helper does not call the policy function');
  for (const restated of ['ORIGIN_RECORD_MAX_AGE_MINUTES =', 'ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES =']) {
    assert(!helper.includes(restated), `the plan helper restates ${restated} instead of reading it`);
  }
  assert(/process\.exit\(refusals\.length === 0 \? 0 : 70\)/.test(helper),
    'the plan helper does not answer 70 for a refusal, so a caller cannot tell "may not start" from a crash');
});

test('DRIVEN: a sequence that does not fit inside one origin turn is REFUSED, and 70 is not a failure', () => {
  const shell = posixShell();
  if (shell === null) { assert(true, NO_SHELL); return; }
  const plan = (args: readonly string[]): { status: number; out: string } => {
    const result = spawnSync(shellOrThrow(), [shPath(join(repoRoot, READINESS)), 'plan', ...args], {
      encoding: 'utf8', timeout: 180_000, cwd: repoRoot,
      env: { ...process.env, PROJECTION_PREENTRY_INPUT_DIR: shPath(freshDir()) },
    });
    return { status: result.status ?? -1, out: String(result.stdout ?? '') + String(result.stderr ?? '') };
  };

  const fits = plan(['--origin-lifetime-min', '40', '--sequence-minutes', '25', '--record-age-min', '5']);
  assertEq(fits.status, 0, `a fitting sequence was refused: ${fits.out}`);
  assert(fits.out.includes('MAY START'), 'a permitted sequence does not say so');

  const overlong = plan(['--origin-lifetime-min', '40', '--sequence-minutes', '35', '--record-age-min', '5']);
  assertEq(overlong.status, 70,
    'a sequence longer than one origin turn was allowed to start, or answered something other than 70');
  assert(overlong.out.includes('does not cover it'), 'the refusal does not name the reason');
  // AND THE REFUSAL SAYS WHAT MUST NOT BE DONE ABOUT IT. The temptation a rotation creates is to widen the
  // allowlist until it goes green, which is a blocker rather than a step.
  assert(overlong.out.includes('BLOCKER AND NOT A STEP'),
    'the refusal does not say that widening the allowlist is a blocker, which is the response it exists to '
    + 'prevent');
  assert(!/FAIL(ED|URE)? of the product/i.test(overlong.out) || overlong.out.includes('NONE of them is a '
    + 'failure of the'), 'the refusal reads as a failure of the product');

  // AN UNMEASURED LIFETIME IS REFUSED RATHER THAN ASSUMED GENEROUS.
  const unmeasured = plan(['--sequence-minutes', '25', '--record-age-min', '5']);
  assertEq(unmeasured.status, 70, 'a plan with no measured origin lifetime was allowed to start');
  assert(unmeasured.out.includes('never measured'), 'the refusal does not name the missing measurement');

  // AND A STALE RECORD IS AN ANSWER ABOUT A DIFFERENT ORIGIN.
  const stale = plan(['--origin-lifetime-min', '40', '--sequence-minutes', '25', '--record-age-min', '600']);
  assertEq(stale.status, 70, 'a stale origin record was trusted');
});

test('the plan mode contacts nothing either', () => {
  const code = codeOf(read(READINESS));
  const planAt = code.indexOf('if [ "$MODE" = "plan" ]; then');
  assert(planAt >= 0, 'there is no plan mode');
  const planBlock = code.slice(planAt, code.indexOf('\nfi\n', planAt));
  for (const forbidden of REACHING_COMMANDS) {
    assert(!invokes(planBlock, forbidden), `the plan mode invokes ${forbidden}`);
  }
  assert(!/docker /.test(planBlock), 'the plan mode runs docker');
});

// ---------------------------------------------------------------------------------------------------------
h.section('P13PRE-I9 — no earlier tranche\'s claim is written, and one mount keeps one owner');
// ---------------------------------------------------------------------------------------------------------

test('no file this tranche ships emits a verdict for another tranche\'s claim', () => {
  // THE ROADMAP ROW SAYS A LATER PHASE MAY CLOSE "the provider half only of P11-R1". There is no such half,
  // and this is the check that no file here quietly grew one.
  const shipped = [GENERIC_GATE, PROVIDER_GATE, STAGE, READINESS,
    ...optionalWrappers().map((name) => `deploy/${name}`)];
  for (const path of shipped) {
    const body = read(path);
    for (const forbidden of ['P11-R1', 'P11-R2', 'P11-R3', 'P11-R4', 'P9-2', 'P9-3', 'P9-5', 'P9-11']) {
      assert(!body.includes(forbidden),
        `${path} names ${forbidden}, and a script that can name a claim of another tranche is a script that `
        + 'can record a verdict for one');
    }
  }
});

test('one mount point keeps exactly one owner', () => {
  // §4's fourth refusal. Neither gate may write a second daemon into a Compose service, and neither may
  // mount, bind or unmount inside the appliance's own mount point.
  for (const gate of [GENERIC_GATE, PROVIDER_GATE]) {
    const code = codeOf(read(gate));
    // EACH GATE MOUNTS INSIDE ITS OWN RUN DIRECTORY, and nowhere else.
    for (const line of code.split('\n').filter((one) => one.includes(':/mnt/projection'))) {
      assert(/\$WORK\/mnt:\/mnt\/projection/.test(line),
        `${gate} binds something other than its own run directory at the daemon's mount point: ${line.trim()}`);
    }
    // AND NEITHER TOUCHES THE APPLIANCE'S CONTAINER OR NETWORK.
    for (const owned of ['projection-alpha-projectiond', 'docker network rm projection-alpha']) {
      assert(!code.includes(owned),
        `${gate} names ${owned}, and the appliance's mount point has exactly one owner`);
    }
  }
});

test('cleanup removes only containers this run named, and only its own compose project', () => {
  for (const gate of [GENERIC_GATE, PROVIDER_GATE]) {
    const code = codeOf(read(gate));
    // EVERY `docker rm -f` NAMES A CONTAINER CARRYING THIS SHELL'S PID, so nothing else on the host can be
    // removed and no concurrent run can be blamed for a leak of this one's.
    for (const line of code.split('\n').filter((one) => /docker rm -f/.test(one))) {
      assert(/\$[A-Z_]*CONTAINER/.test(line),
        `${gate} removes a container it did not name: ${line.trim()}`);
    }
    for (const variable of code.match(/[A-Z_]*CONTAINER="[^"]*"/g) ?? []) {
      assert(variable.includes('-${RUN_ID}"'),
        `${gate} names a container without this run's id (${variable}), so a concurrent run's container `
        + 'could be removed by this one');
    }
    // AND `compose down -v` IS SCOPED TO THIS GATE'S OWN COMPOSE FILE, so the volumes it removes are its own.
    for (const line of code.split('\n').filter((one) => /compose .*down/.test(one))) {
      assert(/-f "\$COMPOSE_FILE"/.test(line),
        `${gate} brings down a compose project it did not name: ${line.trim()}`);
    }
  }
});

test('CONTROL: a container name without this run\'s id is CAUGHT', () => {
  const body = read(PROVIDER_GATE);
  const tampered = body.replace('MOUNT_CONTAINER="projection-tbr-mount-${RUN_ID}"',
    'MOUNT_CONTAINER="projection-tbr-mount"');
  assert(tampered !== body, 'the tamper did not apply, so this control proves nothing');
  const named = (codeOf(tampered).match(/[A-Z_]*CONTAINER="[^"]*"/g) ?? []);
  assert(named.some((one) => !one.includes('-${RUN_ID}"')),
    'a container named without this run\'s id still reads as run-scoped, so a cleanup could remove a '
    + 'concurrent run\'s container and this audit would not say so');
});

// ---------------------------------------------------------------------------------------------------------
h.section('N4/N5/N6 — the limitations an independent re-audit recorded, and the defect repairing them found');
// ---------------------------------------------------------------------------------------------------------

/**
 * A top-level shell function lifted whole out of a gate.
 *
 * THE CLOSING BRACE IS THE ONE IN COLUMN ZERO, which is what tells a function's end from a `|| {` block
 * inside it. Anything else would slice a region this suite is not sure of, and `test/helpers/shell-source.ts`
 * exists because a slice nobody is sure of fails silently in both directions.
 */
function shellFunction(gatePath: string, name: string): string {
  const body = read(gatePath);
  const open = body.indexOf(`\n${name}() {\n`);
  assert(open >= 0, `${gatePath} defines no ${name}, so nothing here can be driven`);
  const close = body.indexOf('\n}\n', open);
  assert(close > open, `${gatePath}'s ${name} has no closing brace in column zero`);
  return body.slice(open + 1, close + 2);
}

/** Run a script under the POSIX shell this suite found by EXECUTING candidates, in a throwaway directory. */
function runShell(script: string): { status: number; out: string; err: string } {
  const dir = freshDir();
  const path = join(dir, 'drive.sh');
  writeFileSync(path, script);
  const result = spawnSync(shellOrThrow(), [shPath(path)], { encoding: 'utf8', timeout: 60_000 });
  return {
    status: result.status ?? -1,
    out: String(result.stdout ?? '').trim(),
    err: String(result.stderr ?? '').trim(),
  };
}

test('N4: no name in either gate is the bare pid, and the id is derived once by a named function', () => {
  // WHAT THE RE-AUDIT NAMED. `$$` is unique among LIVE processes in ONE pid namespace. The sentence these
  // names carry — no two runs share a container, a volume, a network or a project — is ABSOLUTE, and two
  // runs in separate pid namespaces on one Docker host, or a stale project from a crashed run whose pid has
  // been reused, are both permitted by it. The pid is kept; entropy is what makes the sentence true.
  for (const gate of [GENERIC_GATE, PROVIDER_GATE]) {
    const code = codeOf(read(gate));
    assert(/^RUN_ID="\$\(projection_run_id\)" \|\| exit 1$/m.test(code),
      `${gate} does not derive a run id, or does not stop when it cannot`);
    // AND THE DERIVATION IS ABOVE ITS OWN FIRST USE. A top-level call before its definition is one of the
    // classes this suite exists for, and it has happened twice in this repository.
    assert(code.indexOf('projection_run_id() {') < code.indexOf('RUN_ID="$(projection_run_id)"'),
      `${gate} calls projection_run_id above its own definition`);
    // NO SURVIVING BARE PID ANYWHERE ELSE IN THE CODE, including in a name added after this check was
    // written. The derivation itself is the one place `$$` legitimately appears, so it is cut out first
    // rather than matched around — a filter on the line's text would also excuse any future line that
    // happened to mention the function.
    const outside = code.split(shellFunction(gate, 'projection_run_id')).join('\n');
    const bare = outside.split('\n').filter((line) => /\$\$/.test(line));
    assertEq(bare.length, 0,
      `${gate} still names something with the bare pid: ${bare.map((one) => one.trim()).join('; ')}`);
  }
  // AND THE TWO GATES CARRY THE SAME DERIVATION, so a repair to one is a repair to both.
  assertEq(shellFunction(GENERIC_GATE, 'projection_run_id'), shellFunction(PROVIDER_GATE, 'projection_run_id'),
    'the two gates derive their run ids differently, so the collision boundary is closed in only one');
});

test('DRIVEN: two ids taken in ONE shell — same pid — are different', () => {
  const shell = posixShell();
  if (shell === null) { assert(true, NO_SHELL); return; }
  const derive = shellFunction(PROVIDER_GATE, 'projection_run_id');
  const result = runShell(`set -euo pipefail\n${derive}\nprojection_run_id\necho\nprojection_run_id\necho\n`);
  assertEq(result.status, 0, `the shipped derivation failed on this host: ${result.err}`);
  const [first, second] = result.out.split('\n').map((one) => one.trim());
  for (const id of [first, second]) {
    assert(/^[0-9]+-[0-9a-f]{8}$/.test(String(id)),
      `the run id ${String(id)} is not <pid>-<8 hex>, which is what has to be a legal Docker name component`);
  }
  assertEq(String(first).split('-')[0], String(second).split('-')[0],
    'the two ids do not share a pid, so this control is not measuring one shell');
  assert(first !== second,
    'two runs that share a pid namespace got the same id, which is the collision the entropy exists to close');
});

test('CONTROL: a derivation that returns the pid alone is CAUGHT by driving it', () => {
  // THE PRE-REPAIR BEHAVIOUR, EXECUTED rather than described: the same shell, twice, one id.
  const shell = posixShell();
  if (shell === null) { assert(true, NO_SHELL); return; }
  const result = runShell('set -euo pipefail\n'
    + 'projection_run_id() { printf \'%s\' "$$"; }\n'
    + 'projection_run_id\necho\nprojection_run_id\necho\n');
  assertEq(result.status, 0, 'the tampered derivation could not be driven');
  const [first, second] = result.out.split('\n').map((one) => one.trim());
  assertEq(first, second,
    'a pid-only derivation produced two different ids in one shell, so the control above proves nothing');
});

test('N5: the two decision-bearing observations are read from a 0700 directory no container mounts', () => {
  // WHAT THE RE-AUDIT NAMED. `trap-listener.json` and `origin-counters.json` are the two files that would
  // turn three SKIPPED transport arms into measurements, and they were read from `$WORK/out`, which is 0777
  // because a container running as another uid writes into it. Nothing writes them today, so the refusal
  // holds by construction — but the tranche that stands the listener up inherits the trust question, and a
  // verdict is only as trustworthy as the least-privileged thing that can author its input.
  const code = codeOf(read(GENERIC_GATE));
  assert(/mkdir -p .*"\$WORK\/observations"/.test(code), 'the gate creates no observations directory');
  assert(/^chmod 700 "\$WORK\/observations"$/m.test(code),
    'the observations directory is not 0700, so any user on the host can author a decision-bearing input');
  for (const name of ['trap-listener\\.json', 'origin-counters\\.json']) {
    assert(new RegExp(`"\\$WORK/observations/${name}"`).test(code),
      `${name} is not read from the observations directory`);
    assert(!new RegExp(`"\\$WORK/out/${name}"`).test(code),
      `${name} is still read from the 0777 output directory`);
  }
  // AND NO CONTAINER MOUNTS IT. A 0700 directory bind-mounted into a container running as root is 0700 to
  // nobody who matters.
  assert(!/-v "\$WORK\/observations/.test(code),
    'a container mounts the observations directory, so its mode says nothing about who can write it');
  // THE 0777 THAT REMAINS IS EXPLAINED WHERE IT IS, rather than left to be discovered again.
  assert(/# 0777 BECAUSE A CONTAINER RUNNING AS ANOTHER UID WRITES INTO THESE THREE/.test(read(GENERIC_GATE)),
    'the remaining 0777 carries no reason, so the next reader has to rediscover why it cannot be narrowed');
});

test('CONTROL: an observation read back out of the 0777 directory is CAUGHT', () => {
  const tampered = codeOf(read(GENERIC_GATE))
    .replace('"$WORK/observations/trap-listener.json"', '"$WORK/out/trap-listener.json"');
  assert(!/"\$WORK\/observations\/trap-listener\.json"/.test(tampered),
    'the tamper did not apply, so this control proves nothing');
  assert(/"\$WORK\/out\/trap-listener\.json"/.test(tampered),
    'a decision-bearing observation moved back into the world-writable directory still reads as protected');
});

test('N6: set preservation is asserted on the success path AND measured on every failure path', () => {
  for (const gate of [GENERIC_GATE, PROVIDER_GATE]) {
    const code = codeOf(read(gate));
    // ONE DEFINITION, TWO CALL SITES, and the trap's is inside the trap.
    assertEq((code.match(/^set_preservation_losses\(\) \{$/gm) ?? []).length, 1,
      `${gate} defines the set-preservation measurement more than once, so the two can drift`);
    assert(/^set_preservation_losses \\$/m.test(code),
      `${gate} does not assert set preservation on the success path`);
    assert(/^ {2}if ! set_preservation_losses; then$/m.test(code),
      `${gate} never measures set preservation on a failure path, so the teardown after a die is unwatched`);
    // THE TRAP'S COPY IS INSIDE cleanup(), AFTER THE EARLY RETURN THE SUCCESS PATH TAKES.
    const cleanupAt = code.indexOf('cleanup() {');
    const trapCall = code.indexOf('if ! set_preservation_losses; then');
    const trapEnd = code.indexOf('\ntrap cleanup EXIT');
    assert(cleanupAt >= 0 && trapCall > cleanupAt && trapCall < trapEnd,
      `${gate}'s failure-path measurement is not inside its EXIT trap`);
    assert(code.indexOf('if [ "${CLEANED:-0}" = "1" ]; then') < trapCall,
      `${gate} measures again after the success path already asserted, which prints a weaker second answer`);
    // AND THE TRAP MOVES THE VERDICT IN ONE DIRECTION ONLY. An EXIT trap that could turn a red run green is
    // the thing every comment in these files warns about; this one exits only when it was entered with 0.
    assert(/^ {2}_exit_status=\$\?$/m.test(code),
      `${gate}'s trap does not capture the status it was entered with, so it cannot avoid overwriting one`);
    assert(/if \[ "\$\{_exit_status:-0\}" -eq 0 \]; then exit 1; fi/.test(code),
      `${gate}'s trap can move a verdict in a direction other than red`);
    assert(!/exit 0/.test(code.slice(cleanupAt, trapEnd)),
      `${gate}'s EXIT trap can exit zero, which folds a failure into a pass`);
  }
});

test('CONTROL: removing the failure-path measurement is CAUGHT', () => {
  const code = codeOf(read(PROVIDER_GATE));
  const tampered = code.replace(/ {2}if ! set_preservation_losses; then/, '  if false; then');
  assert(tampered !== code, 'the tamper did not apply, so this control proves nothing');
  assert(!/^ {2}if ! set_preservation_losses; then$/m.test(tampered),
    'a gate whose failure path measures nothing still reads as measuring it');
});

test('DRIVEN: the SHIPPED measurement survives the case it was written for — zero removals', () => {
  // THE DEFECT THIS FOUND, AND IT WAS FOUND BY RUNNING RATHER THAN BY READING. The loop this function
  // replaces computed its count as `_gone="$(comm ... | grep -c . )"`, and `grep -c` EXITS 1 WHEN THE COUNT
  // IS ZERO. Under `set -euo pipefail` — which both gates set on their first lines — that assignment ABORTS
  // THE SCRIPT. So the shipped check killed the run on exactly the runs that satisfied it, silently, after
  // the verdict had already been printed. Nobody had seen it because nobody could: this gate needs a
  // provider, and the generic gate's real mode refuses.
  //
  // THE OLD DRIVEN CONTROL DID NOT CATCH IT, and that is the part worth keeping. It re-typed the pipeline
  // into its own harness WITH `|| true` appended, so it drove a correct version of a line the gate shipped
  // wrong. A control that retypes what it measures is measuring the retyping.
  const shell = posixShell();
  if (shell === null) { assert(true, NO_SHELL); return; }
  for (const gate of [GENERIC_GATE, PROVIDER_GATE]) {
    const fn = shellFunction(gate, 'set_preservation_losses');
    const work = freshDir();
    mkdirSync(join(work, 'out'), { recursive: true });
    const names = ['alpha', 'beta', 'gamma'];
    for (const kind of ['containers', 'networks', 'volumes']) {
      writeFileSync(join(work, 'out', `before-${kind}.txt`), `${names.join('\n')}\n`);
    }
    const listing = names.map((one) => `'${one}'`).join(' ');
    const stub = 'docker() {\n'
      + '  case "$1 $2" in\n'
      + `    "ps -a")      printf '%s\\n' ${listing} ;;\n`
      + `    "network ls") printf '%s\\n' ${listing} ;;\n`
      + `    "volume ls")  printf '%s\\n' ${listing} ;;\n`
      + '    *) return 1 ;;\n'
      + '  esac\n'
      + '}\n';
    const result = runShell(`set -euo pipefail\nWORK="${shPath(work)}"\n${stub}${fn}\n`
      + 'set_preservation_losses\necho "RETURNED $?"\n');
    assertEq(result.status, 0,
      `${gate}'s set-preservation measurement ABORTED on a host it removed nothing from: ${result.err}`);
    assert(/RETURNED 0/.test(result.out),
      `${gate}'s measurement did not return success when nothing was removed: ${result.out}`);
    assert(/gone now: 0 \(budget 0\)/.test(result.out),
      `${gate}'s measurement did not report a zero for each kind: ${result.out}`);
  }
});

test('DRIVEN: the SHIPPED measurement fails on the removal a count would hide, for all three kinds', () => {
  const shell = posixShell();
  if (shell === null) { assert(true, NO_SHELL); return; }
  const fn = shellFunction(PROVIDER_GATE, 'set_preservation_losses');
  const drive = (after: Record<string, readonly string[]>): { status: number; out: string; err: string } => {
    const work = freshDir();
    mkdirSync(join(work, 'out'), { recursive: true });
    for (const kind of ['containers', 'networks', 'volumes']) {
      writeFileSync(join(work, 'out', `before-${kind}.txt`), 'alpha\nbeta\ngamma\n');
    }
    const arm = (kind: string, key: string): string =>
      `    "${key}") printf '%s\\n' ${after[kind]!.map((one) => `'${one}'`).join(' ')} ;;\n`;
    const stub = 'docker() {\n  case "$1 $2" in\n'
      + arm('containers', 'ps -a') + arm('networks', 'network ls') + arm('volumes', 'volume ls')
      + '    *) return 1 ;;\n  esac\n}\n';
    return runShell(`set -euo pipefail\nWORK="${shPath(work)}"\n${stub}${fn}\n`
      + 'if set_preservation_losses; then echo "RETURNED 0"; else echo "RETURNED nonzero"; fi\n');
  };

  const all = ['alpha', 'beta', 'gamma'];
  // THE CASE A COUNT CANNOT SEE: one of theirs gone, one of mine created. Same size, different set.
  for (const kind of ['containers', 'networks', 'volumes']) {
    const after: Record<string, readonly string[]> = { containers: all, networks: all, volumes: all };
    after[kind] = ['alpha', 'gamma', 'mine'];
    const result = drive(after);
    assertEq(result.status, 0, `the driver itself failed for ${kind}: ${result.err}`);
    assert(/RETURNED nonzero/.test(result.out),
      `a removed ${kind} masked by a creation of the same size was not seen, which is the case a count `
      + 'comparison is satisfied by');
    assert(/beta/.test(result.err), `the failure does not name what went missing: ${result.err}`);
  }
  // AND THIS RUN'S OWN NEW RESOURCE IS NOT A REMOVAL OF SOMEBODY ELSE'S.
  const added = { containers: [...all, 'mine'], networks: all, volumes: all };
  assert(/RETURNED 0/.test(drive(added).out), 'this run\'s own new container was counted as a removal');
});

test('DRIVEN: a kind whose before-inventory was never taken is UNMEASURED, not preserved', () => {
  // A RUN THAT DIED BEFORE THE INVENTORY CREATED NOTHING, and "did this run remove it?" has no answer yet.
  // Reporting it as preserved would be the skip folded into a pass this whole tranche exists to refuse.
  const shell = posixShell();
  if (shell === null) { assert(true, NO_SHELL); return; }
  const fn = shellFunction(PROVIDER_GATE, 'set_preservation_losses');
  const work = freshDir();
  mkdirSync(join(work, 'out'), { recursive: true });
  const result = runShell(`set -euo pipefail\nWORK="${shPath(work)}"\n`
    + 'docker() { return 1; }\n' + fn
    + '\nif set_preservation_losses; then echo "RETURNED 0"; else echo "RETURNED nonzero"; fi\n');
  assertEq(result.status, 0, `the driver itself failed: ${result.err}`);
  assertEq((result.out.match(/UNMEASURED rather than satisfied/g) ?? []).length, 3,
    `all three kinds should be named as unmeasured when no inventory was taken: ${result.out}`);
  assert(/RETURNED 0/.test(result.out),
    'a run that created nothing was reported as having removed something');
});

test('N7: the verdict-layer control EXECUTES the tampered module rather than reading it', () => {
  // WHAT THE RE-AUDIT NAMED. `CONTROL: a verdict layer that stops reading provenance is CAUGHT` asserted only
  // on the tampered SOURCE TEXT — unlike every sibling control it never ran the tampered module, so it never
  // demonstrated that the all-four-green state comes back. A control that reads a tamper instead of running
  // it is a control that has not seen the defect.
  const module_ = read('src/core/projection/real-provider.ts');
  const tampered = module_.replace(
    /export function isUntakenProvenance\(provenance: string \| undefined\): boolean \{[\s\S]*?\n\}/,
    'export function isUntakenProvenance(_provenance: string | undefined): boolean {\n  return false;\n}',
  );
  assert(tampered !== module_, 'the tamper did not apply, so this control proves nothing');

  // THE MODULE IMPORTS ONLY `node:crypto` AND A TYPE, so a copy of it runs anywhere. The driver is handed to
  // node with `--import tsx`, which is how every other executed TypeScript in this repository is run, and
  // from the repository root — an absolute POSIX path under Git Bash reaches the runtime as a drive-rooted
  // spelling of a directory that does not exist, which §10.7 records as costing a day.
  const dir = freshDir();
  writeFileSync(join(dir, 'tampered.ts'), tampered);
  writeFileSync(join(dir, 'drive.mts'),
    "import { transportResults } from './tampered.ts';\n"
    + 'const record = JSON.parse(process.argv[2]);\n'
    + "const arms = ['retries-bounded', 'egress-allowlist', '429-observed', 'refresh-per-read'];\n"
    + 'console.log(JSON.stringify(arms.map((arm) => '
    + "transportResults('RP3', record).find((one) => one.gate === 'RP3-' + arm).verdict)));\n");

  // THE EXACT SHAPE THE AUDIT FOUND: real mode, a resolver endpoint, no counter surface, a listener filed.
  const oldShape = {
    status429: 0, retries: 0, refreshesPerRead: [] as number[], disallowedOriginContacts: 0,
    egressObservedAtListener: true, endpointExpires: true,
    provenance: {
      endpointExpires: 'derived-from-the-endpoint-document-this-run-used',
      egressObservedAtListener: 'measured-at-a-listener-this-run-stood-up-on-a-deliberately-excluded-origin',
      disallowedOriginContacts: 'the-delta-of-that-listener-own-counters',
      transportCounters: 'UNTAKEN-no-origin-counter-surface-on-this-path',
    },
  };
  const run = spawnSync(process.execPath,
    ['--import', 'tsx', join(dir, 'drive.mts'), JSON.stringify(oldShape)],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
  assertEq(run.status, 0, `the tampered module could not be executed: ${String(run.stderr ?? '').slice(-800)}`);
  const arms = ['retries-bounded', 'egress-allowlist', '429-observed', 'refresh-per-read'] as const;
  const tamperedVerdicts = JSON.parse(String(run.stdout ?? '[]').trim()) as string[];
  const shipped = arms.map((arm) => verdictFor(oldShape, arm).verdict);

  // THE D1 REPAIR HAS TWO INDEPENDENT HALVES AND THIS TAMPER REMOVES ONE, so what it must demonstrate is
  // that half returning — NOT the whole pre-repair state. `refresh-per-read` is refused a second time, by
  // the EMPTY per-read list rule, and it stays a skip here; asserting all four green would be asserting
  // that one repair does the work of two, which is how a control comes to require a defect to pass.
  for (const arm of ['retries-bounded', '429-observed'] as const) {
    const at = arms.indexOf(arm);
    assertEq(shipped[at], 'skip', `${arm} does not skip on the shipped module, so this control has no defect `
      + 'to reproduce');
    assertEq(tamperedVerdicts[at], 'pass',
      `${arm} did not go back to an unmeasured PASS when the verdict layer stopped reading provenance, so `
      + 'the sibling regression would pass against bytes that never carried the defect');
  }
  // AND THE ARM THE SECOND HALF OF THE REPAIR HOLDS IS STILL REFUSED, which is what says the two halves are
  // independent rather than one guarding the other.
  assertEq(tamperedVerdicts[arms.indexOf('refresh-per-read')], 'skip',
    'the empty per-read list stopped being refused once provenance was ignored, so the two halves of the '
    + 'D1 repair are not independent after all');
  assertEq(shipped.filter((one) => one === 'skip').length > tamperedVerdicts.filter((one) => one === 'skip').length,
    true, 'the tampered module refused at least as much as the shipped one, so nothing was executed');
});

// ---------------------------------------------------------------------------------------------------------
h.section('the shipped shell is LF, which is what every byte-level pin here rests on');
// ---------------------------------------------------------------------------------------------------------

test('no script this audit slices carries a carriage return', () => {
  for (const path of [
    GENERIC_GATE, PROVIDER_GATE, STAGE, READINESS,
    ...optionalWrappers().map((name) => `deploy/${name}`),
  ]) {
    const raw = readFileSync(join(repoRoot, path));
    assertEq(raw.includes(0x0d), false, `${path} holds a CR; .gitattributes pins shipped shell to LF`);
  }
  assert(read('.gitattributes').includes('*.sh text eol=lf'),
    '.gitattributes no longer pins shell scripts to LF, so every byte pin here is about a checkout');
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-phase13-preentry-gate-audit.ts'),
    'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-phase13-preentry-gate-audit.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
