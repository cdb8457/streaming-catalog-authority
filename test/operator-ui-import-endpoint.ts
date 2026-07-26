import { Client } from 'pg';
import { request, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  INBOX_MAX_ENTRIES,
  INBOX_NAME_RE,
  CatalogInboxError,
  listImportInbox,
  readInboxFile,
} from '../src/ops/catalog-import-inbox.js';
import {
  IMPORT_CONFIRMATION_MAX_LENGTH,
  IMPORT_CONFIRMATION_TTL_MS,
  ImportConfirmations,
} from '../src/ops/catalog-import-confirmation.js';
import {
  IMPORT_APPLY_ROUTE,
  IMPORT_HISTORY_ROUTE,
  IMPORT_INBOX_ROUTE,
  IMPORT_PREVIEW_ROUTE,
  IMPORT_REQUEST_MAX_BYTES,
  checkWriteRequestHeaders,
} from '../src/ops/operator-ui-import-endpoint.js';
import { CATALOG_IMPORT_DIR_ENV } from '../src/ops/catalog-import.js';
import { IMPORT_MAX_BYTES } from '../src/core/catalog/import-snapshot.js';
import { MIGRATION_VERSION } from '../src/db/schema-version.js';
import { MIGRATED_TABLES, migrateWith } from '../src/db/pool.js';
import { startEmbedded } from './embedded-pg.js';
import { installCompletionSecret } from './crypto-setup.js';
import {
  createOperatorUiServiceServer,
  validateOperatorUiServiceConfig,
} from '../src/ops/operator-ui-service.js';
import {
  OPERATOR_UI_LOCAL_AUTH_HEADER,
  loadOperatorUiLocalAuthRuntime,
} from '../src/ops/operator-ui-local-auth-runtime.js';

