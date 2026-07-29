import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_VERSION } from '../src/db/schema-version.js';
import { REQUIRED_SECRET_FILES, BACKUP_COMPONENT_IDS } from '../src/ops/backup-components.js';
import {
  BACKUP_MANIFEST_NAME,
  COMPONENT_ARTIFACT_NAMES,
  QUIESCED_SERVICES,
  planCompleteBackup,
  readBackupManifest,
  renderCompleteBackup,
  resolveCompleteBackupRequest,
  runCompleteBackup,
  type CompleteBackupRequest,
} from '../src/ops/complete-backup.js';
import { renderBackupVerification, verifyBackupSet } from '../src/ops/backup-set-verification.js';
import {
  BROAD_ROOTS,
  CommandLedger,
  MAINTENANCE_LOCK_DIRNAME,
  MaintenanceRefused,
  acquireMaintenanceLock,
  assertNotBroadRoot,
  assertPermittedCommand,
  resolveMaintenanceRoot,
} from '../src/ops/maintenance-safety.js';
import { parseCompleteBackupArgs } from '../src/ops/complete-backup-cli.js';
import { assertLedgerIsClean, fakeDumpText, fakeToolchain } from './helpers/fake-toolchain.js';

// Phases 277-278 — the complete backup, and the verification that follows it in the same run.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - A COMPLETE BACKUP IS THE FOUR COMPONENTS THE MODEL ALREADY DECLARED, taken from one moment: every
//     writer is stopped first and started again through a `finally` that runs on every path out, including a
//     failure part way through.
//   - EACH COMPONENT'S ABSENCE IS A REFUSAL, and the run publishes nothing.
//   - HOSTILE INPUT IS REFUSED RATHER THAN NORMALISED: a symlink, a special file, traversal, a broad root, a
//     path outside the project, a sidecar topology with no stated path.
//   - THE SET IS PUBLISHED ATOMICALLY AND AN EXISTING NAME IS REFUSED, and a failed run leaves no set.
//   - VERIFICATION FAILS CLOSED on missing, extra, tampered and symlinked components, and changes nothing.
//   - NOTHING IN THE COMMAND LEDGER REACHES A NETWORK, A REGISTRY, A MEDIA PATH, A MEDIA SERVER OR AN
//     ACQUISITION SYSTEM — asserted against the commands that were actually issued.
//   - NO SECRET CONTENT, HOST PATH OR COMPONENT CONTENT REACHES A REPORT.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function refuses(fn: () => unknown, needle: string, msg: string): void {
  try { fn(); } catch (err) {
    const message = (err as Error).message;
    assert(message.includes(needle), `${msg}: expected a refusal mentioning "${needle}", got: ${message}`);
    return;
  }
  throw new Error(`${msg}: nothing was refused`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').split('\r\n').join('\n');

const WORK = mkdtempSync(join(tmpdir(), 'ca-backup-'));
const SECRET_VALUE = 'a-kek-value-that-must-never-appear-in-any-report';

/** A project directory shaped like a real one: secrets, promotion records, and room for backups. */
function makeProject(name: string, options: { readonly secrets?: readonly string[]; readonly records?: boolean; readonly sidecar?: boolean } = {}): string {
  const root = join(WORK, name);
  mkdirSync(root, { recursive: true });
  const secrets = join(root, 'secrets');
  mkdirSync(secrets, { recursive: true });
  for (const file of options.secrets ?? REQUIRED_SECRET_FILES) {
    writeFileSync(join(secrets, file), file === 'custodian_kek' ? SECRET_VALUE : `${file}-value\n`, 'utf8');
  }
  if (options.records !== false) {
    mkdirSync(join(root, 'promotion-records'), { recursive: true });
    writeFileSync(join(root, 'promotion-records', 'record-1.json'), '{"a":1}\n', 'utf8');
  }
  if (options.sidecar === true) {
    mkdirSync(join(root, 'sidecar-state', 'keys'), { recursive: true });
    mkdirSync(join(root, 'sidecar-state', 'tombstones'), { recursive: true });
    writeFileSync(join(root, 'sidecar-state', 'keys', 'k1'), 'wrapped\n', 'utf8');
  }
  return root;
}

function request(root: string, setName: string, overrides: Partial<CompleteBackupRequest> = {}): CompleteBackupRequest {
  return {
    projectRoot: root,
    destination: 'backups',
    setName,
    custodian: 'inline',
    secrets: 'secrets',
    promotionRecords: 'promotion-records',
    ...overrides,
  };
}

console.log('Running Phase 277-278 complete backup and verification suite:\n');

// ---------------------------------------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------------------------------------

test('a complete backup takes all four components, from one quiesced moment, and verifies', () => {
  const root = makeProject('happy');
  const tools = fakeToolchain();
  const report = runCompleteBackup(request(root, 'set-1'), { runner: tools.runner, ledger: tools.ledger, now: () => new Date(0) });

  assertEq(report.ok, true, 'the backup reports success');
  assertEq(report.custodian, 'inline', 'and the topology it was told');
  assertEq(report.quiesced.join(','), QUIESCED_SERVICES.inline.join(','), 'the writers it stopped are the model\'s');
  assertEq(report.restarted, true, 'and it started them again');
  for (const id of BACKUP_COMPONENT_IDS) {
    const component = report.components.find((c) => c.id === id)!;
    assertEq(component.present, true, `the ${id} component is present`);
    assert(component.digest.length === 64, `and the ${id} component has a digest`);
  }

  // THE ORDER IS THE GUARANTEE: stop, dump, copy the keystore, start. A dump taken after the app came back is
  // a dump from a different moment than the keystore.
  const lines = tools.lines();
  const stopAt = lines.findIndex((l) => l.includes('compose stop app'));
  const dumpAt = lines.findIndex((l) => l.includes('pg_dump'));
  const keystoreAt = lines.findIndex((l) => l.includes('compose cp'));
  const startAt = lines.findIndex((l) => l.includes('compose start app'));
  assert(stopAt >= 0 && dumpAt > stopAt && keystoreAt > dumpAt && startAt > keystoreAt,
    `stop -> dump -> keystore -> start, in that order; got ${lines.join(' | ')}`);

  const setDir = join(root, 'backups', 'set-1');
  assertEq(existsSync(join(setDir, COMPONENT_ARTIFACT_NAMES.database)), true, 'the dump is in the set');
  assertEq(existsSync(join(setDir, BACKUP_MANIFEST_NAME)), true, 'and so is the manifest');

  const verification = verifyBackupSet(setDir);
  assertEq(verification.ok, true, `the set verifies: ${JSON.stringify(verification.problems)}`);
  assertEq(verification.wrote, 'nothing', 'and verification wrote nothing');
});

test('the backup directory and the files in it are private', () => {
  const root = makeProject('private');
  const tools = fakeToolchain();
  runCompleteBackup(request(root, 'set-p'), { runner: tools.runner, ledger: tools.ledger });
  if (process.platform === 'win32') { console.log('       (POSIX modes are not observable on this platform)'); return; }
  const setDir = join(root, 'backups', 'set-p');
  assertEq(statSync(setDir).mode & 0o077, 0, 'the set directory is not readable by anyone else');
  assertEq(statSync(join(setDir, COMPONENT_ARTIFACT_NAMES.database)).mode & 0o077, 0, 'nor is the dump');
  assertEq(statSync(join(setDir, BACKUP_MANIFEST_NAME)).mode & 0o077, 0, 'nor is the manifest');
});

test('the sidecar topology copies the keystore from the directory it was TOLD, and never guesses', () => {
  const root = makeProject('sidecar', { sidecar: true });
  const tools = fakeToolchain();
  const report = runCompleteBackup(
    request(root, 'set-s', { custodian: 'sidecar', sidecarState: 'sidecar-state' }),
    { runner: tools.runner, ledger: tools.ledger },
  );
  assertEq(report.ok, true, 'the sidecar backup succeeded');
  assertEq(report.quiesced.join(','), QUIESCED_SERVICES.sidecar.join(','), 'the custodian is stopped too');
  const keystore = join(root, 'backups', 'set-s', COMPONENT_ARTIFACT_NAMES.keystore);
  assertEq(existsSync(join(keystore, 'keys', 'k1')), true, 'the sidecar keystore was copied');
  assert(!tools.lines().some((l) => l.includes('compose cp')), 'and no container copy was needed');

  // The topology must be STATED. Both halves.
  refuses(() => resolveCompleteBackupRequest(request(root, 'x', { custodian: 'sidecar' })),
    'will not guess where', 'sidecar with no state directory');
  refuses(() => resolveCompleteBackupRequest(request(root, 'x', { custodian: 'inline', sidecarState: 'sidecar-state' })),
    'will not choose which', 'inline with a sidecar path');
});

// ---------------------------------------------------------------------------------------------------------
// Each component absent
// ---------------------------------------------------------------------------------------------------------

test('a missing secrets directory refuses before anything is stopped', () => {
  const root = makeProject('no-secrets');
  rmSync(join(root, 'secrets'), { recursive: true, force: true });
  const tools = fakeToolchain();
  refuses(() => runCompleteBackup(request(root, 'set-x'), { runner: tools.runner, ledger: tools.ledger }),
    'secrets directory is not there', 'a missing secrets directory');
  assertEq(tools.lines().length, 0, 'and NOTHING was run: no service was stopped');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'and no set was published');
});

