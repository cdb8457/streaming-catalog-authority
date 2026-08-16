import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq, createFakeApiKeyFileSystem } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  SAB_API_KEY_MAX_BYTES,
  SAB_API_KEY_MAX_MODE,
  SAB_API_KEY_MIN_BYTES,
  SAB_API_KEY_SHAPE,
  isRestrictiveMode,
  readSabApiKeyFile,
  type ApiKeyFileStat,
} from '../src/core/usenet/sab-api-key.js';
import { CREDENTIAL_MAX_MODE } from '../src/core/projection/real-provider.js';

// Projection Phase 9 — the API key file, and every way of holding one badly.
//
// THE PROPERTY THIS SUITE IS ABOUT. §2 says the credential is read from a RESTRICTIVE FILE and never placed
// in argv, a manifest, a log, an error, a metric label or an inline environment value. Two halves: the file
// has to be refused when it is not restrictive, and NOTHING this module returns or throws may carry the path
// or the value. The second half is the one that decays silently, so every refusal below is checked for both.

const h = createHarness('Projection Phase 9 — the SABnzbd API key file');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

const PATH = '/mnt/user/appdata/sabnzbd/admin/projection-api.key';
const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const fileStat = (over: Partial<ApiKeyFileStat> = {}): ApiKeyFileStat =>
  ({ kind: 'file', mode: 0o600, sizeBytes: KEY.length, ...over });

h.section('the happy path');

test('a restrictive file holding one key is read, sealed and fingerprinted', async () => {
  const fs = createFakeApiKeyFileSystem({ [PATH]: { stat: fileStat(), content: KEY } });
  const result = await readSabApiKeyFile(fs, PATH);
  assert(result.ok, 'the key was refused');
  assertEq(result.key.reveal(), KEY, 'the key');
  assertEq(result.key.kind, 'sab-api-key', 'the seal kind');
  assert(/^[0-9a-f]{12}$/.test(result.fingerprint), 'the fingerprint shape');
  assertEq(JSON.stringify(result), '{"ok":true,"key":"[sealed:sab-api-key]","fingerprint":'
    + `"${result.fingerprint}"}`, 'the result stringifies without the key');
});

test('a trailing newline, carriage return or BOM is trimmed rather than refused', async () => {
  for (const suffix of ['\n', '\r\n', '  \n', '\t']) {
    const content = `${KEY}${suffix}`;
    const fs = createFakeApiKeyFileSystem({ [PATH]: { stat: fileStat({ sizeBytes: content.length }), content } });
    const result = await readSabApiKeyFile(fs, PATH);
    assert(result.ok, `a key with trailing ${JSON.stringify(suffix)} was refused`);
    assertEq(result.key.reveal(), KEY, 'the trimmed key');
  }
});

test('mode 0400 is accepted; the rule is "nothing to group or other", not "exactly 0600"', async () => {
  const fs = createFakeApiKeyFileSystem({ [PATH]: { stat: fileStat({ mode: 0o400 }), content: KEY } });
  assert((await readSabApiKeyFile(fs, PATH)).ok, '0400 was refused');
});

h.section('every refusal');

const refusals: ReadonlyArray<[string, Record<string, { stat: ApiKeyFileStat; content?: string; readThrows?: boolean }>, string]> = [
  ['a missing file', {}, 'credential-file-unreadable'],
  ['a symbolic link', { [PATH]: { stat: fileStat({ kind: 'symlink' }), content: KEY } }, 'credential-file-permissive'],
  ['a directory', { [PATH]: { stat: fileStat({ kind: 'directory' }) } }, 'credential-file-unreadable'],
  ['a device', { [PATH]: { stat: fileStat({ kind: 'device' }) } }, 'credential-file-unreadable'],
  ['a FIFO', { [PATH]: { stat: fileStat({ kind: 'fifo' }) } }, 'credential-file-unreadable'],
  ['a socket', { [PATH]: { stat: fileStat({ kind: 'socket' }) } }, 'credential-file-unreadable'],
  ['group-readable', { [PATH]: { stat: fileStat({ mode: 0o640 }), content: KEY } }, 'credential-file-permissive'],
  ['world-readable', { [PATH]: { stat: fileStat({ mode: 0o604 }), content: KEY } }, 'credential-file-permissive'],
  ['world-writable', { [PATH]: { stat: fileStat({ mode: 0o666 }), content: KEY } }, 'credential-file-permissive'],
  ['group-executable', { [PATH]: { stat: fileStat({ mode: 0o610 }), content: KEY } }, 'credential-file-permissive'],
  ['no mode at all', { [PATH]: { stat: { kind: 'file', sizeBytes: KEY.length }, content: KEY } }, 'credential-file-permissive'],
  ['too large', { [PATH]: { stat: fileStat({ sizeBytes: SAB_API_KEY_MAX_BYTES + 1 }), content: KEY } }, 'credential-file-malformed'],
  ['too small', { [PATH]: { stat: fileStat({ sizeBytes: SAB_API_KEY_MIN_BYTES - 1 }), content: 'abc' } }, 'credential-file-malformed'],
  ['unreadable bytes', { [PATH]: { stat: fileStat(), readThrows: true } }, 'credential-file-unreadable'],
  ['whitespace only', { [PATH]: { stat: fileStat(), content: '            \n' } }, 'credential-file-malformed'],
  ['two keys on two lines', { [PATH]: { stat: fileStat(), content: `${KEY}\n${KEY}\n` } }, 'credential-file-malformed'],
  ['a URL rather than a key', { [PATH]: { stat: fileStat(), content: 'http://127.0.0.1:8080/api?apikey=x' } }, 'credential-file-malformed'],
  ['a key with an internal space', { [PATH]: { stat: fileStat(), content: 'a1b2c3d4 e5f60718' } }, 'credential-file-malformed'],
  ['a key with a control character', { [PATH]: { stat: fileStat(), content: 'a1b2c3d4\u0007e5f60718' } }, 'credential-file-malformed'],
  ['a YAML fragment', { [PATH]: { stat: fileStat(), content: 'api_key: a1b2c3d4e5f60718' } }, 'credential-file-malformed'],
];