// Phase 264 — the authenticated catalog IMPORT workflow, the one part of this UI that writes.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - A snapshot can come from the read-only import folder and NOWHERE else: no path, no URL, no upload, no
//     traversal, no symlink out, no file two levels down, no name with a separator in it.
//   - A PREVIEW writes nothing. Proved twice: structurally (the preview path is handed no writer) and
//     empirically (row and event counts across a real PostgreSQL are unchanged).
//   - An APPLY is bound to the exact previewed BYTES. A substituted file, a different file, a replay, an
//     expired preview, a forged confirmation and a confirmation from another process are each refused, with
//     nothing written.
//   - Both write routes refuse a cross-origin request, a body that is not declared JSON, and an oversized
//     body — before they parse anything.
//   - Applying the same snapshot twice changes nothing the second time.
//   - The history is durable, identity-free, and written by BOTH surfaces through one implementation.
//   - No secret, no path and no record content reaches a response, a log line or the history table.

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
function assertThrows(fn: () => unknown, msg: string): unknown {
  try { fn(); } catch (err) { return err; }
  throw new Error(`${msg}: expected a throw, got none`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').split('\r\n').join('\n');

const WORK = mkdtempSync(join(tmpdir(), 'ca-import-endpoint-'));
const TOKEN = 'phase264-operator-token-abcdefghij';

const SECRET_REF = 'tt-phase264-ref-value-must-never-be-shown';
function snapshotJson(items: number, source = 'my-library'): string {
  const records = Array.from({ length: items }, (_, index) => ({
    externalId: `p264-${index}`,
    title: `Phase 264 Record ${index}`,
    year: 1990 + (index % 20),
    ...(index === 0 ? { providerRefs: [{ type: 'imdb', value: SECRET_REF }] } : {}),
    ...(index === 1 ? { metadata: { shelf: 'a1' } } : {}),
  }));
  return `${JSON.stringify({ format: 'catalog-authority.snapshot', version: 1, source, items: records }, null, 2)}\n`;
}

async function main(): Promise<void> {
  console.log('Running Phase 264 catalog import workflow suite:\n');

  // -------------------------------------------------------------------------------------------------------
  // The inbox: one read-only folder, and nowhere else
  // -------------------------------------------------------------------------------------------------------

  const inbox = join(WORK, 'import');
  mkdirSync(inbox, { recursive: true });
  const outside = join(WORK, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.json'), snapshotJson(1, 'outside-library'));
  writeFileSync(join(inbox, 'library.json'), snapshotJson(4));
  writeFileSync(join(inbox, 'notes.txt'), 'not a snapshot');
  writeFileSync(join(inbox, 'empty.json'), '');
  mkdirSync(join(inbox, 'subdir.json'), { recursive: true });
  writeFileSync(join(inbox, 'subdir.json', 'nested.json'), snapshotJson(1));
  const ENV = { [CATALOG_IMPORT_DIR_ENV]: inbox } as NodeJS.ProcessEnv;

  await test('the inbox lists only plain, bounded .json files, and counts what it skipped', () => {
    const listing = listImportInbox(ENV);
    assertEq(listing.state, 'CANDIDATES', 'state');
    assertEq(listing.candidates.map((c) => c.name).join(','), 'library.json', 'exactly the one usable file');
    assertEq(listing.skipped['not-a-json-name'], 1, 'notes.txt was skipped by name');
    assertEq(listing.skipped.empty, 1, 'the empty file was skipped');
    assertEq(listing.skipped['not-a-regular-file'], 1, 'the directory was skipped');
    // A skipped entry is COUNTED, never named: it is still somebody's filesystem.
    assert(!JSON.stringify(listing).includes('notes.txt'), 'a skipped name was echoed');
    assert(!JSON.stringify(listing).includes(inbox), 'the listing echoed a path');
  });

  await test('an unconfigured or unreadable inbox is a STATE with guidance, never a crash', () => {
    const none = listImportInbox({} as NodeJS.ProcessEnv);
    assertEq(none.state, 'NOT_CONFIGURED', 'no variable set');
    assert(none.guidance.includes(CATALOG_IMPORT_DIR_ENV), 'it names the variable');
    const missing = listImportInbox({ [CATALOG_IMPORT_DIR_ENV]: join(WORK, 'no-such-folder') } as NodeJS.ProcessEnv);
    assertEq(missing.state, 'UNREADABLE', 'a folder that is not there');
    assertEq(missing.candidates.length, 0, 'and it offers nothing');
  });

  await test('an empty inbox says so and points at the format, rather than reporting a fault', () => {
    const empty = join(WORK, 'empty-inbox');
    mkdirSync(empty, { recursive: true });
    const listing = listImportInbox({ [CATALOG_IMPORT_DIR_ENV]: empty } as NodeJS.ProcessEnv);
    assertEq(listing.state, 'EMPTY', 'state');
    assert(/snapshot/i.test(listing.guidance), 'the guidance says what to put there');
  });

  await test('a name with any path in it is refused by the GRAMMAR, before a filesystem call', () => {
    const traversals = [
      '../outside/secret.json', '..%2Foutside%2Fsecret.json', '/etc/passwd', 'C:\\windows\\win.ini',
      'subdir.json/nested.json', 'subdir.json\\nested.json', './library.json', '.hidden.json',
      'library.json\u0000.txt', 'lib rary.json', '', '..', 'library.JSON.exe', '\\\\server\\share\\a.json',
    ];
    for (const name of traversals) {
      assertEq(INBOX_NAME_RE.test(name), false, `"${name}" must not match the name grammar`);
      const err = assertThrows(() => readInboxFile(name, ENV), `"${name}" is refused`);
      assert(err instanceof CatalogInboxError, `"${name}" is refused as an inbox error`);
      assert(!String((err as Error).message).includes(WORK), 'the refusal echoed a path');
    }
  });

  await test('a name that is not a string at all is refused', () => {
    for (const value of [undefined, null, 42, {}, [], true]) {
      assert(assertThrows(() => readInboxFile(value, ENV), 'a non-string name is refused') instanceof CatalogInboxError,
        'a non-string name is refused as an inbox error');
    }
  });

  await test('a SYMLINK inside the inbox cannot be used to read outside it', () => {
    let linked = false;
    try {
      symlinkSync(join(outside, 'secret.json'), join(inbox, 'linked.json'));
      linked = true;
    } catch {
      // Creating a symlink needs a privilege a developer's Windows session usually does not have. Saying so
      // beats a test that quietly does not run; the listing assertion below still covers the same rule for
      // whatever links a real deployment has.
      console.log('        (symlink creation is not permitted here; the containment rule is asserted below)');
    }
    if (linked) {
      const err = assertThrows(() => readInboxFile('linked.json', ENV), 'a symlink is refused');
      assert(err instanceof CatalogInboxError, 'a symlink is refused as an inbox error');
      const listing = listImportInbox(ENV);
      assertEq(listing.skipped.symlink, 1, 'and the listing counts it as a symlink');
      assert(!listing.candidates.some((c) => c.name === 'linked.json'), 'and never offers it');
      rmSync(join(inbox, 'linked.json'), { force: true });
    }
    // Independent of symlink support: the containment check is what the resolution rule rests on, and the
    // grammar above already refuses every spelling of a path.
    assert(readRepo('src/ops/catalog-import-inbox.ts').includes('realpathSync'),
      'containment is checked after symlink resolution');
  });

  await test('a file over the size limit is refused before it is read', () => {
    const big = join(inbox, 'huge.json');
    writeFileSync(big, 'x'.repeat(IMPORT_MAX_BYTES + 1));
    const err = assertThrows(() => readInboxFile('huge.json', ENV), 'an oversized file is refused');
    assert(/limit/.test(String((err as Error).message)), 'the refusal names the limit');
    assertEq(listImportInbox(ENV).skipped['too-large'], 1, 'and the listing counts it');
    rmSync(big, { force: true });
  });

  await test('a readable snapshot comes back with its exact bytes and their digest', () => {
    const file = readInboxFile('library.json', ENV);
    assertEq(file.name, 'library.json', 'name');
    assertEq(file.text, snapshotJson(4), 'the exact bytes');
    assertEq(file.bytes, Buffer.byteLength(snapshotJson(4), 'utf8'), 'the byte count');
    assert(/^[0-9a-f]{64}$/.test(file.contentDigest), 'a sha256 of the bytes');
  });

  await test('the listing is bounded and deterministic', () => {
    const many = join(WORK, 'many');
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < INBOX_MAX_ENTRIES + 5; i += 1) {
      writeFileSync(join(many, `s${String(i).padStart(4, '0')}.json`), '{}');
    }
    const listing = listImportInbox({ [CATALOG_IMPORT_DIR_ENV]: many } as NodeJS.ProcessEnv);
    assertEq(listing.candidates.length, INBOX_MAX_ENTRIES, 'the listing is bounded');
    assertEq(listing.truncated, true, 'and says it was bounded rather than implying it saw everything');
    const again = listImportInbox({ [CATALOG_IMPORT_DIR_ENV]: many } as NodeJS.ProcessEnv);
    assertEq(again.candidates.map((c) => c.name).join(','), listing.candidates.map((c) => c.name).join(','),
      'two listings of the same folder are the same listing');
    rmSync(many, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------------------------------------
  // The confirmation: an apply is the apply a preview described
  // -------------------------------------------------------------------------------------------------------

  const CLAIMS = {
    name: 'library.json',
    bytes: 100,
    contentDigest: 'a'.repeat(64),
    snapshotDigest: 'b'.repeat(64),
    source: 'my-library',
    updateExisting: false,
  };

  await test('a confirmation issued for some bytes verifies against exactly those bytes', () => {
    const issuer = new ImportConfirmations();
    const token = issuer.issue(CLAIMS);
    assert(token.length <= IMPORT_CONFIRMATION_MAX_LENGTH, 'a confirmation is small');
    const verdict = issuer.verify(token, CLAIMS.contentDigest, CLAIMS.bytes);
    assertEq(verdict.ok, true, 'it verifies');
    assert(verdict.ok && verdict.claims.name === 'library.json', 'and carries back what was previewed');
    // The claims are readable, which is fine — they are counts and digests, never content.
    assert(!token.includes(SECRET_REF), 'a confirmation carries no record content');
  });

  await test('a SUBSTITUTED file is refused: the bytes changed, so the confirmation does not apply to them', () => {
    const issuer = new ImportConfirmations();
    const verdict = issuer.verify(issuer.issue(CLAIMS), 'c'.repeat(64), CLAIMS.bytes);
    assertEq(verdict.ok, false, 'it is refused');
    assert(!verdict.ok && verdict.rejection === 'FILE_CHANGED', 'and says the file changed');
    assert(!verdict.ok && /previewed/.test(verdict.message), 'and tells the operator to preview again');
  });

  await test('a file of a different SIZE with the same digest claim is refused too', () => {
    const issuer = new ImportConfirmations();
    const verdict = issuer.verify(issuer.issue(CLAIMS), CLAIMS.contentDigest, CLAIMS.bytes + 1);
    assert(!verdict.ok && verdict.rejection === 'FILE_CHANGED', 'a size mismatch is refused');
  });

  await test('a REPLAYED confirmation is refused: each preview may be applied once', () => {
    const issuer = new ImportConfirmations();
    const token = issuer.issue(CLAIMS);
    assertEq(issuer.verify(token, CLAIMS.contentDigest, CLAIMS.bytes).ok, true, 'the first use works');
    const second = issuer.verify(token, CLAIMS.contentDigest, CLAIMS.bytes);
    assert(!second.ok && second.rejection === 'ALREADY_USED', 'the second use is refused');
  });

  await test('a confirmation is spent even when the file turns out to have changed', () => {
    // The nonce is consumed BEFORE the content is compared, so a caller cannot use a failing apply to probe
    // repeatedly whether a file has changed yet.
    const issuer = new ImportConfirmations();
    const token = issuer.issue(CLAIMS);
    assert(!issuer.verify(token, 'c'.repeat(64), CLAIMS.bytes).ok, 'the mismatched attempt is refused');
    const retry = issuer.verify(token, CLAIMS.contentDigest, CLAIMS.bytes);
    assert(!retry.ok && retry.rejection === 'ALREADY_USED', 'and the confirmation is spent');
  });

  await test('a STALE confirmation is refused once the preview is too old', () => {
    let now = 1_000_000;
    const issuer = new ImportConfirmations(() => now);
    const token = issuer.issue(CLAIMS);
    now += IMPORT_CONFIRMATION_TTL_MS - 1000;
    assertEq(issuer.verify(token, CLAIMS.contentDigest, CLAIMS.bytes).ok, true, 'inside the window it works');
    const later = issuer.issue(CLAIMS);
    now += IMPORT_CONFIRMATION_TTL_MS + 1000;
    const verdict = issuer.verify(later, CLAIMS.contentDigest, CLAIMS.bytes);
    assert(!verdict.ok && verdict.rejection === 'EXPIRED', 'past the window it is refused');
  });

  await test('a confirmation from a DIFFERENT process is refused, which is what a restart looks like', () => {
    const before = new ImportConfirmations();
    const after = new ImportConfirmations();
    const verdict = after.verify(before.issue(CLAIMS), CLAIMS.contentDigest, CLAIMS.bytes);
    assert(!verdict.ok && verdict.rejection === 'BAD_SIGNATURE', 'the other process refuses it');
  });

  await test('a FORGED or tampered confirmation is refused', () => {
    const issuer = new ImportConfirmations();
    const token = issuer.issue(CLAIMS);
    const [body, signature] = token.split('.') as [string, string];
    // A payload rewritten to claim different bytes, re-encoded, with the original signature.
    const rewritten = Buffer.from(JSON.stringify({
      ...CLAIMS, contentDigest: 'c'.repeat(64), nonce: '0'.repeat(32), issuedAt: Date.now(),
    }), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const forged = `${rewritten}.${signature}`;
    assert(!issuer.verify(forged, 'c'.repeat(64), CLAIMS.bytes).ok, 'a rewritten payload is refused');
    for (const bad of [
      '', 'not-a-token', `${body}`, `.${signature}`, `${body}.`, `${body}.${signature}.extra`,
      `${body}.${signature}x`, `${body.slice(0, -1)}.${signature}`,
      'x'.repeat(IMPORT_CONFIRMATION_MAX_LENGTH + 1), '$$$.$$$',
    ]) {
      assert(!issuer.verify(bad, CLAIMS.contentDigest, CLAIMS.bytes).ok, `"${bad.slice(0, 24)}" is refused`);
    }
    for (const bad of [undefined, null, 42, {}, []]) {
      assert(!issuer.verify(bad, CLAIMS.contentDigest, CLAIMS.bytes).ok, 'a non-string confirmation is refused');
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // The write surface's request rules
  // -------------------------------------------------------------------------------------------------------

  const headersOf = (headers: Record<string, string>): { headers: Record<string, string> } => ({ headers });

  await test('a write refuses anything that is not declared application/json', () => {
    for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'text/html']) {
      const result = checkWriteRequestHeaders(headersOf(type === undefined ? {} : { 'content-type': type }));
      assert(result !== null && !result.ok && result.rejection === 'BAD_CONTENT_TYPE', `${String(type)} is refused`);
    }
    assertEq(checkWriteRequestHeaders(headersOf({ 'content-type': 'application/json' })), null, 'JSON is accepted');
    assertEq(checkWriteRequestHeaders(headersOf({ 'content-type': 'application/json; charset=utf-8' })), null,
      'a charset parameter is accepted');
  });

  await test('a write refuses a CROSS-ORIGIN request, by Origin and by Sec-Fetch-Site', () => {
    const json = { 'content-type': 'application/json', host: '127.0.0.1:8099' };
    for (const origin of ['http://evil.example', 'http://127.0.0.1:9999', 'http://localhost:8099', 'not a url', 'http://127.0.0.1']) {
      const result = checkWriteRequestHeaders(headersOf({ ...json, origin }));
      assert(result !== null && !result.ok && result.rejection === 'CROSS_ORIGIN', `origin ${origin} is refused`);
    }
    assertEq(checkWriteRequestHeaders(headersOf({ ...json, origin: 'http://127.0.0.1:8099' })), null,
      'the page\'s own origin is accepted');
    // HOST AND PORT, deliberately not the scheme: a supported deployment puts this behind a reverse proxy
    // that terminates TLS, so the browser's Origin is https:// while the request arriving here is http://.
    // Refusing that would break every proxied install to stop an attacker who would already have to be
    // serving TLS on this exact host and port. A cross-SITE origin always differs by host, and does not
    // survive the loop above.
    assertEq(checkWriteRequestHeaders(headersOf({ ...json, origin: 'https://127.0.0.1:8099' })), null,
      'a TLS-terminating proxy in front of the same host and port is accepted');
    for (const site of ['cross-site', 'same-site']) {
      const result = checkWriteRequestHeaders(headersOf({ ...json, 'sec-fetch-site': site }));
      assert(result !== null && !result.ok && result.rejection === 'CROSS_ORIGIN', `sec-fetch-site ${site} is refused`);
    }
    assertEq(checkWriteRequestHeaders(headersOf({ ...json, 'sec-fetch-site': 'same-origin' })), null,
      'a same-origin fetch is accepted');
    // A request with NEITHER header is accepted: that is curl and the acceptance harness, and a browser
    // always sends Origin on the cross-origin request this rule exists to refuse.
    assertEq(checkWriteRequestHeaders(headersOf({ 'content-type': 'application/json' })), null,
      'a non-browser client is accepted');
  });

  await test('the confused-deputy defence is structural, and the code says which parts are which', () => {
    const source = readRepo('src/ops/operator-ui-import-endpoint.ts');
    assert(/no ambient credential/i.test(source), 'it states that there is no ambient credential to abuse');
    assert(source.includes('CORS'), 'and why a custom header cannot be set cross-origin');
    const service = readRepo('src/ops/operator-ui-service.ts');
    assert(!/access-control-allow-origin/i.test(service), 'the service sends no CORS header at all');
  });

  // -------------------------------------------------------------------------------------------------------
  // Against a real server, with no database: auth, method and fail-closed
  // -------------------------------------------------------------------------------------------------------

  const secretsDir = join(WORK, 'secrets');
  mkdirSync(secretsDir, { recursive: true });
  const tokenFile = join(secretsDir, 'operator_ui_token');
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const recordsDir = join(WORK, 'records');
  mkdirSync(recordsDir, { recursive: true });
  process.env[CATALOG_IMPORT_DIR_ENV] = inbox;

  const config = validateOperatorUiServiceConfig({
    host: '127.0.0.1', port: 8099, operatorSecretFile: tokenFile, promotionRecordsDir: recordsDir,
  });

  interface Call { status: number; body: string; headers: Record<string, string | string[] | undefined> }
  const caller = (port: number) => (
    path: string,
    options: { token?: string; method?: string; body?: string; contentType?: string; origin?: string } = {},
  ): Promise<Call> => new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.token !== undefined) headers[OPERATOR_UI_LOCAL_AUTH_HEADER] = options.token;
    if (options.body !== undefined) headers['content-type'] = options.contentType ?? 'application/json';
    if (options.origin !== undefined) headers.origin = options.origin;
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });

  const port = await freePort();
  const server: Server = createOperatorUiServiceServer(config, loadOperatorUiLocalAuthRuntime(tokenFile));
  await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve); });
  const call = caller(port);

  for (const route of [IMPORT_INBOX_ROUTE, IMPORT_HISTORY_ROUTE]) {
    await test(`${route} answers 401 without a valid token`, async () => {
      assertEq((await call(route)).status, 401, 'no token');
      assertEq((await call(route, { token: 'phase264-operator-token-ABCDEFGHIJ' })).status, 401, 'a wrong token of the same length');
    });
  }

  for (const route of [IMPORT_PREVIEW_ROUTE, IMPORT_APPLY_ROUTE]) {
    await test(`${route} answers 401 without a valid token, before it reads a body`, async () => {
      const res = await call(route, { method: 'POST', body: JSON.stringify({ file: 'library.json' }) });
      assertEq(res.status, 401, 'no token');
      assert(res.body.includes('OPERATOR_UI_SERVICE_UNAUTHORIZED'), 'the refusal has the wrong code');
    });

    await test(`${route} is POST-only, and says so`, async () => {
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        const res = await call(route, { token: TOKEN, method });
        assertEq(res.status, 405, `${method} was not refused`);
        assertEq(res.headers.allow, 'POST', `${method} was not told what is allowed`);
      }
    });

    await test(`${route} refuses a non-JSON body, a cross-origin body and an oversized body`, async () => {
      const form = await call(route, { token: TOKEN, method: 'POST', body: 'file=library.json', contentType: 'application/x-www-form-urlencoded' });
      assertEq(form.status, 400, 'a form post was not refused');
      assert(form.body.includes('BAD_CONTENT_TYPE'), 'wrong refusal code for a form post');

      const cross = await call(route, { token: TOKEN, method: 'POST', body: '{}', origin: 'http://evil.example' });
      assertEq(cross.status, 403, 'a cross-origin post was not refused');
      assert(cross.body.includes('CROSS_ORIGIN'), 'wrong refusal code for a cross-origin post');

      const huge = await call(route, { token: TOKEN, method: 'POST', body: JSON.stringify({ file: 'x'.repeat(IMPORT_REQUEST_MAX_BYTES) }) });
      assertEq(huge.status, 413, 'an oversized body was not refused');

      const notJson = await call(route, { token: TOKEN, method: 'POST', body: 'not json at all' });
      assertEq(notJson.status, 400, 'a malformed body was not refused');
      assert(notJson.body.includes('NOT_JSON'), 'wrong refusal code for a malformed body');

      const array = await call(route, { token: TOKEN, method: 'POST', body: '[1,2,3]' });
      assertEq(array.status, 400, 'a JSON array body was not refused');
    });
  }

  await test('with no database, every import route fails CLOSED and says nothing about the configuration', async () => {
    // No DATABASE_URL in this process. The inbox still answers — it needs no database, and an operator whose
    // database is down is exactly the operator trying to work out what to do next.
    const listing = await call(IMPORT_INBOX_ROUTE, { token: TOKEN });
    assertEq(listing.status, 200, 'the inbox needs no database');
    assert(listing.body.includes('library.json'), 'and lists the snapshot');

    for (const res of [
      await call(IMPORT_HISTORY_ROUTE, { token: TOKEN }),
      await call(IMPORT_PREVIEW_ROUTE, { token: TOKEN, method: 'POST', body: JSON.stringify({ file: 'library.json' }) }),
      await call(IMPORT_APPLY_ROUTE, { token: TOKEN, method: 'POST', body: JSON.stringify({ file: 'library.json', confirmation: 'x.y' }) }),
    ]) {
      assertEq(res.status, 503, `a route with no database answered ${res.status}: ${res.body}`);
      assert(!/postgres|password|DATABASE_URL|\/run\/secrets/i.test(res.body), 'the failure leaked configuration');
      assert(!res.body.includes(WORK), 'the failure leaked a path');
    }
  });

  await test('the import routes carry the same hardened headers as every other route', async () => {
    const res = await call(IMPORT_INBOX_ROUTE, { token: TOKEN });
    assertEq(res.headers['x-content-type-options'], 'nosniff', 'missing nosniff');
    assertEq(res.headers['cache-control'], 'no-store', 'missing no-store');
    assertEq(res.headers['x-frame-options'], 'DENY', 'missing frame denial');
    assert(String(res.headers['content-security-policy'] ?? '').includes("default-src 'none'"), 'missing CSP');
  });

  await new Promise<void>((resolve) => { server.close(() => resolve()); });

  // -------------------------------------------------------------------------------------------------------
  // The whole workflow, against a real PostgreSQL
  // -------------------------------------------------------------------------------------------------------

  console.log('\nend to end: preview writes nothing, apply writes exactly what was previewed');

  let pg: Awaited<ReturnType<typeof startEmbedded>> | undefined;
  if (process.env.DATABASE_URL === undefined) {
    try { pg = await startEmbedded(); }
    catch (err) { console.log(`  SKIP  the end-to-end section: an embedded PostgreSQL could not be started: ${(err as Error).message}`); }
  }

  if (process.env.DATABASE_URL !== undefined) {
    await migrateWith(process.env.ADMIN_DATABASE_URL!);
    const admin = new Client({ connectionString: process.env.ADMIN_DATABASE_URL! });
    await admin.connect();
    const completionSecret = await installCompletionSecret(admin);
    const keystore = join(WORK, 'keystore');
    mkdirSync(keystore, { recursive: true });
    const kek = Buffer.alloc(32, 13);
    process.env.CUSTODIAN_MODE = 'file';
    process.env.CUSTODIAN_KEYSTORE_DIR = keystore;
    process.env.CUSTODIAN_KEK = kek.toString('base64');
    process.env.COMPLETION_SECRET = completionSecret;

    const { closePool } = await import('../src/db/pool.js');

    const livePort = await freePort();
    const liveServer = createOperatorUiServiceServer(config, loadOperatorUiLocalAuthRuntime(tokenFile));
    await new Promise<void>((resolve) => { liveServer.listen(livePort, '127.0.0.1', resolve); });
    const live = caller(livePort);
    const post = (route: string, body: unknown): Promise<Call> =>
      live(route, { token: TOKEN, method: 'POST', body: JSON.stringify(body) });
    const counts = async (): Promise<{ items: number; events: number; history: number }> => ({
      items: (await admin.query('SELECT count(*)::int AS n FROM items')).rows[0].n as number,
      events: (await admin.query('SELECT count(*)::int AS n FROM events')).rows[0].n as number,
      history: (await admin.query('SELECT count(*)::int AS n FROM import_history')).rows[0].n as number,
    });

    await test('the v6 migration created the import history table and its one writer', async () => {
      assert(MIGRATED_TABLES.includes('import_history'), 'the migration verifier knows about the table');
      assertEq(
        (await admin.query('SELECT version FROM schema_meta WHERE id = 1')).rows[0].version as number,
        MIGRATION_VERSION, 'the database is at this build\'s schema version');
      const fn = (await admin.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'cat_import_record'`)).rows[0].n as number;
      assertEq(fn, 1, 'the append-only writer exists');
    });

    await test('the least-privileged runtime role can APPEND to and READ the history, and nothing else', async () => {
      const { getPool } = await import('../src/db/pool.js');
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        for (const [what, sql] of [
          ['insert directly', `INSERT INTO import_history (actor, source, file_name, snapshot_digest, content_digest, total, created, updated, unchanged, blocked, failed, outcome) VALUES ('cli','x','y.json','${'a'.repeat(64)}','${'b'.repeat(64)}',0,0,0,0,0,0,'complete')`],
          ['update', 'UPDATE import_history SET total = total WHERE false'],
          ['delete', 'DELETE FROM import_history WHERE false'],
        ] as Array<[string, string]>) {
          await client.query('SAVEPOINT probe');
          let denied = false;
          try { await client.query(sql); } catch (err) { denied = (err as { code?: string }).code === '42501'; }
          await client.query('ROLLBACK TO SAVEPOINT probe');
          assert(denied, `the runtime role can ${what} on import_history — it must not`);
        }
        await client.query('ROLLBACK');
        assert((await client.query('SELECT count(*) FROM import_history')).rows.length === 1, 'but it can read');
      } finally {
        client.release();
      }
    });

    await test('the schema REFUSES a history row carrying a path, or an unknown outcome', async () => {
      for (const [what, args] of [
        ['a path in the file name', ['cli', 'x', '../../etc/passwd', 'a'.repeat(64), 'b'.repeat(64), 0, 0, 0, 0, 0, 0, 'complete']],
        ['a file name with a separator', ['cli', 'x', 'a/b.json', 'a'.repeat(64), 'b'.repeat(64), 0, 0, 0, 0, 0, 0, 'complete']],
        ['an unknown outcome', ['cli', 'x', 'a.json', 'a'.repeat(64), 'b'.repeat(64), 0, 0, 0, 0, 0, 0, 'whatever']],
        ['an unknown actor', ['browser', 'x', 'a.json', 'a'.repeat(64), 'b'.repeat(64), 0, 0, 0, 0, 0, 0, 'complete']],
        ['a digest that is not one', ['cli', 'x', 'a.json', 'not-a-digest', 'b'.repeat(64), 0, 0, 0, 0, 0, 0, 'complete']],
        ['a negative count', ['cli', 'x', 'a.json', 'a'.repeat(64), 'b'.repeat(64), -1, 0, 0, 0, 0, 0, 'complete']],
      ] as Array<[string, unknown[]]>) {
        let refused = false;
        try {
          await admin.query('SELECT cat_import_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', args);
        } catch { refused = true; }
        assert(refused, `the schema accepted ${what}`);
      }
    });

    const before = await counts();

    let confirmation = '';
    await test('a PREVIEW over HTTP writes nothing at all, and says so', async () => {
      const res = await post(IMPORT_PREVIEW_ROUTE, { file: 'library.json' });
      assertEq(res.status, 200, `preview answered ${res.status}: ${res.body}`);
      const body = JSON.parse(res.body) as { wrote: string; preview: { created: number; total: number }; confirmation: string };
      assertEq(body.wrote, 'nothing', 'the preview does not announce itself as a preview');
      assertEq(body.preview.total, 4, 'the preview did not read every record');
      assertEq(body.preview.created, 4, 'the preview did not plan four creates');
      assert(typeof body.confirmation === 'string' && body.confirmation.length > 0, 'no confirmation was issued');
      confirmation = body.confirmation;
      // No content of any kind in the response.
      assert(!res.body.includes(SECRET_REF), 'the preview echoed a provider reference value');
      assert(!res.body.includes('Phase 264 Record'), 'the preview echoed a title');
      const after = await counts();
      assertEq(after.items, before.items, 'the preview created rows');
      assertEq(after.events, before.events, 'the preview appended events');
      assertEq(after.history, before.history, 'the preview wrote a history row');
    });

    await test('an APPLY with a STALE confirmation is refused, with nothing written', async () => {
      const stale = new ImportConfirmations(() => 1).issue({
        name: 'library.json', bytes: 1, contentDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64),
        source: 'my-library', updateExisting: false,
      });
      const res = await post(IMPORT_APPLY_ROUTE, { file: 'library.json', confirmation: stale });
      assertEq(res.status, 409, `a foreign confirmation answered ${res.status}: ${res.body}`);
      assert(res.body.includes('CONFIRMATION_'), 'the refusal does not name the confirmation');
      assertEq((await counts()).items, before.items, 'a refused apply wrote rows');
    });

    await test('an APPLY of a SUBSTITUTED file is refused, with nothing written', async () => {
      const preview = JSON.parse((await post(IMPORT_PREVIEW_ROUTE, { file: 'library.json' })).body) as { confirmation: string };
      // The classic race: the operator previewed one file and the host replaced it before they confirmed.
      writeFileSync(join(inbox, 'library.json'), snapshotJson(9));
      const res = await post(IMPORT_APPLY_ROUTE, { file: 'library.json', confirmation: preview.confirmation });
      assertEq(res.status, 409, `a substituted file answered ${res.status}: ${res.body}`);
      assert(res.body.includes('FILE_CHANGED'), 'the refusal does not name the substitution');
      assertEq((await counts()).items, before.items, 'a substituted apply wrote rows');
      writeFileSync(join(inbox, 'library.json'), snapshotJson(4));
    });

    await test('an APPLY confirming a DIFFERENT file than the one previewed is refused', async () => {
      writeFileSync(join(inbox, 'other.json'), snapshotJson(2, 'other-library'));
      const preview = JSON.parse((await post(IMPORT_PREVIEW_ROUTE, { file: 'other.json' })).body) as { confirmation: string };
      const res = await post(IMPORT_APPLY_ROUTE, { file: 'library.json', confirmation: preview.confirmation });
      assertEq(res.status, 409, `a mismatched apply answered ${res.status}: ${res.body}`);
      assertEq((await counts()).items, before.items, 'a mismatched apply wrote rows');
      rmSync(join(inbox, 'other.json'), { force: true });
    });

    await test('an APPLY with the RIGHT confirmation imports exactly what was previewed', async () => {
      const preview = JSON.parse((await post(IMPORT_PREVIEW_ROUTE, { file: 'library.json' })).body) as { confirmation: string };
      const res = await post(IMPORT_APPLY_ROUTE, { file: 'library.json', confirmation: preview.confirmation });
      assertEq(res.status, 200, `apply answered ${res.status}: ${res.body}`);
      const body = JSON.parse(res.body) as { ok: boolean; recorded: boolean; result: { created: number; total: number } };
      assertEq(body.ok, true, 'the apply reported a failure');
      assertEq(body.result.created, 4, 'the apply did not create four records');
      assertEq(body.recorded, true, 'the apply did not record itself in the history');
      assert(!res.body.includes(SECRET_REF), 'the apply echoed a provider reference value');
      assert(!res.body.includes('Phase 264 Record'), 'the apply echoed a title');
      const after = await counts();
      assertEq(after.items, before.items + 4, 'the apply did not create four rows');
      assertEq(after.history, before.history + 1, 'the apply did not append one history row');
      // ...and that confirmation is now spent.
      const replay = await post(IMPORT_APPLY_ROUTE, { file: 'library.json', confirmation: preview.confirmation });
      assertEq(replay.status, 409, 'a replayed confirmation was accepted');
    });

    await test('the history row is identity-free: counts and digests, never content', async () => {
      const { rows } = await admin.query('SELECT * FROM import_history ORDER BY id DESC LIMIT 1');
      const row = rows[0] as Record<string, unknown>;
      assertEq(row.actor, 'operator-ui', 'the actor is the browser surface');
      assertEq(row.source, 'my-library', 'the source label is the snapshot\'s own');
      assertEq(row.file_name, 'library.json', 'the file name is a base name');
      assertEq(row.created, 4, 'the counts are the import\'s');
      assertEq(row.outcome, 'complete', 'the outcome');
      const serialised = JSON.stringify(row);
      assert(!serialised.includes(SECRET_REF), 'the history row holds a provider reference value');
      assert(!serialised.includes('Phase 264 Record'), 'the history row holds a title');
      assert(!serialised.includes('p264-'), 'the history row holds an external id');
      assert(!serialised.includes(WORK) && !serialised.includes(inbox), 'the history row holds a path');
    });

    await test('applying the SAME snapshot again changes nothing, and says so', async () => {
      const middle = await counts();
      const preview = JSON.parse((await post(IMPORT_PREVIEW_ROUTE, { file: 'library.json' })).body) as {
        confirmation: string; preview: { created: number; unchanged: number };
      };
      assertEq(preview.preview.created, 0, 'the repeat preview planned creates');
      assertEq(preview.preview.unchanged, 4, 'the repeat preview did not recognise every record');
      const res = await post(IMPORT_APPLY_ROUTE, { file: 'library.json', confirmation: preview.confirmation });
      assertEq(res.status, 200, `the repeat apply answered ${res.status}: ${res.body}`);
      const after = await counts();
      assertEq(after.items, middle.items, 'the repeat import changed the item count');
      assertEq(after.events, middle.events, 'the repeat import appended events');
      // The history DOES grow: "I ran an import and it changed nothing" is a fact worth keeping.
      assertEq(after.history, middle.history + 1, 'the repeat import was not recorded');
    });

    await test('the history route serves what was written, newest first, bounded', async () => {
      const res = await live(IMPORT_HISTORY_ROUTE, { token: TOKEN });
      assertEq(res.status, 200, `the history answered ${res.status}: ${res.body}`);
      const body = JSON.parse(res.body) as { entries: Array<{ source: string; created: number; appliedAt: string }>; limit: number };
      assert(body.entries.length >= 2, 'the history does not hold both imports');
      assertEq(body.entries[0]!.created, 0, 'the newest entry is not first');
      assertEq(body.entries[1]!.created, 4, 'the older entry is not second');
      assert(!res.body.includes(SECRET_REF) && !res.body.includes('Phase 264 Record'), 'the history leaked content');
    });

    await test('the COMMAND LINE writes to the same history, through the same implementation', async () => {
      const { getPool } = await import('../src/db/pool.js');
      const { CatalogAuthority } = await import('../src/core/catalog/authority.js');
      const { createCustodian, loadCustodianConfig } = await import('../src/core/crypto/custodian-factory.js');
      const { createExistingStateLookup } = await import('../src/ops/catalog-import.js');
      const { applyImport, readCliSnapshot } = await import('../src/ops/catalog-import-service.js');
      const { createImportHistoryStore } = await import('../src/ops/import-history.js');

      writeFileSync(join(inbox, 'cli.json'), snapshotJson(2, 'cli-library'));
      const snapshot = readCliSnapshot('cli.json', process.env);
      const applied = await applyImport({
        text: snapshot.text,
        lookup: createExistingStateLookup(getPool()),
        authority: new CatalogAuthority(getPool(), createCustodian(loadCustodianConfig())),
        history: createImportHistoryStore(getPool()),
        actor: 'cli',
        fileName: snapshot.fileName,
      });
      assertEq(applied.result.created, 2, 'the CLI import did not create two records');
      assertEq(applied.recorded, true, 'the CLI import was not recorded');
      const { rows } = await admin.query('SELECT actor, source, file_name FROM import_history ORDER BY id DESC LIMIT 1');
      assertEq(rows[0].actor, 'cli', 'the CLI import was recorded as the wrong actor');
      assertEq(rows[0].source, 'cli-library', 'the CLI import recorded the wrong source');
      assertEq(rows[0].file_name, 'cli.json', 'the CLI import recorded the wrong file');
      rmSync(join(inbox, 'cli.json'), { force: true });
    });

    await test('a MALFORMED snapshot is refused whole, with every problem named and nothing written', async () => {
      writeFileSync(join(inbox, 'broken.json'), JSON.stringify({
        format: 'catalog-authority.snapshot',
        version: 1,
        source: 'broken-library',
        items: [
          { externalId: 'ok-1', title: '' },
          { externalId: 'ok-2', title: 'Fine', year: 'nineteen ninety' },
          { externalId: 'ok-3', title: 'Fine', providerRefs: [{ type: 'not-a-provider', value: 'x' }] },
        ],
      }));
      const middle = await counts();
      const res = await post(IMPORT_PREVIEW_ROUTE, { file: 'broken.json' });
      assertEq(res.status, 400, `a malformed snapshot answered ${res.status}`);
      const body = JSON.parse(res.body) as { problems: string[] };
      assert(body.problems.length >= 3, 'the refusal did not list every problem');
      assert(body.problems.every((p) => /item \d+/.test(p)), 'a problem does not name a position');
      assertEq((await counts()).items, middle.items, 'a rejected snapshot wrote rows');
      rmSync(join(inbox, 'broken.json'), { force: true });
    });

    await test('nothing in the service log buffer carries a token, a path or record content', async () => {
      const res = await live('/api/logs', { token: TOKEN });
      assertEq(res.status, 200, 'the log route answered');
      assert(!res.body.includes(TOKEN), 'the log buffer holds the operator token');
      assert(!res.body.includes(SECRET_REF), 'the log buffer holds a provider reference value');
      assert(!res.body.includes('Phase 264 Record'), 'the log buffer holds a title');
      assert(!res.body.includes('library.json'), 'the log buffer holds a file name');
      assert(!res.body.includes(WORK), 'the log buffer holds a path');
    });

    await new Promise<void>((resolve) => { liveServer.close(() => resolve()); });
    await admin.end();
    await closePool();
    if (pg !== undefined) await pg.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? String(err)}`);
  rmSync(WORK, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

/** A port the OS just told us is free. Deterministic enough, and never collides with a sibling suite. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