test('a secrets directory missing one required file refuses, and publishes nothing', () => {
  const root = makeProject('partial-secrets', { secrets: REQUIRED_SECRET_FILES.slice(0, 3) });
  const tools = fakeToolchain();
  refuses(() => runCompleteBackup(request(root, 'set-x'), { runner: tools.runner, ledger: tools.ledger }),
    'files a restore', 'a partial secrets directory');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'no set was published');
  // AND THE STACK IS BACK UP. The refusal happened after the window, and the window's `finally` ran.
  assert(tools.lines().some((l) => l.includes('compose start app')), 'the app was started again');
});

test('a database dump that produces nothing refuses, publishes nothing, and restarts the stack', () => {
  const root = makeProject('no-dump');
  const tools = fakeToolchain({ dumpText: '' });
  refuses(() => runCompleteBackup(request(root, 'set-x'), { runner: tools.runner, ledger: tools.ledger }),
    'did not run, or produced nothing', 'an empty dump');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'no set was published');
  assert(tools.lines().some((l) => l.includes('compose start app')), 'and the app was started again anyway');
});

test('a keystore copy that fails refuses, and says why it matters', () => {
  const root = makeProject('no-keystore');
  const tools = fakeToolchain({ failWhen: [{ contains: 'compose cp', status: 1 }] });
  refuses(() => runCompleteBackup(request(root, 'set-x'), { runner: tools.runner, ledger: tools.ledger }),
    'can decrypt nothing', 'a failed keystore copy');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'no set was published');
  assert(tools.lines().some((l) => l.includes('compose start app')), 'and the app was started again');
});

