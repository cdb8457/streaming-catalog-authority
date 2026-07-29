import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import {
  activeKek,
  adoptStaticKekAsRing,
  initializeKekRing,
  loadKekRing,
} from '../src/core/crypto/kek-ring.js';
import { LocalSidecarCustodianClient } from '../src/core/crypto/local-sidecar-custodian.js';
import { probeSidecarHealth, UnixSocketSidecarTransport } from '../src/core/crypto/local-sidecar-runtime.js';
import {
  startSidecarDaemon,
  validateSidecarDaemonConfig,
  SidecarDaemonConfigError,
} from '../src/ops/sidecar-daemon.js';
import { parseSidecarHealthArgs } from '../src/ops/sidecar-health-cli.js';
import { parseKekRingArgs } from '../src/ops/kek-ring-cli.js';
import { REQUIRED_SECRET_FILES } from '../src/ops/backup-components.js';
import { parseYaml, asMap } from '../src/ops/minimal-yaml.js';

// Phase 284 — O4 and O5, integrated, and said about honestly.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - THE APP NEVER RECEIVES A ROOT KEY OR A KEK. The only surface it reaches is the socket, whose contract
//     carries per-item DEKs and nothing else — asserted against the wire types, the client and the source.
//   - A DAEMON IS WIRED TO ONE SOURCE OF KEY MATERIAL, never both.
//   - THE RING SURVIVES A RESTART, and the daemon on a ring answers a health handshake naming its generation.
//   - THE SHIPPED STACK GATES THE APP ON SIDECAR HEALTH, not on a socket file existing.
//   - THE STATIC KEK IS STILL MOUNTED UNTIL A MIGRATION HAS HAPPENED, and the root secret is declared beside
//     it rather than instead of it — a stack that swapped them before the operator migrated would be a stack
//     whose sidecar cannot open its own keystore.
//   - NO RAW KEY REACHES ANY EVIDENCE SURFACE.
//   - O4 IS CLOSED BY IMPLEMENTATION EVIDENCE; O5 IS IMPLEMENTED AND NOT LIVE-PROVEN, and the documents say
//     exactly that rather than the more flattering version.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function refuses(fn: () => unknown, needle: string, msg: string): void {
  try { fn(); } catch (err) {
    assert((err as Error).message.includes(needle), `${msg}: expected "${needle}", got: ${(err as Error).message}`);
    return;
  }
  throw new Error(`${msg}: nothing was refused`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');
const WORK = mkdtempSync(join(tmpdir(), 'ca-o4-o5-'));
const POSIX = process.platform !== 'win32';
const SECRET = 'a-completion-secret-that-must-never-appear-anywhere';

interface Installation {
  readonly root: string;
  readonly stateDir: string;
  readonly socketPath: string;
  readonly completionSecretFile: string;
  readonly rootKeyFile: string;
  readonly staticKekFile: string;
  readonly rootKey: Buffer;
  readonly staticKek: Buffer;
}

function installation(name: string): Installation {
  const root = join(WORK, name);
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  const completionSecretFile = join(root, 'completion_secret');
  writeFileSync(completionSecretFile, `${SECRET}\n`, { encoding: 'utf8', mode: 0o600 });
  const rootKey = randomBytes(32);
  const rootKeyFile = join(root, 'custodian_root_key');
  writeFileSync(rootKeyFile, `${rootKey.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  const staticKek = randomBytes(32);
  const staticKekFile = join(root, 'custodian_kek');
  writeFileSync(staticKekFile, `${staticKek.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  if (POSIX) { chmodSync(rootKeyFile, 0o600); chmodSync(completionSecretFile, 0o600); }
  const socketPath = POSIX
    ? join(root, 'run', 'catalog-sidecar.sock')
    : `\\\\.\\pipe\\catalog-o4-o5-${name}-${process.pid}-${Date.now()}`;
  return { root, stateDir, socketPath, completionSecretFile, rootKeyFile, staticKekFile, rootKey, staticKek };
}

console.log('Running Phase 284 O4/O5 runtime acceptance suite:\n');

// ---------------------------------------------------------------------------------------------------------
// The app never receives key material
// ---------------------------------------------------------------------------------------------------------

await test('the app\'s only surface is the socket, and its contract carries no KEK and no root key', () => {
  // ASSERTED AGAINST THE WIRE TYPES, not against a promise. Every response shape the client can receive is in
  // one union; if a KEK ever appeared there it would appear here.
  const wire = readRepo('src/core/crypto/local-sidecar-custodian.ts');
  for (const forbidden of ['kek', 'rootKey', 'ringGeneration', 'keyHex', 'wrappedHex']) {
    assert(!wire.includes(forbidden), `the sidecar wire contract must not carry ${forbidden}`);
  }
  // THE APP'S CUSTODIAN FACTORY, in sidecar mode, is handed a socket path and nothing else.
  const factory = readRepo('src/core/crypto/custodian-factory.js'.replace('.js', '.ts'));
  const sidecarBranch = factory.slice(factory.indexOf("case 'sidecar'"));
  assert(sidecarBranch.includes('UnixSocketSidecarTransport'), 'the app builds a socket transport');
  for (const forbidden of ['readRootWrappingKey', 'loadKekRing', 'activeKek', 'SIDECAR_ROOT_KEY']) {
    assert(!factory.includes(forbidden), `the app's custodian factory must not reach for ${forbidden}`);
  }
  // AND THE RING IS NOT IMPORTED ANYWHERE THE APP RUNS. The ring belongs to the sidecar and to the ops
  // commands an operator runs on the host; the operator UI server is the app.
  for (const appFile of ['src/ops/operator-ui-server.ts', 'src/core/catalog/authority.ts']) {
    let source: string;
    try { source = readRepo(appFile); } catch { continue; }
    for (const forbidden of ['kek-ring.js', 'readRootWrappingKey', 'activeKek']) {
      assert(!source.includes(forbidden), `${appFile} must not reach for ${forbidden}`);
    }
  }
});

await test('a daemon is wired to ONE source of key material, never both and never neither', () => {
  const base = { socketPath: POSIX ? '/tmp/x/catalog.sock' : '\\\\.\\pipe\\catalog-x', stateDir: '/tmp/state', completionSecretFile: '/tmp/secret' };
  refuses(() => validateSidecarDaemonConfig({ ...base }), 'unsafe or incomplete', 'neither a static KEK nor a root key');
  refuses(() => validateSidecarDaemonConfig({ ...base, kekFile: '/tmp/kek', rootKeyFile: '/tmp/root' }),
    'unsafe or incomplete', 'BOTH a static KEK and a root key');
  const legacy = validateSidecarDaemonConfig({ ...base, kekFile: '/tmp/kek' });
  assertEq(legacy.rootKeyFile, null, 'a legacy install is on the static KEK alone');
  const ring = validateSidecarDaemonConfig({ ...base, rootKeyFile: '/tmp/root' });
  assertEq(ring.kekFile, null, 'and a migrated one is on the root key alone');
  refuses(() => validateSidecarDaemonConfig({ ...base, rootKeyFile: 'https://a/b' }), 'unsafe or incomplete',
    'a root key that is a network endpoint');
});

// ---------------------------------------------------------------------------------------------------------
// The daemon, on a ring
// ---------------------------------------------------------------------------------------------------------

await test('a daemon on a ring serves keys, survives a restart, and names its generation in health', async () => {
  const install = installation('ring-daemon');
  initializeKekRing(install.stateDir, install.rootKey);

  const config = validateSidecarDaemonConfig({
    socketPath: install.socketPath,
    stateDir: install.stateDir,
    completionSecretFile: install.completionSecretFile,
    rootKeyFile: install.rootKeyFile,
  });
  let daemon = await startSidecarDaemon(config);
  let keyId: string;
  try {
    assertEq(daemon.mode, 'sidecar-managed-kek-ring', 'the daemon says which mechanism is serving');
    const health = await probeSidecarHealth(install.socketPath);
    assert(health !== null, 'it answers a health handshake');
    assertEq(health!.custodian, 'sidecar-managed-ring', 'as a ring installation');
    assertEq(health!.ringGeneration, 1, 'naming the active generation — a number, never a key');

    const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(install.socketPath));
    const provision = await client.provision('op-restart', 'item-restart', 0);
    await client.commitProvision('op-restart');
    keyId = provision.keyId;
    assertEq((await client.get(keyId, 0)).length, 32, 'and serves a DEK over the socket');
  } finally {
    await daemon.close();
  }

  // A RESTART READS THE SAME RING AND OPENS THE SAME KEY. The ring is the durable part; the process is not.
  daemon = await startSidecarDaemon(config);
  try {
    const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(install.socketPath));
    assertEq((await client.get(keyId!, 0)).length, 32, 'a restarted daemon opens a key provisioned before it');
  } finally {
    await daemon.close();
  }

  // A WRONG ROOT KEY FAILS CLOSED AT START, rather than starting and answering nothing.
  const wrongRootFile = join(install.root, 'wrong_root');
  writeFileSync(wrongRootFile, `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  if (POSIX) chmodSync(wrongRootFile, 0o600);
  let threw: unknown = null;
  try {
    await startSidecarDaemon(validateSidecarDaemonConfig({ ...config, rootKeyFile: wrongRootFile, kekFile: undefined }));
  } catch (err) { threw = err; }
  assert(threw !== null, 'a daemon given the wrong root key does not start');
  assert((threw as Error).message.includes('DIFFERENT root wrapping key'), `saying why: ${(threw as Error).message}`);
});

await test('a migrated installation opens the keys its static KEK wrapped', async () => {
  // THE POINT OF THE MIGRATION, checked end to end: keys written under the static KEK are still readable once
  // the ring has adopted it, through a daemon that no longer has the static file wired at all.
  const install = installation('migrated');
  const legacy = new FileCustodian(install.stateDir, SECRET, install.staticKek);
  const before = await legacy.provision('op-legacy', 'item-legacy', 0);
  await legacy.commitProvision('op-legacy');

  adoptStaticKekAsRing(install.stateDir, install.rootKey, install.staticKek);
  const daemon = await startSidecarDaemon(validateSidecarDaemonConfig({
    socketPath: install.socketPath,
    stateDir: install.stateDir,
    completionSecretFile: install.completionSecretFile,
    rootKeyFile: install.rootKeyFile,
  }));
  try {
    const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(install.socketPath));
    assertEq((await client.get(before.keyId, 0)).length, 32, 'a pre-migration key still opens');
    assertEq(activeKek(loadKekRing(install.stateDir, install.rootKey)).toString('hex'),
      install.staticKek.toString('hex'), 'because generation 1 IS the static key, which the ring records');
  } finally {
    await daemon.close();
  }
});

// ---------------------------------------------------------------------------------------------------------
// The shipped stack
// ---------------------------------------------------------------------------------------------------------

await test('the shipped stack gates the app on sidecar HEALTH, not on a socket file existing', () => {
  const text = readRepo('docker-compose.unraid.runtime.yml');
  const doc = parseYaml(text);
  const services = asMap(doc.services ?? null, 'services');
  const sidecar = asMap(services.sidecar ?? null, 'sidecar');
  const healthcheck = asMap(sidecar.healthcheck ?? null, 'sidecar healthcheck');
  const probe = JSON.stringify(healthcheck.test);
  // THE DEFECT: `test -S <socket>` passes for a crashed daemon and for one that cannot read its keystore.
  assert(!probe.includes('test -S'), `the sidecar healthcheck must not be a socket-file test: ${probe}`);
  assert(probe.includes('ops:sidecar-health'), `it runs the health handshake: ${probe}`);

  for (const dependent of ['app', 'migrate']) {
    const service = asMap(services[dependent] ?? null, dependent);
    const depends = asMap(service.depends_on ?? null, `${dependent} depends_on`);
    const onSidecar = asMap(depends.sidecar ?? null, `${dependent} depends_on sidecar`);
    assertEq(onSidecar.condition, 'service_healthy',
      `${dependent} waits for the sidecar to be HEALTHY, not merely started`);
  }
});

await test('the stack declares the root custody secret beside the static KEK, not instead of it', () => {
  // AN INSTALLATION THAT HAS NOT MIGRATED STILL NEEDS ITS STATIC KEK. A stack that swapped one for the other
  // on upgrade would leave every existing deployment with a sidecar that cannot open its own keystore — the
  // exact failure that looks like an empty catalog and reports nothing.
  const text = readRepo('docker-compose.unraid.runtime.yml');
  const doc = parseYaml(text);
  const secrets = asMap(doc.secrets ?? null, 'secrets');
  assert('custodian_kek' in secrets, 'the static KEK secret is still declared');
  assert('custodian_root_key' in secrets, 'and the root custody secret is declared beside it');
  const sidecar = asMap(asMap(doc.services ?? null, 'services').sidecar ?? null, 'sidecar');
  const wired = JSON.stringify(sidecar.secrets);
  assert(wired.includes('custodian_kek'), 'the sidecar is still given the static KEK until a migration');
  // THE ROOT KEY IS NOT A COMPOSE SECRET. Outside Swarm a `file:` secret is a bind mount and uid/gid/mode
  // are ignored, so the only way to give the sidecar a file whose ownership it can rely on is to mount one.
  assert(!wired.includes('custodian_root_key'), 'the root key does NOT come through the secret mechanism');
  assert(JSON.stringify(sidecar.volumes ?? []).includes('/run/catalog-custody/custodian_root_key:ro'),
    'it is a read-only bind whose host ownership and mode carry through');
  // THE APP IS GIVEN NEITHER.
  const app = asMap(asMap(doc.services ?? null, 'services').app ?? null, 'app');
  const appSecrets = JSON.stringify(app.secrets ?? []);
  assert(!appSecrets.includes('custodian_kek'), 'the app is given no KEK');
  assert(!appSecrets.includes('custodian_root_key'), 'and no root key');
});

await test('the required-secret model knows about the root custody key', () => {
  // Phase 256's list is what every backup, verification and rehearsal is checked against. A secret the stack
  // requires and the model does not know is a secret a backup can omit while still verifying.
  assert(REQUIRED_SECRET_FILES.includes('custodian_root_key'),
    `the required secret list covers the root custody key: ${REQUIRED_SECRET_FILES.join(', ')}`);
  const stack = readRepo('docker-compose.unraid.runtime.yml');
  for (const file of REQUIRED_SECRET_FILES) {
    assert(stack.includes(file), `the shipped stack declares the required secret ${file}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// Non-disclosure, everywhere
// ---------------------------------------------------------------------------------------------------------

await test('no raw key reaches any evidence surface this tranche produces', async () => {
  const install = installation('disclosure');
  const ring = initializeKekRing(install.stateDir, install.rootKey);
  const generated = ring.generations[0]!.keyHex;

  const daemon = await startSidecarDaemon(validateSidecarDaemonConfig({
    socketPath: install.socketPath,
    stateDir: install.stateDir,
    completionSecretFile: install.completionSecretFile,
    rootKeyFile: install.rootKeyFile,
  }));
  let surfaces: string[];
  try {
    const health = await probeSidecarHealth(install.socketPath);
    const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(install.socketPath));
    const provision = await client.provision('op-d', 'item-d', 0);
    await client.commitProvision('op-d');
    const receipt = await client.destroy('op-dd', provision.keyId);
    surfaces = [JSON.stringify(health), JSON.stringify(receipt), JSON.stringify(daemon.mode)];
  } finally {
    await daemon.close();
  }
  for (const surface of surfaces) {
    for (const forbidden of [generated, install.rootKey.toString('hex'), install.rootKey.toString('base64'),
      install.staticKek.toString('hex'), SECRET]) {
      assert(!surface.includes(forbidden), `an evidence surface carried ${forbidden.slice(0, 20)}`);
    }
  }
  // AND NOTHING IN THE STATE DIRECTORY HOLDS THE ROOT KEY OR AN UNSEALED KEK.
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = join(dir, entry.name);
    return entry.isDirectory() ? walk(child) : [readFileSync(child, 'utf8')];
  });
  for (const contents of walk(install.stateDir)) {
    assert(!contents.includes(generated), 'no file in the state directory holds a KEK in the clear');
    assert(!contents.includes(install.rootKey.toString('hex')), 'nor the root wrapping key');
  }
});

await test('no key material can be supplied on a command line to any verb', () => {
  // The shared parser refuses a flag whose NAME suggests a credential, so this is enforced rather than
  // documented: `--root-key <hex>` cannot be added later without the refusal firing.
  for (const flag of ['--root-key', '--kek', '--secret', '--password', '--token']) {
    refuses(() => parseKekRingArgs(['status', '--state', '/a/b', '--root-file', '/a/c', flag, 'x']),
      'looks like a credential', `the flag ${flag}`);
  }
  const ok = parseKekRingArgs(['status', '--state', '/a/b', '--root-file', '/a/c']);
  assertEq(ok.verb, 'status', 'while a file path parses');
  assertEq(parseSidecarHealthArgs(['--socket', '/a/b.sock']).socket, '/a/b.sock', 'and so does a socket path');
});

// ---------------------------------------------------------------------------------------------------------
// What is closed, and what is not
// ---------------------------------------------------------------------------------------------------------

await test('O4 is CLOSED by implementation evidence and O5 is implemented but NOT live-proven', () => {
  const doc = readRepo('docs/PHASES_281_284_SIDECAR_CUSTODY.md');
  // O4 — the runtime boundary — is closed by what this tranche implements and its suites prove.
  assert(/O4[^\n]*CLOSED/i.test(doc), 'the document says O4 is closed');
  assert(doc.includes('implementation evidence'), 'and says what closes it');
  // O5 — the managed ring — is implemented and hardened and has NOT been run against a live installation by
  // an operator. Claiming otherwise is the exact false proof this tranche is not allowed to produce.
  assert(/O5[^\n]*NOT (?:live-proven|closed)/i.test(doc), 'the document says O5 is not live-proven');
  assert(doc.includes('operator evidence'), 'and says what would close it');
  for (const overclaim of ['O5 is closed', 'O5: CLOSED', 'production-proven', 'live-proven on']) {
    assert(!doc.includes(overclaim), `the document must not claim ${overclaim}`);
  }
  // AND IT DOES NOT DRIFT INTO KMS LANGUAGE.
  for (const forbidden of ['AWS KMS', 'CloudHSM', 'Azure Key Vault', 'Google Cloud KMS', 'hardware security module']) {
    assert(!doc.includes(forbidden), `the document must not name ${forbidden}`);
  }
  assert(doc.includes('not a cloud KMS'), 'and says plainly what "managed" does not mean');
});

await test('the tranche contacts no media server, no acquisition system and no network', () => {
  for (const file of ['src/core/crypto/sidecar-ipc.ts', 'src/core/crypto/kek-ring.ts',
    'src/core/crypto/custodian-state-io.ts', 'src/ops/kek-rotation.ts', 'src/ops/kek-ring-cli.ts',
    'src/ops/sidecar-health-cli.ts', 'src/ops/kek-ring-secret-io.ts']) {
    const source = readRepo(file).toLowerCase();
    for (const forbidden of ['jellyfin', 'plex', 'emby', '/mnt/user/media', '.mkv', '.mp4', 'nzb', 'torrent',
      'magnet', 'usenet', 'sabnzbd', 'curl ', 'wget ', 'node:http', 'node:https', 'fetch(', 'symlink(']) {
      assert(!source.includes(forbidden), `${file} must not name ${forbidden}`);
    }
  }
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
