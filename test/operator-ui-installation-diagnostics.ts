import { createServer as createNetServer } from 'node:net';
import { Script } from 'node:vm';
import { request, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asMap, parseYaml, yamlStrings, type YamlMap } from './helpers/compose-yaml.js';
import { removeQuietly } from '../src/ops/usable-shell.js';
import {
  createOperatorUiServiceServer,
  buildInstallationReadiness,
  escapeHtml,
  validateOperatorUiServiceConfig,
} from '../src/ops/operator-ui-service.js';
import {
  loadOperatorUiLocalAuthRuntime,
  OPERATOR_UI_LOCAL_AUTH_HEADER,
} from '../src/ops/operator-ui-local-auth-runtime.js';
import {
  buildRuntimeVersionView,
  describeImageRef,
  DEVELOPMENT_VERSION,
  RUNTIME_BUILT_AT_ENV,
  RUNTIME_BUNDLE_VERSION_ENV,
  RUNTIME_IMAGE_REF_ENV,
  RUNTIME_REVISION_ENV,
  RUNTIME_VERSION_ENV,
} from '../src/ops/operator-ui-runtime-version.js';
import {
  collectStaticFacts,
  deriveInstallationReadiness,
  inspectDirectory,
  inspectSecretFile,
  summarizeChainSnapshot,
  SECRET_FILE_IDS,
  type ChainFact,
  type DatabaseFact,
  type ReadinessFacts,
  type RecordsFact,
  type SecretFileFact,
} from '../src/ops/operator-ui-installation-readiness.js';
import {
  firstRunChecklist,
  troubleshootingTable,
  REPOSITORY_COMPOSE_NOTE,
  TOKEN_HANDLING_NOTE,
} from '../src/ops/operator-ui-first-run-checklist.js';
import {
  assertSupportReportIsRedactionSafe,
  buildSupportReport,
  renderSupportReportJson,
  renderSupportReportText,
  SupportReportRedactionError,
} from '../src/ops/operator-ui-support-report.js';
import {
  buildConsumerReleaseBundle,
  RELEASE_IMAGE_REPOSITORY,
  RELEASE_IMAGE_TAG,
  type BundleSources,
} from '../src/ops/consumer-release-bundle.js';

// Phase 246 — first-run onboarding and operational diagnostics.
//
// The defect this phase closes is not a crash. It is that a person could extract the release bundle, start
// Compose, open the UI, and have no way to tell a working installation from a broken one: the page offered a
// doctor report written for whoever built it, a promotion panel that says "unavailable" whether the folder is
// empty or the mount is wrong, and no version at all. So the tests here are mostly about what is SAID, and
// about the two ways saying more can go wrong — saying something untrue, and saying something private.

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

console.log('Running Phase 246 installation diagnostics suite:\n');

// ---------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------

interface HttpResult {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function httpGet(port: number, path: string, token?: string, method = 'GET'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers[OPERATOR_UI_LOCAL_AUTH_HEADER] = token;
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') { probe.close(); reject(new Error('no port')); return; }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

const TOKEN = 'phase246-operator-token-abcdefgh';

interface Harness {
  readonly port: number;
  readonly workspace: string;
  readonly recordsDir: string;
  readonly stop: () => Promise<void>;
}

/**
 * A real server, on a real socket, with a real token file.
 *
 * The alternative — calling the request handler with a fake response object — would pass while the routing,
 * the header hardening and the auth check were all wrong, because none of those live in the handler bodies.
 */
async function startHarness(): Promise<Harness> {
  const workspace = mkdtempSync(join(tmpdir(), 'phase246-'));
  const secretFile = join(workspace, 'operator_ui_token');
  writeFileSync(secretFile, `${TOKEN}\n`);
  const recordsDir = join(workspace, 'promotion-records');
  mkdirSync(recordsDir);

  const port = await freePort();
  const config = validateOperatorUiServiceConfig({
    host: '127.0.0.1', port, operatorSecretFile: secretFile, promotionRecordsDir: '/var/lib/catalog/promotion-records',
  });
  const auth = loadOperatorUiLocalAuthRuntime(secretFile);
  const server: Server = createOperatorUiServiceServer({ ...config, promotionRecordsDir: recordsDir }, auth);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port,
    workspace,
    recordsDir,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      removeQuietly(workspace);
    },
  };
}

/** Facts with everything healthy, so a test can change exactly one thing and name what it changed. */
function healthyFacts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    version: buildRuntimeVersionView({
      [RUNTIME_VERSION_ENV]: 'v1.0.0',
      [RUNTIME_REVISION_ENV]: 'abcdef1234567',
      [RUNTIME_BUNDLE_VERSION_ENV]: 'v1.0.0',
    }),
    database: 'OK',
    secrets: SECRET_FILE_IDS.map((id) => ({ id, state: 'OK' as const })),
    records: 'OK',
    chain: 'HEALTHY',
    artifacts: { present: 10, expected: 10, blockers: 0, terminalPhase: 241, nextRequiredPhase: null },
    keystore: 'OK',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Authentication: the new routes are operational routes
// ---------------------------------------------------------------------------------------------------------

await test('the diagnostics routes require the operator token, exactly like every other operational route', async () => {
  const h = await startHarness();
  try {
    for (const path of ['/api/installation', '/api/version']) {
      const anonymous = await httpGet(h.port, path);
      assertEq(anonymous.statusCode, 401, `${path} refuses an anonymous request`);
      const parsed = JSON.parse(anonymous.body) as { code: string; ok: boolean };
      assertEq(parsed.ok, false, `${path} says so in the body`);
      assertEq(parsed.code, 'OPERATOR_UI_SERVICE_UNAUTHORIZED', `${path} uses the established refusal code`);

      const wrong = await httpGet(h.port, path, 'not-the-token-but-long-enough-x');
      assertEq(wrong.statusCode, 401, `${path} refuses a wrong token`);

      const authorized = await httpGet(h.port, path, TOKEN);
      assertEq(authorized.statusCode, 200, `${path} answers a correct token`);
    }
  } finally { await h.stop(); }
});

await test('a refusal never reveals whether the token was close, and never echoes what was sent', async () => {
  const h = await startHarness();
  try {
    const probe = `${TOKEN}x`;
    const res = await httpGet(h.port, '/api/installation', probe);
    assertEq(res.statusCode, 401, 'a near-miss token is still refused');
    assert(!res.body.includes(probe), 'and the presented value is not echoed back');
    assert(!res.body.includes(TOKEN), 'and the expected value is certainly not');
    const empty = await httpGet(h.port, '/api/installation', '');
    assertEq(empty.statusCode, 401, 'an empty token is refused');
    assertEq(empty.body, (await httpGet(h.port, '/api/installation', 'short')).body,
      'and every refusal is byte-identical, so nothing can be learned by comparing them');
  } finally { await h.stop(); }
});