test('no promotion records is a complete backup, and says so rather than warning', () => {
  const root = makeProject('no-records', { records: false });
  const tools = fakeToolchain();
  const report = runCompleteBackup(request(root, 'set-r', { promotionRecords: 'promotion-records' }),
    { runner: tools.runner, ledger: tools.ledger });
  assertEq(report.ok, true, 'it is still a complete backup');
  assert(report.notes.some((n) => n.includes('correct and permanent state')), 'and the report says why');
  const verification = verifyBackupSet(join(root, 'backups', 'set-r'));
  assertEq(verification.ok, true, 'and it verifies');
});

// ---------------------------------------------------------------------------------------------------------
// The failure window, the lock and the name
// ---------------------------------------------------------------------------------------------------------

test('a service that will not stop refuses, and the finally still starts what WAS stopped', () => {
  const root = makeProject('stubborn', { sidecar: true });
  // The app stops; the custodian does not. The window must unwind whatever it managed to stop.
  const tools = fakeToolchain({ failWhen: [{ contains: 'compose stop custodian', status: 1 }] });
  refuses(() => runCompleteBackup(request(root, 'set-x', { custodian: 'sidecar', sidecarState: 'sidecar-state' }),
    { runner: tools.runner, ledger: tools.ledger }), 'could not be stopped', 'a service that will not stop');
  const lines = tools.lines();
  assert(lines.some((l) => l.includes('compose start app')), 'the app that WAS stopped is started again');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'and no set was published');
});

