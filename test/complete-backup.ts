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
  CompleteBackupFailed,
  QUIESCED_SERVICES,
  planCompleteBackup,
  readBackupManifest,
  renderCompleteBackup,
  resolveCompleteBackupRequest,
  takeCompleteBackupWithoutVerifying,
  runVerifiedCompleteBackup,
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
import { reportRefusal } from '../src/ops/maintenance-cli-shared.js';
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
  const report = takeCompleteBackupWithoutVerifying(request(root, 'set-1'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger, now: () => new Date(0) });

  assertEq(report.published, true, 'the set reached its final name');
  assertEq(report.restarted, true, 'and the stack came back');
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
  takeCompleteBackupWithoutVerifying(request(root, 'set-p'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  if (process.platform === 'win32') { console.log('       (POSIX modes are not observable on this platform)'); return; }
  const setDir = join(root, 'backups', 'set-p');
  assertEq(statSync(setDir).mode & 0o077, 0, 'the set directory is not readable by anyone else');
  assertEq(statSync(join(setDir, COMPONENT_ARTIFACT_NAMES.database)).mode & 0o077, 0, 'nor is the dump');
  assertEq(statSync(join(setDir, BACKUP_MANIFEST_NAME)).mode & 0o077, 0, 'nor is the manifest');
});

test('the sidecar topology copies the keystore from the directory it was TOLD, and never guesses', () => {
  const root = makeProject('sidecar', { sidecar: true });
  const tools = fakeToolchain();
  const report = takeCompleteBackupWithoutVerifying(
    request(root, 'set-s', { custodian: 'sidecar', sidecarState: 'sidecar-state' }),
    { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger },
  );
  assertEq(report.published, true, 'the sidecar backup published its set');
  assertEq(report.quiesced.join(','), QUIESCED_SERVICES.sidecar.join(','), 'the custodian is stopped too');
  assertEq(report.quiesced.join(','), 'app,sidecar', 'the backup stops the shipped sidecar service by its exact Compose name');
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
  refuses(() => takeCompleteBackupWithoutVerifying(request(root, 'set-x'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger }),
    'secrets directory is not there', 'a missing secrets directory');
  assertEq(tools.lines().length, 0, 'and NOTHING was run: no service was stopped');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'and no set was published');
});

test('a secrets directory missing one required file refuses, and publishes nothing', () => {
  const root = makeProject('partial-secrets', { secrets: REQUIRED_SECRET_FILES.slice(0, 3) });
  const tools = fakeToolchain();
  refuses(() => takeCompleteBackupWithoutVerifying(request(root, 'set-x'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger }),
    'files a restore', 'a partial secrets directory');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'no set was published');
  // AND THE STACK IS BACK UP. The refusal happened after the window, and the window's `finally` ran.
  assert(tools.lines().some((l) => l.includes('compose start app')), 'the app was started again');
});

test('a database dump that produces nothing refuses, publishes nothing, and restarts the stack', () => {
  const root = makeProject('no-dump');
  const tools = fakeToolchain({ dumpText: '' });
  refuses(() => takeCompleteBackupWithoutVerifying(request(root, 'set-x'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger }),
    'produced no bytes', 'an empty dump');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'no set was published');
  assert(tools.lines().some((l) => l.includes('compose start app')), 'and the app was started again anyway');
});

test('a keystore copy that fails refuses, and says why it matters', () => {
  const root = makeProject('no-keystore');
  const tools = fakeToolchain({ failWhen: [{ contains: 'compose cp', status: 1 }] });
  refuses(() => takeCompleteBackupWithoutVerifying(request(root, 'set-x'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger }),
    'can decrypt nothing', 'a failed keystore copy');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'no set was published');
  assert(tools.lines().some((l) => l.includes('compose start app')), 'and the app was started again');
});