await test('only GET reaches the diagnostics routes', async () => {
  const h = await startHarness();
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await httpGet(h.port, '/api/installation', TOKEN, method);
      assertEq(res.statusCode, 405, `${method} is refused with method-not-allowed`);
      assertEq(res.headers.allow, 'GET', `and ${method} is told what is allowed`);
    }
    const head = await httpGet(h.port, '/api/version', TOKEN, 'HEAD');
    assertEq(head.statusCode, 405, 'HEAD is refused too');
    assertEq(head.body, '', 'with no body, as HEAD requires');
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------------------------------------
// /healthz stays minimal and unauthenticated
// ---------------------------------------------------------------------------------------------------------

await test('/healthz is still unauthenticated, still minimal, and still says nothing about this install', async () => {
  const h = await startHarness();
  try {
    const res = await httpGet(h.port, '/healthz');
    assertEq(res.statusCode, 200, 'it answers without a token');
    const body = JSON.parse(res.body) as Record<string, unknown>;
    assertEq(Object.keys(body).sort().join(','), 'code,mode,ok,service', 'and carries exactly the four keys it always did');
    for (const forbidden of ['version', 'revision', 'state', 'readiness', 'components', 'database', 'secrets']) {
      assert(!(forbidden in body), `/healthz does not leak ${forbidden} to an unauthenticated caller`);
    }
    assert(!res.body.includes('READY') && !res.body.includes('NEEDS_SETUP') && !res.body.includes('DEGRADED'),
      'and never carries an installation verdict');
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------------------------------------
// Leakage: what the authenticated payload may and may not contain
// ---------------------------------------------------------------------------------------------------------

await test('the readiness payload carries states, never the things it inspected', async () => {
  const h = await startHarness();
  try {
    const res = await httpGet(h.port, '/api/installation', TOKEN);
    const body = res.body;
    // A path in a JSON string is backslash-escaped, so searching for the raw value would miss it. Both
    // spellings are checked, because "we looked and found nothing" is only worth saying if we looked properly.
    for (const [what, value] of [['records directory', h.recordsDir], ['workspace', h.workspace]] as const) {
      assert(!body.includes(value), `the ${what} is not in the response`);
      assert(!body.includes(value.replace(/\\/g, '\\\\')), `nor is the ${what} in its JSON-escaped spelling`);
    }
    assert(!body.includes(TOKEN), 'the operator token is not in the response');
    assert(!/postgres(?:ql)?:\/\//i.test(body), 'no database URL reaches the response');
    assert(!/\/run\/secrets\//.test(body), 'no secret file path reaches the response');

    // The installation-specific half of the payload carries no path of any shape. The checklist half is
    // shipped guidance that legitimately contains placeholders like `C:\path\to\your\artifacts`, and is
    // held to its own rule by the checklist tests below.
    const parsed = JSON.parse(body) as { readiness: { components: { id: string; state: string; detail: string }[] } };
    const readinessOnly = JSON.stringify(parsed.readiness);
    assert(!/[A-Za-z]:\\\\/.test(readinessOnly), 'the verdict contains no Windows filesystem path');
    assert(!/\/(?:home|root|Users|var|run|etc|mnt|tmp)\//.test(readinessOnly), 'and no POSIX filesystem path');
    for (const component of parsed.readiness.components) {
      assert(component.detail.length > 0, `${component.id} has a description`);
      assert(!component.detail.includes(h.workspace), `${component.id} does not name a path`);
    }
  } finally { await h.stop(); }
});

await test('the log line for a readiness read carries the verdict and nothing about the installation', async () => {
  const h = await startHarness();
  try {
    await httpGet(h.port, '/api/installation', TOKEN);
    const logs = JSON.parse((await httpGet(h.port, '/api/logs', TOKEN)).body) as {
      entries: { code: string; message: string }[];
    };
    const entry = logs.entries.find((candidate) => candidate.code === 'INSTALLATION_READ');
    assert(entry !== undefined, 'the read is logged');
    assert(/state=(READY|NEEDS_SETUP|DEGRADED)\.$/.test(entry!.message), 'the message is the verdict alone');
    assert(!entry!.message.includes(h.recordsDir), 'and never a path');
    for (const other of logs.entries) {
      assert(!other.message.includes(TOKEN), 'no log entry contains the operator token');
    }
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------------------------------------
// XSS and CSP
// ---------------------------------------------------------------------------------------------------------

await test('everything server-rendered into the page is escaped, and the escaper covers every dangerous character', () => {
  assertEq(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;', 'tags cannot survive');
  assertEq(escapeHtml('a & b'), 'a &amp; b', 'ampersands are escaped first, so nothing is double-decoded');
  assertEq(escapeHtml('" onload="x'), '&quot; onload=&quot;x', 'a double quote cannot end an attribute');
  assertEq(escapeHtml("' onload='x"), '&#39; onload=&#39;x', 'nor can a single quote');
  assertEq(escapeHtml('&amp;'), '&amp;amp;', 'an already-escaped entity is escaped again rather than passed through');
});

await test('the shipped checklist and troubleshooting text contains nothing that could become markup', () => {
  const strings: string[] = [];
  for (const step of firstRunChecklist()) {
    strings.push(step.id, step.title, step.why);
    if (step.commands !== null) strings.push(step.commands.posix, step.commands.windows);
  }
  for (const entry of troubleshootingTable()) {
    strings.push(entry.id, entry.symptom, entry.likelyCause, entry.fix);
    if (entry.commands !== null) strings.push(entry.commands.posix, entry.commands.windows);
  }
  // A shell redirect is a legitimate `>` in a command, so the rule is not "no angle brackets" -- it is that
  // escaping neutralises every one of them. Anything that survives escaping could open an element.
  for (const value of strings) {
    const escaped = escapeHtml(value);
    assert(!/[<>]/.test(escaped), `shipped guidance cannot produce markup after escaping: ${value.slice(0, 60)}`);
    assert(!/["']/.test(escaped.replace(/&quot;|&#39;/g, '')), `nor break out of an attribute: ${value.slice(0, 60)}`);
  }
  // And the one command that genuinely contains a redirect must reach the page escaped, not stripped.
  const backup = firstRunChecklist().find((step) => step.id === 'back-up')!;
  assert(backup.commands!.posix.includes('>'), 'the backup command really does contain a redirect');
  assert(escapeHtml(backup.commands!.posix).includes('&gt;'), 'which is escaped rather than removed');
});

await test('the page shell escapes its guidance and serves the hardened headers the rest of the UI has', async () => {
  const h = await startHarness();
  try {
    const res = await httpGet(h.port, '/');
    assertEq(res.statusCode, 200, 'the shell is served without a token');
    const csp = String(res.headers['content-security-policy'] ?? '');
    for (const directive of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "img-src 'none'"]) {
      assert(csp.includes(directive), `the shell still declares ${directive}`);
    }
    assertEq(res.headers['x-content-type-options'], 'nosniff', 'sniffing stays disabled');
    assertEq(res.headers['x-frame-options'], 'DENY', 'framing stays denied');
    assertEq(res.headers['referrer-policy'], 'no-referrer', 'the referrer stays unsent');
    assertEq(res.headers['cache-control'], 'no-store', 'and nothing about this page is cached');

    // The apostrophe in the shipped guidance proves the escaper actually ran over it.
    assert(res.body.includes('&#39;'), 'server-rendered guidance went through the escaper');
    assert(!res.body.includes(TOKEN), 'the operator token is never in the HTML');
    assert(!/value="[^"]*token/i.test(res.body), 'and no input is pre-filled with one');
  } finally { await h.stop(); }
});

await test('the page\'s external script parses, and every element it reaches for exists', async () => {
  // Phase 247 moved the behaviour to /assets/app.js so the CSP can be `script-src 'self'`. It still must
  // parse, and every id it reaches for must exist in the shell: a syntax error or a renamed panel would
  // leave a page that renders and then does nothing, and every server-side test would still pass.
  const h = await startHarness();
  try {
    const html = (await httpGet(h.port, '/')).body;
    assert(/<script src="\/assets\/app\.js" defer><\/script>/.test(html), 'the page references the external app.js');
    assert(!/<script>[\s\S]*?<\/script>/.test(html), 'and carries no inline script of its own');
    const source = (await httpGet(h.port, '/assets/app.js')).body;
    // Parse-only: `new Script` compiles without running, which is what we want in a suite with no DOM.
    new Script(source, { filename: 'operator-ui-app.js' });

    const ids = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((match) => match[1]!));
    const referenced = [...source.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map((match) => match[1]!);
    assert(referenced.length > 20, 'the script wires up the panels');
    for (const id of referenced) assert(ids.has(id), `the script reaches for #${id}, which the page defines`);
  } finally { await h.stop(); }
});

await test('the token is never put anywhere a browser would persist it', async () => {
  const h = await startHarness();
  try {
    const res = await httpGet(h.port, '/');
    const script = (await httpGet(h.port, '/assets/app.js')).body;
    assert(res.headers['set-cookie'] === undefined, 'no cookie is ever set');
    // Neither the shell nor the behaviour touches any browser persistence or the URL.
    for (const surface of [res.body, script]) {
      for (const banned of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB']) {
        assert(!surface.includes(banned), `the page never touches ${banned}`);
      }
      assert(!/location\.(search|hash)/.test(surface), 'and never reads the token out of a URL');
    }
    assert(script.includes(`'${OPERATOR_UI_LOCAL_AUTH_HEADER}'`), 'the token travels as the established request header');
    const authed = await httpGet(h.port, '/api/installation', TOKEN);
    assert(authed.headers['set-cookie'] === undefined, 'an authenticated response sets no cookie either');
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------------------------------------
// Categorical derivation — the pure function, exhaustively
// ---------------------------------------------------------------------------------------------------------

await test('everything healthy is READY, and READY is stated not to be an authorization', () => {
  const readiness = deriveInstallationReadiness(healthyFacts());
  assertEq(readiness.state, 'READY', 'a healthy installation is READY');
  assertEq(readiness.ok, true, 'and ok');
  assertEq(readiness.nextSteps.length, 0, 'with nothing outstanding');
  assertEq(readiness.promotionAuthorization, 'NOT_IMPLIED', 'and it says it authorizes nothing');
  assert(/not an approval, an authorization or a verdict/.test(readiness.authorizationNote),
    'in a sentence a reviewer cannot misread');
  assert(readiness.components.every((component) => component.severity === 'SATISFIED'), 'every component is satisfied');
});

await test('an unfinished install is NEEDS_SETUP; a broken one is DEGRADED; a fault outranks a missing step', () => {
  const missingSecrets = deriveInstallationReadiness(healthyFacts({
    secrets: SECRET_FILE_IDS.map((id) => ({ id, state: id === 'custodian_kek' ? 'MISSING' as const : 'OK' as const })),
  }));
  assertEq(missingSecrets.state, 'NEEDS_SETUP', 'a secret file that was never generated is a setup step');
  assert(missingSecrets.nextSteps.includes('generate-secrets'), 'and the fix is the setup script');

  const unreadable = deriveInstallationReadiness(healthyFacts({
    secrets: SECRET_FILE_IDS.map((id) => ({ id, state: id === 'custodian_kek' ? 'UNREADABLE' as const : 'OK' as const })),
  }));
  assertEq(unreadable.state, 'DEGRADED', 'a secret file that exists and cannot be read is a fault');

  // The precedence that matters: told to run the setup script while the database is refusing connections,
  // a person goes and does the wrong thing.
  const both = deriveInstallationReadiness(healthyFacts({
    database: 'UNREACHABLE',
    records: 'MISSING',
  }));
  assertEq(both.state, 'DEGRADED', 'a fault alongside an unfinished step reports the fault');
});

await test('each database fact maps to the state and severity an installer should act on', () => {
  const cases: ReadonlyArray<readonly [DatabaseFact, string, string]> = [
    ['OK', 'OK', 'SATISFIED'],
    ['SCHEMA_MISSING', 'MISSING', 'SETUP_REQUIRED'],
    ['SCHEMA_STALE', 'MALFORMED', 'IMPAIRED'],
    ['UNREACHABLE', 'UNREACHABLE', 'IMPAIRED'],
    ['NOT_CONFIGURED', 'NOT_CONFIGURED', 'SETUP_REQUIRED'],
    ['NOT_PROBED', 'UNKNOWN', 'ADVISORY'],
  ];
  for (const [fact, state, severity] of cases) {
    const component = deriveInstallationReadiness(healthyFacts({ database: fact }))
      .components.find((candidate) => candidate.id === 'database')!;
    assertEq(component.state, state, `${fact} reports state ${state}`);
    assertEq(component.severity, severity, `${fact} reports severity ${severity}`);
    assert(!component.detail.includes(fact) || fact === 'OK', `${fact}'s description is prose, not the enum`);
  }
  // A report that did not contact the database must not be able to claim the database is fine.
  assertEq(deriveInstallationReadiness(healthyFacts({ database: 'NOT_PROBED' })).state, 'READY',
    'not probing does not manufacture a fault');
});

await test('an empty records folder is a setup step on a fresh install, and an unreadable one is a fault', () => {
  const cases: ReadonlyArray<readonly [RecordsFact, string]> = [
    ['OK', 'READY'], ['EMPTY', 'NEEDS_SETUP'], ['MISSING', 'NEEDS_SETUP'], ['UNREADABLE', 'DEGRADED'],
  ];
  for (const [fact, expected] of cases) {
    // The chain follows the folder: an empty folder cannot have a healthy chain in it.
    const chain: ChainFact = fact === 'OK' ? 'HEALTHY' : 'UNAVAILABLE';
    assertEq(deriveInstallationReadiness(healthyFacts({ records: fact, chain })).state, expected,
      `a ${fact} records folder makes the installation ${expected}`);
  }
});

await test('a chain that does not hang together is a fault, and an absent one is not', () => {
  assertEq(deriveInstallationReadiness(healthyFacts({ chain: 'UNHEALTHY' })).state, 'DEGRADED',
    'a chain that contradicts itself is degraded');
  assertEq(deriveInstallationReadiness(healthyFacts({ chain: 'UNAVAILABLE', artifacts: null })).state, 'NEEDS_SETUP',
    'and no chain at all is simply not set up yet');
  const unhealthy = deriveInstallationReadiness(healthyFacts({ chain: 'UNHEALTHY' }));
  assert(unhealthy.components.some((c) => c.id === 'promotion-chain' && /see the promotion panel/i.test(c.detail)),
    'a broken chain points at the panel that lists the specific blockers rather than repeating them here');
});

await test('a version mismatch is DEGRADED, and a development build is only an advisory', () => {
  const mismatch = deriveInstallationReadiness(healthyFacts({
    version: buildRuntimeVersionView({
      [RUNTIME_VERSION_ENV]: 'v1.0.0',
      [RUNTIME_REVISION_ENV]: 'abcdef1234567',
      [RUNTIME_BUNDLE_VERSION_ENV]: 'v2.0.0',
    }),
  }));
  assertEq(mismatch.state, 'DEGRADED', 'an image that disagrees with its bundle is a fault, not a footnote');
  assert(mismatch.nextSteps.includes('upgrade'), 'and the fix is to make one of them match the other');

  const dev = deriveInstallationReadiness(healthyFacts({
    version: buildRuntimeVersionView({ [RUNTIME_VERSION_ENV]: DEVELOPMENT_VERSION }),
  }));
  assertEq(dev.state, 'READY', 'a development build is perfectly usable');
  assert(dev.advisories.some((note) => /development build/i.test(note)), 'and is said to be a development build');

  const unknown = deriveInstallationReadiness(healthyFacts({ version: buildRuntimeVersionView({}) }));
  assertEq(unknown.state, 'READY', 'an unidentified version does not make an install unusable');
  assert(unknown.advisories.some((note) => /Nothing is guessed/i.test(note)), 'but nothing is invented to fill the gap');
});

await test('the next steps are ordered by what to do first, and never repeat a step', () => {
  const readiness = deriveInstallationReadiness(healthyFacts({
    secrets: SECRET_FILE_IDS.map((id) => ({ id, state: 'MISSING' as const })),
    database: 'NOT_CONFIGURED',
    records: 'MISSING',
    chain: 'UNAVAILABLE',
    artifacts: null,
    keystore: 'MISSING',
  }));
  assertEq(readiness.state, 'NEEDS_SETUP', 'a completely fresh extraction is not a fault');
  assertEq(readiness.nextSteps.join(','), 'generate-secrets,start-stack,place-records',
    'the steps are in the order a person performs them, deduplicated');
  const known = new Set(firstRunChecklist().map((step) => step.id));
  for (const step of readiness.nextSteps) assert(known.has(step), `${step} is a real checklist step`);
});

// ---------------------------------------------------------------------------------------------------------
// Collection from a real filesystem
// ---------------------------------------------------------------------------------------------------------

await test('a secret file is judged by presence and shape, and its contents never leave the inspector', () => {
  const ws = mkdtempSync(join(tmpdir(), 'phase246-secrets-'));
  try {
    assertEq(inspectSecretFile('database_url', undefined).state, 'MISSING', 'an unset variable is missing');
    assertEq(inspectSecretFile('database_url', join(ws, 'nope')).state, 'MISSING', 'so is a file that is not there');

    const empty = join(ws, 'empty'); writeFileSync(empty, '');
    assertEq(inspectSecretFile('completion_secret', empty).state, 'EMPTY', 'an empty file is empty');
    const blank = join(ws, 'blank'); writeFileSync(blank, '   \n');
    assertEq(inspectSecretFile('completion_secret', blank).state, 'EMPTY', 'and so is whitespace');

    const url = join(ws, 'url'); writeFileSync(url, 'postgresql://app:pw@postgres:5432/catalog\n');
    assertEq(inspectSecretFile('database_url', url).state, 'OK', 'a database URL with the right scheme is usable');
    const notUrl = join(ws, 'not-url'); writeFileSync(notUrl, 'this is not a connection string\n');
    assertEq(inspectSecretFile('database_url', notUrl).state, 'MALFORMED', 'and one without it is malformed');

    const weak = join(ws, 'weak'); writeFileSync(weak, 'aaaaaaaaaaaaaaaaaaaaaaaa\n');
    assertEq(inspectSecretFile('operator_ui_token', weak).state, 'WEAK',
      'a token the auth runtime would refuse is reported as weak rather than as fine');
    const good = join(ws, 'good'); writeFileSync(good, `${TOKEN}\n`);
    assertEq(inspectSecretFile('operator_ui_token', good).state, 'OK', 'and a real one is OK');

    // The whole point: one word out, never the value.
    const fact: SecretFileFact = inspectSecretFile('database_url', url);
    assertEq(Object.keys(fact).sort().join(','), 'id,state', 'a secret fact is an id and a state, and nothing else');
    assert(!JSON.stringify(fact).includes('postgres'), 'the value is not in the fact');
  } finally { removeQuietly(ws); }
});

await test('a directory is judged present, empty, or unreadable, and the path is not in the answer', () => {
  const ws = mkdtempSync(join(tmpdir(), 'phase246-dirs-'));
  try {
    assertEq(inspectDirectory(undefined), 'MISSING', 'an unset directory is missing');
    assertEq(inspectDirectory(join(ws, 'nope')), 'MISSING', 'so is one that does not exist');
    const empty = join(ws, 'empty'); mkdirSync(empty);
    assertEq(inspectDirectory(empty), 'EMPTY', 'an existing empty directory is empty, not missing');
    writeFileSync(join(empty, 'artifact.json'), '{}');
    assertEq(inspectDirectory(empty), 'OK', 'and one with something in it is OK');
    const file = join(ws, 'a-file'); writeFileSync(file, 'x');
    assertEq(inspectDirectory(file), 'MISSING', 'a file where a directory should be is not a directory');
  } finally { removeQuietly(ws); }
});

await test('static collection reads the filesystem and the environment, and contacts nothing', () => {
  const ws = mkdtempSync(join(tmpdir(), 'phase246-collect-'));
  try {
    const records = join(ws, 'records'); mkdirSync(records);
    const token = join(ws, 'operator_ui_token'); writeFileSync(token, `${TOKEN}\n`);
    const facts = collectStaticFacts({
      promotionRecordsDir: records,
      env: { OPERATOR_UI_TOKEN_FILE: token, [RUNTIME_VERSION_ENV]: 'v1.0.0', [RUNTIME_REVISION_ENV]: 'abcdef1' },
    });
    assertEq(facts.records, 'EMPTY', 'the records folder state is read from disk');
    assertEq(facts.keystore, 'NOT_CONFIGURED', 'an unconfigured keystore says so rather than guessing');
    assertEq(facts.secrets.find((secret) => secret.id === 'operator_ui_token')!.state, 'OK', 'the token file is inspected');
    assertEq(facts.secrets.find((secret) => secret.id === 'custodian_kek')!.state, 'MISSING', 'and an absent one is missing');
    assertEq(facts.version.version, 'v1.0.0', 'the version comes from the environment it was given');
    assertEq(facts.secrets.length, SECRET_FILE_IDS.length, 'every secret the app container mounts is inspected');
  } finally { removeQuietly(ws); }
});

await test('the chain summary is counts only — no phase contents, no digests, no identities', () => {
  const unavailable = summarizeChainSnapshot({ ok: false, availability: 'ARTIFACT_DIRECTORY_UNAVAILABLE', view: null });
  assertEq(unavailable.chain, 'UNAVAILABLE', 'an unreadable chain is unavailable');
  assertEq(unavailable.artifacts, null, 'with nothing counted');

  const summary = summarizeChainSnapshot({
    ok: true,
    availability: 'READABLE',
    view: {
      presentCount: 7,
      artifacts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      blockers: [{ code: 'X' }],
      terminalPhase: 238,
      nextRequiredPhase: 239,
    },
  });
  assertEq(summary.chain, 'HEALTHY', 'health is carried through from the snapshot, never recomputed');
  assertEq(JSON.stringify(summary.artifacts),
    JSON.stringify({ present: 7, expected: 10, blockers: 1, terminalPhase: 238, nextRequiredPhase: 239 }),
    'and the summary is five numbers');
  assert(!JSON.stringify(summary).includes('"code"'), 'no blocker detail survives into the summary');
});

// ---------------------------------------------------------------------------------------------------------
// Version metadata and drift
// ---------------------------------------------------------------------------------------------------------

await test('a version declaration is trusted only when it is shaped like one', () => {
  assertEq(buildRuntimeVersionView({ [RUNTIME_VERSION_ENV]: 'not-a-version' }).version, null, 'garbage is not a version');
  assertEq(buildRuntimeVersionView({ [RUNTIME_VERSION_ENV]: '' }).version, null, 'nor is an empty string');
  assertEq(buildRuntimeVersionView({ [RUNTIME_VERSION_ENV]: 'v1.2.3' }).version, 'v1.2.3', 'a version tag is');
  assertEq(buildRuntimeVersionView({ [RUNTIME_REVISION_ENV]: 'nothex' }).revision, null, 'a revision must be hex');
  assertEq(buildRuntimeVersionView({ [RUNTIME_BUILT_AT_ENV]: 'yesterday' }).builtAt, null, 'a build time must be ISO-8601');

  // A release-shaped version with no commit behind it is not something to call a release.
  assertEq(buildRuntimeVersionView({ [RUNTIME_VERSION_ENV]: 'v1.2.3' }).provenance, 'UNKNOWN',
    'a version with no revision is not a release');
  assertEq(buildRuntimeVersionView({ [RUNTIME_VERSION_ENV]: 'v1.2.3', [RUNTIME_REVISION_ENV]: 'abc1234' }).provenance,
    'RELEASE', 'a version with a revision is');
  assertEq(buildRuntimeVersionView({ [RUNTIME_VERSION_ENV]: DEVELOPMENT_VERSION }).provenance, 'DEVELOPMENT',
    'and the Dockerfile default is recognised as the development build it is');
});

await test('the image and the bundle are compared, and disagreement is reported rather than resolved', () => {
  const agree = buildRuntimeVersionView({
    [RUNTIME_VERSION_ENV]: 'v1.0.0', [RUNTIME_REVISION_ENV]: 'abc1234', [RUNTIME_BUNDLE_VERSION_ENV]: 'v1.0.0',
  });
  assertEq(agree.agreement, 'AGREES', 'the same version on both sides agrees');
  assertEq(buildRuntimeVersionView({
    [RUNTIME_VERSION_ENV]: '1.0.0', [RUNTIME_REVISION_ENV]: 'abc1234', [RUNTIME_BUNDLE_VERSION_ENV]: 'v1.0.0',
  }).agreement, 'AGREES', 'and a leading v is a spelling, not a difference');
  assertEq(buildRuntimeVersionView({
    [RUNTIME_VERSION_ENV]: 'v1.0.0', [RUNTIME_REVISION_ENV]: 'abc1234', [RUNTIME_BUNDLE_VERSION_ENV]: 'v1.0.1',
  }).agreement, 'MISMATCH', 'a different version is a mismatch');
  assertEq(buildRuntimeVersionView({ [RUNTIME_VERSION_ENV]: 'v1.0.0' }).agreement, 'UNKNOWN',
    'and with nothing to compare against, the answer is unknown rather than agreement');
});

await test('an image reference is described by its parts and never repeated back', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const pinned = describeImageRef(`${RELEASE_IMAGE_REPOSITORY}@${digest}`);
  assertEq(pinned.state, 'PARSED', 'a digest reference parses');
  assertEq(pinned.pinnedByDigest, true, 'and is recognised as the strongest pin');
  assertEq(pinned.repository, RELEASE_IMAGE_REPOSITORY, 'with the repository named');

  const tagged = describeImageRef(`${RELEASE_IMAGE_REPOSITORY}:v1.0.0`);
  assertEq(tagged.tag, 'v1.0.0', 'a tagged reference reports its tag');
  assertEq(tagged.movingTag, false, 'a version tag does not move');
  assertEq(describeImageRef(`${RELEASE_IMAGE_REPOSITORY}:latest`).movingTag, true, 'latest does');
  assertEq(describeImageRef('registry.local:5000/team/app:v1.0.0').tag, 'v1.0.0',
    'a port in the registry host is not mistaken for a tag');

  const hostile = describeImageRef('<script>alert(1)</script>');
  assertEq(hostile.state, 'MALFORMED', 'a hostile value is malformed');
  assertEq(hostile.repository, null, 'and nothing of it is carried forward');
  const view = buildRuntimeVersionView({ [RUNTIME_IMAGE_REF_ENV]: '<script>alert(1)</script>' });
  assert(!JSON.stringify(view).includes('script'), 'so it cannot reach a page through the version view either');
});

await test('the release tag, the image, the Compose contract and the bundle cannot drift apart', () => {
  const dockerfile = read('Dockerfile.runtime');
  // The image must be able to tell a running process what it is; labels alone cannot.
  for (const arg of ['IMAGE_VERSION', 'IMAGE_REVISION', 'IMAGE_CREATED']) {
    assert(new RegExp(`ARG ${arg}=`).test(dockerfile), `Dockerfile.runtime declares ARG ${arg}`);
  }
  assert(/CATALOG_AUTHORITY_VERSION=\$\{IMAGE_VERSION\}/.test(dockerfile), 'and bakes the version into the environment');
  assert(/CATALOG_AUTHORITY_REVISION=\$\{IMAGE_REVISION\}/.test(dockerfile), 'along with the revision');
  assert(/CATALOG_AUTHORITY_BUILT_AT=\$\{IMAGE_CREATED\}/.test(dockerfile), 'and the build time');
  assert(dockerfile.includes(`ARG IMAGE_VERSION=${DEVELOPMENT_VERSION}`),
    'and the default is the development placeholder the code recognises, not a release number');

  const compose = read('docker-compose.runtime.yml');
  assert(compose.includes(`${RUNTIME_BUNDLE_VERSION_ENV}: \${${RUNTIME_BUNDLE_VERSION_ENV}:-}`),
    'Compose passes the bundle version through, defaulting to empty rather than to a made-up value');
  assert(compose.includes(`${RUNTIME_IMAGE_REF_ENV}: \${${RUNTIME_IMAGE_REF_ENV}:-}`),
    'and the image reference it resolved');
  assert(compose.includes(`:${RELEASE_IMAGE_TAG}`), 'and its default image is the tag this release names');

  const bundle = buildConsumerReleaseBundle(bundleSources(), {
    image: { repository: RELEASE_IMAGE_REPOSITORY, tag: RELEASE_IMAGE_TAG },
    revision: 'abcdef1234567890abcdef1234567890abcdef12',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const env = bundle.files.find((file) => file.path === '.env')!.contents;
  assert(env.includes(`${RUNTIME_BUNDLE_VERSION_ENV}=${RELEASE_IMAGE_TAG}`),
    'the bundle declares its own version in .env, so the container can be checked against it');
  const versionFile = bundle.files.find((file) => file.path === 'VERSION')!.contents;
  assert(versionFile.includes(`version: ${RELEASE_IMAGE_TAG}`), 'and the VERSION file says the same thing');
  assert(bundle.files.find((file) => file.path === '.env.example')!.contents.includes(RUNTIME_BUNDLE_VERSION_ENV),
    'and the example env documents the variable rather than leaving it a surprise');
});

// ---------------------------------------------------------------------------------------------------------
// Checklist and troubleshooting content
// ---------------------------------------------------------------------------------------------------------

function bundleSources(): BundleSources {
  return {
    runtimeCompose: read('docker-compose.runtime.yml'),
    setupBash: read('deploy/local-runtime-setup.sh'),
    setupPowerShell: read('deploy/local-runtime-setup.ps1'),
  };
}

await test('every command-bearing step gives a Windows form and a POSIX form, and they are not the same by accident', () => {
  const withCommands = [...firstRunChecklist(), ...troubleshootingTable()].filter((entry) => entry.commands !== null);
  assert(withCommands.length >= 8, 'most steps carry a command');
  for (const entry of withCommands) {
    const { posix, windows } = entry.commands!;
    assert(posix.trim().length > 0, `${entry.id} has a POSIX command`);
    assert(windows.trim().length > 0, `${entry.id} has a Windows command`);
    assert(!posix.includes('\\'), `${entry.id}'s POSIX command uses forward slashes`);
    assert(!/&&/.test(windows), `${entry.id}'s Windows command does not use && , which Windows PowerShell cannot parse`);
  }
  // The places the two genuinely differ must actually differ, or the guidance is wrong for one of them.
  const byId = new Map([...firstRunChecklist()].map((step) => [step.id, step]));
  assertEq(byId.get('retrieve-token')!.commands!.windows, 'Get-Content .\\secrets\\operator_ui_token',
    'reading a file on Windows is Get-Content, not cat');
  assertEq(byId.get('generate-secrets')!.commands!.windows, 'powershell -ExecutionPolicy Bypass -File .\\setup.ps1',
    'and the setup script is invoked the way PowerShell requires');
  assertEq(byId.get('generate-secrets')!.commands!.posix, './setup.sh', 'while POSIX simply runs it');
});

await test('the checklist covers every operation the phase promises, and none of it names a real path', () => {
  const ids = firstRunChecklist().map((step) => step.id);
  for (const required of ['generate-secrets', 'start-stack', 'stop-stack', 'retrieve-token', 'place-records',
    'refresh-ui', 'back-up', 'upgrade', 'roll-back']) {
    assert(ids.includes(required as never), `the checklist covers ${required}`);
  }
  for (const step of firstRunChecklist()) {
    if (step.commands === null) continue;
    for (const command of [step.commands.posix, step.commands.windows]) {
      assert(!/\/(?:home|root|Users|var|run|etc|mnt)\//.test(command), `${step.id} names no absolute host path`);
      assert(!/postgres(?:ql)?:\/\//.test(command), `${step.id} contains no database URL`);
    }
  }
});

await test('the troubleshooting table covers every failure the phase promises, with a safe fix', () => {
  const ids = troubleshootingTable().map((entry) => entry.id);
  for (const required of ['port-conflict', 'docker-daemon-unavailable', 'image-pull-denied', 'postgres-unhealthy',
    'wrong-token', 'records-folder-missing', 'records-folder-unreadable', 'records-malformed', 'version-mismatch']) {
    assert(ids.includes(required as never), `the table covers ${required}`);
  }
  for (const entry of troubleshootingTable()) {
    // Nothing here may tell a frightened user to destroy the thing they are trying to diagnose.
    assert(!/docker\s+compose\s+down\s+-v|rm\s+-rf|docker\s+volume\s+rm|Remove-Item\s+-Recurse/.test(entry.fix),
      `${entry.id} does not suggest destroying data`);
    assert(entry.fix.length > 30, `${entry.id} says what to do rather than restating the problem`);
  }
  assert(troubleshootingTable().find((entry) => entry.id === 'image-pull-denied')!.fix.includes('latest'),
    'and the pull failure explicitly warns against "fixing" it with a floating tag');
});

await test('the bundle README is generated from the same checklist the UI renders, so the two cannot disagree', () => {
  const bundle = buildConsumerReleaseBundle(bundleSources(), {
    image: { repository: RELEASE_IMAGE_REPOSITORY, tag: RELEASE_IMAGE_TAG },
    revision: 'abcdef1234567890abcdef1234567890abcdef12',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const readme = bundle.files.find((file) => file.path === 'README.md')!.contents;
  for (const step of firstRunChecklist()) {
    assert(readme.includes(step.title), `the README contains the step "${step.title}"`);
    if (step.commands === null) continue;
    assert(readme.includes(step.commands.posix), `and its POSIX command verbatim: ${step.commands.posix}`);
    assert(readme.includes(step.commands.windows), `and its Windows command verbatim`);
  }
  for (const entry of troubleshootingTable()) {
    assert(readme.includes(entry.symptom), `the README's troubleshooting table covers ${entry.id}`);
  }
  // The bundle promises "Docker and nothing else", so the only toolchain command it may print is one that
  // runs INSIDE the image. Phase 245 exempts exactly this form from its no-toolchain rule; this pins it.
  assert(readme.includes('docker compose exec app npm run ops:support-report'),
    'the support report is produced inside the container, so the user still needs no Node.js');
  assert(!/^\s*npm run ops:support-report/m.test(readme),
    'and it is never presented as something to run on the host');
  assert(/no tokens, secret values,\s*\nfile paths, URLs, record contents/.test(readme)
    || readme.includes('contains no tokens'), 'and says what that report does not contain');
});

// ---------------------------------------------------------------------------------------------------------
// Support report
// ---------------------------------------------------------------------------------------------------------

await test('the support report makes no live calls and says which state it could not determine', () => {
  const ws = mkdtempSync(join(tmpdir(), 'phase246-support-'));
  try {
    const report = buildSupportReport({
      promotionRecordsDir: join(ws, 'records'),
      generatedAt: '2026-01-01T00:00:00.000Z',
      env: {},
      runtime: { nodeVersion: 'v22.0.0', platform: 'linux', arch: 'x64' },
    });
    assertEq(report.liveCallsMade, 'none', 'the report states that it contacted nothing');
    const database = report.components.find((component) => component.id === 'database')!;
    assertEq(database.state, 'UNKNOWN', 'so the database is unknown rather than claimed to be broken');
    assertEq(database.severity, 'ADVISORY', 'and not being probed is not a fault');
    assertEq(report.generatedAt, '2026-01-01T00:00:00.000Z', 'the timestamp is the one supplied, not the clock');
  } finally { removeQuietly(ws); }
});

await test('the support report contains no token, secret, path, URL or host-identifying value', () => {
  const ws = mkdtempSync(join(tmpdir(), 'phase246-support-redaction-'));
  try {
    const records = join(ws, 'records'); mkdirSync(records);
    const token = join(ws, 'operator_ui_token'); writeFileSync(token, `${TOKEN}\n`);
    const url = join(ws, 'database_url'); writeFileSync(url, 'postgresql://app:hunter2pass@db.internal:5432/catalog\n');
    const report = buildSupportReport({
      promotionRecordsDir: records,
      generatedAt: '2026-01-01T00:00:00.000Z',
      env: {
        OPERATOR_UI_TOKEN_FILE: token,
        DATABASE_URL_FILE: url,
        [RUNTIME_IMAGE_REF_ENV]: 'registry.internal.example:5000/private/app:v9.9.9',
        [RUNTIME_VERSION_ENV]: 'v1.0.0',
        [RUNTIME_REVISION_ENV]: 'abcdef1234567890',
      },
      runtime: { nodeVersion: 'v22.0.0', platform: 'linux', arch: 'x64' },
    });

    for (const rendered of [renderSupportReportJson(report), renderSupportReportText(report)]) {
      assert(!rendered.includes(TOKEN), 'the operator token is not in the report');
      assert(!rendered.includes('hunter2pass'), 'nor is a database password');
      assert(!rendered.includes('db.internal'), 'nor a database host');
      assert(!rendered.includes('registry.internal.example'), 'nor a private registry host');
      assert(!rendered.includes(ws), 'nor any path on this machine');
      assert(!/postgres(?:ql)?:\/\//.test(rendered), 'nor any URL');
    }
    // A private registry is reported as "not the published one", which is the useful part without the host.
    assertEq(report.version.imageRepository, 'CUSTOM', 'a non-published registry is described, not named');
    assertEq(report.version.imageTag, 'v9.9.9', 'while the tag, which identifies a release, is kept');
    assert(!('hostname' in report.runtime), 'the report carries no hostname');
  } finally { removeQuietly(ws); }
});

await test('the redaction check is real: it refuses shapes rather than trusting the builder', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['contains postgresql://user:pw@host/db', 'a URL'],
    ['contains https://example.com/x', 'any URL, not only a database one'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'a private key'],
    [`token ${'A'.repeat(43)}=`, 'a base64-encoded 32-byte secret'],
    [`digest ${'a'.repeat(64)}`, 'a hex value longer than a git revision'],
    ['reading /home/clint/secrets/x', 'an absolute POSIX path'],
    ['reading C:\\Users\\clint\\x', 'a Windows path'],
    ['see ./secrets/operator_ui_token', 'a path into the secrets folder'],
  ];
  for (const [rendered, why] of cases) {
    let threw = false;
    try { assertSupportReportIsRedactionSafe(rendered); } catch (err) {
      threw = err instanceof SupportReportRedactionError;
    }
    assert(threw, `the check refuses ${why}`);
  }
  // A git revision is legitimately hex and must survive, or the check would forbid the useful field.
  assertSupportReportIsRedactionSafe('revision abcdef1234567890abcdef1234567890abcdef12');
});

await test('the support report renders as both JSON and text, and both carry the same verdict', () => {
  const ws = mkdtempSync(join(tmpdir(), 'phase246-support-render-'));
  try {
    const report = buildSupportReport({
      promotionRecordsDir: join(ws, 'records'),
      generatedAt: '2026-01-01T00:00:00.000Z',
      env: {},
      runtime: { nodeVersion: 'v22.0.0', platform: 'linux', arch: 'x64' },
    });
    const json = JSON.parse(renderSupportReportJson(report)) as { state: string; report: string };
    assertEq(json.report, 'phase-246-operator-support-report', 'the JSON names the report');
    const text = renderSupportReportText(report);
    assert(text.includes(`state:         ${json.state}`), 'and the text carries the same verdict');
    assert(text.includes('safe to attach to a public issue'), 'and says plainly that it is safe to share');
    for (const secret of SECRET_FILE_IDS) assert(text.includes(secret), `the text lists ${secret}`);
  } finally { removeQuietly(ws); }
});

// ---------------------------------------------------------------------------------------------------------
// End to end against the running service
// ---------------------------------------------------------------------------------------------------------

await test('a freshly extracted install reports NEEDS_SETUP with the commands that finish it', async () => {
  const h = await startHarness();
  try {
    const res = await httpGet(h.port, '/api/installation', TOKEN);
    assertEq(res.statusCode, 200, 'an unfinished install is a 200 answer, not a server error');
    const body = JSON.parse(res.body) as {
      ok: boolean;
      readiness: { state: string; nextSteps: string[]; components: { id: string }[]; authorizationNote: string };
      checklist: { id: string; commands: { posix: string; windows: string } | null }[];
      troubleshooting: { id: string }[];
      notes: { repositoryCompose: string; tokenHandling: string };
    };
    // The route reads the real process environment, which differs between a laptop and CI, so the exact
    // verdict is asserted against a controlled environment in the test below rather than here.
    assert(['READY', 'NEEDS_SETUP', 'DEGRADED'].includes(body.readiness.state),
      'the verdict is one of the three bounded values');
    assert(body.readiness.nextSteps.length > 0, 'and there is something to do');
    assertEq(body.readiness.components.length, 6, 'every component is reported');
    assertEq(body.checklist.length, firstRunChecklist().length, 'the checklist travels with the verdict');
    assertEq(body.troubleshooting.length, troubleshootingTable().length, 'so does the troubleshooting table');
    assertEq(body.notes.repositoryCompose, REPOSITORY_COMPOSE_NOTE, 'and the checkout note');
    assertEq(body.notes.tokenHandling, TOKEN_HANDLING_NOTE, 'and the note about how the token is handled');
    // Every step the verdict points at must be resolvable, or the panel renders a bare identifier.
    const ids = new Set(body.checklist.map((step) => step.id));
    for (const step of body.readiness.nextSteps) assert(ids.has(step), `${step} resolves against the shipped checklist`);
  } finally { await h.stop(); }
});

await test('a bundle extracted and started, with nothing placed in it yet, is NEEDS_SETUP and never DEGRADED', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'phase246-fresh-'));
  try {
    const records = join(workspace, 'promotion-records');
    mkdirSync(records);
    // Exactly what a fresh `docker compose up -d` produces before the operator has done anything: the mount
    // is there and readable, and empty. This is the load that must NOT cry wolf.
    const readiness = await buildInstallationReadiness({ promotionRecordsDir: records }, {});
    assertEq(readiness.state, 'NEEDS_SETUP', 'a fresh install is unfinished, not broken');
    assert(readiness.components.every((component) => component.severity !== 'IMPAIRED'),
      'and nothing about it is reported as a fault');
    const chain = readiness.components.find((component) => component.id === 'promotion-chain')!;
    assertEq(chain.state, 'EMPTY', 'an empty readable folder is an empty chain, not a contradictory one');
    assertEq(readiness.nextSteps[0], 'generate-secrets', 'and the first thing to do is generate the secrets');
  } finally { removeQuietly(workspace); }
});

await test('the readiness route answers even when the records directory is not there at all', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'phase246-missing-'));
  try {
    const readiness = await buildInstallationReadiness({ promotionRecordsDir: join(workspace, 'nowhere') }, {});
    assertEq(readiness.state, 'NEEDS_SETUP', 'a missing folder is a setup step');
    const records = readiness.components.find((component) => component.id === 'promotion-records')!;
    assertEq(records.state, 'MISSING', 'and it is named as missing');
    assertEq(records.fix, 'place-records', 'with the step that fixes it');
    assert(!JSON.stringify(readiness).includes(workspace), 'and the path is nowhere in the verdict');
  } finally { removeQuietly(workspace); }
});

await test('/api/version answers with the parsed view and never with a raw environment value', async () => {
  const h = await startHarness();
  try {
    const res = await httpGet(h.port, '/api/version', TOKEN);
    assertEq(res.statusCode, 200, 'the route answers');
    const body = JSON.parse(res.body) as { code: string; version: { report: string; provenance: string; image: { state: string } } };
    assertEq(body.code, 'OPERATOR_UI_VERSION', 'with its code');
    assertEq(body.version.report, 'phase-246-runtime-version', 'and the version report');
    assert(['RELEASE', 'DEVELOPMENT', 'UNKNOWN'].includes(body.version.provenance), 'provenance is one of the bounded values');
    assert(['PARSED', 'ABSENT', 'MALFORMED'].includes(body.version.image.state), 'and so is the image state');
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------------------------------------
// Nothing that already worked was changed
// ---------------------------------------------------------------------------------------------------------

await test('the existing status, logs and promotion-chain routes behave exactly as they did', async () => {
  const h = await startHarness();
  try {
    for (const path of ['/api/status', '/api/logs', '/api/promotion-chain']) {
      assertEq((await httpGet(h.port, path)).statusCode, 401, `${path} still requires the token`);
    }
    const logs = JSON.parse((await httpGet(h.port, '/api/logs', TOKEN)).body) as { ok: boolean; report: string };
    assertEq(logs.ok, true, '/api/logs still answers ok');
    assertEq(logs.report, 'phase-147-operator-ui-service-logs', 'and still reports as the Phase 147 log route');

    const chain = await httpGet(h.port, '/api/promotion-chain', TOKEN);
    const parsed = JSON.parse(chain.body) as { report: string; availability: string; mutationsOffered: string };
    assertEq(parsed.report, 'phase-244-operator-ui-promotion-chain', 'the chain still reports as Phase 244');
    assertEq(parsed.mutationsOffered, 'none', 'and still offers no mutation');

    const unknown = await httpGet(h.port, '/api/nope', TOKEN);
    assertEq(unknown.statusCode, 404, 'an unknown route is still a 404');
    const traversal = await httpGet(h.port, '/api/../etc/passwd', TOKEN);
    assertEq(traversal.statusCode, 404, 'and a traversal attempt is still refused');
  } finally { await h.stop(); }
});

await test('the UI still offers no mutation, and the new panel adds no form or method that could', async () => {
  const h = await startHarness();
  try {
    const html = (await httpGet(h.port, '/')).body;
    const script = (await httpGet(h.port, '/assets/app.js')).body;
    assert(!/<form\b/i.test(html), 'there is no form on the page');
    assert(!/method\s*:\s*['"]POST/i.test(script), 'and nothing in the script issues a POST');
    assert(!/fetch\([^)]*method/i.test(script), 'every fetch is a plain GET');
    assert(html.includes('Setup &amp; Diagnostics'), 'the new panel is present');
    assert(html.includes('First-run checklist'), 'and so is the checklist a locked-out user needs');
    assert(html.includes('Troubleshooting'), 'and the troubleshooting table');
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------------------------------------
// Compose and bundle contract
// ---------------------------------------------------------------------------------------------------------

await test('the runtime Compose file still mounts the records folder read-only and publishes only the UI', () => {
  const compose = parseYaml(read('docker-compose.runtime.yml'));
  const services = asMap(compose.services ?? null, 'services');
  const app = asMap(services.app ?? null, 'app');
  const volumes = yamlStrings(app.volumes as YamlMap);
  assert(volumes.some((volume) => volume.includes('/var/lib/catalog/promotion-records:ro')),
    'the records mount is still read-only');
  assertEq(app.read_only, true, 'the app container is still read-only');
  const postgres = asMap(services.postgres ?? null, 'postgres');
  assert(!('ports' in postgres), 'the database is still never published to the host');
  // The new variables must not have become a way to smuggle a secret in as an environment value.
  const environment = asMap(app.environment ?? null, 'environment');
  for (const [key, value] of Object.entries(environment)) {
    assert(!/(?:PASSWORD|TOKEN|SECRET|KEK)$/.test(key) || String(key).endsWith('_FILE'),
      `${key} is a file reference rather than a value`);
    assert(!/postgres(?:ql)?:\/\//.test(String(value ?? '')), `${key} carries no database URL`);
  }
});

await test('the bundle still ships no source, no toolchain and no secret, with the new variable included', () => {
  const bundle = buildConsumerReleaseBundle(bundleSources(), {
    image: { repository: RELEASE_IMAGE_REPOSITORY, tag: RELEASE_IMAGE_TAG },
    revision: 'abcdef1234567890abcdef1234567890abcdef12',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const paths = bundle.files.map((file) => file.path).sort();
  assertEq(paths.join(','), '.env,.env.example,README.md,SHA256SUMS,VERSION,bundle-manifest.json,docker-compose.yml,setup.ps1,setup.sh',
    'the bundle file set is unchanged by this phase');
  for (const file of bundle.files) {
    assert(!file.contents.includes('\r'), `${file.path} is still LF-only`);
    assert(!/postgres(?:ql)?:\/\/[^\s:@/]+:[^\s:@/$]{8,}@/.test(file.contents), `${file.path} carries no real credential`);
  }
  const compose = bundle.files.find((file) => file.path === 'docker-compose.yml')!.contents;
  assert(compose.includes(RUNTIME_BUNDLE_VERSION_ENV), 'the shipped Compose file reads the bundle version variable');
  assert(!/^\s*build:/m.test(compose), 'and still never builds from source');
});

// ---------------------------------------------------------------------------------------------------------
// What is NOT proven here
// ---------------------------------------------------------------------------------------------------------

await test('the daemon-backed checks this suite deliberately does not fake are required in CI', () => {
  const workflow = read('.github/workflows/runtime-image.yml');
  assert(workflow.includes('test:phase246-local'), 'CI runs the Phase 246 suite');
  assert(workflow.includes('deploy/ci/runtime-image-smoke.sh'), 'and the daemon-backed image smoke');
  const smoke = read('deploy/ci/runtime-image-smoke.sh');
  assert(smoke.includes('/api/installation'), 'the smoke exercises the readiness route inside a real container');
  assert(smoke.includes('CATALOG_AUTHORITY_VERSION'), 'and proves the image can report its own baked version');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
