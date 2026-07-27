import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeRun, removeQuietly, runScript, usableBash } from '../src/ops/usable-shell.js';
import {
  ARCANE_BIND_ADDRESS_ENV,
  ARCANE_PROJECT_DIR_ENV,
  ARCANE_REQUIRED_SECRET_FILES,
  ARCANE_REQUIRED_SUBDIRECTORIES,
  checkArcaneInstall,
  collectArcaneFilesystemFacts,
  deriveArcaneInstallReadiness,
  inspectArcaneBindAddress,
  inspectArcaneProjectDir,
  type ArcaneFilesystemFacts,
  type ArcaneFindingCode,
} from '../src/ops/arcane-install.js';
import { asMap, parseYaml, service, stringList, yamlStrings, type YamlMap } from './helpers/compose-yaml.js';

// Phase 253 — the Arcane/Unraid install path, adversarially.
//
// THE DEFECT, on a real machine. Arcane runs in a container and stores a Compose project inside it, under
// `/app/data/projects/<name>`. Docker resolves a relative bind source against the project directory, and the
// daemon is on the Unraid HOST — so `./secrets/postgres_password` became a path that exists in Arcane's
// filesystem and nowhere the daemon can see. The stack refused to start, naming a path the operator had
// never typed.
//
// The ways a fix for that could be fake are what this file is about:
//
//   * a "required" variable that quietly has a default, so a wrong install starts anyway
//   * a preflight that passes on a path only Arcane can see
//   * a check that accepts a hostname, or 0.0.0.0, as a deliberate bind address
//   * loopback advertised as though it were reachable from the network
//   * this particular machine's path or address baked in as a constant
//   * the ordinary-computer stack quietly changed to suit Unraid

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const compose = (rel: string): YamlMap => asMap(parseYaml(read(rel)), rel);

/**
 * A filesystem path in the spelling the shell that will receive it uses.
 *
 * Only ever different on Windows, where the test harness's temporary directory is `C:\a\b` and the Git Bash
 * that runs the shipped script sees `/c/a/b`. The script itself is unchanged and still refuses a Windows
 * path: the variable it validates names a path on the Unraid host, which is Linux.
 */
function toShellPath(path: string): string {
  const drive = /^([A-Za-z]):[\\/]/.exec(path);
  if (drive === null) return path;
  return `/${drive[1]!.toLowerCase()}/${path.slice(3).split('\\').join('/')}`;
}

/** The one code a caller cares about, or the list, so a failure message names what actually came back. */
function codes(findings: readonly { code: ArcaneFindingCode }[]): string {
  return findings.map((f) => f.code).join(',');
}

console.log('Running Phase 253 Arcane install suite:\n');

// ---------------------------------------------------------------------------------------------------------
// The project directory: every way it can be the wrong kind of path.
// ---------------------------------------------------------------------------------------------------------

await test('an unset project directory is a blocker, never a default', () => {
  for (const value of [undefined, '', '   ']) {
    assertEq(codes(inspectArcaneProjectDir(value)), 'PROJECT_DIR_UNSET',
      `${JSON.stringify(value)} is refused rather than substituted`);
  }
});

await test('a path only the launcher can see is recognised as exactly that', () => {
  // The real failure. `/app/data/projects/...` is Arcane's own container filesystem; the daemon cannot see it,
  // and a bind source written that way fails with an error naming a path the operator never typed.
  for (const value of ['/app/data', '/app/data/projects/catalog-authority-v110-test']) {
    assertEq(codes(inspectArcaneProjectDir(value)), 'PROJECT_DIR_LOOKS_CONTAINER_INTERNAL',
      `${value} is named as a container-internal path`);
  }
  const finding = inspectArcaneProjectDir('/app/data/projects/x')[0]!;
  assert(/PROJECTS_DIRECTORY/.test(finding.fix), 'and the fix offers the path-matching option Arcane recommends');
  assert(/host path/i.test(finding.fix), 'as well as naming the host path directly');
});

