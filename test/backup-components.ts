import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertBackupCoverage,
  BACKUP_COMPONENT_IDS,
  BACKUP_EXCLUSIONS,
  BACKUP_SUMMARY,
  BackupCoverageError,
  backupComponent,
  backupComponents,
  coverageForTarget,
  reportBackupCoverage,
  stripHostVariablePrefix,
  type BackupComponentId,
} from '../src/ops/backup-components.js';
import { firstRunChecklist, troubleshootingTable } from '../src/ops/operator-ui-first-run-checklist.js';

// Phase 256 — what a complete backup of this installation actually is.
//
// THE DEFECT, precisely. The `back-up` step on the operator page said: dump the database, copy `./secrets/`.
// The custodian keystore — the wrapped data-encryption keys — was not mentioned. It lives on its own volume
// so that a database dump is never also a key backup, which is a good decision and is exactly why it has to
// be backed up deliberately. An operator who followed the instruction to the letter ended up with a backup
// that restores into a service which starts, passes every check, and cannot decrypt one item.
//
// The lifecycle document mentioned it in one section and omitted it from its own upgrade checklist four
// paragraphs later. Two surfaces, three answers, and the one on screen was the wrong one.
//
// WHAT IS PROVED HERE. Not "somebody wrote a better sentence" — that is what was true before, for a while.
// The check is structural: every mount in every shipped stack is walked, and a container path that no backup
// component claims and no stated exclusion explains is a hard failure. A stack that gains persistent state
// and does not say what a backup does about it cannot pass.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function assertThrows(fn: () => unknown, match: RegExp, msg: string): void {
  try { fn(); } catch (err) {
    const text = (err as Error).message;
    if (!match.test(text)) throw new Error(`${msg}: threw, but with "${text}"`);
    return;
  }
  throw new Error(`${msg}: did not throw`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

const SHIPPED_STACKS = [
  'docker-compose.runtime.yml',
  'docker-compose.arcane.yml',
  'docker-compose.unraid.yml',
  'docker-compose.unraid.runtime.yml',
] as const;

console.log('Running Phase 256 complete-backup component suite:\n');

// ---------------------------------------------------------------------------------------------------------
// The finding itself
// ---------------------------------------------------------------------------------------------------------

test('the keystore is a backup component, which is the omission this phase exists to fix', () => {
  const ids = backupComponents().map((component) => component.id);
  assert(ids.includes('keystore'), 'the keystore is in the list');
  const keystore = backupComponent('keystore');
  assertEq(keystore.regenerable, false, 'and it cannot be regenerated');
  // The consequence has to be stated as a consequence. "Back up the keystore too" does not tell anybody why
  // it matters more than the other three, and it matters differently: it fails SILENTLY.
  assert(/nothing in it can be decrypted/i.test(keystore.lostWithout), 'the consequence names the actual failure');
  assert(/start|healthy|checks/i.test(keystore.lostWithout), 'and says that it looks fine while being broken');
  // Both places the same material lives. Forgetting the sidecar one has the identical consequence.
  assert(/sidecar/i.test(keystore.what), 'and it names the sidecar location as well as the volume');
});

test('the operator-facing checklist step names all four components, not two', () => {
  const step = firstRunChecklist().find((entry) => entry.id === 'back-up');
  assert(step !== undefined, 'the back-up step still exists');
  // The regression under test: the step used to enumerate a CLOSED list of two.
  assert(!/two things/i.test(step!.why), 'it no longer claims there are two things');
  assert(/keystore/i.test(step!.why), 'and it names the keystore');
  for (const word of ['database', 'keystore', 'secret', 'promotion record']) {
    assert(step!.why.toLowerCase().includes(word), `the step mentions the ${word} component`);
  }
  assertEq(step!.why.includes(BACKUP_SUMMARY), true, 'because it renders the shared summary rather than its own prose');
});

test('the summary sentence is the one place the list is written down', () => {
  for (const word of ['database', 'keystore', 'secret', 'promotion record']) {
    assert(BACKUP_SUMMARY.toLowerCase().includes(word), `the summary names ${word}`);
  }
  assert(/four/i.test(BACKUP_SUMMARY), 'and says how many there are');
  assert(/quietly|silent/i.test(BACKUP_SUMMARY), 'and singles out the one that fails without a symptom');
});

test('there is a troubleshooting entry for the failure the old instructions produced', () => {
  const entry = troubleshootingTable().find((row) => row.id === 'restored-but-nothing-decrypts');
  assert(entry !== undefined, 'the entry exists');
  assert(/keystore/i.test(entry!.likelyCause), 'the cause names the keystore');
  // It must not promise a recovery that does not exist.
  assert(/cannot regenerate|gone/i.test(entry!.fix), 'and the fix admits that lost keys are lost');
  assert(!/reinstall|delete the volume|start again/i.test(entry!.fix), 'and never suggests a destructive fix');
});

// ---------------------------------------------------------------------------------------------------------
// Coverage against the shipped stacks — the anti-regression
// ---------------------------------------------------------------------------------------------------------

for (const stack of SHIPPED_STACKS) {
  test(`${stack}: every persistent mount is claimed by a component or explained by an exclusion`, () => {
    const report = assertBackupCoverage(stack, read(stack));
    assertEq(report.uncovered.length, 0, 'nothing is undecided');
    assert(report.covered.length > 0, 'and something was actually inspected');
  });
}

test('every shipped stack that keeps key material declares the keystore component', () => {
  for (const stack of SHIPPED_STACKS) {
    const report = reportBackupCoverage(stack, read(stack));
    assert(report.components.includes('keystore'), `${stack} needs the keystore backed up`);
    assert(report.components.includes('secrets'), `${stack} needs the secret files backed up`);
  }
});

test('the launcher stack routes its sidecar state to the keystore component, not to nothing', () => {
  const report = reportBackupCoverage('docker-compose.unraid.runtime.yml', read('docker-compose.unraid.runtime.yml'));
  const sidecarState = report.covered.filter((entry) => entry.target === '/var/lib/catalog-sidecar/state');
  assert(sidecarState.length > 0, 'the sidecar state directory is mounted and was seen');
  for (const entry of sidecarState) {
    assertEq(entry.coverage.kind, 'component', 'it is a component, not an exclusion');
    assertEq(entry.coverage.kind === 'component' ? entry.coverage.component : null, 'keystore',
      'and the component is the keystore, because it is the same material');
  }
});

test('the exclusions are reasons, not a silence', () => {
  const ids = Object.keys(BACKUP_EXCLUSIONS);
  assert(ids.length > 0, 'there are exclusions');
  for (const [id, reason] of Object.entries(BACKUP_EXCLUSIONS)) {
    assert(reason.length > 60, `the reason for ${id} is an argument rather than a label`);
    assert(!/probably|should be|likely/i.test(reason), `the reason for ${id} does not hedge`);
  }
  // Both exclusions are actually used by a shipped stack; an unused exclusion is a claim nobody checks.
  const used = new Set<string>();
  for (const stack of SHIPPED_STACKS) {
    for (const entry of reportBackupCoverage(stack, read(stack)).covered) {
      if (entry.coverage.kind === 'excluded') used.add(entry.coverage.exclusion);
    }
  }
  for (const id of ids) assert(used.has(id), `the ${id} exclusion is used by a shipped stack`);
});

// The point of the whole module: a stack that grows persistent state nobody decided about must FAIL.
test('a stack that mounts new persistent state fails coverage, naming the path', () => {
  const stack = [
    'services:',
    '  app:',
    '    image: example',
    '    volumes:',
    '      - ./cache:/var/lib/catalog/new-durable-thing',
  ].join('\n');
  assertThrows(() => assertBackupCoverage('synthetic', stack), /new-durable-thing/,
    'the uncovered path is named in the refusal');
  assertThrows(() => assertBackupCoverage('synthetic', stack), /CONTAINER_PATH_COVERAGE/,
    'and the refusal says what to do about it');
});

test('every uncovered path is reported, not just the first', () => {
  const stack = [
    'services:',
    '  app:',
    '    volumes:',
    '      - ./a:/var/lib/catalog/one',
    '      - ./b:/var/lib/catalog/two',
    '  other:',
    '    volumes:',
    '      - ./c:/var/lib/catalog/three',
  ].join('\n');
  const report = reportBackupCoverage('synthetic', stack);
  assertEq(report.uncovered.length, 3, 'all three are reported in one run');
  assertEq(report.uncovered.map((finding) => finding.service).join(','), 'app,app,other', 'each names its service');
});

test('long-syntax mounts are inspected too, so switching notation cannot silence the check', () => {
  const stack = [
    'services:',
    '  app:',
    '    volumes:',
    '      - type: bind',
    '        source: ./state',
    '        target: /var/lib/catalog/long-syntax-thing',
  ].join('\n');
  assertThrows(() => assertBackupCoverage('synthetic', stack), /long-syntax-thing/,
    'a long-syntax mount is still checked');
});

// An anonymous volume (`- /var/lib/x`, no colon, no host side) is still persistent state. It must reach the
// coverage decision as the container path it is, rather than making the mount parser throw — a parse error
// would replace a refusal that says what to do with one that does not.
test('an anonymous volume is checked as the container path it is', () => {
  const unknown = ['services:', '  app:', '    volumes:', '      - /var/lib/catalog/anonymous-state'].join('\n');
  assertThrows(() => assertBackupCoverage('synthetic', unknown), /anonymous-state/, 'it is named in the refusal');
  assertThrows(() => assertBackupCoverage('synthetic', unknown), /CONTAINER_PATH_COVERAGE/, 'with the guidance');
  const known = ['services:', '  app:', '    volumes:', '      - /var/lib/catalog/keystore'].join('\n');
  assertEq(reportBackupCoverage('synthetic', known).components.join(','), 'keystore',
    'and a known one is covered the same as any other');
});

test('a mount with no target at all is a refusal, not an assumption', () => {
  const stack = ['services:', '  app:', '    volumes:', '      - type: bind', '        source: ./state'].join('\n');
  assertThrows(() => assertBackupCoverage('synthetic', stack), /no string target/, 'it refuses rather than skipping');
});

test('coverage is decided by the CONTAINER path, so a host path nobody shares cannot change the answer', () => {
  // The same container target behind three completely different host sources, including an unexpanded
  // variable and an absolute Unraid-shaped path. All three answer identically.
  for (const source of ['./keystore', '${CATALOG_AUTHORITY_APPDATA_DIR:-/somewhere/else}/keystore', '/opt/x/keystore']) {
    const stack = ['services:', '  app:', '    volumes:', `      - ${source}:/var/lib/catalog/keystore`].join('\n');
    const report = reportBackupCoverage('synthetic', stack);
    assertEq(report.uncovered.length, 0, `${source} is covered`);
    assertEq(report.components.join(','), 'keystore', 'and by the keystore component');
  }
});

// The Unraid stacks mount the backups directory twice: once at /backups and once at its own host path, so a
// command running in the container can be handed a host-shaped path. Both spellings are the same place, and a
// coverage decision that depended on which notation was used would be an accident waiting to happen.
test('a target written with a host variable in front resolves to the same decision as the plain one', () => {
  const plain = coverageForTarget('/backups');
  const prefixed = coverageForTarget('${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/backups');
  assertEq(plain?.kind, 'excluded', '/backups is the backup destination');
  assertEq(JSON.stringify(prefixed), JSON.stringify(plain), 'and so is the host-path spelling of it');
});

test('the normalisation strips one leading expansion and does not go looking for others', () => {
  // A variable in the MIDDLE is not a spelling of a known path; it is a path nobody decided about.
  assertEq(coverageForTarget('/var/lib/${SOMETHING}/keystore'), null, 'an interior variable stays undecided');
  assertEq(coverageForTarget('${A}${B}/backups'), null, 'and a second leading expansion is not chased');
  assertEq(stripHostVariablePrefix('/backups'), '/backups', 'a plain path is unchanged');
  assertEq(stripHostVariablePrefix('${X:-/a/b}/backups'), '/backups', 'and one leading expansion is removed');
});

test('a read-only option does not change what a mount is', () => {
  const stack = ['services:', '  app:', '    volumes:',
    '      - ./promotion-records:/var/lib/catalog/promotion-records:ro'].join('\n');
  const report = reportBackupCoverage('synthetic', stack);
  assertEq(report.components.join(','), 'promotion-records', 'a :ro records mount is still the records component');
});

test('declared Compose secrets are covered even though they appear in no mount list', () => {
  const stack = ['services:', '  app:', '    secrets:', '      - custodian_kek', '      - completion_secret'].join('\n');
  const report = reportBackupCoverage('synthetic', stack);
  assertEq(report.uncovered.length, 0, 'nothing is undecided');
  assertEq(report.components.join(','), 'secrets', 'and they are the secrets component');
  assertEq(report.covered.length, 2, 'both are accounted for individually');
});

test('coverageForTarget answers null for a path nobody decided about, never a default', () => {
  assertEq(coverageForTarget('/var/lib/catalog/anything-new'), null, 'an unknown path is undecided');
  assertEq(coverageForTarget('/'), null, 'and so is the root');
  const kek = coverageForTarget('/run/secrets/custodian_kek');
  assertEq(kek?.kind === 'component' ? kek.component : null, 'secrets', 'a docker secret is the secrets component');
});

// ---------------------------------------------------------------------------------------------------------
// What the commands may contain
// ---------------------------------------------------------------------------------------------------------

test('no command names any particular machine: no absolute host path, address or library', () => {
  for (const component of backupComponents()) {
    for (const [label, command] of [
      ['backup posix', component.backup.posix], ['backup windows', component.backup.windows],
      ['restore posix', component.restore.posix], ['restore windows', component.restore.windows],
    ] as const) {
      const where = `${component.id} ${label}`;
      // A container path is fine and necessary — it is fixed by this project and is the same everywhere.
      // A HOST path is not: it is somebody's filesystem layout.
      assert(!/\/mnt\/user/.test(command), `${where} does not name an Unraid share`);
      assert(!/\/home\/|\/Users\/|\/root\//.test(command), `${where} does not name a home directory`);
      assert(!/[A-Za-z]:\\(?!\\)(?!\.)[A-Za-z]/.test(command), `${where} does not name a Windows drive path`);
      assert(!/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(command), `${where} contains no IP address`);
      assert(!/https?:\/\//.test(command), `${where} contains no URL`);
      assert(command.trim() !== '', `${where} is not empty`);
    }
  }
});

test('every command is one an operator with only Docker can run', () => {
  for (const component of backupComponents()) {
    for (const command of [component.backup.posix, component.backup.windows,
      component.restore.posix, component.restore.windows]) {
      // No `npm run`, no `npx`, no node. The audience for this panel installed a release bundle and has no
      // toolchain, which is the whole premise of v1.1.1 onwards.
      assert(!/\bnpm\b|\bnpx\b|\bnode\b/.test(command), `${component.id} does not require a Node toolchain: ${command}`);
    }
  }
});

// Found by rendering the panel and reading the commands as a Windows operator would run them.
//
// In Windows PowerShell `>` is `Out-File`, which re-encodes a native command's output as UTF-16LE — so
// `pg_dump > file.sql` produces a dump `psql` cannot read, silently. And `<` is a RESERVED operator with no
// implementation: `psql … < file.sql` is a parse error, not a command. A documented command that cannot run,
// or that quietly corrupts the one artifact a rollback depends on, is worse than no command.
test('no Windows command uses a PowerShell redirection that corrupts or does not exist', () => {
  const windowsCommands = [
    ...backupComponents().flatMap((component) => [component.backup.windows, component.restore.windows]),
    ...firstRunChecklist().flatMap((step) => (step.commands === null ? [] : [step.commands.windows])),
    ...troubleshootingTable().flatMap((entry) => (entry.commands === null ? [] : [entry.commands.windows])),
  ];
  for (const command of windowsCommands) {
    // Redirection is allowed only inside a `cmd /c "…"` string, where it is byte-faithful.
    const outsideCmd = command.startsWith('cmd /c ') ? '' : command;
    assert(!/[^-]>/.test(outsideCmd), `a bare > in a PowerShell command re-encodes as UTF-16: ${command}`);
    assert(!/</.test(outsideCmd), `PowerShell has no input redirection at all: ${command}`);
  }
});

test('the database commands really are the cmd-wrapped ones on Windows and plain on POSIX', () => {
  const database = backupComponent('database');
  for (const command of [database.backup.windows, database.restore.windows]) {
    assert(command.startsWith('cmd /c "') && command.endsWith('"'), `it is one cmd /c invocation: ${command}`);
  }
  for (const command of [database.backup.posix, database.restore.posix]) {
    assert(!command.includes('cmd /c'), `POSIX needs no such wrapper: ${command}`);
  }
  assert(/UTF-16/.test(database.caveat), 'and the caveat says why, rather than leaving it as a curiosity');
});

test('the Windows and POSIX forms differ only where they have to', () => {
  for (const component of backupComponents()) {
    // Where they differ, the difference must be real — a Windows form identical but for a stray character is
    // how a copy-paste error ships.
    // Either genuinely PowerShell, or a deliberate `cmd /c` wrapper where PowerShell's redirection cannot be
    // used at all. A form that differs from POSIX in neither of those ways is a typo.
    const deliberate = (command: string): boolean => /\\|Copy-Item|Get-Content/.test(command) || command.startsWith('cmd /c "');
    if (component.backup.posix !== component.backup.windows) {
      assert(deliberate(component.backup.windows), `${component.id}'s Windows backup form differs on purpose`);
    }
    if (component.restore.posix !== component.restore.windows) {
      assert(deliberate(component.restore.windows), `${component.id}'s Windows restore form differs on purpose`);
    }
  }
});

// A defect found by reviewing the commands as commands rather than as prose: `docker compose down` REMOVES
// the containers, and `docker compose cp` needs one to copy into. "Down, then cp" fails with "no container
// found", at the one moment an operator has no appetite for debugging a documented command.
test('no command removes the container that a later part of the same command needs', () => {
  const all = [
    ...backupComponents().flatMap((component) => [
      component.backup.posix, component.backup.windows, component.restore.posix, component.restore.windows]),
    ...troubleshootingTable().flatMap((entry) => (entry.commands === null ? [] : [entry.commands.posix, entry.commands.windows])),
    ...firstRunChecklist().flatMap((step) => (step.commands === null ? [] : [step.commands.posix, step.commands.windows])),
  ];
  for (const command of all) {
    if (!/compose\s+cp\b/.test(command)) continue;
    assert(!/compose\s+down\b/.test(command),
      `a compose cp is preceded by a compose down, which removes the container it needs: ${command}`);
    assert(/compose\s+stop\b/.test(command) || !/compose\s+(?:stop|down)\b/.test(command),
      `a compose cp that stops anything must use stop, not down: ${command}`);
  }
});

test('the keystore restore stops and restarts the container it copies into', () => {
  const restore = backupComponent('keystore').restore;
  for (const command of [restore.posix, restore.windows]) {
    assert(/compose\s+stop\s+app/.test(command), `it stops the app first: ${command}`);
    assert(/compose\s+cp\b/.test(command), 'then copies');
    assert(/compose\s+start\s+app/.test(command), 'then starts it again');
    assert(command.indexOf('stop') < command.indexOf('cp'), 'in that order');
    assert(command.indexOf('cp') < command.indexOf('start'), 'and the start comes last');
  }
  // The container has to exist at all, which is not obvious on a machine where the stack never started.
  assert(/compose create app/.test(backupComponent('keystore').caveat),
    'and the caveat says what to do when there is no container yet');
});

test('every component states a caveat, and none of them is a reassurance', () => {
  for (const component of backupComponents()) {
    assert(component.caveat.length > 40, `${component.id} has a real caveat`);
    assert(!/^(?:none|nothing|n\/a|no caveat)\.?$/i.test(component.caveat), `${component.id}'s caveat is not "none"`);
  }
  // The database restore is the one that most invites a wrong assumption, so it must say what it needs.
  assert(/EMPTY|empty database/i.test(backupComponent('database').caveat),
    'the database caveat says a restore needs an empty database');
});

// Every string here is rendered into the served page, which the Phase 147 boundary check scans for a fixed
// vocabulary this product must never appear to do. Asserted in THIS suite as well, so an edit to the model is
// caught by the model's own tests rather than by a failure three suites away.
test('nothing the model renders uses the vocabulary the served page is forbidden', () => {
  const rendered = [
    BACKUP_SUMMARY,
    ...backupComponents().flatMap((component) => [
      component.title, component.what, component.lostWithout, component.caveat,
      component.backup.posix, component.backup.windows, component.restore.posix, component.restore.windows,
    ]),
  ].join(' ');
  for (const forbidden of ['postgresql://', 'CUSTODIAN_KEK', 'COMPLETION_SECRET', 'providerRef', 'rawPayload',
    'playback', 'download']) {
    assert(!rendered.includes(forbidden), `the model does not use "${forbidden}"`);
  }
});

test('the component ids are a closed, ordered list with no duplicates', () => {
  const ids = backupComponents().map((component) => component.id);
  assertEq(ids.join(','), BACKUP_COMPONENT_IDS.join(','), 'the exported order matches the components');
  assertEq(new Set(ids).size, ids.length, 'no id appears twice');
  // Order is a claim: the two that fail hardest come first.
  assertEq(ids[0], 'database' as BackupComponentId, 'the database is first');
  assertEq(ids[1], 'keystore' as BackupComponentId, 'and the keystore second, because it is the forgotten one');
});

// ---------------------------------------------------------------------------------------------------------
// One model, every surface
// ---------------------------------------------------------------------------------------------------------

test('the operator page renders the panel from the model rather than repeating it', () => {
  const service = read('src/ops/operator-ui-service.ts');
  assert(service.includes("from './backup-components.js'"), 'the page imports the model');
  assert(service.includes('renderBackupComponents(backupComponents())'), 'and renders the real list');
  assert(service.includes('id="backup-panel"'), 'the panel exists');
  assert(service.includes('href="#backup-panel"'), 'and the nav links to it');
  // Nothing is retyped: the panel must not contain a hard-coded command.
  assert(!/pg_dump/.test(service.replace(/^import[\s\S]*?from '\.\/backup-components\.js';/m, '')),
    'the page does not carry its own copy of a backup command');
});

test('the checklist renders from the model too, so the step and the panel cannot disagree', () => {
  const checklist = read('src/ops/operator-ui-first-run-checklist.ts');
  assert(checklist.includes("from './backup-components.js'"), 'the checklist imports the model');
  const step = firstRunChecklist().find((entry) => entry.id === 'back-up')!;
  assertEq(step.commands?.posix, backupComponent('database').backup.posix, 'the step shows the model command');
  assertEq(step.commands?.windows, backupComponent('database').backup.windows, 'on both platforms');
});

test('the lifecycle document lists four components and no longer claims two', () => {
  const doc = read('docs/LIFECYCLE_MIGRATION_BACKUP_UPGRADE_ROLLBACK.md');
  assert(/complete backup is four things/i.test(doc), 'the backup section says four');
  assert(!/Two things cannot be regenerated/i.test(doc), 'the old two-item claim is gone');
  // The internal contradiction that made this findable: the upgrade checklist said something different from
  // the backup section three headings above it.
  assert(!/\*\*Back up\.\*\* Database dump and `\.\/secrets\/`\./.test(doc),
    'the upgrade checklist no longer contradicts the backup section');
  assert(/Back up all four components/i.test(doc), 'and now agrees with it');
  assert(/keystore/i.test(doc.split('## Rollback')[1] ?? ''), 'the rollback sequence names the keystore too');
});

test('there is a restore step, and it says the dump and the keystore must match', () => {
  const step = firstRunChecklist().find((entry) => entry.id === 'restore');
  assert(step !== undefined, 'a restore step exists');
  assertEq(step!.firstRun, false, 'it is a lifecycle step, not a first-run one');
  assert(/SAME backup/i.test(step!.why), 'and it says the two must come from the same backup');
});

test('nothing in this phase adds a route, a write or a mutation', () => {
  const model = read('src/ops/backup-components.ts');
  for (const [pattern, what] of [
    [/writeFileSync|rmSync|unlinkSync|mkdirSync/, 'a filesystem write'],
    [/createServer|fetch\(|http/, 'a network call'],
    [/exec\(|spawn|execSync/, 'a child process'],
  ] as const) {
    assert(!pattern.test(model), `the model performs ${what}`);
  }
  // It reads Compose text it is HANDED. It never chooses a file itself.
  assert(!/readFileSync/.test(model), 'and it never reads a file of its own choosing');
});

// A suite nothing runs is a suite that stops being true. CI runs a named per-phase script rather than the
// aggregate `test` script, so a new suite that is not wired in is ungated however green it is locally.
test('this suite is a required CI gate, not only a local script', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:phase256-local'], 'tsx test/backup-components.ts', 'the phase has its own CI script');
  const workflow = read('.github/workflows/runtime-image.yml');
  // In the `suites` job — the one that gates on typecheck and the phase suites — not somewhere optional.
  const suites = workflow.split('name: Build and smoke')[0] ?? '';
  assert(suites.includes('npm run test:phase256-local'), 'and the suites job runs it');
});

test('the coverage error is a typed refusal a caller can distinguish', () => {
  try {
    assertBackupCoverage('synthetic', 'services:\n  app:\n    volumes:\n      - ./x:/var/lib/catalog/unknown');
    throw new Error('did not throw');
  } catch (err) {
    assert(err instanceof BackupCoverageError, 'it is the module\'s own error type');
    assertEq((err as BackupCoverageError).code, 'BACKUP_COVERAGE_REJECTED', 'with a stable code');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`\nFAILED: ${name}\n${(err as Error).stack ?? String(err)}`);
process.exit(failed === 0 ? 0 : 1);
