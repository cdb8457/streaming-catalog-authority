import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq, assertThrows } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  completedRootSegments,
  parseUsenetConfig,
  preflight,
  readSealedSource,
  renderPreflight,
  renderReconcile,
  runDiagnose,
  type PreflightDeps,
  type UsenetCommandConfig,
} from '../src/ops/usenet-command.js';
import { loadConfig, main, parseArgs } from '../src/ops/usenet-command-cli.js';
import { USENET_JOB_STATES, USENET_REFUSAL_REASONS } from '../src/core/usenet/sab-contract.js';
import { PHASE9_OPERATOR_INPUTS } from '../src/core/projection/phase9.js';

// Projection Phase 9 §3, FIFTH DELIVERABLE — the operator command surface.
//
// THE THING THIS SUITE IS MOST ABOUT: what may NOT be an argument. An NZB or indexer URL and an API key are
// both read from files whose permissions are checked, never from argv, because argv is visible in `/proc`, in
// every shell history and in `docker inspect` — and closure rule 9 says those values appear in no preserved
// evidence. A CLI that accepted `--source https://…` would put one in three places at once.

const h = createHarness('Projection Phase 9 — the operator command surface');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const CONFIG = {
  worker: { host: '127.0.0.1', port: 8080, scheme: 'http' },
  apiKeyFile: '/run/secrets/sabnzbd-api.key',
  category: 'projection',
  completedRoot: '/var/lib/projectiond/media/usenet-complete',
  mediaRoot: '/var/lib/projectiond/media',
  rootId: 'media',
  stateDir: '/var/lib/catalog-authority/usenet',
  pathPrefix: 'usenet',
};

async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'phase9-cli-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

h.section('the configuration document');

test('a complete configuration parses into exactly what it says', () => {
  const config = parseUsenetConfig(CONFIG);
  assertEq(config.worker.port, 8080, 'the port');
  assertEq(config.rootId, 'media', 'the root id');
  assertEq(config.pathPrefix, 'usenet', 'the prefix');
});

test('a trailing slash on a path is trimmed rather than producing a doubled separator', () => {
  const config = parseUsenetConfig({ ...CONFIG, mediaRoot: '/var/lib/projectiond/media/' });
  assertEq(config.mediaRoot, '/var/lib/projectiond/media', 'the trimmed root');
});

const badConfigs: ReadonlyArray<[string, unknown, RegExp]> = [
  ['not an object', [], /CONFIG_NOT_AN_OBJECT/],
  ['an unknown key', { ...CONFIG, extra: 1 }, /CONFIG_UNKNOWN_KEY/],
  ['no worker', { ...CONFIG, worker: null }, /CONFIG_WORKER_MISSING/],
  ['a worker host that is a URL', { ...CONFIG, worker: { host: 'http://x', port: 1 } }, /CONFIG_WORKER_HOST_INVALID/],
  ['a port that is not one', { ...CONFIG, worker: { host: 'x', port: 0 } }, /CONFIG_WORKER_PORT_INVALID/],
  ['a scheme that is neither', { ...CONFIG, worker: { host: 'x', port: 1, scheme: 'ftp' } }, /CONFIG_WORKER_SCHEME_INVALID/],
  ['a relative api key path', { ...CONFIG, apiKeyFile: 'secrets/key' }, /CONFIG_APIKEYFILE_INVALID/],
  ['a Windows api key path', { ...CONFIG, apiKeyFile: 'C:\\secrets\\key' }, /CONFIG_APIKEYFILE_INVALID/],
  ['a relative media root', { ...CONFIG, mediaRoot: 'media' }, /CONFIG_MEDIAROOT_INVALID/],
  ['a root id that is not a label', { ...CONFIG, rootId: 'Media Root' }, /CONFIG_ROOT_ID_INVALID/],
  ['a category that is not the dedicated one', { ...CONFIG, category: 'movies' }, /CONFIG_CATEGORY_INVALID/],
  ['a prefix with a separator', { ...CONFIG, pathPrefix: 'a/b' }, /CONFIG_PATH_PREFIX_INVALID/],
];