for (const [label, entries, expected] of refusals) {
  test(`${label} is refused as ${expected}`, async () => {
    const fs = createFakeApiKeyFileSystem(entries);
    const result = await readSabApiKeyFile(fs, PATH);
    assert(!result.ok, `${label} was accepted`);
    assertEq(result.reason, expected as never, `${label} reason`);
  });
}

test('no refusal carries the path, the mode digits or any part of the value', async () => {
  for (const [label, entries] of refusals) {
    const fs = createFakeApiKeyFileSystem(entries);
    const result = await readSabApiKeyFile(fs, PATH);
    if (result.ok) continue;
    const text = `${result.reason} ${result.detail}`;
    assert(!text.includes(PATH), `${label}'s refusal names the path`);
    assert(!text.includes('appdata'), `${label}'s refusal names part of the path`);
    assert(!text.includes(KEY.slice(0, 8)), `${label}'s refusal carries part of the key`);
    assert(!/0o?[0-7]{3,4}/.test(text), `${label}'s refusal prints mode digits`);
  }
});

h.section('the mode rule, and where it comes from');

test('the restrictive-mode test is exactly "nothing to group or other"', () => {
  assert(isRestrictiveMode(0o600), '0600');
  assert(isRestrictiveMode(0o400), '0400');
  assert(isRestrictiveMode(0o700), '0700');
  assert(!isRestrictiveMode(0o601), 'other-execute');
  assert(!isRestrictiveMode(0o620), 'group-write');
  assert(!isRestrictiveMode(0o644), 'the default umask result');
});

test('this module holds the SAME bound the real-provider gate and the daemon hold', () => {
  assertEq(SAB_API_KEY_MAX_MODE, CREDENTIAL_MAX_MODE,
    'two modules disagreeing about "restrictive enough" is how one of them ends up looser');
});

test('the requireMode escape hatch is opt-in, and its default fails closed', async () => {
  const entries = { [PATH]: { stat: { kind: 'file' as const, sizeBytes: KEY.length }, content: KEY } };
  const closed = await readSabApiKeyFile(createFakeApiKeyFileSystem(entries), PATH);
  assert(!closed.ok, 'a file with no reported mode is refused by default');
  const opened = await readSabApiKeyFile(createFakeApiKeyFileSystem(entries), PATH, { requireMode: false });
  assert(opened.ok, 'and is accepted only when a caller says the platform has no modes');
});

h.section('the key shape');

test('the shape accepts what SABnzbd generates and refuses what a mistake looks like', () => {
  assert(SAB_API_KEY_SHAPE.test(KEY), 'a 32-character hex key');
  assert(SAB_API_KEY_SHAPE.test('AbC-123_xyz09876'), 'a wider alphabet');
  assert(!SAB_API_KEY_SHAPE.test('short'), 'too short');
  assert(!SAB_API_KEY_SHAPE.test('x'.repeat(129)), 'too long');
  assert(!SAB_API_KEY_SHAPE.test('/run/secrets/key'), 'a path');
  assert(!SAB_API_KEY_SHAPE.test('key=value'), 'an assignment');
  assert(!SAB_API_KEY_SHAPE.test('a b'), 'a space');
});

h.section('wiring');

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/usenet-sab-api-key.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'usenet-sab-api-key.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();