test('a start that fails is reported rather than swallowed', () => {
  const root = makeProject('stuck-start');
  const tools = fakeToolchain({ failWhen: [{ contains: 'compose start app', status: 1 }] });
  const report = runCompleteBackup(request(root, 'set-k'), { runner: tools.runner, ledger: tools.ledger });
  assertEq(report.restarted, false, 'the report does not claim the stack came back');
  assert(report.notes.some((n) => n.includes('the stack is down')), 'and it says so first');
});

test('a restart that THROWS does not replace the failure that caused it', () => {
  // A `finally` that throws REPLACES the error that sent us there. An operator would be told the restart
  // failed and never told the dump did — which is the one fact they need. The restart is attempted, its
  // failure is a note, and the original refusal is what propagates.
  const root = makeProject('masking');
  const tools = fakeToolchain({ failWhen: [{ contains: 'pg_dump', status: 1 }] });
  const exploding = {
    ...tools,
    runner: (command: Parameters<typeof tools.runner>[0]) => {
      if (command.args.includes('start')) throw new Error('the runner itself blew up on the restart');
      return tools.runner(command);
    },
  };
  refuses(() => runCompleteBackup(request(root, 'set-x'), { runner: exploding.runner, ledger: tools.ledger }),
    'did not run, or produced nothing', 'the ORIGINAL failure, not the restart\'s');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'and nothing was published');
  assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false, 'and the lock was still released');
});

test('an interrupted run leaves no set and no lock, and the next run is not blocked by it', () => {
  const root = makeProject('interrupted');
  const tools = fakeToolchain({ failWhen: [{ contains: 'pg_dump', status: 1 }] });
  refuses(() => runCompleteBackup(request(root, 'set-x'), { runner: tools.runner, ledger: tools.ledger }),
    'did not run', 'a failed dump');
  assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false, 'the lock was released');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'and no set was published');
  // ...and a staging directory is all that could be left, which is dot-prefixed and never a set.
  const leftovers = readdirSync(join(root, 'backups')).filter((n) => !n.startsWith('.'));
  assertEq(leftovers.length, 0, 'nothing that is not dot-prefixed was left in the destination');

  const second = fakeToolchain();
  const report = runCompleteBackup(request(root, 'set-2'), { runner: second.runner, ledger: second.ledger });
  assertEq(report.ok, true, 'and the next run succeeds');
});

test('two maintenance runs cannot hold the same project at once', () => {
  const root = makeProject('locked');
  const held = acquireMaintenanceLock(root);
  try {
    const tools = fakeToolchain();
    refuses(() => runCompleteBackup(request(root, 'set-x'), { runner: tools.runner, ledger: tools.ledger }),
      'already running', 'a second run while one holds the lock');
    assertEq(tools.lines().length, 0, 'and the second run stopped nothing');
  } finally {
    held.release();
  }
  assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false, 'and the lock releases');
});

test('an existing set name is refused, and the set that is there is untouched', () => {
  const root = makeProject('existing');
  const first = fakeToolchain();
  runCompleteBackup(request(root, 'set-1'), { runner: first.runner, ledger: first.ledger });
  const before = readFileSync(join(root, 'backups', 'set-1', COMPONENT_ARTIFACT_NAMES.database), 'utf8');

  const second = fakeToolchain({ dumpText: fakeDumpText(3) });
  refuses(() => runCompleteBackup(request(root, 'set-1'), { runner: second.runner, ledger: second.ledger }),
    'already there', 'a repeated set name');
  assertEq(readFileSync(join(root, 'backups', 'set-1', COMPONENT_ARTIFACT_NAMES.database), 'utf8'), before,
    'and the set that was there is byte-identical');
  assertEq(second.lines().length, 0, 'and nothing was stopped for the refused run');
});

// ---------------------------------------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------------------------------------

test('a symbolic link anywhere in a component is refused', () => {
  const root = makeProject('symlinked');
  const target = join(root, 'secrets', 'custodian_kek');
  const link = join(root, 'secrets', 'a-link');
  let created = false;
  try { symlinkSync(target, link); created = true; }
  catch { console.log('       (symlink creation is not permitted on this platform; the link case is not exercised)'); }
  if (!created) return;
  const tools = fakeToolchain();
  refuses(() => runCompleteBackup(request(root, 'set-x'), { runner: tools.runner, ledger: tools.ledger }),
    'symbolic link', 'a symlink in the secrets directory');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'and nothing was published');
  rmSync(link);
});