for (const [label, raw, pattern] of badConfigs) {
  test(`${label} is refused`, async () => {
    await assertThrows(() => parseUsenetConfig(raw), pattern, label);
  });
}

test('THE CATEGORY CANNOT BE WIDENED, which is what stops this phase reading a general download tree', async () => {
  await assertThrows(() => parseUsenetConfig({ ...CONFIG, category: 'movies' }), /CONFIG_CATEGORY_INVALID/, 'widening');
  await assertThrows(() => parseUsenetConfig({ ...CONFIG, category: '' }), /CONFIG_CATEGORY_INVALID/, 'emptying');
});

test('the completed root must be strictly below the media root, or the locator could never reach it', () => {
  assertEq(completedRootSegments(parseUsenetConfig(CONFIG)).join('/'), 'usenet-complete', 'the segments');
});

const badRoots: ReadonlyArray<[string, Partial<typeof CONFIG>]> = [
  ['the same directory', { completedRoot: '/var/lib/projectiond/media' }],
  ['a sibling sharing a prefix', { completedRoot: '/var/lib/projectiond/media-usenet' }],
  ['somewhere else entirely', { completedRoot: '/mnt/user/downloads/complete' }],
  ['above the media root', { completedRoot: '/var/lib' }],
];

for (const [label, over] of badRoots) {
  test(`a completed root that is ${label} is refused`, async () => {
    const config = parseUsenetConfig({ ...CONFIG, ...over }) as UsenetCommandConfig;
    await assertThrows(() => completedRootSegments(config), /CONFIG_COMPLETED_ROOT_NOT_UNDER_MEDIA_ROOT/, label);
  });
}

h.section('argv');

test('the five verbs parse, and nothing else is a verb', () => {
  for (const verb of ['preflight', 'status', 'reconcile'] as const) {
    assertEq(parseArgs([verb, '--config', '/c.json']).verb, verb, verb);
  }
  assertEq(parseArgs(['diagnose']).verb, 'diagnose', 'diagnose needs no config');
  assertEq(parseArgs(['submit', '--config', '/c.json', '--item', 'x', '--source', '/s']).verb, 'submit', 'submit');
});

test('an unknown verb, an unknown option and a missing value are refusals with usage', async () => {
  await assertThrows(() => parseArgs(['teleport']), /USAGE/, 'an unknown verb');
  await assertThrows(() => parseArgs(['status', '--config', '/c', '--wat']), /USAGE/, 'an unknown option');
  await assertThrows(() => parseArgs(['status', '--config']), /USAGE/, 'a missing value');
  await assertThrows(() => parseArgs(['--json']), /USAGE/, 'no verb');
  await assertThrows(() => parseArgs(['status']), /USAGE/, 'no config');
  await assertThrows(() => parseArgs(['submit', '--config', '/c']), /USAGE/, 'submit without item and source');
});

test('THE CLI HAS NO OPTION THAT TAKES A URL OR A KEY', () => {
  const source = read('src/ops/usenet-command-cli.ts');
  for (const forbidden of ['--url', '--nzb', '--apikey', '--api-key', '--key', '--token', '--password']) {
    assert(!source.includes(`'${forbidden}'`),
      `${forbidden} is an option, and argv is visible in /proc, in shell history and in docker inspect`);
  }
  assert(source.includes("case '--source':"), 'the source is not read from a file');
  assert(/read from files/i.test(source), 'the CLI does not say why the source is a path rather than a value');
});

test('the usage text tells an operator that the URL is read from the file, not from the command line', () => {
  const source = read('src/ops/usenet-command-cli.ts');
  assert(/never from this command line/.test(source), 'the usage does not say where the URL may not go');
});

h.section('reading the source file');