test('no promotion records is a complete backup, and says so rather than warning', () => {
  const root = makeProject('no-records', { records: false });
  const tools = fakeToolchain();
  const report = takeCompleteBackupWithoutVerifying(request(root, 'set-r', { promotionRecords: 'promotion-records' }),
    { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  assertEq(report.published, true, 'it is still a complete backup');
  assert(report.notes.some((n) => n.includes('correct and permanent state')), 'and the report says why');
  const verification = verifyBackupSet(join(root, 'backups', 'set-r'));
  assertEq(verification.ok, true, 'and it verifies');
});

// ---------------------------------------------------------------------------------------------------------
// The failure window, the lock and the name
// ---------------------------------------------------------------------------------------------------------

test('a service that will not stop refuses, and the finally still starts what WAS stopped', () => {
  const root = makeProject('stubborn', { sidecar: true });
  // The app stops; the sidecar does not. The window must unwind whatever it managed to stop.
  const tools = fakeToolchain({ failWhen: [{ contains: 'compose stop sidecar', status: 1 }] });
  refuses(() => takeCompleteBackupWithoutVerifying(request(root, 'set-x', { custodian: 'sidecar', sidecarState: 'sidecar-state' }),
    { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger }), 'could not be stopped', 'a service that will not stop');
  const lines = tools.lines();
  assert(lines.some((l) => l.includes('compose start app')), 'the app that WAS stopped is started again');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'and no set was published');
});

test('a start that fails is reported rather than swallowed', () => {
  const root = makeProject('stuck-start');
  const tools = fakeToolchain({ failWhen: [{ contains: 'compose start app', status: 1 }] });
  const report = takeCompleteBackupWithoutVerifying(request(root, 'set-k'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
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
  refuses(() => takeCompleteBackupWithoutVerifying(request(root, 'set-x'), { runner: exploding.runner, fileRunner: tools.fileRunner, ledger: tools.ledger }),
    'the database dump did not run', 'the ORIGINAL failure, not the restart\'s');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'and nothing was published');
  assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false, 'and the lock was still released');
});

test('a DUAL failure carries both facts: what went wrong, AND that the stack is still down', () => {
  // THE DEFECT: the outage was recorded as a note, and notes travel on a report that a THROWN failure never
  // returns. So when the dump failed and the restart failed too, the operator was told "the database dump did
  // not run. Nothing was written." and was never told their installation was down — which is by far the
  // larger of the two problems and the only one that is urgent.
  const root = makeProject('dual-failure');
  const tools = fakeToolchain({
    failWhen: [{ contains: 'pg_dump', status: 1 }, { contains: 'compose start app', status: 1 }],
  });
  let caught: unknown = null;
  try {
    takeCompleteBackupWithoutVerifying(request(root, 'set-x'),
      { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  } catch (err) { caught = err; }
  assert(caught instanceof CompleteBackupFailed, `a dual failure is its own kind: ${String(caught)}`);
  const failure = caught as CompleteBackupFailed;
  // BOTH, IN ONE SENTENCE AN OPERATOR READS ONCE.
  assert(failure.primary.includes('the database dump did not run'),
    `the primary failure is preserved word for word: ${failure.primary}`);
  assert(failure.message.includes('the database dump did not run'), 'and it is in the message');
  assert(failure.message.includes('THE STACK IS STILL DOWN'), 'as is the outage');
  assertEq(failure.stillStopped.join(','), 'app', 'naming what did not come back');
  // It is still a refusal, so the CLI prints it in full rather than reducing it to an errno.
  assert(failure instanceof MaintenanceRefused, 'and it is one of this product\'s own refusals');
  assertEq(reportRefusal(failure), failure.message, 'which the CLI prints whole');
  assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false, 'and the lock was still released');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'and nothing was published');
});

test('a failure with the stack HEALTHY is left exactly as it was, with nothing added', () => {
  // The other half of the rule: where there is no second fact, nothing is wrapped. An operator reading a
  // refusal must not have to look past a paragraph about an outage that did not happen.
  const root = makeProject('single-failure');
  const tools = fakeToolchain({ failWhen: [{ contains: 'pg_dump', status: 1 }] });
  let caught: unknown = null;
  try {
    takeCompleteBackupWithoutVerifying(request(root, 'set-x'),
      { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  } catch (err) { caught = err; }
  assert(caught instanceof MaintenanceRefused, 'it is still a refusal');
  assert(!(caught instanceof CompleteBackupFailed), 'but not the dual-failure kind');
  assert(!(caught as Error).message.includes('STILL DOWN'), 'and it claims no outage');
  assert(tools.lines().some((line) => line.includes('compose start app')), 'because the app really did restart');
});

test('a failure AFTER the window still carries an outage that happened during it', () => {
  // The restart can fail while the set is being described or published, which leaves exactly the same outage
  // as one that failed while the dump was running. The enrichment therefore covers the whole run, not only
  // the quiesced block.
  const root = makeProject('late-failure', { records: false });
  // The app never comes back, AND the secrets copy is emptied before the set is described, so the failure
  // that propagates is raised well after the window closed.
  const tools = fakeToolchain({ failWhen: [{ contains: 'compose start app', status: 1 }] });
  rmSync(join(root, 'secrets', 'custodian_kek'), { force: true });
  let caught: unknown = null;
  try {
    takeCompleteBackupWithoutVerifying(request(root, 'set-x'),
      { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  } catch (err) { caught = err; }
  assert(caught instanceof CompleteBackupFailed, `a post-window failure carries the outage too: ${String(caught)}`);
  assert((caught as CompleteBackupFailed).primary.length > 0, 'with the original reason preserved');
  assert((caught as Error).message.includes('THE STACK IS STILL DOWN'), 'and the outage named');
});

test('an interrupted run leaves no set and no lock, and the next run is not blocked by it', () => {
  const root = makeProject('interrupted');
  const tools = fakeToolchain({ failWhen: [{ contains: 'pg_dump', status: 1 }] });
  refuses(() => takeCompleteBackupWithoutVerifying(request(root, 'set-x'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger }),
    'did not run', 'a failed dump');
  assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false, 'the lock was released');
  assertEq(existsSync(join(root, 'backups', 'set-x')), false, 'and no set was published');
  // ...and a staging directory is all that could be left, which is dot-prefixed and never a set.
  const leftovers = readdirSync(join(root, 'backups')).filter((n) => !n.startsWith('.'));
  assertEq(leftovers.length, 0, 'nothing that is not dot-prefixed was left in the destination');

  const second = fakeToolchain();
  const report = takeCompleteBackupWithoutVerifying(request(root, 'set-2'), { runner: second.runner, fileRunner: second.fileRunner, ledger: second.ledger });
  assertEq(report.published, true, 'and the next run publishes');
});

test('two maintenance runs cannot hold the same project at once', () => {
  const root = makeProject('locked');
  const held = acquireMaintenanceLock(root);
  try {
    const tools = fakeToolchain();
    refuses(() => takeCompleteBackupWithoutVerifying(request(root, 'set-x'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger }),
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
  takeCompleteBackupWithoutVerifying(request(root, 'set-1'), { runner: first.runner, fileRunner: first.fileRunner, ledger: first.ledger });
  const before = readFileSync(join(root, 'backups', 'set-1', COMPONENT_ARTIFACT_NAMES.database), 'utf8');

  const second = fakeToolchain({ dumpText: fakeDumpText(3) });
  refuses(() => takeCompleteBackupWithoutVerifying(request(root, 'set-1'), { runner: second.runner, fileRunner: second.fileRunner, ledger: second.ledger }),
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
  refuses(() => takeCompleteBackupWithoutVerifying(request(root, 'set-x'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger }),
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
  takeCompleteBackupWithoutVerifying(request(root, 'set-1'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
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
  takeCompleteBackupWithoutVerifying(request(root, 'set-1'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
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
  takeCompleteBackupWithoutVerifying(request(root, 'set-1'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
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
  takeCompleteBackupWithoutVerifying(request(root, 'set-1'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  const copied = readFileSync(join(root, 'backups', 'set-1', COMPONENT_ARTIFACT_NAMES['promotion-records'], 'binary.bin'));
  assertEq(copied.equals(hostile), true, 'the copied component is byte-identical to the original');
  assertEq(verifyBackupSet(join(root, 'backups', 'set-1')).ok, true, 'and the set still verifies');
});

test('the manifest carries structure and digests, and no content of any kind', () => {
  const root = makeProject('manifest');
  const tools = fakeToolchain();
  takeCompleteBackupWithoutVerifying(request(root, 'set-1'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
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
  const report = takeCompleteBackupWithoutVerifying(request(root, 'set-1'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
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
    takeCompleteBackupWithoutVerifying(req, { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
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
// The corrections. Every test below FAILS on the first implementation of this tranche.
// ---------------------------------------------------------------------------------------------------------

test('the dump is written to a descriptor, so bytes that are not text survive it exactly', () => {
  // THE DEFECT: the dump was captured as a STRING from the runner and written back out. Every byte that is
  // not valid UTF-8 came back as U+FFFD, so a dump holding a `bytea` column, a client encoding that is not
  // UTF-8, or any binary payload restored as something that is not what the database produced — silently,
  // with a green result and a digest computed over the corrupted bytes.
  const root = makeProject('dump-bytes');
  const hostile = Buffer.concat([
    Buffer.from('-- PostgreSQL database dump\n', 'utf8'),
    Buffer.from([0x00, 0x80, 0xff, 0xfe, 0xc3, 0x28, 0x41, 0x0d, 0x0a]),
    Buffer.from('COPY public.schema_meta (id, version) FROM stdin;\n', 'utf8'),
    Buffer.from(`1\t${MIGRATION_VERSION}\n\\.\n`, 'utf8'),
  ]);
  const tools = fakeToolchain({ dumpBytes: hostile });
  takeCompleteBackupWithoutVerifying(request(root, 'set-1'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  const written = readFileSync(join(root, 'backups', 'set-1', COMPONENT_ARTIFACT_NAMES.database));
  assertEq(written.equals(hostile), true, 'the published dump is byte-identical to what the producer wrote');
  assert(!written.includes(Buffer.from([0xef, 0xbf, 0xbd])), 'and no byte was replaced by U+FFFD');
});

test('a dump larger than any in-memory bound succeeds, and is digested without being held', () => {
  // THE DEFECT: the dump passed through this process as a captured buffer under a 512 MiB cap. A real
  // database dump exceeds that, and the failure mode was a TRUNCATED backup or an out-of-memory kill — at
  // 3am, on a schedule, against the one artifact that cannot be obtained again.
  const root = makeProject('dump-huge');
  const size = 600 * 1024 * 1024;
  const tools = fakeToolchain({ dumpSize: size });
  const report = takeCompleteBackupWithoutVerifying(request(root, 'set-1'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  assertEq(report.published, true, 'a dump past the old cap is taken');
  const database = report.components.find((c) => c.id === 'database')!;
  assertEq(database.bytes, size, 'and the manifest records its real size');
  assertEq(database.digest.length, 64, 'and it was digested, which means it was read end to end');
  // The file is sparse, so this costs disk time rather than disk space; removing it now keeps the rest cheap.
  rmSync(join(root, 'backups', 'set-1'), { recursive: true, force: true });
});

test('every component is taken inside the quiesced window, not just the database and the keystore', () => {
  // THE DEFECT: the secrets and the promotion records were copied AFTER the writers were started again. The
  // custodian rotates a wrapped key on startup, so a set could hold a database from before the restart and a
  // keystore state from after it — the exact split-moment failure the whole command exists to prevent, and
  // one that verifies green because every component is individually intact.
  const root = makeProject('window');
  const kek = join(root, 'secrets', 'custodian_kek');
  const beforeRestart = readFileSync(kek, 'utf8');
  const tools = fakeToolchain();
  const mutating = {
    ...tools,
    runner: (command: Parameters<typeof tools.runner>[0]) => {
      // The instant the writers come back, the on-disk secret CHANGES. A copy taken after this point is
      // observably from a different moment.
      if (command.args.includes('start')) writeFileSync(kek, 'a-value-written-after-the-restart\n', 'utf8');
      return tools.runner(command);
    },
  };
  takeCompleteBackupWithoutVerifying(request(root, 'set-1'), { runner: mutating.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  const copied = readFileSync(join(root, 'backups', 'set-1', COMPONENT_ARTIFACT_NAMES.secrets, 'custodian_kek'), 'utf8');
  assertEq(copied, beforeRestart, 'the secrets in the set are the ones from inside the window');
  assert(readFileSync(kek, 'utf8') !== beforeRestart, 'and the test really did move the source, so this is not vacuous');
});

test('a cycle whose stack did not come back is a FAILED cycle, however good the set on disk is', () => {
  // THE DEFECT: `ok` meant "a set reached its final name". An operator whose app never restarted was told the
  // backup succeeded. Both facts are now carried separately and the success of the CYCLE is the conjunction.
  const root = makeProject('unrestarted');
  const tools = fakeToolchain({ failWhen: [{ contains: 'compose start app', status: 1 }] });
  const outcome = runVerifiedCompleteBackup(request(root, 'set-1'), {
    runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger,
  });
  assertEq(outcome.ok, false, 'the cycle failed');
  assertEq(outcome.backup.published, true, 'even though the set itself was published');
  assertEq(outcome.backup.restarted, false, 'because the writers did not come back');
  assert(outcome.failures.length > 0, 'and the failure is stated rather than implied');
  assertEq(outcome.verification.ok, true, 'while the set that IS there still verifies, which is the honest picture');
});

test('taking a set and verifying it are one contract, and the verdict decides the exit', () => {
  const root = makeProject('one-contract');
  const tools = fakeToolchain();
  const outcome = runVerifiedCompleteBackup(request(root, 'set-1'), {
    runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger,
  });
  assertEq(outcome.ok, true, 'a good cycle is ok');
  assertEq(outcome.verification.ok, true, 'and it verified in the same call');
  assertEq(outcome.failures.length, 0, 'with nothing to report');
});

test('there is NO unverified success to receive: the taking report carries no verdict at all', () => {
  // THE DEFECT: `runCompleteBackup` returned `ok: true` on its own, and only the CLI happened to verify
  // afterwards. Any other caller got an unverified success indistinguishable from a verified one. Closing it
  // by discipline would have lasted until the next caller; closing it by SUBTRACTION means there is no value
  // in existence to misread.
  const root = makeProject('no-unverified-ok');
  const tools = fakeToolchain();
  const report = takeCompleteBackupWithoutVerifying(request(root, 'set-1'),
    { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  assert(!('ok' in report), 'the taking report has no ok field');
  assert(!JSON.stringify(report).includes('"ok"'), 'and none appears in its serialised form either');
  assert(!renderCompleteBackup(report).includes('RESULT:'), 'nor does its rendering print a verdict line');

  // The ONE function that produces a verdict cannot produce one without a verification beside it.
  const outcome = runVerifiedCompleteBackup(request(root, 'set-2'),
    { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  assert('verification' in outcome && outcome.verification.report.length > 0,
    'the outcome that HAS an ok carries the verification that earned it');

  // A PUBLISHED SET THAT DOES NOT VERIFY IS NOT A SUCCESS, which is the case the removed field would have
  // reported as one.
  // The dump the database actually produces holds a schema version this build does not, so the set stages,
  // publishes and restarts perfectly — and the verification's own inspector disagrees with the manifest that
  // describes it. Nothing here is injected after the fact: the set really is one that must not be trusted.
  const damaged = makeProject('published-but-broken');
  const damaging = fakeToolchain({ dumpText: fakeDumpText(MIGRATION_VERSION - 1) });
  const broken = runVerifiedCompleteBackup(request(damaged, 'set-1'),
    { runner: damaging.runner, fileRunner: damaging.fileRunner, ledger: damaging.ledger });
  assertEq(broken.backup.published, true, 'the set reached its final name');
  assertEq(broken.backup.restarted, true, 'and the stack came back');
  assertEq(broken.verification.ok, false, 'but it does not verify');
  assertEq(broken.ok, false, 'so the CYCLE is not ok — the conjunction, not the taking');
  assert(broken.failures.some((f) => f.includes('does not verify')), 'and the reason is stated');
});

test('nothing else in src/ can take a backup without verifying it', () => {
  // ANTI-DRIFT. The unverified taker exists so a suite can exercise the refusals of the taking step; a future
  // route, scheduler or phase reaching for it would reintroduce exactly the path this closed.
  const callers: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) { walk(child); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      if (child.endsWith(join('ops', 'complete-backup.ts'))) continue; // where it is defined
      if (readFileSync(child, 'utf8').includes('takeCompleteBackupWithoutVerifying')) callers.push(entry.name);
    }
  };
  walk(join(repoRoot, 'src'));
  assertEq(callers.join(','), '', 'no file under src/ calls the unverified taker');
});

test('the backup reads every component through a descriptor, never by re-opening a name', () => {
  // THE DEFECT: components were `lstat`ed, judged, and then RE-OPENED by path to copy and digest. Three
  // resolutions of one name, with a window between each, against a directory other things write to. A static
  // guard is the right shape here: the property is "this module never reads a path", and a behavioural test
  // can only ever sample the paths it happens to think of.
  const source = readRepo('src/ops/complete-backup.ts');
  for (const forbidden of ['readFileSync(', 'createReadStream(', 'copyFileSync(', 'cpSync(']) {
    assert(!source.includes(forbidden), `the backup must not reach for ${forbidden} — every read goes through a descriptor`);
  }
  assert(source.includes('readFileNoFollow') && source.includes('digestFileNoFollow'),
    'and it uses the descriptor-based readers, so the guard above is not vacuous');
});

test('the docker guard is a closed shape, not a prefix skip', () => {
  const cwd = WORK;
  for (const [args, needle] of [
    // ONLY `compose`. The old allowlist admitted six more docker families, each of which reaches things this
    // product has no business touching.
    [['exec', 'app', 'sh'], 'docker subcommands'],
    [['run', 'app'], 'docker subcommands'],
    [['cp', 'app:/x', '/y'], 'docker subcommands'],
    [['inspect', 'app'], 'docker subcommands'],
    [['ps'], 'docker subcommands'],
    // `logs` is gone: container output is not this product's to read or to put in a report.
    [['compose', 'logs', 'app'], 'compose subcommands'],
    // A DOCKER-LEVEL FLAG BEFORE THE FAMILY IS NOT A FAMILY. `docker --tls compose up` never reaches the
    // compose parser at all: the first argument is what decides, and it is not `compose`.
    [['--tls', 'compose', 'up'], 'docker subcommands'],
    // THE COMPOSE GLOBAL FLAGS ARE A CLOSED SET WITH DECLARED SHAPES. The old parser skipped two tokens for
    // anything beginning with a dash, so an unknown flag taking NO value slid the whole command along by one
    // and the token then checked as the subcommand was not the verb that would have run.
    [['compose', '--tls', 'up'], 'global flag'],
    [['compose', '--host', 'tcp:', 'up'], 'global flag'],
    [['compose', '--verbose', 'up'], 'global flag'],
    [['compose', '-f'], 'was given no value'],
    [['compose', '--file'], 'was given no value'],
    [['compose', '-f', '-p'], 'was given no value'],
    [['compose', '-f', 'a.yml'], 'compose subcommands'],
  ] as Array<[string[], string]>) {
    refuses(() => assertPermittedCommand({ program: 'docker', args, cwd, purpose: 'p' }), needle,
      `the command docker ${args.join(' ')}`);
  }
  // ...and the flags that ARE declared still work, with their values consumed as values rather than as verbs.
  assertPermittedCommand({
    program: 'docker', args: ['compose', '-f', 'compose.yml', '-p', 'catalog', 'up', '-d'], cwd, purpose: 'p',
  });
});

test('a refusal says what this product decided, never what an unknown error happened to say', () => {
  // THE DEFECT: the CLI printed `err.message` for anything it caught. A runner failure, a filesystem error or
  // a third-party message could carry a host path, a project name or a fragment of a secret straight to a
  // console and into whatever an operator pastes into a support ticket.
  const hostile = new Error(`ENOENT: open '${join(WORK, 'secrets', 'custodian_kek')}' failed: ${SECRET_VALUE}`);
  (hostile as NodeJS.ErrnoException).code = 'ENOENT';
  const printed = reportRefusal(hostile);
  assert(!printed.includes(SECRET_VALUE), 'no secret value reaches the console');
  assert(!printed.includes(WORK), 'and no host path does either');
  assert(printed.includes('ENOENT'), 'while the closed-vocabulary errno code IS kept, because it is diagnosable');
  // A refusal this product wrote is shown in full: it was written to be read.
  assert(reportRefusal(new MaintenanceRefused('the secrets directory is not there')).includes('is not there'),
    'and the product\'s own refusals are still printed');
  // A code that is not a code is not printed as one.
  const forged = new Error('x');
  (forged as NodeJS.ErrnoException).code = `../../${SECRET_VALUE}`;
  assert(!reportRefusal(forged).includes(SECRET_VALUE), 'and a forged errno code is not echoed either');
});

test('an intact set from an OLDER schema verifies as intact and NOT restorable under this build', () => {
  // THE DEFECT: verification compared the manifest's schema version to this build's and called any difference
  // incompatible. An older set is the ROLLBACK POINT — the thing a rollback rehearsal exists to restore — and
  // reporting it as a failure teaches an operator to ignore the one check that would catch a real problem.
  const root = makeProject('rollback-point');
  const older = MIGRATION_VERSION - 1;
  const tools = fakeToolchain({ dumpText: fakeDumpText(older) });
  takeCompleteBackupWithoutVerifying(request(root, 'set-1'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  const setDir = join(root, 'backups', 'set-1');
  const manifestPath = join(setDir, BACKUP_MANIFEST_NAME);
  if (process.platform !== 'win32') chmodSync(manifestPath, 0o600);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.schemaVersion = older;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const verification = verifyBackupSet(setDir);
  assertEq(verification.ok, true, `an older intact set verifies: ${JSON.stringify(verification.problems)}`);
  assertEq(verification.restorableUnderThisBuild, false, 'and is honestly NOT restorable under this build');
  assert(verification.notes.some((n) => n.toLowerCase().includes('rollback')), 'and it is named as a rollback point');
});

test('a set whose manifest and whose dump disagree about the schema is a finding, not a rounding', () => {
  const root = makeProject('disagreement');
  const tools = fakeToolchain({ dumpText: fakeDumpText(MIGRATION_VERSION) });
  takeCompleteBackupWithoutVerifying(request(root, 'set-1'), { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  const setDir = join(root, 'backups', 'set-1');
  const manifestPath = join(setDir, BACKUP_MANIFEST_NAME);
  if (process.platform !== 'win32') chmodSync(manifestPath, 0o600);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.schemaVersion = MIGRATION_VERSION - 2;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const verification = verifyBackupSet(setDir);
  assertEq(verification.ok, false, 'a set that describes itself two different ways does not verify');
  assert(verification.problems.some((p) => p.finding === 'SCHEMA_DISAGREEMENT'),
    `and the finding names the disagreement: ${JSON.stringify(verification.problems)}`);
  assertEq(verification.restorableUnderThisBuild, false, 'and nothing is claimed about restoring it');
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
  // ONE module starts a process, and it is the one that says so in its name. It holds exactly two spawns —
  // the runner that captures a child's output and the runner that binds a child's stdout to a file — and both
  // must run with no shell. The count is asserted so a third one cannot appear unnoticed.
  const runner = readRepo('src/ops/maintenance-cli-shared.ts');
  const spawns = [...runner.matchAll(/spawnSync\(/g)].length;
  assertEq(spawns, 2, 'exactly two spawns exist in the tranche: the capturing runner and the to-file runner');
  assert([...runner.matchAll(/shell: false/g)].length >= spawns, 'and every one of them runs with no shell');
});

// ---------------------------------------------------------------------------------------------------------
// The root wrapping key: required by what the SET holds, not by what the stack declares
// ---------------------------------------------------------------------------------------------------------
//
// THE PRODUCTION GAP THESE CLOSE, FOUND BY REHEARSING AN UPGRADE END TO END. `custodian_root_key` was
// required from the moment the stack declared it rather than from the moment an installation migrated onto a
// ring. A released v1.1.4 installation has neither a ring nor that file — so the one population that most
// needs a rollback set, the one about to be upgraded, was the one this command refused. The only way past it
// was to put something at that name, and a placeholder is worse than the absence: it restores an unusable
// artifact to the path the whole ring is sealed under.

function withRing(root: string): void {
  mkdirSync(join(root, 'sidecar-state', 'ring'), { recursive: true });
  writeFileSync(join(root, 'sidecar-state', 'ring', 'kek-ring.json'),
    '{"document":"catalog-authority.kek-ring","version":1}\n', 'utf8');
}

const WITHOUT_ROOT = REQUIRED_SECRET_FILES.filter((name) => name !== 'custodian_root_key');
const A_REAL_ROOT_KEY = 'b'.repeat(64);

test('a static-custody set with NO ring is complete without a root wrapping key', () => {
  const root = makeProject('legacy-no-root', { sidecar: true, secrets: WITHOUT_ROOT });
  const tools = fakeToolchain({ dumpText: fakeDumpText(MIGRATION_VERSION) });
  const outcome = runVerifiedCompleteBackup(
    request(root, 'legacy', { custodian: 'sidecar', sidecarState: 'sidecar-state' }),
    { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger },
  );
  assertEq(outcome.ok, true, `a v1.1.4-shaped installation can take a complete backup: ${JSON.stringify(outcome.failures)}`);
  assertEq(existsSync(join(root, 'backups', 'legacy', COMPONENT_ARTIFACT_NAMES.secrets, 'custodian_root_key')), false,
    'and the set does not invent a file the installation does not have');
  assertEq(outcome.verification.ok, true, 'the shipped verifier agrees');
});

test('a set whose keystore holds a RING is refused without the root key that seals it', () => {
  const root = makeProject('ring-no-root', { sidecar: true, secrets: WITHOUT_ROOT });
  withRing(root);
  const tools = fakeToolchain({ dumpText: fakeDumpText(MIGRATION_VERSION) });
  refuses(() => takeCompleteBackupWithoutVerifying(
    request(root, 'sealed-box', { custodian: 'sidecar', sidecarState: 'sidecar-state' }),
    { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger },
  ), 'sealed box with no key', 'a ring with no root key');
  assertEq(existsSync(join(root, 'backups', 'sealed-box')), false, 'and nothing was published');
});

test('a set whose keystore holds a ring is refused when the root artifact is NOT a key', () => {
  const root = makeProject('ring-placeholder-root', { sidecar: true });
  withRing(root);
  // `makeProject` writes `custodian_root_key-value` at that name: the shape of a placeholder, which is
  // exactly what a fixture or a hurried operator leaves there.
  const tools = fakeToolchain({ dumpText: fakeDumpText(MIGRATION_VERSION) });
  refuses(() => takeCompleteBackupWithoutVerifying(
    request(root, 'not-a-key', { custodian: 'sidecar', sidecarState: 'sidecar-state' }),
    { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger },
  ), 'is not a root wrapping key', 'a placeholder where the root key belongs');
  assertEq(existsSync(join(root, 'backups', 'not-a-key')), false, 'and nothing was published');
});

test('a ring plus a real root wrapping key is a complete set', () => {
  const root = makeProject('ring-with-root', { sidecar: true });
  withRing(root);
  writeFileSync(join(root, 'secrets', 'custodian_root_key'), `${A_REAL_ROOT_KEY}\n`, 'utf8');
  const tools = fakeToolchain({ dumpText: fakeDumpText(MIGRATION_VERSION) });
  const outcome = runVerifiedCompleteBackup(
    request(root, 'migrated', { custodian: 'sidecar', sidecarState: 'sidecar-state' }),
    { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger },
  );
  assertEq(outcome.ok, true, `a migrated installation still verifies: ${JSON.stringify(outcome.failures)}`);
  assertEq(readFileSync(join(root, 'backups', 'migrated', COMPONENT_ARTIFACT_NAMES.secrets, 'custodian_root_key'), 'utf8'),
    `${A_REAL_ROOT_KEY}\n`, 'and the key it is sealed under is in the set');
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
