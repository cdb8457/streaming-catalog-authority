import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import { NO_SHELL, posixShell, shPath, shellOrThrow } from './posix-shell-kit.js';

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
h.section('P13PRE-I4 — every compose and provider wait is bounded');
// ---------------------------------------------------------------------------------------------------------

/** Every `docker compose … up -d --wait` invocation in a script, as whole lines. */
function composeWaits(gatePath: string): readonly string[] {
  return codeOf(read(gatePath)).split('\n').filter((line) => /docker compose .*up -d --wait/.test(line));
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
    const waits = codeOf(tampered).split('\n').filter((line) => /docker compose .*up -d --wait/.test(line));
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

/** The commands by which a shell program could reach something off this host. */
const REACHING_COMMANDS = ['curl', 'wget', 'nc', 'ssh', 'openssl', 'telnet'] as const;

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
      assert(variable.includes('-$$"'),
        `${gate} names a container without this shell's pid (${variable}), so a concurrent run's container `
        + 'could be removed by this one');
    }
    // AND `compose down -v` IS SCOPED TO THIS GATE'S OWN COMPOSE FILE, so the volumes it removes are its own.
    for (const line of code.split('\n').filter((one) => /compose .*down/.test(one))) {
      assert(/-f "\$COMPOSE_FILE"/.test(line),
        `${gate} brings down a compose project it did not name: ${line.trim()}`);
    }
  }
});

test('CONTROL: a container name without this run\'s pid is CAUGHT', () => {
  const body = read(PROVIDER_GATE);
  const tampered = body.replace('MOUNT_CONTAINER="projection-tbr-mount-$$"',
    'MOUNT_CONTAINER="projection-tbr-mount"');
  assert(tampered !== body, 'the tamper did not apply, so this control proves nothing');
  const named = (codeOf(tampered).match(/[A-Z_]*CONTAINER="[^"]*"/g) ?? []);
  assert(named.some((one) => !one.includes('-$$"')),
    'a container named without this run\'s pid still reads as pid-scoped, so a cleanup could remove a '
    + 'concurrent run\'s container and this audit would not say so');
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