test('traversal, an absolute path and a path outside the project are all refused', () => {
  const root = makeProject('traversal');
  for (const [path, needle] of [
    ['../elsewhere', 'above the project root'],
    ['secrets/../../elsewhere', 'above the project root'],
  ] as Array<[string, string]>) {
    refuses(() => resolveCompleteBackupRequest(request(root, 'set-x', { secrets: path })), needle, `secrets at ${path}`);
  }
  refuses(() => resolveCompleteBackupRequest(request(root, 'set-x', { secrets: join(root, 'secrets') })),
    'must be relative', 'an absolute secrets path');
});

test('a broad root is refused as a project root', () => {
  // The SHAPE check is asserted directly, so the case holds on a host where `/etc` does not exist at all —
  // which is every Windows one, and is exactly where a resolve-first test would pass for the wrong reason.
  for (const broad of ['/', '/etc', '/mnt', '/mnt/user', '/var', '/home']) {
    refuses(() => assertNotBroadRoot(broad, 'project root'), 'will not use one', `${broad} as a project root`);
  }
  assert(BROAD_ROOTS.includes('/mnt/user'), 'the Unraid share root is one of the broad roots');
  // A path that is not on the list but is too shallow to be a project directory is refused too.
  refuses(() => assertNotBroadRoot('/appdata', 'project root'), 'too shallow', 'a one-segment root');
  // ...and the resolving entry point refuses one that is not there at all, before anything else.
  refuses(() => resolveMaintenanceRoot(join(WORK, 'not-there-at-all'), 'project root'), 'does not exist',
    'a root that is not there');
});