test('a restrictive file holding one URL is sealed; a permissive or malformed one is refused', async () => {
  await withTempDir(async (dir) => {
    const good = join(dir, 'source.url');
    writeFileSync(good, 'https://indexer.example/getnzb?id=42&apikey=abc\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(good, 0o600);
    const sealed = await readSealedSource(good);
    assertEq(sealed.kind, 'nzb-source', 'the seal kind');
    assertEq(JSON.stringify({ sealed }), '{"sealed":"[sealed:nzb-source]"}', 'the sealed source stringifies safely');

    const empty = join(dir, 'empty.url');
    writeFileSync(empty, '', 'utf8');
    if (process.platform !== 'win32') chmodSync(empty, 0o600);
    await assertThrows(() => readSealedSource(empty), /SOURCE_FILE_MALFORMED/, 'an empty file');

    const notUrl = join(dir, 'notes.txt');
    writeFileSync(notUrl, 'the nzb for tonight\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(notUrl, 0o600);
    await assertThrows(() => readSealedSource(notUrl), /SOURCE_FILE_MALFORMED/, 'not a URL');

    await assertThrows(() => readSealedSource(join(dir, 'missing.url')), /SOURCE_FILE_UNREADABLE/, 'missing');
    await assertThrows(() => readSealedSource(dir), /SOURCE_FILE_UNREADABLE/, 'a directory');
  });
});

test('a world-readable source file is refused, because an indexer URL carries an indexer key', async () => {
  if (process.platform === 'win32') return; // Windows reports no meaningful mode; the Unraid gate covers it.
  await withTempDir(async (dir) => {
    const path = join(dir, 'source.url');
    writeFileSync(path, 'https://indexer.example/getnzb?id=42&apikey=abc\n', 'utf8');
    chmodSync(path, 0o644);
    await assertThrows(() => readSealedSource(path), /SOURCE_FILE_PERMISSIVE/, 'world-readable');
  });
});

h.section('preflight');

/**
 * Preflight's host contacts, faked.
 *
 * The whole point is that these conditions are producible on any platform and that running the test changes
 * nothing on the machine — a preflight test that had to create `/var/lib/catalog-authority` to run would be a
 * test with a side effect on somebody's host.
 */
function preflightDeps(over: {
  key?: { stat: { kind: 'file' | 'missing' | 'symlink'; mode?: number; sizeBytes: number }; content?: string };
  dirs?: Readonly<Record<string, 'directory' | 'symlink' | 'other' | 'missing'>>;
  stateDirFails?: boolean;
} = {}): PreflightDeps {
  return {
    apiKeyFs: {
      async lstatFile() { return over.key?.stat ?? { kind: 'missing' as const, sizeBytes: 0 }; },
      async readFileNoFollow() { return Buffer.from(over.key?.content ?? '', 'utf8'); },
    },
    async lstatDirectory(path: string) {
      return { kind: over.dirs?.[path] ?? 'missing' };
    },
    async ensureDirectory() {
      if (over.stateDirFails === true) throw new Error('EACCES');
    },
    hasPosixModes: true,
  };
}

const GOOD_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

test('preflight reports every problem in ONE pass rather than one per run', async () => {
  const problems = await preflight(parseUsenetConfig(CONFIG), preflightDeps({ stateDirFails: true }));
  const codes = problems.map((problem) => problem.code);
  assert(codes.includes('CREDENTIAL_FILE_UNREADABLE'), `the missing key was not reported: ${codes.join(',')}`);
  assert(codes.includes('COMPLETEDROOT_MISSING'), 'the missing completed root was not reported');
  assert(codes.includes('MEDIAROOT_MISSING'), 'the missing media root was not reported');
  assert(codes.includes('STATE_DIR_NOT_WRITABLE'), 'the unwritable state directory was not reported');
  assertEq(problems.length, 4, 'preflight reported one problem at a time');
});

test('preflight is clean when the directories exist and the key file is restrictive', async () => {
  const problems = await preflight(parseUsenetConfig(CONFIG), preflightDeps({
    key: { stat: { kind: 'file', mode: 0o600, sizeBytes: GOOD_KEY.length }, content: GOOD_KEY },
    dirs: { [CONFIG.completedRoot]: 'directory', [CONFIG.mediaRoot]: 'directory' },
  }));
  assertEq(problems.length, 0, `preflight reported ${problems.map((p) => p.code).join(', ')}`);
});

test('a symlinked media root or completed root is reported rather than followed', async () => {
  const problems = await preflight(parseUsenetConfig(CONFIG), preflightDeps({
    key: { stat: { kind: 'file', mode: 0o600, sizeBytes: GOOD_KEY.length }, content: GOOD_KEY },
    dirs: { [CONFIG.completedRoot]: 'symlink', [CONFIG.mediaRoot]: 'other' },
  }));
  const codes = problems.map((problem) => problem.code);
  assert(codes.includes('COMPLETEDROOT_IS_SYMLINK'), 'a symlinked completed root was accepted');
  assert(codes.includes('MEDIAROOT_NOT_A_DIRECTORY'), 'a media root that is a file was accepted');
});

test('a permissive key file is reported by preflight, with no path in the message', async () => {
  const problems = await preflight(parseUsenetConfig(CONFIG), preflightDeps({
    key: { stat: { kind: 'file', mode: 0o644, sizeBytes: GOOD_KEY.length }, content: GOOD_KEY },
    dirs: { [CONFIG.completedRoot]: 'directory', [CONFIG.mediaRoot]: 'directory' },
  }));
  assertEq(problems.length, 1, 'the permissive key was not the only problem');
  assertEq(problems[0]?.code, 'CREDENTIAL_FILE_PERMISSIVE', 'the code');
  assert(!(problems[0]?.message ?? '').includes('/run/secrets'), 'the message names the credential\'s location');
});

test('a completed root outside the media root is reported by preflight rather than at admission time', async () => {
  const problems = await preflight(parseUsenetConfig({ ...CONFIG, completedRoot: '/mnt/user/downloads' }), preflightDeps({
    key: { stat: { kind: 'file', mode: 0o600, sizeBytes: GOOD_KEY.length }, content: GOOD_KEY },
    dirs: { '/mnt/user/downloads': 'directory', [CONFIG.mediaRoot]: 'directory' },
  }));
  assert(problems.some((problem) => problem.code === 'CONFIG_COMPLETED_ROOT_NOT_UNDER_MEDIA_ROOT'),
    'a completed root outside the media root was not reported');
});

test('preflight NEVER contacts the worker, so an unreachable one cannot hide a permission problem', () => {
  const source = read('src/ops/usenet-command.ts');
  const preflightBody = source.slice(source.indexOf('export async function preflight'), source.indexOf('export function openLedger'));
  assert(!preflightBody.includes('client'), 'preflight builds a client');
  assert(!preflightBody.includes('version()'), 'preflight contacts the worker');
});

test('the rendered preflight says what to fix, and says so plainly when nothing is wrong', () => {
  assert(renderPreflight([]).join('\n').includes('nothing is wrong'), 'a clean preflight');
  const lines = renderPreflight([{ code: 'X_Y', message: 'the thing is wrong' }]).join('\n');
  assert(lines.includes('X_Y') && lines.includes('the thing is wrong'), 'a problem is rendered');
});

h.section('diagnose');

test('diagnose generates its tables from the closed sets rather than restating them', () => {
  const document = runDiagnose();
  assertEq(document.lifecycle.length, USENET_JOB_STATES.length, 'the lifecycle');
  assertEq(document.refusals.length, USENET_REFUSAL_REASONS.length, 'the refusals');
  for (const row of document.refusals) {
    assert(row.meaning.length > 20, `${row.reason} has no meaning in diagnose`);
  }
  assert(document.hardRefusals.length === 8, 'the eight hard refusals');
  assertEq(document.operatorInputsStillRequired.length, PHASE9_OPERATOR_INPUTS.length, 'the operator inputs');
});

test('diagnose tells an operator exactly what is still required from THEM', () => {
  const inputs = runDiagnose().operatorInputsStillRequired.join(' | ');
  assert(/SABnzbd/.test(inputs), 'the worker is not named');
  assert(/API key/i.test(inputs), 'the credential is not named');
  assert(/NNTP/.test(inputs), 'the NNTP provider is not named');
  assert(/never reads or holds one/.test(inputs),
    'the inputs must say that this project never holds an NNTP credential, which is §4\'s seventh refusal');
  assert(/legally entitled/.test(inputs), 'the content requirement is not stated honestly');
});

test('diagnose carries no identity and can be printed anywhere', () => {
  const text = JSON.stringify(runDiagnose());
  assert(!/https?:\/\//.test(text), 'diagnose carries a URL');
  assert(!text.includes('127.0.0.1'), 'diagnose carries an address');
});

h.section('the CLI end to end');

test('diagnose runs, prints and exits zero without a configuration or a worker', async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    assertEq(await main(['diagnose']), 0, 'the exit code');
  } finally {
    console.log = original;
  }
  const text = lines.join('\n');
  assert(text.includes('lifecycle'), 'the lifecycle section');
  assert(text.includes('still required from the operator'), 'the operator inputs section');
  for (const state of USENET_JOB_STATES) assert(text.includes(state), `${state} is missing`);
});

test('an unreadable configuration is a named refusal with a non-zero exit, not a stack trace', async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    assertEq(await main(['status', '--config', '/definitely/not/here.json']), 1, 'the exit code');
  } finally {
    console.error = originalError;
  }
  assert(errors.join('\n').includes('CONFIG_UNREADABLE'), 'the failure was not named');
});