await test('a relative, Windows or traversing path is refused with the reason it is wrong', () => {
  const cases: ReadonlyArray<readonly [string, ArcaneFindingCode]> = [
    ['mnt/user/projects/x', 'PROJECT_DIR_NOT_ABSOLUTE'],
    ['./projects/x', 'PROJECT_DIR_NOT_ABSOLUTE'],
    ['C:\\projects\\x', 'PROJECT_DIR_NOT_POSIX'],
    ['/mnt/user\\projects', 'PROJECT_DIR_NOT_POSIX'],
    ['/mnt/user/../../etc', 'PROJECT_DIR_TRAVERSAL'],
    ['/mnt/user/./x', 'PROJECT_DIR_TRAVERSAL'],
    ['/mnt//user/x', 'PROJECT_DIR_TRAVERSAL'],
    [`/${'a'.repeat(600)}`, 'PROJECT_DIR_TOO_LONG'],
  ];
  for (const [value, expected] of cases) {
    assertEq(codes(inspectArcaneProjectDir(value)), expected, `${value} is refused as ${expected}`);
  }
});

await test('an ordinary absolute host path passes, and a trailing slash is not a reason to refuse one', () => {
  for (const value of ['/mnt/user/projects/catalog-authority', '/mnt/user/projects/catalog-authority/', '/srv/x']) {
    assertEq(codes(inspectArcaneProjectDir(value)), '', `${value} is accepted`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The filesystem: a sound path that is not actually there, or is not set up.
// ---------------------------------------------------------------------------------------------------------

const fullFacts = (overrides: Partial<ArcaneFilesystemFacts> = {}): ArcaneFilesystemFacts => ({
  projectDir: 'OK',
  subdirectories: Object.fromEntries(ARCANE_REQUIRED_SUBDIRECTORIES.map((n) => [n, true])),
  secretFiles: Object.fromEntries(ARCANE_REQUIRED_SECRET_FILES.map((n) => [n, true])),
  ...overrides,
});

const soundInput = {
  projectDir: '/mnt/user/projects/catalog-authority',
  bindAddress: '192.0.2.10',
  hostPort: '8099',
};

await test('a well-formed path that is not on this machine is a blocker, with the fix being to create it', () => {
  for (const [state, expected] of [
    ['MISSING', 'PROJECT_DIR_MISSING'],
    ['NOT_A_DIRECTORY', 'PROJECT_DIR_NOT_A_DIRECTORY'],
    ['UNREADABLE', 'PROJECT_DIR_UNREADABLE'],
  ] as const) {
    const result = deriveArcaneInstallReadiness({ ...soundInput, filesystem: fullFacts({ projectDir: state }) });
    assertEq(codes(result.findings), expected, `a ${state} project directory is ${expected}`);
    assert(!result.ok, 'and blocks the install');
  }
});

await test('a missing secret file blocks, because Docker turns that into a confusing failure rather than a loud one', () => {
  const result = deriveArcaneInstallReadiness({
    ...soundInput,
    filesystem: fullFacts({ secretFiles: { ...fullFacts().secretFiles, operator_ui_token: false } }),
  });
  assertEq(codes(result.findings), 'SECRET_FILE_MISSING', 'a missing secret is caught before Docker sees it');
  assert(/DIRECTORY/.test(result.findings[0]!.fix),
    'and the reason names what Docker actually does with a missing bind source');
});

await test('a missing records or secrets folder blocks', () => {
  for (const name of ARCANE_REQUIRED_SUBDIRECTORIES) {
    const result = deriveArcaneInstallReadiness({
      ...soundInput,
      filesystem: fullFacts({ subdirectories: { ...fullFacts().subdirectories, [name]: false } }),
    });
    assertEq(codes(result.findings), 'SUBDIRECTORY_MISSING', `a missing ${name}/ blocks`);
  }
});

await test('a malformed path is not ALSO reported as a missing directory', () => {
  // Reporting "the directory does not exist" about a path that is malformed sends an operator to create a
  // directory they should never create.
  const result = deriveArcaneInstallReadiness({
    ...soundInput,
    projectDir: '/app/data/projects/x',
    filesystem: fullFacts({ projectDir: 'MISSING' }),
  });
  assertEq(codes(result.findings), 'PROJECT_DIR_LOOKS_CONTAINER_INTERNAL',
    'the structural fault is reported alone, so the fix is unambiguous');
});

// ---------------------------------------------------------------------------------------------------------
// Networking: a deliberate, specific bind — not a wildcard, and not a false claim about loopback.
// ---------------------------------------------------------------------------------------------------------

await test('the bind address must be set, and a wildcard is refused rather than defaulted to', () => {
  assertEq(codes(inspectArcaneBindAddress(undefined)), 'BIND_ADDRESS_UNSET', 'unset is a blocker');
  for (const wildcard of ['0.0.0.0', '::', '*']) {
    assertEq(codes(inspectArcaneBindAddress(wildcard)), 'BIND_ADDRESS_WILDCARD',
      `${wildcard} is refused: publishing an operator interface on every interface is a decision, not a default`);
  }
});

await test('a hostname is not an address, because a name can move where this UI is reachable from', () => {
  for (const name of ['tower', 'tower.local', 'localhost', 'unraid.example.com']) {
    assertEq(codes(inspectArcaneBindAddress(name)), 'BIND_ADDRESS_NOT_AN_ADDRESS', `${name} is not an address`);
  }
});

await test('a specific LAN address passes with nothing to say', () => {
  for (const address of ['192.0.2.10', '10.1.2.3', '172.16.0.9', 'fd00::1']) {
    assertEq(codes(inspectArcaneBindAddress(address)), '', `${address} is a deliberate, specific bind`);
  }
});

await test('loopback is allowed, and is never described as remotely reachable', () => {
  for (const loopback of ['127.0.0.1', '127.0.1.1', '::1']) {
    const findings = inspectArcaneBindAddress(loopback);
    assertEq(codes(findings), 'BIND_ADDRESS_LOOPBACK_NOT_REMOTE', `${loopback} is advisory, not a blocker`);
    assertEq(findings[0]!.severity, 'ADVISORY', 'loopback is a safe choice, not an error');
  }
  const advisory = inspectArcaneBindAddress('127.0.0.1')[0]!;
  assert(/no other machine/i.test(advisory.detail), 'the advisory says it is the server and nothing else');
  assert(/NOT remotely reachable/i.test(advisory.fix),
    'and says outright that it is not remotely reachable, rather than leaving it to be discovered');
  assert(/tunnel/i.test(advisory.fix), 'while offering the way to reach it anyway');
  // An advisory must not block: a loopback install is a correct install.
  const result = deriveArcaneInstallReadiness({ ...soundInput, bindAddress: '127.0.0.1', filesystem: fullFacts() });
  assert(result.ok, 'a loopback-published install is not blocked');
});

await test('an unusable host port is refused, and an unset one falls to the Compose default', () => {
  const bad = deriveArcaneInstallReadiness({ ...soundInput, hostPort: '80', filesystem: fullFacts() });
  assertEq(codes(bad.findings), 'HOST_PORT_INVALID', 'a privileged port is refused');
  for (const value of ['not-a-port', '0', '70000']) {
    const result = deriveArcaneInstallReadiness({ ...soundInput, hostPort: value, filesystem: fullFacts() });
    assertEq(codes(result.findings), 'HOST_PORT_INVALID', `${value} is refused`);
  }
  const unset = deriveArcaneInstallReadiness({ ...soundInput, hostPort: undefined, filesystem: fullFacts() });
  assertEq(codes(unset.findings), '', 'an unset port is fine — Compose has a default for that one');
});

await test('a fully sound install reports ok, and still authorizes nothing', () => {
  const result = deriveArcaneInstallReadiness({ ...soundInput, filesystem: fullFacts() });
  assertEq(codes(result.findings), '', 'nothing to fix');
  assert(result.ok, 'and the install can proceed');
  assertEq(result.promotionAuthorization, 'NOT_IMPLIED', 'a startable stack is not an authorization');
  assert(/reads no promotion record/i.test(result.note), 'and the note says what it did not do');
  assert(/says nothing about whether any promotion may proceed/i.test(result.note), 'in as many words');
});

// ---------------------------------------------------------------------------------------------------------
// Against a real directory, so the collector is proven rather than described.
// ---------------------------------------------------------------------------------------------------------

await test('the collector reports a real directory truthfully, before and after it is set up', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'arcane-install-'));
  try {
    const project = join(workspace, 'catalog-authority');
    assertEq(collectArcaneFilesystemFacts(project).projectDir, 'MISSING', 'an absent directory is MISSING');

    mkdirSync(project);
    const bare = collectArcaneFilesystemFacts(project);
    assertEq(bare.projectDir, 'OK', 'a present directory is OK');
    assert(ARCANE_REQUIRED_SUBDIRECTORIES.every((n) => bare.subdirectories[n] === false),
      'and an empty one is honestly missing everything the stack binds');

    for (const name of ARCANE_REQUIRED_SUBDIRECTORIES) mkdirSync(join(project, name));
    for (const name of ARCANE_REQUIRED_SECRET_FILES) writeFileSync(join(project, 'secrets', name), 'x\n');
    const ready = collectArcaneFilesystemFacts(project);
    assert(ARCANE_REQUIRED_SUBDIRECTORIES.every((n) => ready.subdirectories[n] === true), 'then every folder is found');
    assert(ARCANE_REQUIRED_SECRET_FILES.every((n) => ready.secretFiles[n] === true), 'and every secret file');

    // A file where a directory belongs is not a directory, and is not silently accepted.
    const asFile = join(workspace, 'a-file');
    writeFileSync(asFile, 'x');
    assertEq(collectArcaneFilesystemFacts(asFile).projectDir, 'NOT_A_DIRECTORY', 'a file is not a project directory');

    // End to end through the environment, which is how the CLI reaches it.
    //
    // The variable names a path on the UNRAID HOST, which is Linux. So on a Windows developer machine the
    // temporary directory above is — correctly — not an acceptable value, and that is worth asserting rather
    // than working around: someone typing a Windows path into this variable has misunderstood what it is.
    const env = {
      [ARCANE_PROJECT_DIR_ENV]: project,
      [ARCANE_BIND_ADDRESS_ENV]: '192.0.2.10',
    } as NodeJS.ProcessEnv;
    const result = checkArcaneInstall(env);
    if (project.startsWith('/')) {
      assert(result.ok, `a fully prepared project passes the whole preflight (got ${codes(result.findings)})`);
    } else {
      assertEq(codes(result.findings), 'PROJECT_DIR_NOT_POSIX',
        'a Windows path is refused for a variable that names a path on a Linux host');
    }
    assert(!checkArcaneInstall({ ...env, [ARCANE_BIND_ADDRESS_ENV]: '0.0.0.0' }).ok,
      'and a wildcard bind still blocks it, however well the directory is set up');
  } finally {
    removeQuietly(workspace);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The shipped stack: required variables that really are required, and no machine's identity in the repo.
// ---------------------------------------------------------------------------------------------------------

await test('the Arcane stack refuses to run without its two required variables, rather than substituting one', () => {
  const raw = read('docker-compose.arcane.yml');
  // `${VAR:?msg}` is Compose's REFUSE form. `${VAR:-default}` would silently substitute, which is the whole
  // failure being prevented — a stack that starts against a directory nobody chose.
  assert(!/\$\{CATALOG_AUTHORITY_PROJECT_DIR:-/.test(raw),
    'the project directory has no default: a guessed one starts the wrong installation and looks fine');
  assert(!/\$\{OPERATOR_UI_BIND_ADDRESS:-/.test(raw),
    'and the bind address has no default: 0.0.0.0 would publish an operator interface on every interface');
  const required = raw.match(/\$\{CATALOG_AUTHORITY_PROJECT_DIR:\?/g) ?? [];
  assert(required.length >= 8, `every bind source demands the variable (found ${required.length})`);
  assert(/\$\{OPERATOR_UI_BIND_ADDRESS:\?/.test(raw), 'and so does the published port');
});

await test('every bind source in the Arcane stack is an absolute host path, never a relative one', () => {
  const doc = compose('docker-compose.arcane.yml');
  for (const [name, svc] of Object.entries(asMap(doc.services ?? null, 'services'))) {
    const parsed = asMap(svc, `service ${name}`);
    const volumes = parsed.volumes === undefined || parsed.volumes === null ? [] : stringList(parsed.volumes, `${name} volumes`);
    for (const entry of volumes) {
      assert(entry.startsWith('${CATALOG_AUTHORITY_PROJECT_DIR'),
        `${name} binds ${entry} from the declared host project directory, not from wherever Compose is standing`);
      assert(!entry.startsWith('./') && !entry.startsWith('../'),
        `${name} has no relative bind source — that is the exact shape that failed under Arcane`);
    }
  }
  for (const [name, entry] of Object.entries(asMap(doc.secrets ?? null, 'secrets'))) {
    const file = String(asMap(entry, `secret ${name}`).file ?? '');
    assert(file.startsWith('${CATALOG_AUTHORITY_PROJECT_DIR'), `secret ${name} is an absolute host path`);
  }
});

await test('the promotion records mount is read-only, and the database is not published, in the Arcane stack too', () => {
  const app = service(compose('docker-compose.arcane.yml'), 'app');
  const records = stringList(app.volumes ?? null, 'app volumes').filter((v) => v.includes('promotion-records'));
  assertEq(records.length, 1, 'exactly one records mount');
  assert(records[0]!.endsWith(':ro'), 'and it is read-only: the container can never write, rename or delete evidence');
  const postgres = service(compose('docker-compose.arcane.yml'), 'postgres');
  assert(postgres.ports === undefined, 'the database is not published to the host');
});

await test('no machine\'s path, address or hostname is baked into the shipped stack or the preflight', () => {
  // The install this remediation came from was on one specific server. None of it belongs in the product.
  const surfaces = ['docker-compose.arcane.yml', 'deploy/arcane-setup.sh', 'src/ops/arcane-install.ts',
    'src/ops/arcane-install-cli.ts'];
  for (const file of surfaces) {
    const text = read(file);
    assert(!/192\.168\.\d+\.\d+/.test(text), `${file} carries no LAN address`);
    assert(!/catalog-authority-v110-test/.test(text), `${file} carries no test project name`);
    assert(!/\bTower\b/.test(text), `${file} names no particular server`);
    assert(!/\/mnt\/user\/media\/Movies/.test(text), `${file} names no media library`);
  }
  // The example path in the documentation is a documented EXAMPLE, and is never a default in the stack.
  assert(!/CATALOG_AUTHORITY_PROJECT_DIR:-\/mnt/.test(read('docker-compose.arcane.yml')),
    'and no example path leaked into a default');
});

await test('the ordinary-computer release stack is left alone: still relative, still loopback, still one file', () => {
  const runtime = compose('docker-compose.runtime.yml');
  const app = service(runtime, 'app');
  const records = stringList(app.volumes ?? null, 'runtime app volumes').filter((v) => v.includes('promotion-records'));
  assertEq(records.length, 1, 'the runtime stack still mounts the records folder');
  assert(records[0]!.includes('${PROMOTION_RECORDS_HOST_DIR:-./promotion-records}'),
    'still relative by default, because on an ordinary computer Compose and the daemon share a filesystem');
  const ports = stringList(app.ports ?? null, 'runtime app ports');
  assertEq(ports.length, 1, 'one published port');
  assert(ports[0]!.startsWith('${OPERATOR_UI_BIND_ADDRESS:-127.0.0.1}'),
    'still loopback by default on an ordinary computer, where that IS the machine you are sitting at');
  // v1.1.2 CORRECTS this assertion. It used to require that the Arcane file never reach the consumer bundle
  // — "nothing about it reaches the bundle a normal user downloads" — which sounded like scope discipline and
  // was actually the defect: it pinned in place the fact that an Arcane user's archive contained no Arcane
  // path. What genuinely matters is that the ordinary-computer stack is UNCHANGED, which the assertions above
  // establish, and that `docker-compose.yml` in the bundle is still the ordinary runtime stack rather than
  // being replaced by the Arcane one. Shipping the Arcane pair ALONGSIDE it takes nothing away from anybody.
  const bundleSource = read('src/ops/consumer-release-bundle.ts');
  assert(bundleSource.includes("toFile('docker-compose.yml', sources.runtimeCompose)"),
    'the bundle\'s docker-compose.yml is still the ordinary-computer runtime stack');
  assert(bundleSource.includes("toFile('docker-compose.arcane.yml', sources.arcaneCompose)"),
    'and the Arcane stack ships alongside it, so a launcher user gets the path the documentation names');
});

await test('the setup script and the preflight agree about what a project directory must contain', () => {
  const setup = read('deploy/arcane-setup.sh');
  for (const name of ARCANE_REQUIRED_SUBDIRECTORIES) {
    assert(setup.includes(name), `the setup script creates ${name}/`);
  }
  for (const name of ARCANE_REQUIRED_SECRET_FILES) {
    assert(setup.includes(name), `the setup script writes ${name}`);
  }
  // A setup script that regenerated an existing secret would lock an operator out of a running stack.
  assert(/already exists/.test(setup), 'and it keeps every secret that already exists');
  assert(/write_secret_if_absent/.test(setup), 'by construction, not by convention');
  // It prepares; it never starts, promotes, approves or touches a library.
  for (const forbidden of ['docker compose up', 'unraid-real-library-promotion', 'jellyfin', 'git push', 'git tag']) {
    assert(!new RegExp(forbidden, 'i').test(setup.replace(/^#.*$/gm, '').replace(/echo "[^"]*"/g, '')),
      `the setup script never does ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The setup script, actually run. A re-run that regenerated a secret would lock an operator out of a running
// stack, orphan a database initialised with the old password, and invalidate a token in someone's browser.
// ---------------------------------------------------------------------------------------------------------

await test('re-running the Arcane setup keeps every secret, the token, and the data directories', () => {
  const shell = usableBash();
  if (shell === null) { console.log('        (skipped: no bash on this host can run the setup script)'); return; }
  const workspace = mkdtempSync(join(tmpdir(), 'arcane-setup-'));
  try {
    const project = join(workspace, 'catalog-authority');
    // The script takes a path on a LINUX host and refuses anything else, correctly. On Windows the shell
    // running it is Git Bash, whose view of `C:\a\b` is `/c/a/b` — so the argument is given in the shell's
    // spelling while Node reads the results back in the platform's. This is a test-harness translation, not
    // a supported input: the variable really does name a path on the Unraid host.
    const argument = toShellPath(project);
    const first = runScript(shell, join(root, 'deploy', 'arcane-setup.sh'), { cwd: workspace, args: [argument] });
    assertEq(first.status, 0, `the setup script exits cleanly — ${describeRun(first)}`);

    const before = new Map<string, string>();
    for (const name of ARCANE_REQUIRED_SECRET_FILES) {
      before.set(name, readFileSync(join(project, 'secrets', name), 'utf8'));
    }
    // Something that only a real database would have written, so a destructive re-run is visible.
    writeFileSync(join(project, 'pgdata', 'PG_VERSION'), '16\n');
    writeFileSync(join(project, 'promotion-records', 'phase-231-example.json'), '{}\n');

    const second = runScript(shell, join(root, 'deploy', 'arcane-setup.sh'), { cwd: workspace, args: [argument] });
    assertEq(second.status, 0, `a re-run also exits cleanly — ${describeRun(second)}`);

    for (const name of ARCANE_REQUIRED_SECRET_FILES) {
      assertEq(readFileSync(join(project, 'secrets', name), 'utf8'), before.get(name),
        `${name} is byte-for-byte unchanged by a re-run`);
    }
    assert(/kept/.test(second.stdout ?? ''), 'and the re-run says it kept them rather than claiming to create them');
    assertEq(readFileSync(join(project, 'pgdata', 'PG_VERSION'), 'utf8'), '16\n',
      'the database directory is untouched — a re-run is not a reinstall');
    assert(existsSync(join(project, 'promotion-records', 'phase-231-example.json')),
      'and nobody\'s evidence is removed');

    // The two URLs are different roles, and the runtime one is the least-privileged `app`.
    const admin = before.get('admin_database_url')!.trim();
    const runtime = before.get('database_url')!.trim();
    assert(admin.startsWith('postgresql://postgres:'), 'the owner URL is the superuser');
    assert(runtime.startsWith('postgresql://app:'), 'and the runtime URL is the least-privileged role');
    assert(admin !== runtime, 'they are not the same credential');
    // The generated token is what an operator pastes, so it is the one value the script prints. Nothing else.
    const stdout = first.stdout ?? '';
    assert(stdout.includes(before.get('operator_ui_token')!.trim()), 'the operator token is printed once');
    for (const name of ['postgres_password', 'completion_secret', 'custodian_kek', 'admin_database_url', 'database_url']) {
      assert(!stdout.includes(before.get(name)!.trim()), `${name} is never printed`);
    }
  } finally {
    removeQuietly(workspace);
  }
});

await test('the Arcane setup refuses a path that is not an absolute host path', () => {
  const shell = usableBash();
  if (shell === null) { console.log('        (skipped: no bash on this host can run the setup script)'); return; }
  const workspace = mkdtempSync(join(tmpdir(), 'arcane-setup-bad-'));
  try {
    for (const [why, arg] of [
      ['no argument at all', undefined],
      ['a relative path', 'projects/catalog-authority'],
      ['a path inside the launcher container', '/app/data/projects/catalog-authority'],
    ] as const) {
      const run = runScript(shell, join(root, 'deploy', 'arcane-setup.sh'),
        { cwd: workspace, args: arg === undefined ? [] : [arg] });
      assertEq(run.status, 2, `${why} is refused with a usage failure, not a guess — ${describeRun(run)}`);
      assertEq(readdirSync(workspace).length, 0, `and ${why} creates nothing`);
    }
  } finally {
    removeQuietly(workspace);
  }
});

await test('the yaml the Arcane stack is written in parses to the services it claims', () => {
  const doc = compose('docker-compose.arcane.yml');
  const names = Object.keys(asMap(doc.services ?? null, 'services')).sort().join(',');
  // Phase 263 adds a fourth: the `keystore-prepare` one-shot that repairs an existing installation's
  // root-owned keystore. It is not a second web server — it has no ports, no network at all, and exits.
  assertEq(names, 'app,keystore-prepare,migrate,postgres', 'exactly four services, and no second web server');
  assertEq(doc.name, 'catalogauthority-arcane',
    'under its own project name, so it cannot collide with an ordinary-computer stack on the same host');
  // Nothing in this stack may reach the host's Docker socket or its network stack.
  for (const [name, svc] of Object.entries(asMap(doc.services ?? null, 'services'))) {
    const parsed = asMap(svc, `service ${name}`);
    assert(parsed.privileged !== true, `${name} is not privileged`);
    // `none` is explicitly allowed and nothing else is: the Phase 263 repair one-shot asks for NO network,
    // which is the strictest answer available and the opposite of the thing this assertion guards against.
    assert(parsed.network_mode === undefined || parsed.network_mode === 'none',
      `${name} either takes the compose network or none at all — never the host's`);
    assert(!yamlStrings(parsed).some((v) => v.includes('docker.sock')), `${name} does not mount the Docker socket`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${String(err)}`);
  process.exit(1);
}