test('a set name with a folder part, a leading dot or traversal is refused', () => {
  const root = makeProject('names');
  for (const name of ['../escape', 'a/b', '.hidden', '', 'x'.repeat(200)]) {
    refuses(() => resolveCompleteBackupRequest(request(root, name)), 'backup set name', `the set name ${JSON.stringify(name)}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------------------

test('a tampered component is caught, and verification changes nothing', () => {
  const root = makeProject('tampered');
  const tools = fakeToolchain();
  runCompleteBackup(request(root, 'set-1'), { runner: tools.runner, ledger: tools.ledger });
  const setDir = join(root, 'backups', 'set-1');
  const dump = join(setDir, COMPONENT_ARTIFACT_NAMES.database);
  if (process.platform !== 'win32') chmodSync(dump, 0o600);
  writeFileSync(dump, `${readFileSync(dump, 'utf8')}-- tampered\n`, 'utf8');

  const verification = verifyBackupSet(setDir);
  assertEq(verification.ok, false, 'a changed component does not verify');
  assert(verification.problems.some((p) => p.finding === 'COMPONENT_CHANGED' && p.component === 'database'),
    `the finding names the component: ${JSON.stringify(verification.problems)}`);
  assertEq(verification.wrote, 'nothing', 'and it wrote nothing');
});

test('a removed component and an added artifact are both caught', () => {
  const root = makeProject('missing-extra');
  const tools = fakeToolchain();
  runCompleteBackup(request(root, 'set-1'), { runner: tools.runner, ledger: tools.ledger });
  const setDir = join(root, 'backups', 'set-1');

  writeFileSync(join(setDir, 'something-else.txt'), 'not declared\n', 'utf8');
  const withExtra = verifyBackupSet(setDir);
  assertEq(withExtra.ok, false, 'an undeclared artifact does not verify');
  assert(withExtra.problems.some((p) => p.finding === 'COMPONENT_UNEXPECTED'), 'and it says so');
  rmSync(join(setDir, 'something-else.txt'));

  rmSync(join(setDir, COMPONENT_ARTIFACT_NAMES.keystore), { recursive: true, force: true });
  const withMissing = verifyBackupSet(setDir);
  assertEq(withMissing.ok, false, 'a removed component does not verify');
  assert(withMissing.problems.some((p) => p.finding === 'COMPONENT_MISSING' && p.component === 'keystore'),
    'and the keystore is named');
});

test('a set with no manifest is refused, and says which tool to use instead', () => {
  const root = makeProject('manifestless');
  mkdirSync(join(root, 'loose'), { recursive: true });
  writeFileSync(join(root, 'loose', 'catalog-backup.sql'), fakeDumpText(MIGRATION_VERSION), 'utf8');
  const verification = verifyBackupSet(join(root, 'loose'));
  assertEq(verification.ok, false, 'a set with no manifest does not verify');
  assert(verification.problems.some((p) => p.finding === 'MANIFEST_MISSING'), 'and says the manifest is missing');
  assert(verification.notes.some((n) => n.includes('ops:backup-inspect')), 'and points at the tool that needs none');
});

test('a set from a NEWER schema is refused as incompatible', () => {
  const root = makeProject('ahead');
  const tools = fakeToolchain();
  runCompleteBackup(request(root, 'set-1'), { runner: tools.runner, ledger: tools.ledger });
  const setDir = join(root, 'backups', 'set-1');
  const manifestPath = join(setDir, BACKUP_MANIFEST_NAME);
  if (process.platform !== 'win32') chmodSync(manifestPath, 0o600);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.schemaVersion = MIGRATION_VERSION + 5;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const verification = verifyBackupSet(setDir);
  assertEq(verification.ok, false, 'a newer set does not verify under this build');
  assert(verification.problems.some((p) => p.finding === 'SCHEMA_INCOMPATIBLE'), 'and says the schema is incompatible');
});

test('components are copied BYTE-FAITHFULLY, including bytes that are not text', () => {
  // A secret file, a wrapped key or an operator's own promotion artifact may hold any byte at all. A copy
  // that round-tripped through a string encoding would restore something subtly different — the same defect
  // the Phase 256 Windows guidance exists for, and the last place it may reappear.
  const root = makeProject('bytes');
  const hostile = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x41, 0x0d, 0x0a, 0xc3, 0x28]);
  writeFileSync(join(root, 'promotion-records', 'binary.bin'), hostile);
  const tools = fakeToolchain();
  runCompleteBackup(request(root, 'set-1'), { runner: tools.runner, ledger: tools.ledger });
  const copied = readFileSync(join(root, 'backups', 'set-1', COMPONENT_ARTIFACT_NAMES['promotion-records'], 'binary.bin'));
  assertEq(copied.equals(hostile), true, 'the copied component is byte-identical to the original');
  assertEq(verifyBackupSet(join(root, 'backups', 'set-1')).ok, true, 'and the set still verifies');
});

test('the manifest carries structure and digests, and no content of any kind', () => {
  const root = makeProject('manifest');
  const tools = fakeToolchain();
  runCompleteBackup(request(root, 'set-1'), { runner: tools.runner, ledger: tools.ledger });
  const raw = readFileSync(join(root, 'backups', 'set-1', BACKUP_MANIFEST_NAME), 'utf8');
  for (const forbidden of [SECRET_VALUE, root, WORK, 'custodian_kek-value', 'PostgreSQL database dump']) {
    assert(!raw.includes(forbidden), `the manifest must not carry ${forbidden.slice(0, 32)}`);
  }
  const manifest = readBackupManifest(join(root, 'backups', 'set-1'));
  assertEq(manifest.schemaVersion, MIGRATION_VERSION, 'it records the schema version');
  assertEq(manifest.components.length, BACKUP_COMPONENT_IDS.length, 'and every component');
});

// ---------------------------------------------------------------------------------------------------------
// Disclosure and the ledger
// ---------------------------------------------------------------------------------------------------------

test('no report carries a secret value, a host path or a component\'s content', () => {
  const root = makeProject('disclosure');
  const tools = fakeToolchain();
  const report = runCompleteBackup(request(root, 'set-1'), { runner: tools.runner, ledger: tools.ledger });
  const verification = verifyBackupSet(join(root, 'backups', 'set-1'));
  const printed = [
    renderCompleteBackup(report), JSON.stringify(report),
    renderBackupVerification(verification), JSON.stringify(verification),
  ].join('\n');
  for (const forbidden of [SECRET_VALUE, root, WORK, 'PostgreSQL database dump', 'wrapped']) {
    assert(!printed.includes(forbidden), `a report carried ${forbidden.slice(0, 40)}`);
  }
  assert(printed.includes('set-1'), 'while the set name the operator chose IS shown, which is what they act on');
});

test('the command ledger reaches no network, registry, media path, media server or acquisition system', () => {
  const root = makeProject('ledger', { sidecar: true });
  for (const req of [request(root, 'set-a'), request(root, 'set-b', { custodian: 'sidecar', sidecarState: 'sidecar-state' })]) {
    const tools = fakeToolchain();
    runCompleteBackup(req, { runner: tools.runner, ledger: tools.ledger });
    const problems = assertLedgerIsClean(tools.lines());
    assertEq(problems.join('; '), '', `the ledger is clean: ${tools.lines().join(' | ')}`);
    assert(tools.lines().length > 0, 'and it is not empty, so the scan is not vacuous');
    for (const line of tools.lines()) {
      assert(line.startsWith('docker compose '), `every command is a compose command: ${line}`);
    }
  }
});

test('the guard refuses a command that would fetch, or reach a media server, before it could run', () => {
  const cwd = WORK;
  for (const [args, needle] of [
    [['compose', 'pull'], 'compose subcommands'],
    [['pull', 'x:1'], 'docker subcommands'],
    [['compose', 'up', '-d', 'jellyfin'], 'jellyfin'],
    [['compose', 'cp', 'app:/x', '/mnt/user/media/Movies'], '/mnt/user/media'],
    [['compose', 'run', 'app', 'curl', 'x'], 'curl'],
  ] as Array<[string[], string]>) {
    refuses(() => assertPermittedCommand({ program: 'docker', args, cwd, purpose: 'p' }), needle,
      `the command ${args.join(' ')}`);
  }
  refuses(() => assertPermittedCommand({ program: 'sh', args: ['-c', 'x'], cwd, purpose: 'p' }),
    'only run', 'a shell');
});

// ---------------------------------------------------------------------------------------------------------
// The plan and the command line
// ---------------------------------------------------------------------------------------------------------

test('the plan is the commands, and it stops nothing', () => {
  const root = makeProject('planned');
  const resolved = resolveCompleteBackupRequest(request(root, 'set-1'));
  const commands = planCompleteBackup(resolved, join(root, 'backups', '.staging'));
  assert(commands.length >= 4, 'the plan has the steps');
  for (const command of commands) {
    assertEq(command.cwd, resolved.projectRoot, 'every command runs in the project root');
    assertPermittedCommand(command);
  }
  assertEq(existsSync(join(root, 'backups', 'set-1')), false, 'and planning published nothing');
});

test('the CLI parser is strict, refuses a guessed topology, and takes no credential', () => {
  const parsed = parseCompleteBackupArgs(['--project', '/x/y', '--set', 's', '--custodian', 'inline']);
  assertEq(parsed.request.custodian, 'inline', 'the topology parses');
  assertEq(parsed.request.destination, 'backups', 'and the destination defaults');
  for (const [argv, needle] of [
    [['--project', '/x/y', '--set', 's'], '--custodian'],
    [['--project', '/x/y', '--set', 's', '--custodian', 'maybe'], 'will not guess'],
    [['--set', 's', '--custodian', 'inline'], '--project is required'],
    [['--project', '/x/y', '--set', 's', '--custodian', 'inline', '--nope', 'v'], 'unknown option'],
    [['--project', '/x/y', '--set', 's', '--custodian', 'inline', '--db-password', 'hunter2'], 'looks like a credential'],
  ] as Array<[string[], string]>) {
    refuses(() => parseCompleteBackupArgs(argv), needle, `the arguments ${argv.join(' ')}`);
  }
});

test('the maintenance modules build no shell command and reach for no shell', () => {
  for (const rel of ['src/ops/maintenance-safety.ts', 'src/ops/complete-backup.ts',
    'src/ops/backup-set-verification.ts', 'src/ops/doctor-monitor.ts', 'src/ops/upgrade-rehearsal.ts']) {
    const source = readRepo(rel);
    for (const forbidden of ['execSync', 'spawnSync', 'child_process', 'shell: true', '`sh -c']) {
      assert(!source.includes(forbidden), `${rel} must not name ${forbidden}`);
    }
  }
  // ONE module starts a process, and it is the one that says so in its name.
  const runner = readRepo('src/ops/maintenance-cli-shared.ts');
  assert(runner.includes('shell: false'), 'the one runner runs with no shell');
  assertEq([...runner.matchAll(/spawnSync\(/g)].length, 1, 'and there is exactly one spawn in the tranche');
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