test('a configuration file on disk loads through the same parser the suite drives', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'usenet.json');
    writeFileSync(path, JSON.stringify(CONFIG), 'utf8');
    assertEq(loadConfig(path).rootId, 'media', 'the loaded config');
    writeFileSync(path, 'not json', 'utf8');
    await assertThrows(() => loadConfig(path), /CONFIG_UNREADABLE/, 'a malformed file');
  });
});

h.section('rendering a reconciliation');

test('a reconciliation renders its outcomes and says plainly when there is nothing to do', () => {
  assertEq(renderReconcile([]).join(''), 'nothing to reconcile', 'an empty reconciliation');
  const lines = renderReconcile([
    { key: 'a'.repeat(32), marker: 'projection-' + 'a'.repeat(32), state: 'admitted', changed: true,
      admitted: { projectedPath: 'usenet/a.mkv', projectedEntryId: 'pe_x', versionKey: 'v', sizeBytes: 1, sha256: 'x' } },
    { key: 'b'.repeat(32), marker: 'projection-' + 'b'.repeat(32), state: 'refused', changed: true,
      reason: 'output-is-symlink', detail: 'the output is a symbolic link' },
  ]).join('\n');
  assert(lines.includes('usenet/a.mkv'), 'the admitted path');
  assert(lines.includes('output-is-symlink'), 'the refusal reason');
});

h.section('wiring');

test('the publisher goes through the EXISTING registration boundary and adds no table of its own', () => {
  const source = read('src/ops/usenet-command.ts');
  assert(source.includes('registerVersion'), 'the publisher does not use registerVersion');
  assert(source.includes('registerEntry'), 'the publisher does not use registerEntry');
  assert(!/CREATE TABLE|INSERT INTO|cat_usenet_/.test(source),
    'the command surface writes its own SQL, which would be a second producer of projection state');
  assert(source.includes("kind: 'local'"), 'an admitted Usenet file is published as something other than a local source');
  assert(!source.includes("kind: 'http-range'"), 'the command surface can produce a provider locator');
});

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/usenet-command.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'usenet-command.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();
