import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Phase 3 Stage 3.4 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â static structural checks for the deployment artifacts.
 *
 * Dependency-free (no YAML lib, no Docker): asserts the compose topology, secret-file wiring, and
 * the one-shot CLI shape and intentional app port by inspecting the files. The REAL compose smoke test
 * (`npm run smoke:compose`) is opt-in/manual and not part of CI, because this environment has no
 * Docker (the suite uses embedded PostgreSQL). This keeps the topology verified regardless.
 */

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const exists = (rel: string): boolean => existsSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)));
function assertTorBoxFactoryInjectedOnly(factory: string): void {
  assert(factory.includes("'torbox-readonly'"), 'TorBox read-only adapter mode is explicit');
  assert(/requires explicit injected transport/i.test(factory), 'TorBox env-only mode fails closed');
  assert(!factory.includes('createTorBoxLiveTransport'), 'factory does not construct live TorBox transport');
  assert(!factory.includes('globalThis.fetch'), 'factory has no global fetch');
  assert(!factory.includes('process.env.TORBOX'), 'factory has no TorBox env secret read');
}
const opsFiles = (): Array<[string, string]> => {
  const dir = fileURLToPath(new URL('../src/ops', import.meta.url));
  return readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => [f, readFileSync(`${dir}/${f}`, 'utf8')]);
};
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walkTs(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

console.log('Running Phase 3 deployment topology suite (Stage 3.4):\n');

const compose = read('docker-compose.deploy.yml');
const unraidCompose = read('docker-compose.unraid.yml');
const unraidRuntimeCompose = read('docker-compose.unraid.runtime.yml');
const unraidOpsLauncher = read('deploy/unraid-ops-launcher.sh');
const dockerignore = read('.dockerignore');
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

test('compose ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â defines postgres + one-shot ops services', () => {
  assert(/^\s{2}postgres:/m.test(compose), 'postgres service');
  assert(/^\s{2}ops:/m.test(compose), 'ops service');
  assert(/entrypoint:\s*\["npm",\s*"run"\]/.test(compose), 'ops is a one-shot npm-run container');
});

test('compose ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â postgres has a pg_isready healthcheck', () => {
  assert(/healthcheck:/.test(compose) && /pg_isready/.test(compose), 'pg_isready healthcheck present');
});

test('compose ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â keystore is a SEPARATE volume from pgdata and backups', () => {
  for (const v of ['pgdata:', 'keystore:', 'backups:']) assert(compose.includes(v), `${v} volume declared`);
  assert(compose.includes('/var/lib/postgresql/data'), 'pgdata mount path');
  assert(compose.includes('/var/lib/catalog/keystore'), 'keystore mount path (distinct from pgdata)');
});

test('compose ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â secrets delivered via *_FILE (no inline secret values)', () => {
  for (const v of ['POSTGRES_PASSWORD_FILE', 'ADMIN_DATABASE_URL_FILE', 'DATABASE_URL_FILE', 'COMPLETION_SECRET_FILE', 'CUSTODIAN_KEK_FILE']) {
    assert(compose.includes(v), `${v} used`);
  }
  assert(/^secrets:/m.test(compose), 'top-level secrets section');
  // no raw secret-looking assignments for the sensitive vars
  assert(!/COMPLETION_SECRET:\s*\S/.test(compose), 'no inline COMPLETION_SECRET value');
  assert(!/CUSTODIAN_KEK:\s*\S/.test(compose), 'no inline CUSTODIAN_KEK value');
});

test('compose ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â CLI pattern: no ports / no HTTP daemon', () => {
  assert(!/ports:/.test(compose), 'no published ports (not an HTTP service)');
  assert(!/(expose|EXPOSE)/.test(compose), 'no exposed port');
});

test('unraid compose ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â single canonical file with production binds and intentional app port', () => {
  assert(exists('docker-compose.unraid.yml'), 'canonical Unraid compose exists');
  assert(/^\s{2}postgres:/m.test(unraidCompose), 'Unraid postgres service');
  assert(/^\s{2}ops:/m.test(unraidCompose), 'Unraid ops service');
  assert(/^\s{2}app:/m.test(unraidCompose), 'Unraid app service');
  assert(unraidCompose.includes('APP_ENV: production'), 'Unraid ops uses production environment');
  assert(unraidCompose.includes('/mnt/user/appdata/catalog/pgdata:/var/lib/postgresql/data'), 'Unraid pgdata bind mount');
  assert(unraidCompose.includes('/mnt/user/appdata/catalog/keystore:/var/lib/catalog/keystore'), 'Unraid keystore bind mount');
  assert(unraidCompose.includes('/mnt/user/appdata/catalog/backups:/backups'), 'Unraid backups bind mount');
  assert(
    unraidCompose.includes('/mnt/user/appdata/catalog/secrets/operator_ui_token:/mnt/user/appdata/catalog/secrets/operator_ui_token'),
    'Unraid ops can manage the operator token file without exposing a UI write path',
  );
  for (const secret of [
    '/mnt/user/appdata/catalog/secrets/postgres_password',
    '/mnt/user/appdata/catalog/secrets/admin_database_url',
    '/mnt/user/appdata/catalog/secrets/database_url',
    '/mnt/user/appdata/catalog/secrets/completion_secret',
    '/mnt/user/appdata/catalog/secrets/custodian_kek',
    '/mnt/user/appdata/catalog/secrets/operator_ui_token',
  ]) assert(unraidCompose.includes(secret), `Unraid secret file ${secret}`);
  assert(unraidCompose.includes('ops:operator-ui-server'), 'Unraid app runs operator UI server');
  assert(unraidCompose.includes('OPERATOR_UI_TOKEN_FILE: /run/secrets/operator_ui_token'), 'Unraid app uses operator token file');
  assert(
    unraidCompose.includes('OPERATOR_UI_TOKEN_FILE: /mnt/user/appdata/catalog/secrets/operator_ui_token'),
    'Unraid ops token helper uses writable host token path',
  );
  assert(unraidCompose.includes('"8099:8099"'), 'Unraid compose publishes only the intentional operator UI port');
  assert(!/(expose|EXPOSE)/.test(unraidCompose), 'Unraid compose exposes no ports');
});

test('unraid runtime compose ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â launcher-ready image mode with no build context', () => {
  assert(exists('docker-compose.unraid.runtime.yml'), 'Unraid runtime compose exists');
  assert(/^name:\s*catalogauthority/m.test(unraidRuntimeCompose), 'runtime compose has stable launcher project name');
  assert(/^\s{2}postgres:/m.test(unraidRuntimeCompose), 'runtime postgres service');
  assert(/^\s{2}ops:/m.test(unraidRuntimeCompose), 'runtime ops service');
  assert(/^\s{2}app:/m.test(unraidRuntimeCompose), 'runtime app service');
  assert(unraidRuntimeCompose.includes('image: ${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}'), 'runtime ops uses configurable prebuilt image');
  assert(!/^\s+build:/m.test(unraidRuntimeCompose), 'runtime compose has no build context');
  assert(unraidRuntimeCompose.includes('APP_ENV: production'), 'runtime ops uses production environment');
  assert(
    unraidRuntimeCompose.includes('${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/pgdata:/var/lib/postgresql/data'),
    'runtime pgdata bind mount keeps canonical default and smoke override',
  );
  assert(
    unraidRuntimeCompose.includes('${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/sidecar/run:/run/catalog-sidecar'),
    'runtime sidecar socket bind mount keeps canonical default and smoke override',
  );
  assert(
    unraidRuntimeCompose.includes('${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/backups:/backups'),
    'runtime backups bind mount keeps canonical default and smoke override',
  );
  assert(
    unraidRuntimeCompose.includes('${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/backups:${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/backups'),
    'runtime ops can review saved evidence by host path or /backups path',
  );
  assert(
    unraidRuntimeCompose.includes('${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/secrets/operator_ui_token:${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/secrets/operator_ui_token'),
    'runtime ops can manage the operator token file without exposing a UI write path',
  );
  for (const secret of [
    'postgres_password',
    'admin_database_url',
    'database_url',
    'completion_secret',
    'custodian_kek',
    'operator_ui_token',
  ]) assert(
    unraidRuntimeCompose.includes(`file: \${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/secrets/${secret}`),
    `runtime secret file ${secret} keeps canonical default and smoke override`,
  );
  assert(unraidRuntimeCompose.includes('ops:operator-ui-server'), 'runtime app runs operator UI server');
  assert(unraidRuntimeCompose.includes('OPERATOR_UI_TOKEN_FILE: /run/secrets/operator_ui_token'), 'runtime app uses operator token file');
  assert(
    unraidRuntimeCompose.includes('OPERATOR_UI_TOKEN_FILE: ${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/secrets/operator_ui_token'),
    'runtime ops token helper uses writable host token path with canonical default',
  );
  assert(unraidRuntimeCompose.includes('"${OPERATOR_UI_HOST_PORT:-8099}:8099"'), 'runtime compose publishes only the intentional operator UI port with smoke override');
  assert(!/(expose|EXPOSE)/.test(unraidRuntimeCompose), 'runtime compose exposes no ports');
});

test('compose ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â `docker compose run ops` invocations must NOT double-prefix npm run', () => {
  // With entrypoint ["npm","run"], `docker compose run ops <args>` already prepends `npm run`.
  // So any `... run --rm ops npm run X` becomes `npm run npm run X` (broken). The script name
  // must be passed directly: `... run --rm ops X`. Enforce that invariant everywhere it appears.
  assert(/entrypoint:\s*\["npm",\s*"run"\]/.test(compose), 'entrypoint is ["npm","run"] (the assumed model)');
  const doc = read('docs/PHASE_3_DEPLOYMENT.md');
  const broken = /run\s+--rm\s+ops\s+npm\s+run\b/;
  assert(!broken.test(compose), 'compose comments do not double-prefix npm run');
  assert(!broken.test(doc), 'deployment doc does not double-prefix npm run');
  assert(!broken.test(pkg.scripts['smoke:compose'] ?? ''), 'smoke:compose does not double-prefix npm run');
  assert(/run --rm ops ops:migrate\b/.test(pkg.scripts['smoke:compose'] ?? ''), 'smoke:compose passes the script name directly');
  // ...and the same stale pattern must not reappear in src/ops/*.ts comments (Phase 5).
  for (const [name, src] of opsFiles()) assert(!broken.test(src), `src/ops/${name} must not contain the "run --rm ops npm run" double-prefix`);
});

test('package.json ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ops + deploy scripts wired; no HTTP framework dep', () => {
  for (const s of ['ops:migrate', 'ops:backup', 'test:backup-ops', 'test:deploy', 'smoke:compose']) {
    assert(typeof pkg.scripts[s] === 'string', `script ${s} present`);
  }
  assert(/test\/backup-ops\.ts/.test(pkg.scripts.test ?? ''), 'backup-ops in the test chain');
  assert(/test\/deploy\.ts/.test(pkg.scripts.test ?? ''), 'deploy in the test chain');
  assert(/docker-compose\.unraid\.runtime\.yml/.test(pkg.scripts['smoke:compose'] ?? ''), 'smoke uses the public Unraid runtime compose');
  const deps = Object.keys(pkg.dependencies ?? {});
  for (const banned of ['express', 'fastify', 'koa', 'http-server', 'age', 'aws-sdk', '@aws-sdk/client-kms',
    'node-fetch', 'undici', 'axios', 'got', 'puppeteer', 'cheerio', 'ws', 'plex-api', 'real-debrid', 'torbox']) {
    assert(!deps.includes(banned), `no ${banned} dependency`);
  }
});

test('adapter boundary ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â no network/provider leakage in src/core/adapters (Phase 7)', () => {
  const dir = fileURLToPath(new URL('../src/core/adapters', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert(files.length >= 3, 'adapter module present');
  const network = /(from\s*['"]node:(http|https|net|tls|dns)['"]|from\s*['"](node-fetch|undici|axios|got|ws|puppeteer|cheerio)['"]|\bfetch\s*\()/;
  const providers = /(real[-_ ]?debrid|torbox|\bplex\b|jellyfin|scrap(e|ing)|\bdownload\b|playback)/i;
  for (const f of files) {
    if (f === 'torbox-boundary.ts') continue;
    const src = readFileSync(`${dir}/${f}`, 'utf8');
    assert(!network.test(src), `src/core/adapters/${f} makes no network import/call`);
    if (f === 'adapter-factory.ts') {
      assertTorBoxFactoryInjectedOnly(src);
      continue;
    }
    if (f === 'fake-torbox-adapter.ts' || f === 'torbox-real-client-gate.ts' || f === 'torbox-readonly-client.ts') continue;
    if (f === 'torbox-provider-adapter.ts') continue;
    assert(!providers.test(src), `src/core/adapters/${f} names no real provider / scraping / playback`);
  }
  assert(exists('docs/PHASE_7_ADAPTER_BOUNDARY.md'), 'adapter boundary doc exists');
  const doc = read('docs/PHASE_7_ADAPTER_BOUNDARY.md');
  for (const kw of ['AdapterRefView', 'withProviderRef', 'advisory', 'ADAPTER_MODE', 'deferred']) assert(doc.includes(kw), `doc covers ${kw}`);
  assert((pkg.scripts.test ?? '').includes('test/adapter-privacy.ts') && (pkg.scripts.test ?? '').includes('test/adapter-contract.ts'), 'adapter suites in the CI chain');
});

test('torbox boundary - Phase 31 is static research only, no SDK/live provider mode', () => {
  assert(exists('src/core/adapters/torbox-boundary.ts'), 'TorBox static boundary contract exists');
  assert(exists('docs/PHASE_31_TORBOX_BOUNDARY.md'), 'Phase 31 TorBox boundary doc exists');
  assert(typeof pkg.scripts['test:torbox-boundary'] === 'string', 'test:torbox-boundary script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-boundary.ts'), 'TorBox boundary suite in the CI chain');
  const source = read('src/core/adapters/torbox-boundary.ts');
  const suite = read('test/torbox-boundary.ts');
  const doc = read('docs/PHASE_31_TORBOX_BOUNDARY.md');
  const readme = read('README.md');

  for (const kw of ['TorrentsService', 'WebDownloadsDebridService', 'UsenetService', 'GeneralService', 'hoster-list']) {
    assert(`${source}\n${doc}`.includes(kw), `Phase 31 names official surface ${kw}`);
  }
  for (const kw of ['no live TorBox', 'no SDK dependency', 'no downloading', 'no playback', 'no provider mode', '@torbox/torbox-api']) {
    assert(`${doc}\n${readme}`.includes(kw), `Phase 31 docs preserve ${kw}`);
  }
  assert(/local fake TorBox adapter contract[\s\S]*gated real client/i.test(doc), 'Phase 31 states fake-contract-before-real-client sequence');
  assert(/O4 remains open\/deferred/.test(doc) && /O5 remains open\/deferred/.test(doc), 'Phase 31 keeps O4/O5 open');
  assert(/FileCustodian`? remains a hardened reference\s+harness, not production KMS/.test(doc), 'Phase 31 preserves FileCustodian boundary');

  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'readFileSync',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
  ]) assert(!source.includes(forbidden), `TorBox boundary source excludes ${forbidden}`);
  assert(suite.includes('no runtime dependency, network, DB, Docker, env read, or provider behavior'), 'suite enforces static-only boundary');
});

test('fake TorBox adapter - Phase 32 is local contract only and fail-closed', () => {
  assert(exists('src/core/adapters/fake-torbox-adapter.ts'), 'Phase 32 fake TorBox adapter exists');
  assert(exists('docs/PHASE_32_FAKE_TORBOX_ADAPTER.md'), 'Phase 32 fake TorBox doc exists');
  assert(typeof pkg.scripts['test:torbox-fake-adapter'] === 'string', 'test:torbox-fake-adapter script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-fake-adapter.ts'), 'fake TorBox suite in the CI chain');

  const source = read('src/core/adapters/fake-torbox-adapter.ts');
  const factory = read('src/core/adapters/adapter-factory.ts');
  const suite = read('test/torbox-fake-adapter.ts');
  const doc = read('docs/PHASE_32_FAKE_TORBOX_ADAPTER.md');
  const readme = read('README.md');
  const phase31 = read('docs/PHASE_31_TORBOX_BOUNDARY.md');

  for (const kw of ['ProviderAdapter', 'AdapterRefView', 'available', 'unavailable', 'unknown', 'unsupported-ref-type']) {
    assert(source.includes(kw), `Phase 32 fake adapter covers ${kw}`);
  }
  for (const kw of ['infohash', 'hash-digest', 'link-derived-digest', 'nzb-derived-digest']) {
    assert(source.includes(kw), `Phase 32 supports scoped local ref ${kw}`);
  }
  for (const kw of [
    'local fake contract only',
    'does not prove real TorBox works',
    'separately gated real client',
    'Create/download-link/token-query flows remain future-gated/high risk',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(`${doc}\n${readme}\n${phase31}`.includes(kw), `Phase 32 docs preserve ${kw}`);

  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assert(!factory.includes('fake-torbox') && !factory.includes('FakeTorBoxAdapter'), 'TorBox fake is not wired into ADAPTER_MODE');
  for (const forbidden of [
    '@torbox/torbox-api',
    "from 'pg'",
    'from "pg"',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'node:child_process',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'readFileSync',
    'readdirSync',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'requestDownloadLink',
    'createTorrent',
    'createWebDownload',
    'createUsenetDownload',
    'CDN URL',
    'permalink URL',
  ]) assert(!source.includes(forbidden), `Phase 32 fake source excludes ${forbidden}`);
  assert(suite.includes('source has no SDK, network, env, DB, Docker, or provider-mode scope creep'), 'suite enforces Phase 32 static scope');
});

test('TorBox real-client gate - Phase 33 is static design only and fail-closed', () => {
  assert(exists('src/core/adapters/torbox-real-client-gate.ts'), 'Phase 33 TorBox real-client gate exists');
  assert(exists('docs/PHASE_33_TORBOX_REAL_CLIENT_GATE.md'), 'Phase 33 TorBox real-client gate doc exists');
  assert(typeof pkg.scripts['test:torbox-real-client-gate'] === 'string', 'test:torbox-real-client-gate script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-real-client-gate.ts'), 'TorBox real-client gate suite in the CI chain');

  const source = read('src/core/adapters/torbox-real-client-gate.ts');
  const suite = read('test/torbox-real-client-gate.ts');
  const doc = read('docs/PHASE_33_TORBOX_REAL_CLIENT_GATE.md');
  const readme = read('README.md');
  const factory = read('src/core/adapters/adapter-factory.ts');

  for (const kw of [
    'TorBoxTransport',
    'createDisabledTorBoxRealClientPlan',
    'assertTorBoxRealClientGateClosed',
    'TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY',
    'TorBoxRealClientGateError',
  ]) assert(source.includes(kw), `Phase 33 source covers ${kw}`);

  for (const kw of ['torrent-cache-check', 'webdl-cache-check', 'usenet-cache-check', 'status-check', 'hoster-list']) {
    assert(source.includes(kw), `Phase 33 allows read-only operation ${kw}`);
  }
  for (const kw of ['create-download', 'request-download-link', 'user-list', 'user-data', 'control-item', 'delete-item', 'export-provider-data', 'cdn-url']) {
    assert(source.includes(kw), `Phase 33 future-gates ${kw}`);
  }

  for (const kw of [
    'design gate, not a live client',
    'injected transport only',
    'no SDK dependency',
    'future real client must be separately authorized/reviewed',
    'live smoke must be operator-run outside CI',
    'no ADAPTER_MODE wiring',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(`${doc}\n${readme}`.includes(kw), `Phase 33 docs preserve ${kw}`);

  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assertTorBoxFactoryInjectedOnly(factory);
  assert(!/class\s+\w*Transport\b/.test(source), 'no transport class implementation');
  assert(!/implements\s+TorBoxTransport/.test(source), 'no TorBox transport implementation');
  for (const forbidden of [
    '@torbox/torbox-api',
    "from 'pg'",
    'from "pg"',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'node:child_process',
    'globalThis.fetch',
    'window.fetch',
    'fetch(',
    'process.env',
    'readFileSync',
    'readdirSync',
    'openSync',
    'readSync',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
  ]) assert(!source.includes(forbidden), `Phase 33 source excludes ${forbidden}`);
  assert(suite.includes('transport is injected-only and no TorBox transport implementation exists'), 'suite enforces injected-only transport');
  assert(suite.includes('gate is disabled by default and cannot be enabled from pure config'), 'suite enforces disabled-by-default gate');
  assert(suite.includes('redaction-safe errors expose only operation, status, and category'), 'suite enforces error redaction');
});

test('TorBox read-only fixture client - Phase 34 is injected transport only and fail-closed', () => {
  assert(exists('src/core/adapters/torbox-readonly-client.ts'), 'Phase 34 TorBox read-only client exists');
  assert(exists('docs/PHASE_34_TORBOX_READONLY_FIXTURE.md'), 'Phase 34 TorBox read-only fixture doc exists');
  assert(typeof pkg.scripts['test:torbox-readonly-client'] === 'string', 'test:torbox-readonly-client script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-readonly-client.ts'), 'TorBox read-only fixture suite in the CI chain');

  const source = read('src/core/adapters/torbox-readonly-client.ts');
  const suite = read('test/torbox-readonly-client.ts');
  const doc = read('docs/PHASE_34_TORBOX_READONLY_FIXTURE.md');
  const readme = read('README.md');
  const phase31 = read('docs/PHASE_31_TORBOX_BOUNDARY.md');
  const phase32 = read('docs/PHASE_32_FAKE_TORBOX_ADAPTER.md');
  const phase33 = read('docs/PHASE_33_TORBOX_REAL_CLIENT_GATE.md');
  const factory = read('src/core/adapters/adapter-factory.ts');

  for (const kw of [
    'TorBoxReadOnlyClient',
    'TorBoxTransport',
    'AdapterRefView',
    'AdapterResult',
    'torrent-cache-check',
    'webdl-cache-check',
    'usenet-cache-check',
    'status-check',
    'hoster-list',
    'ambiguous-availability',
  ]) assert(source.includes(kw), `Phase 34 source covers ${kw}`);

  for (const kw of [
    'injected fake transport in tests only',
    'not a live TorBox client',
    'does not prove real TorBox works',
    'Real transport and live smoke remain separately authorized and operator-run outside CI',
    'Request-download-link, token-query, permalink, CDN, create, user, control, delete, and export flows remain future-gated',
    'no ADAPTER_MODE wiring',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(`${doc}\n${readme}\n${phase31}\n${phase32}\n${phase33}`.includes(kw), `Phase 34 docs preserve ${kw}`);

  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assertTorBoxFactoryInjectedOnly(factory);
  assert(!/class\s+\w*Transport\b/.test(source), 'no transport class implementation');
  assert(!/implements\s+TorBoxTransport/.test(source), 'no TorBox transport implementation');
  for (const forbidden of [
    '@torbox/torbox-api',
    "from 'pg'",
    'from "pg"',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'node:child_process',
    'globalThis.fetch',
    'window.fetch',
    'fetch(',
    'process.env',
    'readFileSync',
    'readdirSync',
    'openSync',
    'readSync',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'INSERT INTO',
    'UPDATE ',
    'DELETE FROM',
    'TRUNCATE',
  ]) assert(!source.includes(forbidden), `Phase 34 source excludes ${forbidden}`);
  assert(suite.includes('request mapping from scoped refs to read-only operations and route ids is deterministic'), 'suite enforces request mapping');
  assert(suite.includes('availability parser accepts clear hit, miss, and unknown only'), 'suite enforces strict fixture parsing');
  assert(suite.includes('adapter factory remains injected-only and package test chain includes the suite'), 'suite enforces injected-only factory wiring');
});

test('TorBox smoke evidence - Phase 35 is docs/templates/static UI examples only', () => {
  assert(exists('docs/PHASE_35_TORBOX_SMOKE_EVIDENCE.md'), 'Phase 35 smoke evidence doc exists');
  assert(exists('docs/templates/TORBOX_SMOKE_EVIDENCE.md'), 'Phase 35 smoke evidence template exists');
  assert(exists('docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md'), 'Phase 35 future UI examples doc exists');
  assert(typeof pkg.scripts['test:torbox-smoke-evidence'] === 'string', 'test:torbox-smoke-evidence script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-smoke-evidence.ts'), 'TorBox smoke evidence suite in the CI chain');

  const doc = read('docs/PHASE_35_TORBOX_SMOKE_EVIDENCE.md');
  const tpl = read('docs/templates/TORBOX_SMOKE_EVIDENCE.md');
  const ui = read('docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md');
  const suite = read('test/torbox-smoke-evidence.ts');
  const readme = read('README.md');
  const factory = read('src/core/adapters/adapter-factory.ts');
  const combined = `${doc}\n${tpl}\n${ui}\n${readme}`;

  for (const kw of [
    'operator-run smoke design and evidence shape only',
    'not a live TorBox transport',
    'no `@torbox/torbox-api` dependency or import',
    'no global fetch',
    'no environment-variable reads',
    'no ADAPTER_MODE wiring',
    'no UI runtime',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(kw), `Phase 35 docs preserve ${kw}`);
  assert(/DB\s+writes/.test(combined), 'Phase 35 docs preserve no DB writes');
  assert(/adapter-factory\s+mode for TorBox/.test(combined), 'Phase 35 docs preserve no adapter-factory mode for TorBox');
  assert(/Real transport and live smoke remain a future separately authorized and\s+reviewed phase/.test(combined), 'Phase 35 keeps live transport/smoke future-gated');

  for (const forbidden of [
    'create-download',
    'request-download-link',
    'request-permalink',
    'user list',
    'user data',
    'control',
    'delete',
    'export',
    'CDN',
    'permalink',
    'playback',
    'downloading',
  ]) assert(combined.includes(forbidden), `Phase 35 docs explicitly forbid ${forbidden}`);

  for (const heading of [
    'Build',
    'Read-Only Confirmation',
    'Explicit Gates Checked',
    'Probe Summary',
    'Failure Categories',
    'Redaction Review Checklist',
    'Operator / Reviewer Signoff',
  ]) assert(tpl.includes(`## ${heading}`), `template includes ${heading}`);

  for (const forbiddenField of ['Token', 'API key', 'Raw URL', 'Raw ref', 'Provider payload', 'Response body', 'Title', 'Item id', 'CDN URL', 'Permalink']) {
    assert(!new RegExp(`^- ${forbiddenField}:`, 'mi').test(tpl), `template does not request ${forbiddenField}`);
  }

  for (const uiKw of [
    'quiet utilitarian operations UI',
    'dense tables',
    'restrained colors',
    '8px-or-less radius',
    'should not look like an AI-generated dashboard',
    'no hero section',
    'Readiness Gates',
    'TorBox Smoke',
    'Catalog Privacy',
    'Provider Availability',
    'Phase 35 adds no frontend code',
  ]) assert(ui.includes(uiKw), `UI examples cover ${uiKw}`);

  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assertTorBoxFactoryInjectedOnly(factory);
  assert(suite.includes('Phase 35 adds no production runtime module or transport implementation'), 'suite enforces no Phase 35 runtime module');
});

test('TorBox live smoke contract - Phase 36 is acceptance contract only', () => {
  assert(exists('docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md'), 'Phase 36 live smoke contract doc exists');
  assert(typeof pkg.scripts['test:torbox-live-smoke-contract'] === 'string', 'test:torbox-live-smoke-contract script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-contract.ts'), 'TorBox live smoke contract suite in the CI chain');

  const doc = read('docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md');
  const readme = read('README.md');
  const suite = read('test/torbox-live-smoke-contract.ts');
  const factory = read('src/core/adapters/adapter-factory.ts');
  const combined = `${doc}\n${readme}`;

  for (const kw of [
    'not a live transport',
    'not an operator command',
    'no live TorBox calls',
    'no real TorBox transport implementation',
    'no `@torbox/torbox-api` dependency or import',
    'no global fetch',
    'no environment-variable reads',
    'no ADAPTER_MODE wiring',
    'no adapter-factory mode for TorBox',
    'absent from `npm run test` and `npm run ci`',
    'disabled unless a live-smoke flag and a read-only flag are both present',
    'Execute read-only probes through an injected reviewed transport only',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian` remains a hardened reference harness',
  ]) assert(combined.includes(kw), `Phase 36 docs preserve ${kw}`);

  for (const forbidden of [
    'create-download',
    'request-download-link',
    'request-permalink',
    'user list',
    'user data',
    'control',
    'delete',
    'export',
    'CDN',
    'permalink URL',
    'playback',
    'downloading',
  ]) assert(combined.includes(forbidden), `Phase 36 docs explicitly forbid ${forbidden}`);

  for (const category of [
    'auth',
    'quota',
    'timeout',
    'transport',
    'parse',
    'unsupported-ref',
    'empty-ref',
    'ambiguous-response',
    'policy-block',
    'redaction-block',
    'not-authorized',
    'not-read-only',
  ]) assert(doc.includes(`\`${category}\``), `Phase 36 requires ${category} category`);

  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assertTorBoxFactoryInjectedOnly(factory);
  assert(exists('src/ops/torbox-smoke-cli.ts'), 'Phase 37 adds the refused-by-default TorBox smoke CLI shell');
  assert(!exists('src/core/adapters/torbox-live-transport.ts'), 'Phase 36 adds no live transport');
  assert(suite.includes('required future execution order is explicit and fail-closed before network contact'), 'suite enforces pre-network order');
});

test('TorBox smoke CLI shell - Phase 37 is refused-by-default and non-network', () => {
  assert(exists('docs/PHASE_37_TORBOX_SMOKE_CLI_SHELL.md'), 'Phase 37 smoke CLI shell doc exists');
  assert(exists('src/ops/torbox-smoke-shell.ts'), 'Phase 37 pure shell module exists');
  assert(exists('src/ops/torbox-smoke-cli.ts'), 'Phase 37 CLI wrapper exists');
  assert(typeof pkg.scripts['smoke:torbox-readonly'] === 'string', 'smoke:torbox-readonly script present');
  assert(typeof pkg.scripts['test:torbox-smoke-cli'] === 'string', 'test:torbox-smoke-cli script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-smoke-cli.ts'), 'TorBox smoke CLI shell suite in the CI chain');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator TorBox smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator TorBox smoke command is not in ci script');

  const doc = read('docs/PHASE_37_TORBOX_SMOKE_CLI_SHELL.md');
  const shell = read('src/ops/torbox-smoke-shell.ts');
  const cli = read('src/ops/torbox-smoke-cli.ts');
  const suite = read('test/torbox-smoke-cli.ts');
  const factory = read('src/core/adapters/adapter-factory.ts');
  const combined = `${doc}\n${shell}\n${cli}\n${suite}\n${read('README.md')}`;

  for (const kw of [
    'refuses before provider contact',
    'no live TorBox calls',
    'no real TorBox transport implementation',
    'no `@torbox/torbox-api` dependency or import',
    'no global fetch',
    'no environment-variable reads',
    'no ADAPTER_MODE wiring',
    'no adapter-factory mode for TorBox',
    'would-contact-torbox: false',
    'smoke-transport-attached',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian` remains a hardened reference harness',
  ]) assert(combined.includes(kw), `Phase 37 preserves ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'window.fetch',
    'process.env',
    'readdirSync',
    'docker compose',
  ]) assert(!`${shell}\n${cli}`.includes(forbidden), `Phase 37 source excludes ${forbidden}`);
  for (const forbidden of ['globalThis.fetch', 'fetch(', 'readFileSync', 'node:fs']) {
    assert(!shell.includes(forbidden), `Phase 37 shell excludes ${forbidden}`);
  }
  assert(cli.includes('globalThis.fetch') && cli.includes('openSync') && cli.includes('readSync'), 'Phase 43 operator CLI contains the bounded live attachment point');

  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assertTorBoxFactoryInjectedOnly(factory);
  assert(suite.includes('CLI emits parseable JSON refusal and never prints credential ref values'), 'suite covers CLI redaction');
});

test('TorBox smoke fixture harness - Phase 38 is deterministic local-only output', () => {
  assert(exists('docs/PHASE_38_TORBOX_SMOKE_FIXTURE_HARNESS.md'), 'Phase 38 fixture harness doc exists');
  assert(typeof pkg.scripts['test:torbox-smoke-fixture'] === 'string', 'test:torbox-smoke-fixture script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-smoke-fixture.ts'), 'TorBox fixture suite in the CI chain');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');

  const doc = read('docs/PHASE_38_TORBOX_SMOKE_FIXTURE_HARNESS.md');
  const shell = read('src/ops/torbox-smoke-shell.ts');
  const cli = read('src/ops/torbox-smoke-cli.ts');
  const suite = read('test/torbox-smoke-fixture.ts');
  const combined = `${doc}\n${shell}\n${cli}\n${suite}\n${read('README.md')}`;

  for (const kw of [
    'never contacts TorBox',
    'local deterministic fixture',
    'no live TorBox calls',
    'no real TorBox transport implementation',
    'no `@torbox/torbox-api` dependency or import',
    'no global fetch',
    'no environment-variable reads',
    'no ADAPTER_MODE wiring',
    'no adapter-factory mode for TorBox',
    'fixture-ok',
    'ambiguous-response',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian` remains a hardened reference',
  ]) assert(combined.includes(kw), `Phase 38 preserves ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'window.fetch',
    'process.env',
    'readdirSync',
    'docker compose',
  ]) assert(!`${shell}\n${cli}`.includes(forbidden), `Phase 38 source excludes ${forbidden}`);
  for (const forbidden of ['globalThis.fetch', 'fetch(', 'readFileSync', 'node:fs']) {
    assert(!shell.includes(forbidden), `Phase 38 shell excludes ${forbidden}`);
  }
  assert(cli.includes('globalThis.fetch') && cli.includes('openSync') && cli.includes('readSync'), 'Phase 43 operator CLI contains the bounded live attachment point');
});

test('TorBox transport acceptance - Phase 39 is deterministic local-only harnessing', () => {
  assert(exists('docs/PHASE_39_TORBOX_TRANSPORT_ACCEPTANCE.md'), 'Phase 39 transport acceptance doc exists');
  assert(exists('src/ops/torbox-transport-acceptance.ts'), 'Phase 39 transport acceptance source exists');
  assert(typeof pkg.scripts['test:torbox-transport-acceptance'] === 'string', 'test:torbox-transport-acceptance script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-transport-acceptance.ts'), 'TorBox transport acceptance suite in the CI chain');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');

  const doc = read('docs/PHASE_39_TORBOX_TRANSPORT_ACCEPTANCE.md');
  const source = read('src/ops/torbox-transport-acceptance.ts');
  const suite = read('test/torbox-transport-acceptance.ts');
  const combined = `${doc}\n${source}\n${suite}\n${read('README.md')}`;

  for (const kw of [
    'deterministic transport acceptance harness',
    'does not add a live TorBox transport',
    'no live TorBox calls',
    'no real TorBox transport implementation',
    'no `@torbox/torbox-api` dependency or import',
    'no global fetch',
    'no environment-variable reads',
    'no ADAPTER_MODE wiring',
    'no adapter-factory mode for TorBox',
    'injected local fixtures only',
    'ambiguous-response',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian` remains a hardened reference',
  ]) assert(combined.includes(kw), `Phase 39 preserves ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'window.fetch',
    'fetch(',
    'process.env',
    'readFileSync',
    'readdirSync',
    'docker compose',
    'createTorBoxTransport',
    'TorBoxLiveTransport',
    'ADAPTER_MODE',
  ]) assert(!source.includes(forbidden), `Phase 39 source excludes ${forbidden}`);
});

test('TorBox smoke readiness preflight - Phase 40 is descriptor-only and non-live', () => {
  assert(exists('docs/PHASE_40_TORBOX_SMOKE_READINESS_PREFLIGHT.md'), 'Phase 40 smoke readiness preflight doc exists');
  assert(exists('src/ops/torbox-smoke-readiness-preflight.ts'), 'Phase 40 pure preflight source exists');
  assert(exists('src/ops/torbox-smoke-readiness-preflight-cli.ts'), 'Phase 40 CLI preflight source exists');
  assert(typeof pkg.scripts['ops:torbox-smoke-readiness-preflight'] === 'string', 'ops:torbox-smoke-readiness-preflight script present');
  assert(typeof pkg.scripts['test:torbox-smoke-readiness-preflight'] === 'string', 'test:torbox-smoke-readiness-preflight script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-smoke-readiness-preflight.ts'), 'TorBox smoke readiness preflight suite in the CI chain');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');

  const doc = read('docs/PHASE_40_TORBOX_SMOKE_READINESS_PREFLIGHT.md');
  const preflight = read('src/ops/torbox-smoke-readiness-preflight.ts');
  const cli = read('src/ops/torbox-smoke-readiness-preflight-cli.ts');
  const suite = read('test/torbox-smoke-readiness-preflight.ts');
  const combined = `${doc}\n${preflight}\n${cli}\n${suite}\n${read('README.md')}`;

  for (const kw of [
    'static, redaction-safe descriptor preflight',
    'does not add a live TorBox transport',
    'no live TorBox calls',
    'no real TorBox transport implementation',
    'no `@torbox/torbox-api` dependency or import',
    'no global fetch',
    'no environment-variable reads',
    'no ADAPTER_MODE wiring',
    'no adapter-factory mode for TorBox',
    'descriptorValuesEchoed: false',
    'liveTorBoxContact: false',
    'closesLiveSmokeReadiness: false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian` remains a hardened reference',
  ]) assert(combined.includes(kw), `Phase 40 preserves ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'window.fetch',
    'fetch(',
    'process.env',
    'readFileSync',
    'readdirSync',
    'docker compose',
    'createTorBoxTransport',
    'TorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'ADAPTER_MODE',
  ]) assert(!`${preflight}\n${cli}`.includes(forbidden), `Phase 40 source excludes ${forbidden}`);

  assert(cli.includes("from 'node:fs'") && cli.includes('openSync') && cli.includes('readSync'), 'Phase 40 CLI has explicit bounded descriptor file read');
  assert(!preflight.includes("node:fs"), 'Phase 40 pure preflight module has no fs import');
  assert(!(pkg.scripts['ops:torbox-smoke-readiness-preflight'] ?? '').includes('docker'), 'Phase 40 command does not invoke Docker');
});

test('TorBox endpoint mapping - Phase 41 is static review only and non-live', () => {
  assert(exists('docs/PHASE_41_TORBOX_ENDPOINT_MAPPING.md'), 'Phase 41 endpoint mapping doc exists');
  assert(typeof pkg.scripts['test:torbox-endpoint-mapping'] === 'string', 'test:torbox-endpoint-mapping script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-endpoint-mapping.ts'), 'TorBox endpoint mapping suite in the CI chain');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');

  const doc = read('docs/PHASE_41_TORBOX_ENDPOINT_MAPPING.md');
  const suite = read('test/torbox-endpoint-mapping.ts');
  const factory = read('src/core/adapters/adapter-factory.ts');
  const combined = `${doc}\n${suite}\n${read('README.md')}`;

  for (const kw of [
    'static review artifact only',
    'https://api.torbox.app/openapi.json',
    'https://api.torbox.app/docs',
    'GeneralService.getUpStatus',
    'TorrentsService.getTorrentCachedAvailability',
    'WebDownloadsDebridService.getWebDownloadCachedAvailability',
    'UsenetService.getUsenetCachedAvailability',
    'WebDownloadsDebridService.getHosterList',
    '/v1/api/torrents/checkcached',
    '/v1/api/webdl/checkcached',
    '/v1/api/usenet/checkcached',
    '/v1/api/webdl/hosters',
    'Authorization Bearer header',
    'Query-string tokens are forbidden',
    'no live TorBox calls',
    'no real TorBox transport implementation',
    'no `@torbox/torbox-api` dependency or import',
    'no global fetch',
    'environment-variable reads',
    'no provider mode wiring',
    'does not authorize live smoke',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian` remains a hardened reference',
  ]) assert(combined.includes(kw), `Phase 41 preserves ${kw}`);
  assert(/Phase 41 allows `GET` only for the\s+first future live-smoke transport/.test(combined), 'Phase 41 preserves GET-only first live-smoke transport');

  for (const gated of [
    '/v1/api/torrents/requestdl',
    '/v1/api/webdl/requestdl',
    '/v1/api/usenet/requestdl',
    'token query parameters',
    'CDN/permalink URLs',
    '/v1/api/torrents/torrentinfo',
    'authenticated hoster-list user metrics',
  ]) assert(doc.includes(gated), `Phase 41 future-gates ${gated}`);

  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assertTorBoxFactoryInjectedOnly(factory);
  assert(!exists('src/core/adapters/torbox-live-transport.ts'), 'no adapter live TorBox transport exists');
});

test('TorBox live transport - Phase 42 is injected, GET-only, and still detached from provider mode', () => {
  assert(exists('src/ops/torbox-live-transport.ts'), 'Phase 42 live transport source exists');
  assert(exists('docs/PHASE_42_TORBOX_LIVE_TRANSPORT.md'), 'Phase 42 live transport doc exists');
  assert(typeof pkg.scripts['test:torbox-live-transport'] === 'string', 'test:torbox-live-transport script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-transport.ts'), 'TorBox live transport suite in the CI chain');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');

  const source = read('src/ops/torbox-live-transport.ts');
  const suite = read('test/torbox-live-transport.ts');
  const doc = read('docs/PHASE_42_TORBOX_LIVE_TRANSPORT.md');
  const factory = read('src/core/adapters/adapter-factory.ts');
  const combined = `${source}\n${suite}\n${doc}\n${read('README.md')}`;

  for (const kw of [
    'createTorBoxLiveTransport',
    'injected-fetch',
    'GET-only mapping',
    'Authorization Bearer header',
    '/v1/api/torrents/checkcached',
    '/v1/api/webdl/checkcached',
    '/v1/api/usenet/checkcached',
    '/v1/api/webdl/hosters',
    'format=object',
    'list_files=false',
    'never returns raw provider payloads',
    'no TorBox SDK dependency or import',
    'no `globalThis.fetch` construction in this module',
    'no environment-variable reads',
    'no request-download-link',
    'token-query download route',
    'no `ADAPTER_MODE` wiring',
    'does not prove TorBox works against a real account',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian` remains a hardened reference',
  ]) assert(combined.includes(kw), `Phase 42 preserves ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    "from 'pg'",
    'from "pg"',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'window.fetch',
    'process.env',
    'readFileSync',
    'readdirSync',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'requestdl',
  ]) assert(!source.includes(forbidden), `Phase 42 source excludes ${forbidden}`);

  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assertTorBoxFactoryInjectedOnly(factory);
  assert(!exists('src/core/adapters/torbox-live-transport.ts'), 'no core adapter live transport exists');
});

test('TorBox live smoke CLI - Phase 43 is operator-run, redacted, and still detached from provider mode', () => {
  assert(exists('src/ops/torbox-live-smoke-runner.ts'), 'Phase 43 live smoke runner exists');
  assert(exists('docs/PHASE_43_TORBOX_LIVE_SMOKE_CLI.md'), 'Phase 43 live smoke CLI doc exists');
  assert(typeof pkg.scripts['test:torbox-live-smoke-cli'] === 'string', 'test:torbox-live-smoke-cli script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-cli.ts'), 'TorBox live smoke CLI suite in the CI chain');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in ci script');

  const runner = read('src/ops/torbox-live-smoke-runner.ts');
  const cli = read('src/ops/torbox-smoke-cli.ts');
  const shell = read('src/ops/torbox-smoke-shell.ts');
  const suite = read('test/torbox-live-smoke-cli.ts');
  const doc = read('docs/PHASE_43_TORBOX_LIVE_SMOKE_CLI.md');
  const factory = read('src/core/adapters/adapter-factory.ts');
  const combined = `${runner}\n${cli}\n${shell}\n${suite}\n${doc}\n${read('README.md')}`;

  for (const kw of [
    'smoke:torbox-readonly',
    '--live-transport',
    '--credential-file',
    'operator-run only',
    'absent from `npm run test` / `npm run ci`',
    'fixed categories',
    'No credential values, credential file paths, raw refs, provider payloads, or endpoint URLs are emitted.',
    'no provider mode',
    'adapter-factory',
    'downloads',
    'playback',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian` remains a hardened reference',
  ]) assert(combined.includes(kw), `Phase 43 preserves ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    "from 'pg'",
    'from "pg"',
    'process.env',
    'ADAPTER_MODE',
    'createAdapter',
    'requestdl',
    'requestDownloadLink',
    'create-download',
    'cdn-url',
  ]) assert(!`${runner}\n${cli}\n${shell}`.includes(forbidden), `Phase 43 source excludes ${forbidden}`);

  for (const forbidden of ['node:fs', 'globalThis.fetch', 'fetch(', 'readFileSync']) {
    assert(!runner.includes(forbidden), `Phase 43 runner excludes ${forbidden}`);
    assert(!shell.includes(forbidden), `Phase 43 shell excludes ${forbidden}`);
  }
  assert(cli.includes('globalThis.fetch'), 'operator CLI is TorBox fetch attachment point');
  assert(cli.includes('openSync') && cli.includes('readSync') && !cli.includes('readFileSync'), 'operator CLI uses bounded credential file read');
  assertTorBoxFactoryInjectedOnly(factory);
});

test('TorBox live smoke evidence preflight - Phase 44 verifies saved reports without live contact', () => {
  assert(exists('src/ops/torbox-live-smoke-evidence-preflight.ts'), 'Phase 44 pure preflight source exists');
  assert(exists('src/ops/torbox-live-smoke-evidence-preflight-cli.ts'), 'Phase 44 preflight CLI exists');
  assert(exists('docs/PHASE_44_TORBOX_LIVE_SMOKE_EVIDENCE_PREFLIGHT.md'), 'Phase 44 doc exists');
  assert(typeof pkg.scripts['ops:torbox-live-smoke-evidence-preflight'] === 'string', 'ops script present');
  assert(typeof pkg.scripts['test:torbox-live-smoke-evidence-preflight'] === 'string', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-evidence-preflight.ts'), 'Phase 44 suite in the CI chain');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in ci script');

  const preflight = read('src/ops/torbox-live-smoke-evidence-preflight.ts');
  const cli = read('src/ops/torbox-live-smoke-evidence-preflight-cli.ts');
  const suite = read('test/torbox-live-smoke-evidence-preflight.ts');
  const doc = read('docs/PHASE_44_TORBOX_LIVE_SMOKE_EVIDENCE_PREFLIGHT.md');
  const combined = `${preflight}\n${cli}\n${suite}\n${doc}\n${read('README.md')}`;

  for (const kw of [
    'phase-44-torbox-live-smoke-evidence-preflight',
    'single-user-supplied-json-file',
    'evidenceValuesEchoed: false',
    'liveTorBoxContact: false',
    'closesLiveSmokeReview: false',
    'does not contact TorBox',
    'does not echo evidence values',
    'no live TorBox call',
    'no credential-file',
    'no provider mode',
    'downloading',
    'playback',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian` remains a hardened reference',
  ]) assert(combined.includes(kw), `Phase 44 preserves ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    "from 'pg'",
    'from "pg"',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'ADAPTER_MODE',
    'createAdapter',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'requestdl',
    'requestDownloadLink',
    'create-download',
    'cdn-url',
    'readFileSync',
  ]) assert(!`${preflight}\n${cli}`.includes(forbidden), `Phase 44 source excludes ${forbidden}`);
  assert(cli.includes('openSync') && cli.includes('readSync'), 'Phase 44 CLI uses bounded file read');
  assert(!preflight.includes("node:fs"), 'Phase 44 pure preflight module has no fs import');
});

test('TorBox live smoke operator plan - Phase 45 is static command planning only', () => {
  assert(exists('src/ops/torbox-live-smoke-plan.ts'), 'Phase 45 pure plan source exists');
  assert(exists('src/ops/torbox-live-smoke-plan-cli.ts'), 'Phase 45 plan CLI exists');
  assert(exists('docs/PHASE_45_TORBOX_LIVE_SMOKE_OPERATOR_PLAN.md'), 'Phase 45 doc exists');
  assert(typeof pkg.scripts['ops:torbox-live-smoke-plan'] === 'string', 'ops script present');
  assert(typeof pkg.scripts['test:torbox-live-smoke-plan'] === 'string', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-plan.ts'), 'Phase 45 suite in the CI chain');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in ci script');

  const plan = read('src/ops/torbox-live-smoke-plan.ts');
  const cli = read('src/ops/torbox-live-smoke-plan-cli.ts');
  const suite = read('test/torbox-live-smoke-plan.ts');
  const doc = read('docs/PHASE_45_TORBOX_LIVE_SMOKE_OPERATOR_PLAN.md');
  const combined = `${plan}\n${cli}\n${suite}\n${doc}\n${read('README.md')}`;

  for (const kw of [
    'phase-45-torbox-live-smoke-operator-plan',
    'ops:torbox-live-smoke-plan',
    '<torbox-token-file>',
    '<redacted-cache-ref>',
    'commandExecution: false',
    'liveTorBoxContact: false',
    'credentialValuesIncluded: false',
    'rawRefsIncluded: false',
    'placeholder-only',
    'executes nothing',
    'no live network',
    'provider mode',
    'downloading',
    'playback',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian` remains a hardened reference',
  ]) assert(combined.includes(kw), `Phase 45 preserves ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    "from 'pg'",
    'from "pg"',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'ADAPTER_MODE',
    'createAdapter',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'requestdl',
    'requestDownloadLink',
    'create-download',
    'cdn-url',
    'readFileSync',
    'spawnSync',
    'execFileSync',
  ]) assert(!`${plan}\n${cli}`.includes(forbidden), `Phase 45 source excludes ${forbidden}`);
});

test('TorBox catalog bridge - Phase 47 proves encrypted infohash refs through injected adapter only', () => {
  assert(exists('docs/PHASE_47_TORBOX_CATALOG_BRIDGE.md'), 'Phase 47 catalog bridge doc exists');
  assert(exists('test/torbox-catalog-bridge.ts'), 'Phase 47 catalog bridge suite exists');
  assert(typeof pkg.scripts['test:torbox-catalog-bridge'] === 'string', 'test:torbox-catalog-bridge script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-catalog-bridge.ts 5451'), 'Phase 47 suite in the CI chain');

  const doc = read('docs/PHASE_47_TORBOX_CATALOG_BRIDGE.md');
  const suite = read('test/torbox-catalog-bridge.ts');
  const combined = `${doc}\n${suite}\n${read('README.md')}`;
  for (const kw of [
    'CatalogAuthority.withProviderRef()',
    'createAdapter({ mode: \'torbox-readonly\', transport })',
    'persisted `infohash` provider refs only',
    'writes no events',
    'no provider ref rows',
    'no live TorBox calls',
    'no SDK dependency',
    'no env secret reads',
    'no credential-file reads',
    'no live transport construction in core',
    'no download',
    'playback',
    'Live validation remains operator-run',
    'O4 and O5 remain open/deferred',
    'FileCustodian` remains a hardened reference harness',
  ]) assert(combined.includes(kw), `Phase 47 preserves ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'process.env.TORBOX',
    'createTorBoxLiveTransport',
  ]) assert(!suite.includes(forbidden), `Phase 47 suite excludes ${forbidden}`);
});

test('TorBox smoke command plan fix - Phase 48 keeps npm command shapes copy/paste safe', () => {
  assert(exists('docs/PHASE_48_TORBOX_SMOKE_COMMAND_PLAN_FIX.md'), 'Phase 48 command plan fix doc exists');
  const plan = read('src/ops/torbox-live-smoke-plan.ts');
  const suite = read('test/torbox-live-smoke-plan.ts');
  const doc = read('docs/PHASE_48_TORBOX_SMOKE_COMMAND_PLAN_FIX.md');
  const combined = `${plan}\n${suite}\n${doc}\n${read('README.md')}`;

  for (const kw of [
    'npm run --silent smoke:torbox-readonly -- -- --live-smoke',
    'npm run --silent ops:torbox-live-smoke-evidence-preflight -- --',
    'copy-paste-safe npm separators',
    'clean JSON',
    'no live TorBox calls',
    'no command execution from the plan command',
    'O4 and O5 remain open/deferred',
  ]) assert(combined.includes(kw), `Phase 48 preserves ${kw}`);

  assert(!plan.includes('npm run smoke:torbox-readonly -- --live-smoke'), 'old npm-consuming live smoke shape removed');
  assert(!plan.includes('npm run ops:torbox-live-smoke-evidence-preflight -- -- <'), 'old noisy preflight shape removed');
});

test('TorBox live smoke summary pack - Phase 49 summarizes explicit redacted reports only', () => {
  assert(exists('docs/PHASE_49_TORBOX_LIVE_SMOKE_SUMMARY_PACK.md'), 'Phase 49 summary pack doc exists');
  assert(exists('src/ops/torbox-live-smoke-summary-pack.ts'), 'Phase 49 pure summary source exists');
  assert(exists('src/ops/torbox-live-smoke-summary-pack-cli.ts'), 'Phase 49 summary CLI exists');
  assert(typeof pkg.scripts['ops:torbox-live-smoke-summary-pack'] === 'string', 'ops script present');
  assert(typeof pkg.scripts['test:torbox-live-smoke-summary-pack'] === 'string', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-summary-pack.ts'), 'Phase 49 suite in the CI chain');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in ci script');

  const summary = read('src/ops/torbox-live-smoke-summary-pack.ts');
  const cli = read('src/ops/torbox-live-smoke-summary-pack-cli.ts');
  const suite = read('test/torbox-live-smoke-summary-pack.ts');
  const doc = read('docs/PHASE_49_TORBOX_LIVE_SMOKE_SUMMARY_PACK.md');
  const combined = `${summary}\n${cli}\n${suite}\n${doc}\n${read('README.md')}`;

  for (const kw of [
    'phase-49-torbox-live-smoke-summary-pack',
    'explicit-operator-supplied-json-files',
    'evidenceValuesEchoed: false',
    'credentialPathsIncluded: false',
    'rawRefsIncluded: false',
    'providerPayloadsIncluded: false',
    'liveTorBoxContact: false',
    'commandExecution: false',
    'does not close live-smoke review',
    'O4 and O5 remain open/deferred',
    'FileCustodian',
  ]) assert(combined.includes(kw), `Phase 49 preserves ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'docker compose',
  ]) assert(!`${summary}\n${cli}`.includes(forbidden), `Phase 49 source excludes ${forbidden}`);
  assert(!summary.includes("from 'node:fs'"), 'pure summary module has no filesystem dependency');
  assert(cli.includes("from 'node:fs'") && cli.includes('openSync') && cli.includes('readSync'), 'CLI has bounded explicit file reads');
});

test('TorBox live smoke labels - Phase 50 keeps producer, preflight, and summary labels in lockstep', () => {
  assert(exists('docs/PHASE_50_TORBOX_LIVE_SMOKE_LABEL_CONTRACT.md'), 'Phase 50 label contract doc exists');
  assert(exists('src/ops/torbox-live-smoke-labels.ts'), 'Phase 50 shared label source exists');
  assert(exists('test/torbox-live-smoke-labels.ts'), 'Phase 50 label suite exists');
  assert(typeof pkg.scripts['test:torbox-live-smoke-labels'] === 'string', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-labels.ts'), 'Phase 50 suite in the CI chain');

  const labels = read('src/ops/torbox-live-smoke-labels.ts');
  const preflight = read('src/ops/torbox-live-smoke-evidence-preflight.ts');
  const summary = read('src/ops/torbox-live-smoke-summary-pack.ts');
  const runner = read('src/ops/torbox-live-smoke-runner.ts');
  const shell = read('src/ops/torbox-smoke-shell.ts');
  const suite = read('test/torbox-live-smoke-labels.ts');
  const doc = read('docs/PHASE_50_TORBOX_LIVE_SMOKE_LABEL_CONTRACT.md');
  const combined = `${labels}\n${preflight}\n${summary}\n${runner}\n${shell}\n${suite}\n${doc}\n${read('README.md')}`;

  for (const kw of [
    'TORBOX_LIVE_SMOKE_PROBES',
    'TORBOX_LIVE_SMOKE_OPERATIONS',
    'TORBOX_LIVE_SMOKE_CATEGORIES',
    'torBoxLiveSmokeOperationForProbe',
    'fixedTorBoxLiveSmokeProbe',
    'fixedTorBoxLiveSmokeOperation',
    'fixedTorBoxLiveSmokeCategory',
    'Phase 43 report production, Phase 44 preflight, and Phase 49',
    'O4 and O5 remain open/deferred',
  ]) assert(combined.includes(kw), `Phase 50 preserves ${kw}`);

  assert(!preflight.includes("const PROBES = ['service-status'"), 'Phase 44 local probe duplicate removed');
  assert(!summary.includes("const PROBES = ['service-status'"), 'Phase 49 local probe duplicate removed');
  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'node:fs',
    'node:http',
    'node:https',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
  ]) assert(!labels.includes(forbidden), `Phase 50 label source excludes ${forbidden}`);
});

test('TorBox live smoke review gate - Phase 51 verifies required summary probes without live contact', () => {
  assert(exists('docs/PHASE_51_TORBOX_LIVE_SMOKE_REVIEW_GATE.md'), 'Phase 51 review gate doc exists');
  assert(exists('src/ops/torbox-live-smoke-review-gate.ts'), 'Phase 51 pure review gate source exists');
  assert(exists('src/ops/torbox-live-smoke-review-gate-cli.ts'), 'Phase 51 review gate CLI exists');
  assert(exists('test/torbox-live-smoke-review-gate.ts'), 'Phase 51 review gate suite exists');
  assert(typeof pkg.scripts['ops:torbox-live-smoke-review-gate'] === 'string', 'ops script present');
  assert(typeof pkg.scripts['test:torbox-live-smoke-review-gate'] === 'string', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-review-gate.ts'), 'Phase 51 suite in the CI chain');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in ci script');

  const gate = read('src/ops/torbox-live-smoke-review-gate.ts');
  const cli = read('src/ops/torbox-live-smoke-review-gate-cli.ts');
  const suite = read('test/torbox-live-smoke-review-gate.ts');
  const doc = read('docs/PHASE_51_TORBOX_LIVE_SMOKE_REVIEW_GATE.md');
  const combined = `${gate}\n${cli}\n${suite}\n${doc}\n${read('README.md')}`;

  for (const kw of [
    'phase-51-torbox-live-smoke-review-gate',
    'single-phase-49-summary-pack-json-file',
    'summaryValuesEchoed: false',
    'credentialPathsIncluded: false',
    'rawRefsIncluded: false',
    'providerPayloadsIncluded: false',
    'liveTorBoxContact: false',
    'commandExecution: false',
    'service-status',
    'hoster-metadata',
    'does not close live-smoke review',
    'O4 and O5 remain open/deferred',
    'FileCustodian',
  ]) assert(combined.includes(kw), `Phase 51 preserves ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'docker compose',
  ]) assert(!`${gate}\n${cli}`.includes(forbidden), `Phase 51 source excludes ${forbidden}`);
  assert(!gate.includes("from 'node:fs'"), 'pure review gate module has no filesystem dependency');
  assert(cli.includes("from 'node:fs'") && cli.includes('openSync') && cli.includes('readSync'), 'CLI has bounded explicit file reads');
});

test('TorBox live smoke operator packet - Phase 52 packages run-save-review without live contact', () => {
  assert(exists('docs/PHASE_52_TORBOX_LIVE_SMOKE_OPERATOR_PACKET.md'), 'Phase 52 operator packet doc exists');
  assert(exists('src/ops/torbox-live-smoke-operator-packet.ts'), 'Phase 52 pure packet source exists');
  assert(exists('src/ops/torbox-live-smoke-operator-packet-cli.ts'), 'Phase 52 packet CLI exists');
  assert(exists('test/torbox-live-smoke-operator-packet.ts'), 'Phase 52 packet suite exists');
  assert(typeof pkg.scripts['ops:torbox-live-smoke-operator-packet'] === 'string', 'ops script present');
  assert(typeof pkg.scripts['test:torbox-live-smoke-operator-packet'] === 'string', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-operator-packet.ts'), 'Phase 52 suite in the CI chain');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in ci script');

  const packet = read('src/ops/torbox-live-smoke-operator-packet.ts');
  const cli = read('src/ops/torbox-live-smoke-operator-packet-cli.ts');
  const suite = read('test/torbox-live-smoke-operator-packet.ts');
  const doc = read('docs/PHASE_52_TORBOX_LIVE_SMOKE_OPERATOR_PACKET.md');
  const combined = `${packet}\n${cli}\n${suite}\n${doc}\n${read('README.md')}`;

  for (const kw of [
    'phase-52-torbox-live-smoke-operator-packet',
    'static-operator-workflow-packet',
    'service-status',
    'hoster-metadata',
    'cache-availability',
    'ops:torbox-live-smoke-evidence-preflight',
    'ops:torbox-live-smoke-summary-pack',
    'ops:torbox-live-smoke-review-gate',
    'summaryValuesEchoed: false',
    'credentialPathsIncluded: false',
    'rawRefsIncluded: false',
    'providerPayloadsIncluded: false',
    'liveTorBoxContact: false',
    'commandExecution: false',
    'does not close live-smoke review',
    'O4 and O5 remain open/deferred',
    'FileCustodian',
  ]) assert(combined.includes(kw), `Phase 52 preserves ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'node:fs'",
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'docker compose',
  ]) assert(!`${packet}\n${cli}`.includes(forbidden), `Phase 52 source excludes ${forbidden}`);
});

test('TorBox live smoke packet manifest - Phase 53 preflights retained artifact manifest only', () => {
  assert(exists('docs/PHASE_53_TORBOX_LIVE_SMOKE_PACKET_MANIFEST.md'), 'Phase 53 packet manifest doc exists');
  assert(exists('src/ops/torbox-live-smoke-packet-manifest.ts'), 'Phase 53 pure manifest source exists');
  assert(exists('src/ops/torbox-live-smoke-packet-manifest-cli.ts'), 'Phase 53 manifest CLI exists');
  assert(exists('test/torbox-live-smoke-packet-manifest.ts'), 'Phase 53 manifest suite exists');
  assert(typeof pkg.scripts['ops:torbox-live-smoke-packet-manifest'] === 'string', 'ops script present');
  assert(typeof pkg.scripts['test:torbox-live-smoke-packet-manifest'] === 'string', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-packet-manifest.ts'), 'Phase 53 suite in the CI chain');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in ci script');

  const manifest = read('src/ops/torbox-live-smoke-packet-manifest.ts');
  const cli = read('src/ops/torbox-live-smoke-packet-manifest-cli.ts');
  const suite = read('test/torbox-live-smoke-packet-manifest.ts');
  const doc = read('docs/PHASE_53_TORBOX_LIVE_SMOKE_PACKET_MANIFEST.md');
  const combined = `${manifest}\n${cli}\n${suite}\n${doc}\n${read('README.md')}`;

  for (const kw of [
    'phase-53-torbox-live-smoke-packet-manifest',
    'single-operator-supplied-packet-manifest-json-file',
    'phase-43-service-status-report',
    'phase-43-hoster-metadata-report',
    'phase-44-service-status-preflight',
    'phase-44-hoster-metadata-preflight',
    'phase-49-summary-pack',
    'phase-51-review-gate',
    'artifactContentsIncluded: false',
    'manifestValuesEchoed: false',
    'credentialPathsIncluded: false',
    'rawRefsIncluded: false',
    'providerPayloadsIncluded: false',
    'liveTorBoxContact: false',
    'commandExecution: false',
    'does not close live-smoke review',
    'O4 and O5 remain open/deferred',
    'FileCustodian',
  ]) assert(combined.includes(kw), `Phase 53 preserves ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'docker compose',
  ]) assert(!`${manifest}\n${cli}`.includes(forbidden), `Phase 53 source excludes ${forbidden}`);
  assert(!manifest.includes("from 'node:fs'"), 'pure manifest module has no filesystem dependency');
  assert(cli.includes("from 'node:fs'") && cli.includes('openSync') && cli.includes('readSync'), 'CLI has bounded explicit file reads');
});

test('TorBox live smoke acceptance record - Phase 54 records review disposition without provider activation', () => {
  assert(exists('docs/PHASE_54_TORBOX_LIVE_SMOKE_ACCEPTANCE_RECORD.md'), 'Phase 54 acceptance doc exists');
  assert(exists('src/ops/torbox-live-smoke-acceptance-record.ts'), 'Phase 54 pure acceptance source exists');
  assert(exists('src/ops/torbox-live-smoke-acceptance-record-cli.ts'), 'Phase 54 acceptance CLI exists');
  assert(exists('test/torbox-live-smoke-acceptance-record.ts'), 'Phase 54 acceptance suite exists');
  assert(typeof pkg.scripts['ops:torbox-live-smoke-acceptance-record'] === 'string', 'ops script present');
  assert(typeof pkg.scripts['test:torbox-live-smoke-acceptance-record'] === 'string', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-acceptance-record.ts'), 'Phase 54 suite in the CI chain');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');

  const source = read('src/ops/torbox-live-smoke-acceptance-record.ts');
  const cli = read('src/ops/torbox-live-smoke-acceptance-record-cli.ts');
  const suite = read('test/torbox-live-smoke-acceptance-record.ts');
  const doc = read('docs/PHASE_54_TORBOX_LIVE_SMOKE_ACCEPTANCE_RECORD.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${read('README.md')}`;
  for (const kw of [
    'phase-54-torbox-live-smoke-acceptance-record',
    'single-operator-supplied-acceptance-record-json-file',
    'accepted',
    'rejected',
    'deferred',
    'packetManifestPreflight',
    'enablesProviderMode: false',
    'credentialPathsIncluded: false',
    'rawRefsIncluded: false',
    'providerPayloadsIncluded: false',
    'liveTorBoxContact: false',
    'commandExecution: false',
    'does not enable TorBox provider mode',
    'O4 and O5 remain open/deferred',
    'FileCustodian',
  ]) assert(combined.includes(kw), `Phase 54 preserves ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'docker compose',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 54 source excludes ${forbidden}`);
  assert(!source.includes("from 'node:fs'"), 'pure acceptance module has no filesystem dependency');
  assert(cli.includes("from 'node:fs'") && cli.includes('openSync') && cli.includes('readSync'), 'CLI has bounded explicit file reads');
});

test('publisher boundary - Phase 8 doc + suites wired; erasure-conflict noted', () => {
  // the network/provider scope scan above already covers the publisher files under src/core/adapters.
  for (const f of ['src/core/adapters/publisher.ts', 'src/core/adapters/fake-publisher.ts', 'src/core/adapters/publisher-factory.ts']) {
    assert(exists(f), `${f} exists`);
  }
  assert(exists('docs/PHASE_8_PUBLISHER_BOUNDARY.md'), 'publisher boundary doc exists');
  const doc = read('docs/PHASE_8_PUBLISHER_BOUNDARY.md');
  for (const kw of ['PublishableIdentity', 'withPublishableIdentity', 'PUBLISHER_MODE', 'dry-run', 'advisory', 'deferred']) assert(doc.includes(kw), `doc covers ${kw}`);
  assert(/crypto-shred|erasure/i.test(doc), 'doc states the publish-vs-erasure policy conflict');
  assert((pkg.scripts.test ?? '').includes('test/publisher-privacy.ts') && (pkg.scripts.test ?? '').includes('test/publisher-contract.ts'), 'publisher suites in the CI chain');
});

test('provider availability policy - Phase 55 keeps advisory provider results non-authoritative', () => {
  assert(exists('src/core/adapters/provider-availability-policy.ts'), 'Phase 55 policy source exists');
  assert(exists('docs/PHASE_55_PROVIDER_AVAILABILITY_POLICY.md'), 'Phase 55 policy doc exists');
  assert(exists('test/provider-availability-policy.ts'), 'Phase 55 policy suite exists');
  assert(typeof pkg.scripts['test:provider-availability-policy'] === 'string', 'Phase 55 test script present');
  assert((pkg.scripts.test ?? '').includes('test/provider-availability-policy.ts'), 'Phase 55 suite in CI chain');

  const source = read('src/core/adapters/provider-availability-policy.ts');
  const doc = read('docs/PHASE_55_PROVIDER_AVAILABILITY_POLICY.md');
  const combined = `${source}\n${doc}\n${read('README.md')}`;
  for (const kw of [
    'Provider availability policy (Phase 55)',
    'advisoryOnly',
    'persisted: false',
    'available',
    'unavailable',
    'unknown',
    'stale',
    'invalid',
    'candidate',
    'skip',
    'hold',
    'redaction-safe',
    'never echoes provider locators',
  ]) assert(combined.includes(kw), `Phase 55 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'readFileSync',
    "from 'node:fs'",
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'document.',
    'window.',
  ]) assert(!source.includes(forbidden), `Phase 55 source excludes ${forbidden}`);
});

test('provider availability bridge - Phase 56 classifies scoped adapter output without echoing provider detail', () => {
  assert(exists('src/core/adapters/provider-availability-bridge.ts'), 'Phase 56 bridge source exists');
  assert(exists('docs/PHASE_56_PROVIDER_AVAILABILITY_BRIDGE.md'), 'Phase 56 bridge doc exists');
  assert(exists('test/provider-availability-bridge.ts'), 'Phase 56 bridge suite exists');
  assert(typeof pkg.scripts['test:provider-availability-bridge'] === 'string', 'Phase 56 test script present');
  assert((pkg.scripts.test ?? '').includes('test/provider-availability-bridge.ts'), 'Phase 56 suite in CI chain');

  const source = read('src/core/adapters/provider-availability-bridge.ts');
  const suite = read('test/torbox-catalog-bridge.ts');
  const doc = read('docs/PHASE_56_PROVIDER_AVAILABILITY_BRIDGE.md');
  const combined = `${source}\n${suite}\n${doc}\n${read('README.md')}`;
  for (const kw of [
    'Provider availability bridge (Phase 56)',
    'resolveProviderAvailability',
    'decideProviderAvailability',
    'echoesAdapterLocator: false',
    'echoesAdapterDetail: false',
    'persisted: false',
    'candidate',
    'skip',
    'hold',
    'sanitized',
    'no provider locator or detail echo',
  ]) assert(combined.includes(kw), `Phase 56 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'readFileSync',
    "from 'node:fs'",
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'document.',
    'window.',
  ]) assert(!source.includes(forbidden), `Phase 56 source excludes ${forbidden}`);
});

test('provider availability summary - Phase 57 emits count-only provider decision summaries', () => {
  assert(exists('src/core/adapters/provider-availability-summary.ts'), 'Phase 57 summary source exists');
  assert(exists('docs/PHASE_57_PROVIDER_AVAILABILITY_SUMMARY.md'), 'Phase 57 summary doc exists');
  assert(exists('test/provider-availability-summary.ts'), 'Phase 57 summary suite exists');
  assert(typeof pkg.scripts['test:provider-availability-summary'] === 'string', 'Phase 57 test script present');
  assert((pkg.scripts.test ?? '').includes('test/provider-availability-summary.ts'), 'Phase 57 suite in CI chain');

  const source = read('src/core/adapters/provider-availability-summary.ts');
  const doc = read('docs/PHASE_57_PROVIDER_AVAILABILITY_SUMMARY.md');
  const combined = `${source}\n${doc}\n${read('README.md')}`;
  for (const kw of [
    'Provider availability summary (Phase 57)',
    'phase-57-provider-availability-summary',
    'sanitized-provider-availability-bridge-reports',
    'candidate',
    'skip',
    'hold',
    'available',
    'unavailable',
    'unknown',
    'stale',
    'invalid',
    'count-only',
    'no item rows',
  ]) assert(combined.includes(kw), `Phase 57 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'readFileSync',
    "from 'node:fs'",
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'document.',
    'window.',
  ]) assert(!source.includes(forbidden), `Phase 57 source excludes ${forbidden}`);
});

test('provider availability summary CLI - Phase 58 reads explicit bridge reports only', () => {
  assert(exists('src/ops/provider-availability-summary-cli.ts'), 'Phase 58 summary CLI exists');
  assert(exists('docs/PHASE_58_PROVIDER_AVAILABILITY_SUMMARY_CLI.md'), 'Phase 58 summary CLI doc exists');
  assert(exists('test/provider-availability-summary-cli.ts'), 'Phase 58 summary CLI suite exists');
  assert(typeof pkg.scripts['ops:provider-availability-summary'] === 'string', 'Phase 58 ops script present');
  assert(typeof pkg.scripts['test:provider-availability-summary-cli'] === 'string', 'Phase 58 test script present');
  assert((pkg.scripts.test ?? '').includes('test/provider-availability-summary-cli.ts'), 'Phase 58 suite in CI chain');

  const cli = read('src/ops/provider-availability-summary-cli.ts');
  const doc = read('docs/PHASE_58_PROVIDER_AVAILABILITY_SUMMARY_CLI.md');
  const combined = `${cli}\n${doc}\n${read('README.md')}`;
  for (const kw of [
    'Provider availability summary CLI (Phase 58)',
    'ops:provider-availability-summary',
    'explicit bridge-report JSON file inputs only',
    'bounded file reads',
    'count-only Phase 57 summary output',
    'no path, raw ref, provider detail, credential, URL, item, media identity, or payload echo',
  ]) assert(combined.includes(kw), `Phase 58 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'document.',
    'window.',
  ]) assert(!cli.includes(forbidden), `Phase 58 CLI excludes ${forbidden}`);
  assert(cli.includes("from 'node:fs'") && cli.includes('openSync') && cli.includes('readSync'), 'CLI has bounded explicit file reads');
});

test('provider availability operator packet - Phase 59 packages count-only evidence review without execution', () => {
  assert(exists('src/ops/provider-availability-operator-packet.ts'), 'Phase 59 packet source exists');
  assert(exists('src/ops/provider-availability-operator-packet-cli.ts'), 'Phase 59 packet CLI exists');
  assert(exists('docs/PHASE_59_PROVIDER_AVAILABILITY_OPERATOR_PACKET.md'), 'Phase 59 packet doc exists');
  assert(exists('test/provider-availability-operator-packet.ts'), 'Phase 59 packet suite exists');
  assert(typeof pkg.scripts['ops:provider-availability-operator-packet'] === 'string', 'Phase 59 ops script present');
  assert(typeof pkg.scripts['test:provider-availability-operator-packet'] === 'string', 'Phase 59 test script present');
  assert((pkg.scripts.test ?? '').includes('test/provider-availability-operator-packet.ts'), 'Phase 59 suite in CI chain');

  const packet = read('src/ops/provider-availability-operator-packet.ts');
  const cli = read('src/ops/provider-availability-operator-packet-cli.ts');
  const doc = read('docs/PHASE_59_PROVIDER_AVAILABILITY_OPERATOR_PACKET.md');
  const combined = `${packet}\n${cli}\n${doc}\n${read('README.md')}`;
  for (const kw of [
    'phase-59-provider-availability-operator-packet',
    'Provider availability operator packet (Phase 59)',
    'ops:provider-availability-operator-packet',
    'sanitized Phase 56 bridge reports',
    'Phase 58 count-only summary',
    'does not enable provider mode',
    'O4 and O5 remain open/deferred',
    'FileCustodian',
  ]) assert(combined.includes(kw), `Phase 59 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'node:fs',
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'document.',
    'window.',
  ]) assert(!`${packet}\n${cli}`.includes(forbidden), `Phase 59 source excludes ${forbidden}`);
});

test('erasure policy ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Phase 9 publish module clean; doc + suites wired', () => {
  const dir = fileURLToPath(new URL('../src/core/publish', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert(files.length >= 4, 'publish module present');
  const network = /(from\s*['"]node:(http|https|net|tls|dns)['"]|from\s*['"](node-fetch|undici|axios|got|ws|puppeteer|cheerio)['"]|\bfetch\s*\()/;
  const providers = /(real[-_ ]?debrid|torbox|\bplex\b|jellyfin|scrap(e|ing)|\bdownload\b|playback)/i;
  for (const f of files) {
    const src = readFileSync(`${dir}/${f}`, 'utf8');
    assert(!network.test(src), `src/core/publish/${f} makes no network import/call`);
    assert(!providers.test(src), `src/core/publish/${f} names no real provider / scraping / playback`);
  }
  assert(exists('docs/PHASE_9_ERASURE_POLICY.md'), 'erasure policy doc exists');
  const doc = read('docs/PHASE_9_ERASURE_POLICY.md');
  for (const kw of ['publish_ledger', 'PUBLISH_EXTERNAL_IDENTITY', 'revoke', 'forget', 'identity-free']) assert(doc.includes(kw), `doc covers ${kw}`);
  assert(/crypto-shred|erasure/i.test(doc), 'doc states the erasure conflict');
  assert((pkg.scripts.test ?? '').includes('test/publish-erasure.ts') && (pkg.scripts.test ?? '').includes('test/publish-consent.ts'), 'publish suites in the CI chain');
});

test('jellyfin adapter ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Phase 10 fake/local only: no network, no OTHER providers; doc + suites wired', () => {
  const dir = fileURLToPath(new URL('../src/core/adapters/jellyfin', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert(files.length >= 5, 'jellyfin module present');
  // CRITICAL for Phase 10: the fake-only module must make NO real network import/call (the real
  // HTTP client is deferred to Phase 11). It may name "jellyfin" (that is the module), but not other providers.
  const network = /(from\s*['"]node:(http|https|net|tls|dns)['"]|from\s*['"](node-fetch|undici|axios|got|ws|puppeteer|cheerio)['"]|\bfetch\s*\()/;
  const otherProviders = /(real[-_ ]?debrid|torbox|\bplex\b|\bdownload\b|playback|scrap(e|ing))/i;
  for (const f of files) {
    const src = readFileSync(`${dir}/${f}`, 'utf8');
    assert(!network.test(src), `src/core/adapters/jellyfin/${f} makes NO network import/call (Phase 11 defers the real client)`);
    assert(!otherProviders.test(src), `src/core/adapters/jellyfin/${f} names no other provider / scraping / playback`);
  }
  assert(exists('docs/PHASE_10_JELLYFIN_ADAPTER.md'), 'jellyfin doc exists');
  const doc = read('docs/PHASE_10_JELLYFIN_ADAPTER.md');
  for (const kw of ['collection', 'providerRefs', 'PUBLISH_EXTERNAL_IDENTITY', 'Phase 11', 'no-match']) assert(doc.includes(kw), `doc covers ${kw}`);
  assert(/deferred|defer/i.test(doc) && /limit/i.test(doc), 'doc states the real-client deferral + revoke limits');
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-privacy.ts') && (pkg.scripts.test ?? '').includes('test/jellyfin-contract.ts'), 'jellyfin suites in the CI chain');
});

test('jellyfin HTTP (Phase 11) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â injected-fetch only in core; gated; smoke opt-in + out of CI', () => {
  const dir = fileURLToPath(new URL('../src/core/adapters/jellyfin', import.meta.url));
  // the core adapter must NEVER reference a bare/global fetch ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â network only flows via the injected seam.
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const src = readFileSync(`${dir}/${f}`, 'utf8');
    assert(!/globalThis\.fetch|\bwindow\.fetch\b|\bfetch\s*\(/.test(src), `src/core/adapters/jellyfin/${f} references no bare/global fetch`);
  }
  assert(read('src/core/adapters/jellyfin/http-client.ts').includes('this.fetchImpl'), 'http client calls the INJECTED transport');
  assert(read('src/core/adapters/jellyfin/real-factory.ts').includes('JELLYFIN_ENABLE_NETWORK'), 'real factory is gated by the enable flag');
  // globalThis.fetch may appear ONLY in the operator smoke entrypoint.
  assert(exists('src/ops/jellyfin-smoke-cli.ts') && read('src/ops/jellyfin-smoke-cli.ts').includes('globalThis.fetch'), 'smoke CLI is the single network entrypoint');
  assert(typeof pkg.scripts['smoke:jellyfin'] === 'string', 'smoke:jellyfin script present');
  // the network-hitting smoke CLI must not run in CI (the fake-transport report suite test/jellyfin-smoke.ts is fine).
  assert(!(pkg.scripts.test ?? '').includes('jellyfin-smoke-cli') && !(pkg.scripts.test ?? '').includes('smoke:jellyfin'), 'the smoke CLI is NOT in the CI test chain');
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-http.ts'), 'jellyfin-http suite in the CI chain');
  assert(exists('docs/PHASE_11_JELLYFIN_HTTP.md'), 'Phase 11 doc exists');
  const doc = read('docs/PHASE_11_JELLYFIN_HTTP.md');
  for (const kw of ['JELLYFIN_ENABLE_NETWORK', 'PROVISIONAL', 'injected', 'X-Emby-Token', 'smoke:jellyfin']) assert(doc.includes(kw), `doc covers ${kw}`);
});

test('publish outbox ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Phase 12 doc + suites wired; create only via the outbox', () => {
  assert(exists('docs/PHASE_12_PUBLISH_OUTBOX.md'), 'outbox doc exists');
  const doc = read('docs/PHASE_12_PUBLISH_OUTBOX.md');
  for (const kw of ['correlation_token', 'outbox', 'adopt', 'reconcile', 'JELLYFIN_ALLOW_LIVE_PUBLISH']) assert(doc.includes(kw), `doc covers ${kw}`);
  assert((pkg.scripts.test ?? '').includes('test/publish-outbox.ts') && (pkg.scripts.test ?? '').includes('test/jellyfin-outbox.ts'), 'outbox suites in the CI chain');
  // the bare create stays disabled ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the ONLY real-create path is the outbox (createTaggedCollection).
  const hc = read('src/core/adapters/jellyfin/http-client.ts');
  assert(hc.includes('JellyfinPublishDisabledError') && /createCollection\([^)]*\)[^{]*\{[^}]*throw/.test(hc), 'bare createCollection stays disabled');
  assert(hc.includes('createTaggedCollection'), 'outbox-only tagged create exists');
  assert(typeof pkg.scripts['ops:publish-reconcile'] === 'string', 'ops:publish-reconcile present');
  assert(!(pkg.scripts.test ?? '').includes('publish-reconcile'), 'the reconcile CLI is NOT in the CI chain');
});

test('jellyfin smoke ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Phase 13 validation: doc + suite wired; globalThis.fetch limited to operator CLIs', () => {
  assert(exists('docs/PHASE_13_JELLYFIN_VALIDATION.md'), 'validation doc exists');
  const doc = read('docs/PHASE_13_JELLYFIN_VALIDATION.md');
  for (const kw of ['--write', 'self-clean', 'find-by-token', 'SearchTerm', 'redaction-safe']) assert(doc.includes(kw), `doc covers ${kw}`);
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-smoke.ts'), 'smoke-report suite in the CI chain');
  const cli = read('src/ops/jellyfin-smoke-cli.ts');
  assert(cli.includes('--write') && cli.includes('runReadOnlySmoke') && cli.includes('runWriteSmoke'), 'smoke CLI has read-only + --write modes');
  assert(cli.includes('isJellyfinLivePublishAllowed'), '--write gated by ALLOW_LIVE_PUBLISH');
  // globalThis.fetch must live ONLY in the explicit operator entrypoints.
  const withFetch = walkTs(fileURLToPath(new URL('../src', import.meta.url)))
    .filter((f) => readFileSync(f, 'utf8').includes('globalThis.fetch'))
    .map((f) => f.replace(/\\/g, '/'));
  assert(withFetch.length === 5, `exactly five src files use globalThis.fetch (got: ${withFetch.join(', ')})`);
  assert(withFetch.every((f) => /src\/ops\/(jellyfin-smoke-cli|jellyfin-live-readonly-smoke-cli|jellyfin-live-evidence-capture-cli|publish-reconcile-cli|torbox-smoke-cli)\.ts$/.test(f)), 'globalThis.fetch only in the operator smoke/reconcile CLIs');
});

test('jellyfin mapping ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Phase 14 pagination is present + bounded; doc wired', () => {
  const map = read('src/core/adapters/jellyfin/mapping.ts');
  assert(/StartIndex/.test(map) && /Limit/.test(map), 'find requests carry StartIndex + Limit (paginated)');
  const hc = read('src/core/adapters/jellyfin/http-client.ts');
  assert(hc.includes('getAllPages') && /MAX_PAGES/.test(hc), 'client walks pages with a bounded MAX_PAGES cap');
  assert(exists('docs/PHASE_14_JELLYFIN_HARDENING.md'), 'Phase 14 hardening doc exists');
  const doc = read('docs/PHASE_14_JELLYFIN_HARDENING.md');
  for (const kw of ['pagination', 'StartIndex', 'MAX_PAGES', 'PROVISIONAL', '--write']) assert(doc.includes(kw), `doc covers ${kw}`);
});

test('production readiness gate ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Phase 22 consolidates the 9 criteria + statuses; no stale refs', () => {
  assert(exists('docs/PHASE_22_PRODUCTION_READINESS_GATE.md'), 'readiness gate doc exists');
  const gate = read('docs/PHASE_22_PRODUCTION_READINESS_GATE.md');
  // all 9 readiness areas are covered
  for (const area of ['Deployment', 'custodian', 'KEK rotation', 'ackup', 'doctor', 'Scheduled', 'Jellyfin', 'CI', 'redaction']) {
    assert(gate.includes(area), `gate covers "${area}"`);
  }
  // the four status categories are defined + the open gates are visible (not hidden)
  for (const kw of ['met', 'operator-provided', 'deferred', 'blocked', 'O4', 'O5']) assert(gate.includes(kw), `gate defines "${kw}"`);
  // it must not overstate: it states what "production ready" requires and that nothing is hidden
  assert(/production-gated|not.*turnkey|do not (advertise|overstate|claim)/i.test(gate), 'gate does not overstate production readiness');
  assert(gate.includes('PRODUCTION_READINESS_EVIDENCE.md'), 'gate points to the evidence template');
  // the README surfaces the gate for a new operator
  assert(read('README.md').includes('PHASE_22_PRODUCTION_READINESS_GATE.md'), 'README points to the readiness gate');
  // reconciled stale references must not reappear
  assert(!/=\s*86 passed/.test(read('README.md')), 'the stale "86 passed" figure is gone');
  assert(!/Phase 18/.test(read('docs/PHASE_19_PRODUCTION_READINESS_EVIDENCE.md')), 'the stale "Phase 18" label is gone');
});

test('operator evidence packaging - Phase 23 maps Phase 22 rows and preserves production gates', () => {
  assert(exists('docs/PHASE_23_OPERATOR_EVIDENCE_PACKAGING.md'), 'Phase 23 evidence packaging doc exists');
  const doc = read('docs/PHASE_23_OPERATOR_EVIDENCE_PACKAGING.md');
  const readme = read('README.md');
  const gate = read('docs/PHASE_22_PRODUCTION_READINESS_GATE.md');
  const phase19 = read('docs/PHASE_19_PRODUCTION_READINESS_EVIDENCE.md');
  const checklist = read('docs/RELEASE_CHECKLIST.md');
  const tpl = read('docs/templates/PRODUCTION_READINESS_EVIDENCE.md');

  for (const source of [readme, gate, phase19, checklist]) {
    assert(source.includes('PHASE_23_OPERATOR_EVIDENCE_PACKAGING.md'), 'Phase 23 doc is linked from operator/readiness docs');
  }
  for (const row of [
    'Deployment / Unraid config',
    'External custodian / KMS (O4)',
    'KEK rotation (O5)',
    'Backup/restore + retention',
    '`ops:doctor` / warning gates',
    'Scheduled operator tasks',
    'Jellyfin validation evidence',
    'CI / test expectations',
    'Privacy / redaction',
  ]) {
    assert(doc.includes(row), `Phase 23 maps row ${row}`);
    assert(tpl.includes(row), `template summarizes row ${row}`);
  }
  for (const label of [
    '01-deployment-unraid.redacted.md',
    '02-external-custodian-o4.redacted.md',
    '03-kek-rotation-o5.redacted.md',
    '04-backup-restore-retention.redacted.md',
    '05-doctor-warning-gates.redacted.json',
    '06-scheduled-operator-tasks.redacted.md',
    '07-jellyfin-validation.redacted.md',
    '08-ci-test-expectations.redacted.md',
    '09-privacy-redaction.redacted.md',
  ]) assert(doc.includes(label), `Phase 23 suggests artifact ${label}`);
  for (const kw of ['Command shape or evidence source', 'Retention location', 'Never paste or retain']) {
    assert(doc.includes(kw), `Phase 23 table includes ${kw}`);
  }
  assert(/O4 remains open[\s\S]{0,180}real external\/managed custodian/i.test(doc), 'Phase 23 keeps O4 open unless separately proven');
  assert(/O5 remains open[\s\S]{0,180}managed age\s+KEK custody/i.test(doc), 'Phase 23 keeps O5 open unless separately proven');
  assert(/FileCustodian[\s\S]{0,120}reference harness[\s\S]{0,80}not a production KMS/i.test(doc), 'Phase 23 does not describe FileCustodian as production KMS');
  assert(/production-gated pending operator evidence/i.test(doc), 'Phase 23 avoids turnkey production-ready claims');
  assert(/adds no runtime behavior[\s\S]{0,160}scheduler[\s\S]{0,160}network requirement/i.test(doc), 'Phase 23 is docs/static only');
  assert(/must not require Docker[\s\S]*network[\s\S]*live Jellyfin[\s\S]*live external\s+custodian[\s\S]*cloud services[\s\S]*age tooling[\s\S]*production databases[\s\S]*operator credentials/i.test(doc), 'Phase 23 forbids live-service CI requirements');
});

test('operator evidence packaging - Phase 23 redaction boundary avoids sensitive requested fields', () => {
  const doc = read('docs/PHASE_23_OPERATOR_EVIDENCE_PACKAGING.md');
  const tpl = read('docs/templates/PRODUCTION_READINESS_EVIDENCE.md');
  const combined = `${doc}\n${tpl}`;

  for (const forbiddenField of [
    'KEK',
    'DEK',
    'Completion secret',
    'HMAC secret',
    'API key',
    'Token',
    'Credential',
    'Private key',
    'Database URL',
    'Secret path',
    'Raw identity',
    'Provider ref',
    'Media title',
    'Jellyfin id',
    'Jellyfin token',
    'Artifact contents',
    'Full environment',
  ]) {
    assert(!new RegExp(`^- ${forbiddenField}:`, 'mi').test(combined), `Phase 23/template do not request ${forbiddenField}`);
  }
  assert(/Never paste or retain[\s\S]*secret values[\s\S]*database URLs[\s\S]*Jellyfin tokens[\s\S]*artifact contents/i.test(doc), 'Phase 23 explicitly forbids sensitive evidence contents');
  assert(!/paste (the )?(raw|full|complete) (command )?output/i.test(doc), 'Phase 23 does not ask operators to paste raw output');
  assert(!/retain (the )?(raw|full|complete) (backup|artifact) contents/i.test(doc), 'Phase 23 does not ask operators to retain artifact contents in evidence');
});

test('coordinator release gate - Phase 24 doc is linked and defines the three release phases', () => {
  assert(exists('docs/PHASE_24_COORDINATOR_RELEASE_GATE.md'), 'Phase 24 coordinator gate doc exists');
  const doc = read('docs/PHASE_24_COORDINATOR_RELEASE_GATE.md');
  const readme = read('README.md');
  const checklist = read('docs/RELEASE_CHECKLIST.md');

  assert(readme.includes('PHASE_24_COORDINATOR_RELEASE_GATE.md'), 'README links the coordinator gate');
  assert(checklist.includes('PHASE_24_COORDINATOR_RELEASE_GATE.md'), 'release checklist links the coordinator gate');
  for (const heading of [
    '## Pre-Push / PR-GO Checks',
    '## Pre-Merge GO Checks',
    '## Post-Merge / Tag / Push Verification',
  ]) assert(doc.includes(heading), `Phase 24 includes ${heading}`);
  for (const cmd of [
    'git diff --check <base>...HEAD',
    'git diff --check origin/master...HEAD',
    'git ls-remote --tags origin <phase-tag>',
    'npm run test:deploy',
    'npm run typecheck',
    'npm run ci',
  ]) assert(doc.includes(cmd), `Phase 24 command block includes ${cmd}`);
});

test('coordinator release gate - Phase 24 names reviewer, HOLD, Ask-Clint, and intake rules', () => {
  const doc = read('docs/PHASE_24_COORDINATOR_RELEASE_GATE.md');

  for (const heading of [
    '## Builder Intake Requirements',
    '## Reviewer-Required Conditions',
    '## HOLD Conditions',
    '## Ask-Clint Conditions',
    '## Hard Scope Boundary Checklist',
  ]) assert(doc.includes(heading), `Phase 24 includes ${heading}`);
  for (const kw of [
    'Branch name and exact base commit',
    'Exact commit hash or hashes',
    'Tests run with exact command names and outcomes',
    'Residual risks and reviewer focus areas',
    'Reviewer prompt must include',
    'Stop and report the blocker',
    'Ask Clint before proceeding',
  ]) assert(doc.includes(kw), `Phase 24 covers ${kw}`);
  assert(/Reviewer-Required Conditions[\s\S]*release gates[\s\S]*privacy\/redaction[\s\S]*operator evidence[\s\S]*CI expectations/i.test(doc), 'Reviewer-required conditions cover sensitive release areas');
  assert(/HOLD Conditions[\s\S]*unexpectedly dirty[\s\S]*deterministic check fails[\s\S]*Reviewer reports a P0/i.test(doc), 'HOLD conditions cover dirty state, failed checks, and P0 findings');
  assert(/Ask-Clint Conditions[\s\S]*product readiness wording[\s\S]*required gate cannot run[\s\S]*remote state differs/i.test(doc), 'Ask-Clint conditions cover readiness wording, skipped gates, and ref mismatch');
});

test('coordinator release gate - Phase 24 preserves scope boundaries and production gates', () => {
  const doc = read('docs/PHASE_24_COORDINATOR_RELEASE_GATE.md');
  const pkgText = read('package.json');

  assert(/adds no runtime behavior[\s\S]*app code[\s\S]*scheduler daemon[\s\S]*GitHub automation[\s\S]*CI workflow/i.test(doc), 'Phase 24 states no runtime/app/scheduler/workflow behavior');
  for (const forbidden of [
    'provider/debrid/Plex/Jellyfin',
    'scraping, downloading, playback',
    'HTTP service, UI',
    'real KMS/cloud SDK',
    'live external custodian',
    'network dependency',
  ]) assert(doc.includes(forbidden), `Phase 24 forbids ${forbidden}`);
  assert(/CI stays deterministic[\s\S]*does not require Docker[\s\S]*network[\s\S]*live Jellyfin[\s\S]*live external custodian[\s\S]*cloud services[\s\S]*age tooling[\s\S]*production database[\s\S]*operator credentials/i.test(doc), 'Phase 24 forbids live-service CI requirements');
  assert(/O4 remains open\/deferred[\s\S]*separate operator evidence/i.test(doc), 'Phase 24 keeps O4 open/deferred unless separately proven');
  assert(/O5 remains open\/deferred[\s\S]*managed age\s+KEK custody/i.test(doc), 'Phase 24 keeps O5 open/deferred unless separately proven');
  assert(/FileCustodian`? remains a hardened reference harness, not production KMS/i.test(doc), 'Phase 24 preserves FileCustodian reference-harness boundary');
  assert(/Scope statement[\s\S]*no runtime behavior was added/i.test(doc), 'release note template requires runtime scope statement');
  assert(!/production-ready as turnkey|turnkey production-ready|closes O4|closes O5/i.test(doc), 'Phase 24 does not overstate production readiness or close O4/O5');
  assert(!/PHASE_24_COORDINATOR_RELEASE_GATE/.test(pkgText), 'Phase 24 adds no package script/product wiring');
});

test('readiness rehearsal - Phase 25 command, docs, and deterministic suite are wired', () => {
  assert(exists('src/ops/readiness-plan.ts'), 'readiness plan module exists');
  assert(exists('src/ops/readiness-plan-cli.ts'), 'readiness plan CLI exists');
  assert(exists('test/readiness-plan.ts'), 'readiness plan suite exists');
  assert(exists('docs/PHASE_25_READINESS_REHEARSAL.md'), 'Phase 25 rehearsal doc exists');

  assert(typeof pkg.scripts['ops:readiness-plan'] === 'string', 'ops:readiness-plan script present');
  assert(typeof pkg.scripts['test:readiness-plan'] === 'string', 'test:readiness-plan script present');
  assert((pkg.scripts.test ?? '').includes('test/readiness-plan.ts'), 'readiness suite in the deterministic test chain');

  const readme = read('README.md');
  const gate = read('docs/PHASE_22_PRODUCTION_READINESS_GATE.md');
  const packaging = read('docs/PHASE_23_OPERATOR_EVIDENCE_PACKAGING.md');
  const checklist = read('docs/RELEASE_CHECKLIST.md');
  for (const source of [readme, gate, packaging]) {
    assert(source.includes('PHASE_25_READINESS_REHEARSAL.md'), 'Phase 25 doc is linked from readiness/operator docs');
  }
  assert(checklist.includes('ops:readiness-plan'), 'release checklist mentions the rehearsal command');
});

test('operator evidence rehearsal - Phase 26 command, docs, and deterministic suite are wired', () => {
  assert(exists('src/ops/evidence-rehearsal.ts'), 'evidence rehearsal module exists');
  assert(exists('src/ops/evidence-rehearsal-cli.ts'), 'evidence rehearsal CLI exists');
  assert(exists('test/evidence-rehearsal.ts'), 'evidence rehearsal suite exists');
  assert(exists('docs/PHASE_26_EVIDENCE_REHEARSAL.md'), 'Phase 26 evidence rehearsal doc exists');

  assert(typeof pkg.scripts['ops:evidence-rehearsal'] === 'string', 'ops:evidence-rehearsal script present');
  assert(typeof pkg.scripts['test:evidence-rehearsal'] === 'string', 'test:evidence-rehearsal script present');
  assert((pkg.scripts.test ?? '').includes('test/evidence-rehearsal.ts'), 'evidence rehearsal suite in the deterministic test chain');

  const readme = read('README.md');
  const gate = read('docs/PHASE_22_PRODUCTION_READINESS_GATE.md');
  const packaging = read('docs/PHASE_23_OPERATOR_EVIDENCE_PACKAGING.md');
  const phase25 = read('docs/PHASE_25_READINESS_REHEARSAL.md');
  const checklist = read('docs/RELEASE_CHECKLIST.md');
  for (const source of [readme, gate, packaging, phase25]) {
    assert(source.includes('PHASE_26_EVIDENCE_REHEARSAL.md'), 'Phase 26 doc is linked from readiness/operator docs');
  }
  assert(checklist.includes('ops:evidence-rehearsal'), 'release checklist mentions the evidence rehearsal command');
});

test('operator evidence rehearsal - Phase 26 preserves static-only scope and open production gates', () => {
  const cli = read('src/ops/evidence-rehearsal-cli.ts');
  const rehearsal = read('src/ops/evidence-rehearsal.ts');
  const doc = read('docs/PHASE_26_EVIDENCE_REHEARSAL.md');
  const combined = `${cli}\n${rehearsal}\n${doc}`;

  for (const label of [
    '01-deployment-unraid.redacted.md',
    '02-external-custodian-o4.redacted.md',
    '03-kek-rotation-o5.redacted.md',
    '04-backup-restore-retention.redacted.md',
    '05-doctor-warning-gates.redacted.json',
    '06-scheduled-operator-tasks.redacted.md',
    '07-jellyfin-validation.redacted.md',
    '08-ci-test-expectations.redacted.md',
    '09-privacy-redaction.redacted.md',
  ]) assert(combined.includes(label), `Phase 26 includes artifact ${label}`);

  assert(/O4 remains open\/deferred/.test(rehearsal) && /O5 remains open\/deferred/.test(rehearsal), 'Phase 26 keeps O4/O5 open/deferred');
  assert(/FileCustodian is a hardened reference harness, not production KMS/.test(rehearsal), 'Phase 26 preserves FileCustodian boundary');
  assert(/does not[\s\S]*inspect the filesystem for evidence[\s\S]*read evidence artifacts[\s\S]*connect to a database[\s\S]*call the network[\s\S]*run Docker[\s\S]*contact Jellyfin[\s\S]*contact a live custodian, cloud service, or KMS/i.test(doc), 'Phase 26 documents static-only non-requirements');
  assert(!/closes O4|closes O5|production-ready as turnkey|turnkey production-ready/i.test(combined), 'Phase 26 does not close gates or overstate readiness');

  for (const forbidden of [
    "from 'pg'",
    'from "pg"',
    'node:fs',
    'node:path',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'loadDbConfig',
    'loadCustodianConfig',
    'createCustodian',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'readFileSync',
  ]) assert(!`${cli}\n${rehearsal}`.includes(forbidden), `evidence rehearsal CLI/module do not use ${forbidden}`);

  assert(!(pkg.scripts['ops:evidence-rehearsal'] ?? '').includes('docker'), 'evidence rehearsal command does not invoke Docker');
  assert(!(pkg.scripts['test:evidence-rehearsal'] ?? '').includes('docker'), 'evidence rehearsal test command does not invoke Docker');
});

test('release guard - Phase 27 is wired as advisory read-only coordinator support', () => {
  assert(exists('docs/PHASE_27_RELEASE_GUARD.md'), 'Phase 27 release guard doc exists');
  assert(exists('src/ops/release-guard.ts'), 'release guard module exists');
  assert(exists('src/ops/release-guard-cli.ts'), 'release guard CLI exists');
  assert(exists('test/release-guard.ts'), 'release guard suite exists');
  assert(typeof pkg.scripts['ops:release-guard'] === 'string', 'ops:release-guard script present');
  assert(typeof pkg.scripts['test:release-guard'] === 'string', 'test:release-guard script present');
  assert((pkg.scripts.test ?? '').includes('test/release-guard.ts'), 'release guard suite in the deterministic test chain');

  const cli = read('src/ops/release-guard-cli.ts');
  const guard = read('src/ops/release-guard.ts');
  const doc = read('docs/PHASE_27_RELEASE_GUARD.md');
  const readme = read('README.md');
  const phase24 = read('docs/PHASE_24_COORDINATOR_RELEASE_GATE.md');
  const checklist = read('docs/RELEASE_CHECKLIST.md');
  const combined = `${cli}\n${guard}\n${doc}`;

  for (const kw of ['--base <ref>', '--mode pre-pr|pre-merge|post-merge', '--json', 'advisory']) {
    assert(combined.includes(kw), `Phase 27 covers ${kw}`);
  }
  for (const source of [readme, phase24, checklist]) {
    assert(source.includes('PHASE_27_RELEASE_GUARD.md') || source.includes('ops:release-guard'), 'Phase 27 command/doc is linked from release docs');
  }
  assert(/Coordinator, Reviewer,\s+and Clint still make GO\/HOLD decisions/.test(doc), 'doc preserves human GO/HOLD decision boundary');
  assert(/O4 remains open\/deferred/.test(combined) && /O5 remains open\/deferred/.test(combined), 'Phase 27 keeps O4/O5 open/deferred');
  assert(/FileCustodian remains a hardened reference harness, not production KMS/.test(combined), 'Phase 27 preserves FileCustodian boundary');
  assert(/read-only local Git inspection/.test(combined), 'Phase 27 states read-only git inspection');
  assert(!/\bis approval to (push|merge|tag)\b|\bapproves (push|merge|tag)\b/i.test(combined), 'Phase 27 does not claim approval authority');

  for (const forbidden of [
    "from 'pg'",
    'from "pg"',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'docker compose',
    'process.env.',
    'readFileSync',
    'loadDbConfig',
    'loadCustodianConfig',
    'createCustodian',
  ]) assert(!`${cli}\n${guard}`.includes(forbidden), `release guard CLI/module do not use ${forbidden}`);

  for (const mutating of ['git merge', 'git tag', 'git push', 'git checkout', 'git reset', 'branch -d', 'worktree remove']) {
    assert(!`${cli}\n${guard}`.includes(mutating), `release guard implementation does not invoke ${mutating}`);
  }
  assert(!(pkg.scripts['ops:release-guard'] ?? '').includes('docker'), 'release guard command does not invoke Docker');
  assert(!(pkg.scripts['test:release-guard'] ?? '').includes('docker'), 'release guard test command does not invoke Docker');
});

test('production custodian contract - Phase 28 is static, redaction-safe, and keeps O4/O5 open', () => {
  assert(exists('docs/PHASE_28_PRODUCTION_CUSTODIAN_CONTRACT.md'), 'Phase 28 production custodian contract doc exists');
  assert(exists('src/core/crypto/production-custodian-contract.ts'), 'Phase 28 contract module exists');
  assert(exists('test/production-custodian-contract.ts'), 'Phase 28 contract suite exists');
  assert(typeof pkg.scripts['test:production-custodian-contract'] === 'string', 'test:production-custodian-contract script present');
  assert((pkg.scripts.test ?? '').includes('test/production-custodian-contract.ts'), 'Phase 28 suite in deterministic test chain');

  const contract = read('src/core/crypto/production-custodian-contract.ts');
  const suite = read('test/production-custodian-contract.ts');
  const doc = read('docs/PHASE_28_PRODUCTION_CUSTODIAN_CONTRACT.md');
  const readme = read('README.md');
  const phase16 = read('docs/PHASE_16_EXTERNAL_CUSTODIAN_READINESS.md');
  const phase21 = read('docs/PHASE_21_EXTERNAL_CUSTODIAN_ACCEPTANCE.md');
  const phase22 = read('docs/PHASE_22_PRODUCTION_READINESS_GATE.md');
  const checklist = read('docs/RELEASE_CHECKLIST.md');
  const combined = `${contract}\n${doc}`;

  for (const kw of [
    'validateProductionCustodianDescriptor',
    'requiredKeyCustodianInvariants',
    'forbiddenBehaviors',
    'evidenceRequirements',
    'redactionRequirements',
    'failClosedSemantics',
    'trustBoundaryAssertions',
    'REFERENCE_HARNESS_NOT_PRODUCTION_KMS',
    'closesO4: false',
  ]) assert(combined.includes(kw), `Phase 28 covers ${kw}`);

  for (const source of [readme, phase16, phase21, phase22, checklist]) {
    assert(source.includes('PHASE_28_PRODUCTION_CUSTODIAN_CONTRACT.md') || source.includes('test:production-custodian-contract'), 'Phase 28 doc/script is linked from readiness docs');
  }

  assert(/O4 remains open\/deferred/.test(doc) && /O5 remains open\/deferred/.test(doc), 'Phase 28 doc keeps O4/O5 open/deferred');
  assert(/FileCustodian` remains a hardened reference\s+harness, not production KMS/.test(doc), 'Phase 28 preserves FileCustodian boundary');
  assert(/does not instantiate\s+adapters[\s\S]*read environment variables[\s\S]*connect to a database[\s\S]*call the network[\s\S]*run\s+Docker/i.test(doc), 'Phase 28 documents metadata-only static scope');
  assert(/descriptor values are never echoed/i.test(doc), 'Phase 28 documents redaction-safe descriptor output');

  for (const forbidden of [
    "from 'pg'",
    'from "pg"',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'loadDbConfig',
    'loadCustodianConfig',
    'createCustodian',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'readFileSync',
    'execFileSync',
    'docker compose',
    'aws-sdk',
    '@aws-sdk',
    '@google-cloud',
    '@azure',
    'node-vault',
    'openbao',
  ]) assert(!contract.includes(forbidden), `Phase 28 contract module does not use ${forbidden}`);

  assert(suite.includes('hostile descriptor strings'), 'Phase 28 suite covers hostile descriptor strings');
  assert(!(pkg.scripts['test:production-custodian-contract'] ?? '').includes('docker'), 'Phase 28 test command does not invoke Docker');
});

test('custodian evidence preflight - Phase 29 command/docs are redaction-safe and keep O4/O5 open', () => {
  assert(exists('docs/PHASE_29_CUSTODIAN_EVIDENCE_PREFLIGHT.md'), 'Phase 29 preflight doc exists');
  assert(exists('src/ops/custodian-evidence-preflight.ts'), 'Phase 29 pure preflight module exists');
  assert(exists('src/ops/custodian-evidence-preflight-cli.ts'), 'Phase 29 preflight CLI exists');
  assert(exists('test/custodian-evidence-preflight.ts'), 'Phase 29 preflight suite exists');
  assert(typeof pkg.scripts['ops:custodian-evidence-preflight'] === 'string', 'ops:custodian-evidence-preflight script present');
  assert(typeof pkg.scripts['test:custodian-evidence-preflight'] === 'string', 'test:custodian-evidence-preflight script present');
  assert((pkg.scripts.test ?? '').includes('test/custodian-evidence-preflight.ts'), 'Phase 29 suite in deterministic test chain');

  const preflight = read('src/ops/custodian-evidence-preflight.ts');
  const cli = read('src/ops/custodian-evidence-preflight-cli.ts');
  const suite = read('test/custodian-evidence-preflight.ts');
  const doc = read('docs/PHASE_29_CUSTODIAN_EVIDENCE_PREFLIGHT.md');
  const readme = read('README.md');
  const phase22 = read('docs/PHASE_22_PRODUCTION_READINESS_GATE.md');
  const phase28 = read('docs/PHASE_28_PRODUCTION_CUSTODIAN_CONTRACT.md');
  const checklist = read('docs/RELEASE_CHECKLIST.md');
  const source = `${preflight}\n${cli}`;

  for (const kw of [
    'validateProductionCustodianDescriptor',
    'phase-29-custodian-evidence-preflight',
    'descriptorValuesEchoed: false',
    'closesO4: false',
    'open/deferred',
    'reference-harness-not-production-kms',
    'DESCRIPTOR_JSON_MALFORMED',
    'DESCRIPTOR_OBJECT_REQUIRED',
    'DESCRIPTOR_FILE_READ_FAILED',
    'DESCRIPTOR_FILE_TOO_LARGE',
  ]) assert(`${source}\n${doc}`.includes(kw), `Phase 29 covers ${kw}`);

  for (const linked of [readme, phase22, phase28, checklist]) {
    assert(linked.includes('PHASE_29_CUSTODIAN_EVIDENCE_PREFLIGHT.md') || linked.includes('ops:custodian-evidence-preflight'), 'Phase 29 doc/script is linked from readiness docs');
  }

  assert(/does not close O4/i.test(doc) && /O4 remains open\/deferred/.test(doc), 'Phase 29 doc keeps O4 open/deferred');
  assert(/O5 remains open\/deferred/.test(doc), 'Phase 29 doc keeps O5 open/deferred');
  assert(/FileCustodian` remains a hardened reference\s+harness, not production KMS/.test(doc), 'Phase 29 preserves FileCustodian boundary');
  assert(/does not read environment values[\s\S]*scan directories[\s\S]*connect to a database[\s\S]*call the network[\s\S]*run Docker[\s\S]*contact a live custodian, KMS, cloud service, or vendor SDK/i.test(doc), 'Phase 29 documents descriptor-only static boundary');
  assert(/never echoes descriptor paths[\s\S]*descriptor values[\s\S]*raw JSON[\s\S]*parse snippets/i.test(doc), 'Phase 29 documents redaction-safe output');

  for (const forbidden of [
    "from 'pg'",
    'from "pg"',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'loadDbConfig',
    'loadCustodianConfig',
    'createCustodian',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'execFileSync',
    'spawnSync',
    'docker compose',
    'aws-sdk',
    '@aws-sdk',
    '@google-cloud',
    '@azure',
    'node-vault',
    'openbao',
    'readdirSync',
    'readFileSync',
    'existsSync',
  ]) assert(!source.includes(forbidden), `Phase 29 source does not include ${forbidden}`);

  assert(cli.includes("from 'node:fs'") && cli.includes('openSync') && cli.includes('readSync'), 'Phase 29 CLI has explicit bounded descriptor file read');
  assert(!preflight.includes("node:fs"), 'Phase 29 formatter module remains pure');
  assert(suite.includes('hostile descriptor values'), 'Phase 29 suite covers hostile descriptor values');
  assert(suite.includes('missing') && suite.includes('oversized') && suite.includes('DESCRIPTOR_FILE_READ_FAILED'), 'Phase 29 suite covers file failure modes');
  assert(!(pkg.scripts['ops:custodian-evidence-preflight'] ?? '').includes('docker'), 'Phase 29 command does not invoke Docker');
  assert(!(pkg.scripts['test:custodian-evidence-preflight'] ?? '').includes('docker'), 'Phase 29 test command does not invoke Docker');
});

test('KEK evidence preflight - Phase 30 command/docs are redaction-safe and keep O4/O5 open', () => {
  assert(exists('docs/PHASE_30_KEK_EVIDENCE_PREFLIGHT.md'), 'Phase 30 preflight doc exists');
  assert(exists('src/ops/kek-evidence-preflight.ts'), 'Phase 30 pure preflight module exists');
  assert(exists('src/ops/kek-evidence-preflight-cli.ts'), 'Phase 30 preflight CLI exists');
  assert(exists('test/kek-evidence-preflight.ts'), 'Phase 30 preflight suite exists');
  assert(typeof pkg.scripts['ops:kek-evidence-preflight'] === 'string', 'ops:kek-evidence-preflight script present');
  assert(typeof pkg.scripts['test:kek-evidence-preflight'] === 'string', 'test:kek-evidence-preflight script present');
  assert((pkg.scripts.test ?? '').includes('test/kek-evidence-preflight.ts'), 'Phase 30 suite in deterministic test chain');

  const preflight = read('src/ops/kek-evidence-preflight.ts');
  const cli = read('src/ops/kek-evidence-preflight-cli.ts');
  const suite = read('test/kek-evidence-preflight.ts');
  const doc = read('docs/PHASE_30_KEK_EVIDENCE_PREFLIGHT.md');
  const readme = read('README.md');
  const phase17 = read('docs/PHASE_17_KEK_ROTATION_READINESS.md');
  const phase20 = read('docs/PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md');
  const phase22 = read('docs/PHASE_22_PRODUCTION_READINESS_GATE.md');
  const checklist = read('docs/RELEASE_CHECKLIST.md');
  const source = `${preflight}\n${cli}`;

  for (const kw of [
    'phase-30-kek-evidence-preflight',
    'prepare-o5-managed-kek-custody-and-scheduling-evidence-review',
    'descriptorValuesEchoed: false',
    'closesO5: false',
    'open/deferred',
    'reference-harness-not-production-kms',
    'managedKekCustodyDocumented',
    'rotationScheduleDocumented',
    'operatorRunbookDocumented',
    'alertTriageDocumented',
    'independentSecretMediaDocumented',
    'residualRiskAccepted',
    'DESCRIPTOR_JSON_MALFORMED',
    'DESCRIPTOR_OBJECT_REQUIRED',
    'DESCRIPTOR_FILE_READ_FAILED',
    'DESCRIPTOR_FILE_TOO_LARGE',
  ]) assert(`${source}\n${doc}`.includes(kw), `Phase 30 covers ${kw}`);

  for (const linked of [readme, phase17, phase20, phase22, checklist]) {
    assert(linked.includes('PHASE_30_KEK_EVIDENCE_PREFLIGHT.md') || linked.includes('ops:kek-evidence-preflight'), 'Phase 30 doc/script is linked from O5 readiness docs');
  }

  assert(/does not[\s\S]*close O5/i.test(doc) && /O5 remains open\/deferred/.test(doc), 'Phase 30 doc keeps O5 open/deferred');
  assert(/O4 remains open\/deferred/.test(doc), 'Phase 30 doc keeps O4 open/deferred');
  assert(/FileCustodian` remains a hardened reference\s+harness, not production KMS/.test(doc), 'Phase 30 preserves FileCustodian boundary');
  assert(/does not read environment values[\s\S]*scan directories[\s\S]*inspect evidence artifacts[\s\S]*inspect\s+key files[\s\S]*connect to a database[\s\S]*call the network[\s\S]*run\s+Docker[\s\S]*invoke age[\s\S]*contact a live custodian, KMS, cloud service, vendor SDK, scheduler API/i.test(doc), 'Phase 30 documents descriptor-only static boundary');
  assert(/does not add a scheduler[\s\S]*cron installer[\s\S]*daemon[\s\S]*runtime default[\s\S]*key rotation automation[\s\S]*mutating rewrap[\s\S]*real KMS adapter[\s\S]*HTTP service[\s\S]*UI/i.test(doc), 'Phase 30 documents no runtime product behavior');
  assert(/never echoes descriptor paths[\s\S]*descriptor values[\s\S]*raw JSON[\s\S]*parse snippets/i.test(doc), 'Phase 30 documents redaction-safe output');
  assert(/ready-for-review[\s\S]*does not mean production-ready[\s\S]*does not close O5/i.test(doc), 'Phase 30 ready state cannot be O5 closure');

  for (const forbidden of [
    "from 'pg'",
    'from "pg"',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'loadDbConfig',
    'loadCustodianConfig',
    'createCustodian',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'execFileSync',
    'spawnSync',
    'docker compose',
    'aws-sdk',
    '@aws-sdk',
    '@google-cloud',
    '@azure',
    'node-vault',
    'openbao',
    'node:child_process',
    'node:crypto',
    'readdirSync',
    'readFileSync',
    'existsSync',
    'watch(',
    'setInterval',
    'setTimeout',
    'node-schedule',
    'scheduleJob',
    'CUSTODIAN_KEK_FILE',
    'CUSTODIAN_KEYSTORE_DIR',
  ]) assert(!source.includes(forbidden), `Phase 30 source does not include ${forbidden}`);

  assert(cli.includes("from 'node:fs'") && cli.includes('openSync') && cli.includes('readSync'), 'Phase 30 CLI has explicit bounded descriptor file read');
  assert(!preflight.includes("node:fs"), 'Phase 30 formatter module remains pure');
  assert(suite.includes('hostile descriptor values'), 'Phase 30 suite covers hostile descriptor values');
  assert(suite.includes('missing') && suite.includes('directory') && suite.includes('oversized') && suite.includes('DESCRIPTOR_FILE_READ_FAILED'), 'Phase 30 suite covers file failure modes');
  assert(!(pkg.scripts['ops:kek-evidence-preflight'] ?? '').includes('docker'), 'Phase 30 command does not invoke Docker');
  assert(!(pkg.scripts['test:kek-evidence-preflight'] ?? '').includes('docker'), 'Phase 30 test command does not invoke Docker');
});

test('readiness rehearsal - Phase 25 preserves static-only scope and open production gates', () => {
  const cli = read('src/ops/readiness-plan-cli.ts');
  const plan = read('src/ops/readiness-plan.ts');
  const doc = read('docs/PHASE_25_READINESS_REHEARSAL.md');
  const combined = `${cli}\n${plan}\n${doc}`;

  for (const label of [
    '01-deployment-unraid.redacted.md',
    '02-external-custodian-o4.redacted.md',
    '03-kek-rotation-o5.redacted.md',
    '04-backup-restore-retention.redacted.md',
    '05-doctor-warning-gates.redacted.json',
    '06-scheduled-operator-tasks.redacted.md',
    '07-jellyfin-validation.redacted.md',
    '08-ci-test-expectations.redacted.md',
    '09-privacy-redaction.redacted.md',
  ]) assert(combined.includes(label), `Phase 25 includes artifact ${label}`);

  for (const kw of ['met', 'operator-provided', 'deferred', 'blocked']) {
    assert(plan.includes(kw), `Phase 25 includes status ${kw}`);
  }
  assert(/O4 remains open\/deferred/.test(plan) && /O5 remains open\/deferred/.test(plan), 'Phase 25 keeps O4/O5 open/deferred');
  assert(/FileCustodian is a hardened reference harness, not production KMS/.test(plan), 'Phase 25 preserves FileCustodian boundary');
  assert(/does not[\s\S]*connect to a database[\s\S]*scan evidence directories[\s\S]*read backup artifacts[\s\S]*call the network[\s\S]*run Docker[\s\S]*contact Jellyfin[\s\S]*contact a custodian, cloud service, or KMS/i.test(doc), 'Phase 25 documents static-only non-requirements');
  assert(!/closes O4|closes O5|production-ready as turnkey|turnkey production-ready/i.test(combined), 'Phase 25 does not close gates or overstate readiness');

  for (const forbidden of [
    "from 'pg'",
    'from "pg"',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'loadDbConfig',
    'loadCustodianConfig',
    'createCustodian',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'readFileSync',
  ]) assert(!`${cli}\n${plan}`.includes(forbidden), `readiness CLI/module do not use ${forbidden}`);

  assert(!(pkg.scripts['ops:readiness-plan'] ?? '').includes('docker'), 'readiness command does not invoke Docker');
  assert(!(pkg.scripts['test:readiness-plan'] ?? '').includes('docker'), 'readiness test command does not invoke Docker');
});

test('ops entrypoints exist', () => {
  assert(exists('src/ops/migrate-cli.ts'), 'migrate-cli');
  assert(exists('src/ops/backup-cli.ts'), 'backup-cli');
});

test('docs ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â PHASE_3_DEPLOYMENT covers Unraid, *_FILE, keystore separation, operator age', () => {
  assert(exists('docs/PHASE_3_DEPLOYMENT.md'), 'deployment doc exists');
  const doc = read('docs/PHASE_3_DEPLOYMENT.md');
  for (const kw of ['Unraid', '_FILE', 'keystore', 'age', 'O4']) assert(doc.includes(kw), `doc mentions ${kw}`);
  assert(/separate volume/i.test(doc), 'doc states keystore/pgdata separation');
});

test('docs ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â production-gate wording is accurate (memory guard is CLOSED/enforced)', () => {
  const doc = read('docs/PHASE_3_DEPLOYMENT.md');
  // stale: the memory-mode guard must NOT be described as an open "guard ... OPEN" gate anymore.
  assert(!/guard[^\n]*\bopen\b/i.test(doc), 'no stale "guard ... OPEN" wording (memory guard is enforced)');
  assert(!/production guard open/i.test(doc), 'no "production guard OPEN" phrase');
  // accurate: memory is refused in production (matches README + the Phase 4 guard).
  assert(/CUSTODIAN_MODE=memory[\s\S]{0,200}refused/i.test(doc), 'doc ties CUSTODIAN_MODE=memory to "refused"');
  assert(/refused in production/i.test(doc), 'doc states memory is refused in production');
  // O4 still open; O5 open as automation while rewrap tooling exists.
  assert(/O4[^\n]*OPEN/i.test(doc), 'O4 still open');
  assert(/O5[^\n]*OPEN/i.test(doc) && /ops:rewrap-kek/.test(doc), 'O5 automation open but rewrap tooling documented');
});

test('unraid template ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â one-shot, no ports, *_FILE secrets, separate keystore (Stage 5.3)', () => {
  assert(exists('deploy/unraid-catalog-authority.xml'), 'unraid template exists');
  const xml = read('deploy/unraid-catalog-authority.xml');
  assert(/<Container/.test(xml) && /<\/Container>/.test(xml), 'is a Container template');
  assert(/<WebUI\s*\/>/.test(xml), 'no web UI');
  assert(!/Type="Port"/.test(xml) && !/<Config[^>]*Type="Port"/.test(xml), 'no published ports');
  assert(xml.includes('/var/lib/catalog/keystore'), 'keystore path present');
  for (const v of ['ADMIN_DATABASE_URL_FILE', 'DATABASE_URL_FILE', 'COMPLETION_SECRET_FILE', 'CUSTODIAN_KEK_FILE']) {
    assert(xml.includes(v), `${v} wired via *_FILE`);
  }
  assert(/APP_ENV[\s\S]*production/.test(xml), 'APP_ENV=production');
  assert(/CUSTODIAN_MODE[\s\S]*file/.test(xml), 'CUSTODIAN_MODE=file');
  assert(/one-shot/i.test(xml) && /no web ui|no published ports/i.test(xml), 'documents the one-shot / no-HTTP shape');
  // no secret VALUES baked into the template (only *_FILE paths)
  assert(!/<Config Name="COMPLETION_SECRET"[^>]*>(?!\/run\/secrets)/.test(xml), 'no inline completion secret value');
});

test('ops lifecycle ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Phase 6 CLIs + docs are wired (version/verify/rehearse/doctor --json)', () => {
  for (const s of ['ops:version', 'ops:verify-backup', 'ops:rehearse-restore', 'ops:doctor']) {
    assert(typeof pkg.scripts[s] === 'string', `script ${s} present`);
  }
  for (const t of ['test/schema-version.ts', 'test/backup-verify.ts', 'test/ops-rehearse.ts']) {
    assert((pkg.scripts.test ?? '').includes(t), `${t} in the test chain`);
  }
  assert(exists('docs/PHASE_6_LIFECYCLE.md'), 'lifecycle doc exists');
  assert(exists('docs/RELEASE_CHECKLIST.md'), 'release checklist exists');
  const life = read('docs/PHASE_6_LIFECYCLE.md');
  for (const kw of ['ops:version', 'ops:rehearse-restore', 'ops:doctor --json', 'REHEARSAL_ADMIN_DATABASE_URL']) {
    assert(life.includes(kw), `lifecycle doc covers ${kw}`);
  }
  assert(/no down-migrations/i.test(life) && /restore the pre-upgrade backup/i.test(life), 'lifecycle doc states the rollback model');
});

test('production readiness evidence - Phase 19 doc + template are redaction-safe and wired', () => {
  assert(exists('docs/PHASE_19_PRODUCTION_READINESS_EVIDENCE.md'), 'Phase 19 evidence doc exists');
  assert(exists('docs/templates/PRODUCTION_READINESS_EVIDENCE.md'), 'production readiness template exists');
  const doc = read('docs/PHASE_19_PRODUCTION_READINESS_EVIDENCE.md');
  const tpl = read('docs/templates/PRODUCTION_READINESS_EVIDENCE.md');
  const readme = read('README.md');
  const runbook = read('docs/PHASE_5_RUNBOOK.md');
  const checklist = read('docs/RELEASE_CHECKLIST.md');

  for (const kw of [
    'ops:doctor -- --json',
    'ops:verify-backup',
    'ops:rehearse-restore',
    'ops:rewrap-kek -- --plan --json',
    'production-gate-o4-external-custodian',
    'production-gate-o5-managed-kek',
    'throwaway database',
  ]) assert(doc.includes(kw), `Phase 19 doc covers ${kw}`);
  assert(/must not become a CI\s+requirement/.test(doc), 'Phase 19 doc keeps live evidence out of CI');
  assert(/PASS[\s\S]*WARN[\s\S]*FAIL/.test(doc), 'Phase 19 doc explains doctor PASS/WARN/FAIL');
  assert(/offline structural evidence/i.test(doc), 'backup verification described as offline evidence');
  assert(/non-mutating KEK rotation preflight/i.test(doc), 'rewrap plan described as non-mutating');
  assert(/does not close O5 by itself/i.test(doc), 'rewrap plan does not close O5');

  for (const heading of [
    'Environment / Build',
    'Doctor Result',
    'Backup Verification',
    'Restore Rehearsal',
    'KEK Rewrap Plan',
    'Open Gate Status',
    'Failures Observed',
    'Operator / Reviewer Signoff',
  ]) assert(tpl.includes(`## ${heading}`), `template has ${heading}`);
  for (const kw of [
    'Catalog Authority commit or build',
    'production-gate-o4-external-custodian',
    'production-gate-o5-managed-kek',
    'O5 remains open after this plan alone',
    'Throwaway database confirmed',
    'Operator confirms no secret values or key material included',
  ]) assert(tpl.includes(kw), `template covers ${kw}`);
  for (const forbiddenField of ['KEK', 'DEK', 'Completion secret', 'API key', 'Token', 'Database URL', 'Raw identity', 'Provider ref', 'Media title']) {
    assert(!new RegExp(`^- ${forbiddenField}:`, 'mi').test(tpl), `template does not request ${forbiddenField}`);
  }
  assert(/Do not include KEKs[\s\S]*raw identity[\s\S]*provider refs[\s\S]*media titles[\s\S]*secret file paths/i.test(tpl), 'template states omit/redact boundary');
  assert(!/\ball green\b/i.test(checklist), 'release checklist does not use stale "all green" doctor wording');
  assert(!/\bconfirm green\b/i.test(checklist), 'release checklist does not use stale "confirm green" doctor wording');
  assert(/ops:doctor[\s\S]{0,120}no FAIL checks[\s\S]{0,120}WARN/i.test(checklist), 'upgrade checklist uses no-FAIL/WARN doctor semantics');
  assert(/confirm no FAIL checks; review WARNs/i.test(checklist), 'rollback checklist uses no-FAIL/WARN doctor semantics');
  assert(readme.includes('PHASE_19_PRODUCTION_READINESS_EVIDENCE.md') && runbook.includes('PRODUCTION_READINESS_EVIDENCE.md') && checklist.includes('PRODUCTION_READINESS_EVIDENCE.md'), 'Phase 19 evidence docs linked from operator docs');
});

test('unraid operations schedule - Phase 20 doc is templates-only and redaction-safe', () => {
  assert(exists('docs/PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md'), 'Phase 20 schedule doc exists');
  const doc = read('docs/PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md');
  const readme = read('README.md');
  const runbook = read('docs/PHASE_5_RUNBOOK.md');
  const life = read('docs/PHASE_6_LIFECYCLE.md');
  const checklist = read('docs/RELEASE_CHECKLIST.md');

  for (const kw of [
    'Unraid User Scripts',
    'cron',
    'ops:doctor --json',
    'ops:doctor -- --json',
    'ops:backup -- dump',
    'ops:verify-backup',
    'ops:rehearse-restore',
    'ops:rewrap-kek -- --plan --json',
  ]) assert(doc.includes(kw), `Phase 20 doc covers ${kw}`);
  assert(/REHEARSAL_ADMIN_DATABASE_URL="?<throwaway-db-url>"?/.test(doc), 'Phase 20 doc covers throwaway rehearsal DB placeholder');
  assert(/documentation only[\s\S]{0,160}no scheduler daemon/i.test(doc), 'Phase 20 doc is docs/templates only');
  assert(/must not become CI requirements|must not become a CI requirement/i.test(doc), 'Phase 20 doc keeps schedules out of CI');
  assert(/CI must not require Docker[\s\S]*network[\s\S]*live Jellyfin[\s\S]*live external custodian[\s\S]*cloud services/i.test(doc), 'Phase 20 doc forbids live-service CI requirements');
  assert(/operator-owned templates only|examples only/i.test(runbook), 'runbook says schedules are operator-owned templates');
  assert(/FAIL[\s\S]*page[\s\S]*Expected[\s\S]*WARN[\s\S]*not health failures[\s\S]*Other[\s\S]*WARN/i.test(doc), 'Phase 20 doc covers FAIL/WARN triage semantics');
  assert(/no FAIL checks[\s\S]*WARN/.test(life), 'lifecycle preserves no-FAIL/WARN doctor semantics');
  assert(/throwaway[\s\S]*must never be the production/i.test(doc), 'restore rehearsal must use throwaway DB and avoid production');
  assert(/Plan mode is non-mutating[\s\S]*does not\s+close O5/i.test(doc), 'rewrap plan is non-mutating and does not close O5');
  assert(/independent media[\s\S]*separate failure domains/i.test(doc), 'retention guidance requires separate media/failure domains');
  assert(/Do not store the FileCustodian keystore, KEK, completion secret, or secret files in the same backup/i.test(doc), 'retention guidance separates key material from DB backups');
  for (const forbidden of ['/mnt/user/', 'postgresql://', 'CUSTODIAN_KEK=', 'COMPLETION_SECRET=', 'API_KEY=', 'TOKEN=']) {
    assert(!doc.includes(forbidden), `Phase 20 snippets avoid concrete secret/path pattern ${forbidden}`);
  }
  assert(readme.includes('PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md') && runbook.includes('PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md') && life.includes('PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md') && checklist.includes('PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md'), 'Phase 20 doc linked from operator docs');
});

test('external custodian acceptance - Phase 21 harness is local, wired, and keeps O4 open', () => {
  assert(exists('docs/PHASE_21_EXTERNAL_CUSTODIAN_ACCEPTANCE.md'), 'Phase 21 acceptance doc exists');
  assert(exists('test/helpers/custodian-contract-kit.ts'), 'importable custodian contract kit exists');
  assert(exists('test/custodian-acceptance.ts'), 'Phase 21 local acceptance suite exists');
  assert(typeof pkg.scripts['test:custodian-acceptance'] === 'string', 'test:custodian-acceptance script present');
  assert((pkg.scripts.test ?? '').includes('test/custodian-acceptance.ts'), 'acceptance suite in deterministic CI chain');

  const kit = read('test/helpers/custodian-contract-kit.ts');
  const executable = read('test/custodian-contract.ts');
  const acceptance = read('test/custodian-acceptance.ts');
  const phase16 = read('docs/PHASE_16_EXTERNAL_CUSTODIAN_READINESS.md');
  const phase19 = read('docs/PHASE_19_PRODUCTION_READINESS_EVIDENCE.md');
  const phase21 = read('docs/PHASE_21_EXTERNAL_CUSTODIAN_ACCEPTANCE.md');
  const tpl = read('docs/templates/PRODUCTION_READINESS_EVIDENCE.md');
  const readme = read('README.md');

  assert(kit.includes('export async function runCustodianContract'), 'kit exports runCustodianContract');
  assert(kit.includes('export type CustodianFactory'), 'kit exports documented factory type');
  assert(!/main\(\)|Running Phase 3 custodian/.test(kit), 'kit has no executable suite side effects');
  // Harness output must be REDACTION-SAFE by default (a real KMS error can embed secrets/endpoints/key ids):
  assert(kit.includes('formatHarnessFailure'), 'kit has a redaction-safe failure formatter');
  assert(/FAIL {2}\$\{name\}: \$\{formatHarnessFailure\(err\)\}/.test(kit), 'default FAIL line uses the redaction-safe formatter');
  assert(!/\(err as Error\)\.(message|stack)/.test(kit), 'kit does not print raw (err as Error).message/.stack by default');
  assert(kit.includes('CUSTODIAN_HARNESS_VERBOSE') && /debug\/non-evidence/.test(kit), 'raw debug output is gated behind CUSTODIAN_HARNESS_VERBOSE and labelled non-evidence');
  assert(kit.includes('SAFE_ERROR_NAMES') && kit.includes("'UnknownError'"), 'error class/category is allowlisted (not a raw err.name that could carry secrets)');
  assert((pkg.scripts.test ?? '').includes('test/custodian-harness-redaction.ts'), 'harness redaction regression is in the CI chain');
  assert(/redaction-safe|redacted/i.test(phase21), 'Phase 21 doc states harness output is redaction-safe');
  assert(executable.includes("from './helpers/custodian-contract-kit.js'"), 'executable suite imports the helper kit');
  assert(phase16.includes('./test/helpers/custodian-contract-kit.js'), 'Phase 16 points future adapters at helper kit');
  assert(acceptance.includes('LocalExternalCustodianHarness') && acceptance.includes('CustodianTransportError'), 'acceptance suite models external failures locally');

  for (const doc of [phase16, phase19, phase21, tpl, readme]) {
    assert(/O4[\s\S]{0,120}open/i.test(doc) || /does not close O4/i.test(doc), 'linked docs keep O4 open');
  }
  assert(/FileCustodian[\s\S]{0,160}reference harness/i.test(phase21), 'Phase 21 states FileCustodian is reference harness');
  assert(/operator-run|manually/i.test(phase21), 'Phase 21 keeps live validation operator-run');
  assert(/must not be wired into `npm run ci`/.test(phase21), 'Phase 21 keeps live validation out of CI');
  assert(readme.includes('PHASE_21_EXTERNAL_CUSTODIAN_ACCEPTANCE.md') && readme.includes('test:custodian-acceptance'), 'README links Phase 21 doc and script');

  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  for (const banned of [
    'aws-sdk', '@aws-sdk/client-kms', '@google-cloud/kms', '@azure/keyvault-keys',
    '@azure/identity', 'hashicorp-vault-client', 'node-vault', 'openbao', 'node-fetch',
    'undici', 'axios', 'got',
  ]) assert(!allDeps.includes(banned), `no external custodian/cloud/network SDK dependency ${banned}`);
  assert(!/(docker compose|curl |http:\/\/|https:\/\/|fetch\(|globalThis\.fetch)/.test(pkg.scripts['test:custodian-acceptance'] ?? ''), 'acceptance script has no Docker/network command');
});

test('operator UI packet contract - Phase 61 is static, allowlisted, and redaction-safe', () => {
  assert(exists('src/ops/operator-ui-packet-contract.ts'), 'Phase 61 contract source exists');
  assert(exists('docs/PHASE_61_OPERATOR_UI_PACKET_CONTRACT.md'), 'Phase 61 contract doc exists');
  assert(exists('test/operator-ui-packet-contract.ts'), 'Phase 61 contract suite exists');
  assert(typeof pkg.scripts['test:operator-ui-packet-contract'] === 'string', 'Phase 61 test script present');
  assert((pkg.scripts.test ?? '').includes('test/operator-ui-packet-contract.ts'), 'Phase 61 suite in CI chain');

  const source = read('src/ops/operator-ui-packet-contract.ts');
  const suite = read('test/operator-ui-packet-contract.ts');
  const doc = read('docs/PHASE_61_OPERATOR_UI_PACKET_CONTRACT.md');
  const combined = `${source}\n${suite}\n${doc}\n${read('README.md')}`;
  for (const kw of [
    'operator UI packet contract',
    'OPERATOR_UI_SCREEN_IDS',
    'OPERATOR_UI_DISPLAY_FIELD_LABELS',
    'OPERATOR_UI_FORBIDDEN_FIELD_CATEGORIES',
    'validateOperatorUiPacketDescriptor',
    'OPERATOR_UI_PACKET_REJECTED',
    'overview',
    'catalog-authority',
    'privacy-crypto-shredding',
    'key-custodian-o4-status',
    'reconciler',
    'backup-restore',
    'provider-availability-packets',
    'audit-queue',
    'settings-operator-configuration',
    'Item A',
    'Provider Count',
    'Review Required',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `Phase 61 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'React',
    'Vite',
    'Next',
    'Express',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'Plex',
    'Jellyfin',
    'Hermes',
    'document.',
    'window.',
    'readFileSync',
    'readdirSync',
    'existsSync',
  ]) assert(!source.includes(forbidden), `Phase 61 source excludes ${forbidden}`);

  for (const forbiddenCategory of [
    'title',
    'externalId',
    'providerRef',
    'infohash',
    'magnet',
    'credential',
    'token',
    'secret',
    'path',
    'url',
    'poster',
    'artwork',
    'providerName',
    'providerLogo',
    'rawPayload',
    'rawLog',
    'databaseUrl',
    'playback',
    'download',
    'stream',
  ]) assert(source.includes(forbiddenCategory), `Phase 61 denylist includes ${forbiddenCategory}`);
});

test('operator UI fixture packets - Phase 62 is static, deterministic, and contract-backed', () => {
  assert(exists('src/ops/operator-ui-fixtures.ts'), 'Phase 62 fixture source exists');
  assert(exists('docs/PHASE_62_OPERATOR_UI_FIXTURES.md'), 'Phase 62 fixture doc exists');
  assert(exists('test/operator-ui-fixtures.ts'), 'Phase 62 fixture suite exists');
  assert(typeof pkg.scripts['test:operator-ui-fixtures'] === 'string', 'Phase 62 test script present');
  assert((pkg.scripts.test ?? '').includes('test/operator-ui-packet-contract.ts && tsx test/operator-ui-fixtures.ts'), 'Phase 62 suite follows Phase 61 suite in CI chain');

  const source = read('src/ops/operator-ui-fixtures.ts');
  const suite = read('test/operator-ui-fixtures.ts');
  const doc = read('docs/PHASE_62_OPERATOR_UI_FIXTURES.md');
  const readme = read('README.md');
  const combined = `${source}\n${suite}\n${doc}\n${readme}`;
  for (const kw of [
    'operator UI fixture packets',
    'OPERATOR_UI_FIXTURE_PACKETS',
    'validateOperatorUiFixturePackets',
    'formatOperatorUiFixtureReport',
    'validateOperatorUiPacketDescriptor',
    'overview',
    'catalog-authority',
    'privacy-crypto-shredding',
    'key-custodian-o4-status',
    'reconciler',
    'backup-restore',
    'provider-availability-packets',
    'audit-queue',
    'settings-operator-configuration',
    'Item A',
    'Provider Count',
    'Review Required',
    'Phase 63',
    'fixture packets only',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `Phase 62 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'React',
    'Vite',
    'Next',
    'Express',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'Plex',
    'Jellyfin',
    'Hermes',
    'document.',
    'window.',
    'readFileSync',
    'readdirSync',
    'existsSync',
  ]) assert(!source.includes(forbidden), `Phase 62 source excludes ${forbidden}`);
});

test('static operator UI prototype - Phase 63 is fixture-only and read-only', () => {
  assert(exists('src/ops/operator-ui-static-prototype.ts'), 'Phase 63 static prototype source exists');
  assert(exists('src/ops/operator-ui-static-prototype-cli.ts'), 'Phase 63 static prototype CLI exists');
  assert(exists('docs/PHASE_63_STATIC_OPERATOR_UI_PROTOTYPE.md'), 'Phase 63 static prototype doc exists');
  assert(exists('test/operator-ui-static-prototype.ts'), 'Phase 63 static prototype suite exists');
  assert(typeof pkg.scripts['test:operator-ui-static-prototype'] === 'string', 'Phase 63 test script present');
  assert(typeof pkg.scripts['ops:operator-ui-static-prototype'] === 'string', 'Phase 63 ops script present');
  assert((pkg.scripts.test ?? '').includes('test/operator-ui-fixtures.ts && tsx test/operator-ui-static-prototype.ts'), 'Phase 63 suite follows Phase 62 suite in CI chain');

  const source = read('src/ops/operator-ui-static-prototype.ts');
  const cli = read('src/ops/operator-ui-static-prototype-cli.ts');
  const contract = read('src/ops/operator-ui-packet-contract.ts');
  const fixtures = read('src/ops/operator-ui-fixtures.ts');
  const suite = read('test/operator-ui-static-prototype.ts');
  const doc = read('docs/PHASE_63_STATIC_OPERATOR_UI_PROTOTYPE.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${contract}\n${fixtures}\n${suite}\n${doc}\n${readme}`;
  for (const kw of [
    'read-only static operator UI prototype',
    'renderOperatorUiStaticPrototypeHtml',
    'OPERATOR_UI_FIXTURE_PACKETS',
    'ops:operator-ui-static-prototype',
    'test:operator-ui-static-prototype',
    'overview',
    'catalog-authority',
    'privacy-crypto-shredding',
    'key-custodian-o4-status',
    'reconciler',
    'backup-restore',
    'provider-availability-packets',
    'audit-queue',
    'settings-operator-configuration',
    'Item A',
    'Provider Count',
    'Review Required',
    'Graphite + Muted Orange',
    'Phase 62 fixture packets only',
    'Phase 64',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `Phase 63 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'globalThis.fetch',
    'process.env',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'Plex',
    'Jellyfin',
    'Hermes',
    'window.',
    'localStorage',
    'readFileSync',
    'readdirSync',
    'existsSync',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 63 source excludes ${forbidden}`);
});

test('operator UI render allowlist - Phase 64 hardens static render boundary', () => {
  assert(exists('src/ops/operator-ui-render-allowlist.ts'), 'Phase 64 render allowlist source exists');
  assert(exists('docs/PHASE_64_RENDER_ALLOWLIST_HARDENING.md'), 'Phase 64 render allowlist doc exists');
  assert(exists('test/operator-ui-render-allowlist.ts'), 'Phase 64 render allowlist suite exists');
  assert(typeof pkg.scripts['test:operator-ui-render-allowlist'] === 'string', 'Phase 64 test script present');
  assert((pkg.scripts.test ?? '').includes('test/operator-ui-static-prototype.ts && tsx test/operator-ui-render-allowlist.ts'), 'Phase 64 suite follows Phase 63 suite in CI chain');

  const source = read('src/ops/operator-ui-render-allowlist.ts');
  const renderer = read('src/ops/operator-ui-static-prototype.ts');
  const contract = read('src/ops/operator-ui-packet-contract.ts');
  const fixtures = read('src/ops/operator-ui-fixtures.ts');
  const suite = read('test/operator-ui-render-allowlist.ts');
  const doc = read('docs/PHASE_64_RENDER_ALLOWLIST_HARDENING.md');
  const readme = read('README.md');
  const combined = `${source}\n${renderer}\n${contract}\n${fixtures}\n${suite}\n${doc}\n${readme}`;
  for (const kw of [
    'static render allowlist',
    'inspectOperatorUiRenderedHtml',
    'OPERATOR_UI_RENDER_ALLOWED_TEXT',
    'OPERATOR_UI_RENDER_FORBIDDEN_TEXT',
    'OPERATOR_UI_RENDER_FORBIDDEN_MARKUP',
    'OPERATOR_UI_RENDER_FORBIDDEN_EXTERNAL_REFERENCE',
    'Phase 61/62 allowlists',
    'fixed safe chrome',
    'overview',
    'catalog-authority',
    'privacy-crypto-shredding',
    'key-custodian-o4-status',
    'reconciler',
    'backup-restore',
    'provider-availability-packets',
    'audit-queue',
    'settings-operator-configuration',
    'Item A',
    'Provider Count',
    'Review Required',
    'Provider availability remains advisory/count-only',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
    'Phase 65',
  ]) assert(combined.includes(kw), `Phase 64 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'globalThis.fetch',
    'process.env',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'Plex',
    'Jellyfin',
    'Hermes',
    'window.',
    'localStorage',
    'sessionStorage',
    'readFileSync',
    'readdirSync',
    'existsSync',
  ]) assert(!source.includes(forbidden), `Phase 64 source excludes ${forbidden}`);
});

test('static operator UI artifact packaging - Phase 65 is allowlist-gated and fixture-only', () => {
  assert(exists('src/ops/operator-ui-static-artifact.ts'), 'Phase 65 static artifact source exists');
  assert(exists('src/ops/operator-ui-static-artifact-cli.ts'), 'Phase 65 static artifact CLI exists');
  assert(exists('docs/PHASE_65_STATIC_UI_ARTIFACT_PACKAGING.md'), 'Phase 65 static artifact doc exists');
  assert(exists('test/operator-ui-static-artifact.ts'), 'Phase 65 static artifact suite exists');
  assert(typeof pkg.scripts['test:operator-ui-static-artifact'] === 'string', 'Phase 65 test script present');
  assert(typeof pkg.scripts['ops:operator-ui-static-artifact'] === 'string', 'Phase 65 ops script present');
  assert((pkg.scripts.test ?? '').includes('test/operator-ui-render-allowlist.ts && tsx test/operator-ui-static-artifact.ts'), 'Phase 65 suite follows Phase 64 suite in CI chain');

  const source = read('src/ops/operator-ui-static-artifact.ts');
  const cli = read('src/ops/operator-ui-static-artifact-cli.ts');
  const renderer = read('src/ops/operator-ui-static-prototype.ts');
  const allowlist = read('src/ops/operator-ui-render-allowlist.ts');
  const suite = read('test/operator-ui-static-artifact.ts');
  const doc = read('docs/PHASE_65_STATIC_UI_ARTIFACT_PACKAGING.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${renderer}\n${allowlist}\n${suite}\n${doc}\n${readme}`;
  for (const kw of [
    'static operator UI artifact packaging',
    'buildOperatorUiStaticArtifact',
    'inspectOperatorUiRenderedHtml',
    'OPERATOR_UI_STATIC_ARTIFACT_READY',
    'operator-ui-static-prototype.html',
    'ops:operator-ui-static-artifact',
    'test:operator-ui-static-artifact',
    'Phase 64 allowlist gate',
    'fixture-only',
    'metadata only',
    'no React, Vite, Next, Express, frontend framework, bundler, HTTP route, API route, database read, provider adapter, network call, env read, file read, browser JavaScript, browser storage, external asset, remote font, provider control, playback, download, or streaming behavior',
    'Provider availability remains advisory/count-only',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
    'Phase 66',
  ]) assert(combined.includes(kw), `Phase 65 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'Plex',
    'Jellyfin',
    'Hermes',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'writeFile',
    'writeFileSync',
    'createWriteStream',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 65 source excludes ${forbidden}`);
});

test('static UI layout refinement - Phase 66 is allowlist-gated and fixture-only', () => {
  assert(exists('docs/PHASE_66_STATIC_UI_LAYOUT_REFINEMENT.md'), 'Phase 66 static layout doc exists');
  assert(exists('test/operator-ui-static-layout.ts'), 'Phase 66 static layout suite exists');
  assert(typeof pkg.scripts['test:operator-ui-static-layout'] === 'string', 'Phase 66 test script present');
  assert((pkg.scripts.test ?? '').includes('test/operator-ui-static-artifact.ts && tsx test/operator-ui-static-layout.ts'), 'Phase 66 suite follows Phase 65 suite in CI chain');

  const renderer = read('src/ops/operator-ui-static-prototype.ts');
  const allowlist = read('src/ops/operator-ui-render-allowlist.ts');
  const suite = read('test/operator-ui-static-layout.ts');
  const doc = read('docs/PHASE_66_STATIC_UI_LAYOUT_REFINEMENT.md');
  const readme = read('README.md');
  const combined = `${renderer}\n${allowlist}\n${suite}\n${doc}\n${readme}`;
  for (const kw of [
    'static UI layout refinement',
    'test:operator-ui-static-layout',
    'overview-band',
    'status-rail',
    'table-frame',
    'Static Surface',
    'Allowlist Gate',
    'Artifact Gate',
    'Render Boundary',
    'Phase 64 allowlist gate',
    'Phase 65 artifact packaging',
    'Graphite + Muted Orange',
    'fixture-only',
    'future decision gate',
    'Provider availability remains advisory/count-only',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `Phase 66 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'Plex',
    'Jellyfin',
    'Hermes',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'readFileSync',
    'readdirSync',
    'existsSync',
  ]) assert(!renderer.includes(forbidden), `Phase 66 renderer source excludes ${forbidden}`);
});

test('operator UI launch readiness - Phase 67 is fixed, synthetic, and redaction-safe', () => {
  assert(exists('src/ops/operator-ui-launch-readiness.ts'), 'Phase 67 launch readiness source exists');
  assert(exists('src/ops/operator-ui-launch-readiness-cli.ts'), 'Phase 67 launch readiness CLI exists');
  assert(exists('docs/PHASE_67_OPERATOR_UI_LAUNCH_READINESS.md'), 'Phase 67 launch readiness doc exists');
  assert(exists('test/operator-ui-launch-readiness.ts'), 'Phase 67 launch readiness suite exists');
  assert(typeof pkg.scripts['test:operator-ui-launch-readiness'] === 'string', 'Phase 67 test script present');
  assert(typeof pkg.scripts['ops:operator-ui-launch-readiness'] === 'string', 'Phase 67 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-static-layout.ts && tsx test/operator-ui-launch-readiness.ts'),
    'Phase 67 suite follows Phase 66 suite in CI chain',
  );

  const source = read('src/ops/operator-ui-launch-readiness.ts');
  const cli = read('src/ops/operator-ui-launch-readiness-cli.ts');
  const suite = read('test/operator-ui-launch-readiness.ts');
  const doc = read('docs/PHASE_67_OPERATOR_UI_LAUNCH_READINESS.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${readme}`;
  for (const kw of [
    'Operator UI Launch Readiness Gate',
    'operator UI launch readiness',
    'ops:operator-ui-launch-readiness',
    'test:operator-ui-launch-readiness',
    'static-preview',
    'local-readonly-ui',
    'live-product',
    'ready',
    'blocked/deferred',
    'not-ready',
    'fixed-synthetic-readiness',
    'fixture-only static preview can be generated/shared',
    'local read-only UI is blocked/deferred',
    'live product launch is not ready',
    'Live UI/API/runtime is not implemented or authorized',
    'Sanitized local packet source is not implemented',
    'Auth/access boundary is not implemented',
    'Phase 64 render allowlist and Phase 65 artifact packaging',
    'Provider availability remains packet/count/advisory only',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `Phase 67 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'Plex',
    'Jellyfin',
    'Hermes',
    'scraping',
    'playback',
    'download',
    'writeFile',
    'createWriteStream',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 67 source excludes ${forbidden}`);
});

test('operator UI runtime boundary - Phase 68 is fixed, synthetic, and no-input', () => {
  assert(exists('src/ops/operator-ui-runtime-boundary.ts'), 'Phase 68 runtime boundary source exists');
  assert(exists('src/ops/operator-ui-runtime-boundary-cli.ts'), 'Phase 68 runtime boundary CLI exists');
  assert(exists('docs/PHASE_68_OPERATOR_UI_RUNTIME_BOUNDARY.md'), 'Phase 68 runtime boundary doc exists');
  assert(exists('test/operator-ui-runtime-boundary.ts'), 'Phase 68 runtime boundary suite exists');
  assert(typeof pkg.scripts['test:operator-ui-runtime-boundary'] === 'string', 'Phase 68 test script present');
  assert(typeof pkg.scripts['ops:operator-ui-runtime-boundary'] === 'string', 'Phase 68 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-preview-launch-packet.ts && tsx test/operator-ui-runtime-boundary.ts'),
    'Phase 68 suite follows the Phase 97 preview launch packet in CI chain',
  );

  const source = read('src/ops/operator-ui-runtime-boundary.ts');
  const cli = read('src/ops/operator-ui-runtime-boundary-cli.ts');
  const suite = read('test/operator-ui-runtime-boundary.ts');
  const doc = read('docs/PHASE_68_OPERATOR_UI_RUNTIME_BOUNDARY.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${readme}`;
  for (const kw of [
    'Local Operator UI Runtime Boundary Plan',
    'operator UI runtime boundary',
    'ops:operator-ui-runtime-boundary',
    'test:operator-ui-runtime-boundary',
    'npm run --silent ops:operator-ui-runtime-boundary -- -- --json',
    'fixed-synthetic-runtime-boundary',
    'static-preview',
    'local-readonly-runtime',
    'live-product',
    'ready',
    'blocked/deferred',
    'not-ready',
    'local-only bind/access posture',
    'operator access/auth boundary',
    'read-only packet endpoint/source',
    'direct UI DB access is forbidden',
    'static preview remains the only ready surface',
    'local read-only runtime remains blocked',
    'Phase 69',
    'Phase 64 render allowlist remains intact',
    'Phase 65 static artifact packaging remains intact',
    'Phase 67 launch readiness gate remains intact',
    'Provider availability remains packet/count/advisory only',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `Phase 68 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'Plex',
    'Jellyfin',
    'Hermes',
    'scraping',
    'playback',
    'download',
    'writeFile',
    'createWriteStream',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 68 source excludes ${forbidden}`);
});

test('operator UI packet source contract - Phase 69 is sanitized and no-input', () => {
  assert(exists('src/ops/operator-ui-packet-source-contract.ts'), 'Phase 69 packet source contract source exists');
  assert(exists('src/ops/operator-ui-packet-source-contract-cli.ts'), 'Phase 69 packet source contract CLI exists');
  assert(exists('docs/PHASE_69_OPERATOR_UI_PACKET_SOURCE_CONTRACT.md'), 'Phase 69 packet source contract doc exists');
  assert(exists('test/operator-ui-packet-source-contract.ts'), 'Phase 69 packet source contract suite exists');
  assert(typeof pkg.scripts['test:operator-ui-packet-source-contract'] === 'string', 'Phase 69 test script present');
  assert(typeof pkg.scripts['ops:operator-ui-packet-source-contract'] === 'string', 'Phase 69 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-runtime-boundary.ts && tsx test/operator-ui-packet-source-contract.ts'),
    'Phase 69 suite follows Phase 68 suite in CI chain',
  );

  const source = read('src/ops/operator-ui-packet-source-contract.ts');
  const cli = read('src/ops/operator-ui-packet-source-contract-cli.ts');
  const suite = read('test/operator-ui-packet-source-contract.ts');
  const doc = read('docs/PHASE_69_OPERATOR_UI_PACKET_SOURCE_CONTRACT.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${readme}`;
  for (const kw of [
    'Sanitized Local Operator Packet Source Contract',
    'operator UI packet source contract',
    'ops:operator-ui-packet-source-contract',
    'test:operator-ui-packet-source-contract',
    'npm run --silent ops:operator-ui-packet-source-contract -- -- --json',
    'fixed-synthetic-packet-source-contract',
    'immutable/read-only packet snapshots',
    'explicit sanitized local packet endpoint',
    'allowed-future-source/not-implemented',
    'explicit sanitization and allowlist checks',
    'redaction-safe operator packets',
    'synthetic labels, counts, and statuses',
    'Phase 61 operator UI packet descriptor allowlists',
    'direct UI DB reads',
    'raw event payloads',
    'raw provider refs',
    'infohashes',
    'magnets',
    'credentials',
    'paths',
    'artwork',
    'user library data',
    'Provider availability remains packet/count/advisory only',
    'Local read-only runtime remains blocked/deferred',
    'Live product launch remains not-ready',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `Phase 69 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'Plex',
    'Jellyfin',
    'Hermes',
    'scraping',
    'playback',
    'download',
    'writeFile',
    'createWriteStream',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 69 source excludes ${forbidden}`);
});

test('operator UI static runtime shell - Phase 70 is local fixture-only HTTP', () => {
  assert(exists('src/ops/operator-ui-static-runtime.ts'), 'Phase 70 static runtime source exists');
  assert(exists('src/ops/operator-ui-static-runtime-cli.ts'), 'Phase 70 static runtime CLI exists');
  assert(exists('docs/PHASE_70_LOCAL_STATIC_UI_RUNTIME_SHELL.md'), 'Phase 70 static runtime doc exists');
  assert(exists('test/operator-ui-static-runtime.ts'), 'Phase 70 static runtime suite exists');
  assert(typeof pkg.scripts['test:operator-ui-static-runtime'] === 'string', 'Phase 70 test script present');
  assert(typeof pkg.scripts['ops:operator-ui-static-runtime'] === 'string', 'Phase 70 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-packet-source-contract.ts && tsx test/operator-ui-static-runtime.ts'),
    'Phase 70 suite follows Phase 69 suite in CI chain',
  );

  const source = read('src/ops/operator-ui-static-runtime.ts');
  const cli = read('src/ops/operator-ui-static-runtime-cli.ts');
  const suite = read('test/operator-ui-static-runtime.ts');
  const doc = read('docs/PHASE_70_LOCAL_STATIC_UI_RUNTIME_SHELL.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${readme}`;
  for (const kw of [
    'Local Static Operator UI Runtime Shell',
    'operator UI static runtime shell',
    'ops:operator-ui-static-runtime',
    'test:operator-ui-static-runtime',
    'npm run ops:operator-ui-static-runtime -- --serve --host 127.0.0.1 --port 8787',
    'buildOperatorUiStaticArtifact',
    'OPERATOR_UI_STATIC_RUNTIME_HEALTHY',
    'fixture/static/local-only',
    'GET /',
    'GET /healthz',
    '127.0.0.1',
    'Cache-Control',
    'no-store',
    'X-Content-Type-Options',
    'nosniff',
    "script-src 'none'",
    "connect-src 'none'",
    "frame-ancestors 'none'",
    'Phase 64 render allowlist',
    'Phase 65 artifact packaging',
    'Phase 68/69 boundaries remain visible',
    'no live DB/provider/packet-source/API/playback/download/scraping/media-server behavior',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `Phase 70 covers ${kw}`);

  assert(source.includes("from 'node:http'"), 'Phase 70 runtime uses Node built-in HTTP');
  assert(suite.includes("from 'node:http'"), 'Phase 70 tests may use Node built-in HTTP against loopback');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:fs',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'Plex',
    'Jellyfin',
    'Hermes',
    'writeFile',
    'createWriteStream',
    '/api/',
    'DATABASE_URL',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 70 source excludes ${forbidden}`);
});

test('operator UI static runtime hardening - Phase 71 fails closed before new data surfaces', () => {
  assert(exists('docs/PHASE_71_STATIC_RUNTIME_HARDENING.md'), 'Phase 71 static runtime hardening doc exists');
  assert(exists('test/operator-ui-static-runtime-hardening.ts'), 'Phase 71 static runtime hardening suite exists');
  assert(typeof pkg.scripts['test:operator-ui-static-runtime-hardening'] === 'string', 'Phase 71 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-static-runtime.ts && tsx test/operator-ui-static-runtime-hardening.ts'),
    'Phase 71 suite follows Phase 70 suite in CI chain',
  );

  const source = read('src/ops/operator-ui-static-runtime.ts');
  const cli = read('src/ops/operator-ui-static-runtime-cli.ts');
  const suite = read('test/operator-ui-static-runtime-hardening.ts');
  const doc = read('docs/PHASE_71_STATIC_RUNTIME_HARDENING.md');
  const phase70 = read('docs/PHASE_70_LOCAL_STATIC_UI_RUNTIME_SHELL.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${phase70}\n${readme}`;

  for (const kw of [
    'Local Static Runtime Hardening',
    'test:operator-ui-static-runtime-hardening',
    'pre-listen self-check',
    'Phase 64 allowlist inspection',
    'buildPrecheckedOperatorUiStaticRuntimeArtifact',
    'server.listen',
    'HEAD',
    'Allow: GET',
    'query strings',
    'graceful shutdown',
    'SIGINT',
    'SIGTERM',
    'requestTimeout',
    'headersTimeout',
    'keepAliveTimeout',
    'maxHeadersCount',
    'Referrer-Policy',
    'X-Frame-Options',
    'npm run ops:operator-ui-static-runtime -- --serve --host 127.0.0.1 --port 8787',
    'Still serves only the in-process Phase 65 static artifact behind the Phase 64 allowlist',
    'no API/data route, packet source, DB/provider/playback/download/scraping/media-server behavior',
    'Phase 68/69 boundaries remain visible',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `Phase 71 covers ${kw}`);

  assert(source.includes("from 'node:http'"), 'Phase 71 runtime remains Node built-in HTTP only');
  assert(!source.includes('buildOperatorUiStaticArtifact();\n      setSafeHeaders'), 'root handler does not rebuild artifact per request');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:fs',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'Plex',
    'Jellyfin',
    'Hermes',
    'writeFile',
    'createWriteStream',
    '/api/',
    'DATABASE_URL',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 71 source excludes ${forbidden}`);
});

test('operator UI static runtime manifest - Phase 72 is fixed local metadata only', () => {
  assert(exists('docs/PHASE_72_STATIC_RUNTIME_MANIFEST.md'), 'Phase 72 static runtime manifest doc exists');
  assert(exists('test/operator-ui-static-runtime-manifest.ts'), 'Phase 72 static runtime manifest suite exists');
  assert(typeof pkg.scripts['test:operator-ui-static-runtime-manifest'] === 'string', 'Phase 72 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-static-runtime-hardening.ts && tsx test/operator-ui-static-runtime-manifest.ts'),
    'Phase 72 suite follows Phase 71 hardening suite in CI chain',
  );

  const source = read('src/ops/operator-ui-static-runtime.ts');
  const cli = read('src/ops/operator-ui-static-runtime-cli.ts');
  const suite = read('test/operator-ui-static-runtime-manifest.ts');
  const doc = read('docs/PHASE_72_STATIC_RUNTIME_MANIFEST.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${readme}`;

  for (const kw of [
    'Local Static Runtime Manifest Endpoint',
    'test:operator-ui-static-runtime-manifest',
    'buildOperatorUiStaticRuntimeManifest',
    'GET /manifest.json',
    'OPERATOR_UI_STATIC_RUNTIME_MANIFEST',
    'local-static-fixture-preview',
    'fixture-only',
    'packetSource',
    'not-implemented',
    'static-preview-only',
    'not-ready',
    'Content-Type: application/json; charset=utf-8',
    'HEAD /manifest.json',
    'Allow: GET',
    'absolute-form',
    'scheme-relative',
    'encoded slash',
    'encoded backslash',
    'Phase 64',
    'Phase 65',
    'Phase 68',
    'Phase 69',
    'Phase 71',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
    'Provider availability remains packet/count/advisory only',
    'no DB/provider/API data/playback/download/scraping/media-server/packet source behavior',
  ]) assert(combined.includes(kw), `Phase 72 covers ${kw}`);

  assert(source.includes("from 'node:http'"), 'Phase 72 runtime remains Node built-in HTTP only');
  assert(!source.includes('new Date'), 'manifest has no timestamp construction');
  assert(!source.includes('Date.now'), 'manifest has no dynamic clock read');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:fs',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'TorBox',
    'Plex',
    'Jellyfin',
    'Hermes',
    'writeFile',
    'createWriteStream',
    '/api/',
    'DATABASE_URL',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 72 source excludes ${forbidden}`);
});

test('operator UI static runtime access boundary - Phase 73 is explicit and fail-closed', () => {
  assert(exists('docs/PHASE_73_OPERATOR_UI_ACCESS_BOUNDARY.md'), 'Phase 73 operator access boundary doc exists');
  assert(exists('test/operator-ui-static-runtime-access-boundary.ts'), 'Phase 73 operator access boundary suite exists');
  assert(typeof pkg.scripts['test:operator-ui-static-runtime-access-boundary'] === 'string', 'Phase 73 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-static-runtime-manifest.ts && tsx test/operator-ui-static-runtime-access-boundary.ts'),
    'Phase 73 suite follows Phase 72 manifest suite in CI chain',
  );

  const source = read('src/ops/operator-ui-static-runtime.ts');
  const cli = read('src/ops/operator-ui-static-runtime-cli.ts');
  const suite = read('test/operator-ui-static-runtime-access-boundary.ts');
  const doc = read('docs/PHASE_73_OPERATOR_UI_ACCESS_BOUNDARY.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${readme}`;

  for (const kw of [
    'Operator Static Runtime Access Boundary',
    'test:operator-ui-static-runtime-access-boundary',
    'accessBoundary',
    'loopback-only-fixture-preview',
    'operatorAuth',
    'not-implemented',
    'remoteExposure',
    'blocked',
    'futureDataSurfacesRequire',
    'explicit-auth-access-phase',
    'not production auth',
    'does not authorize reverse proxy or public exposure',
    'loopback-only fixture preview',
    'no auth/session/cookie/token mechanism',
    'no API route, packet endpoint, DB read, provider integration, playback, download, scraping, media-server logic, TLS, or public bind',
    'packet or data surfaces require an explicit auth/access phase',
    '/api/*',
    '/packets',
    '/login',
    '/session',
    '/auth',
    '/token',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
    'Provider availability remains packet/count/advisory only',
  ]) assert(combined.includes(kw), `Phase 73 covers ${kw}`);

  assert(source.includes("from 'node:http'"), 'Phase 73 runtime remains Node built-in HTTP only');
  assert(!source.includes('server.listen(0.0.0.0'), 'runtime has no remote listen literal');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:fs',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'TorBox',
    'Plex',
    'Jellyfin',
    'Hermes',
    'writeFile',
    'createWriteStream',
    '/api/',
    '/login',
    '/session',
    '/auth',
    '/token',
    'Set-Cookie',
    'Cookie',
    'cookie',
    'session',
    'Authorization',
    'authorization',
    'Bearer',
    'bearer',
    'Basic',
    'basic',
    'token',
    'credential',
    'password',
    'DATABASE_URL',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 73 source excludes ${forbidden}`);
});

test('operator UI auth/access contract - Phase 74 is contract-only and fail-closed', () => {
  assert(exists('src/ops/operator-ui-auth-access-contract.ts'), 'Phase 74 auth/access contract source exists');
  assert(exists('src/ops/operator-ui-auth-access-contract-cli.ts'), 'Phase 74 auth/access contract CLI exists');
  assert(exists('docs/PHASE_74_OPERATOR_UI_AUTH_ACCESS_CONTRACT.md'), 'Phase 74 auth/access contract doc exists');
  assert(exists('test/operator-ui-auth-access-contract.ts'), 'Phase 74 auth/access contract suite exists');
  assert(typeof pkg.scripts['test:operator-ui-auth-access-contract'] === 'string', 'Phase 74 test script present');
  assert(typeof pkg.scripts['ops:operator-ui-auth-access-contract'] === 'string', 'Phase 74 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-static-runtime-access-boundary.ts && tsx test/operator-ui-auth-access-contract.ts'),
    'Phase 74 suite follows Phase 73 access-boundary suite in CI chain',
  );

  const source = read('src/ops/operator-ui-auth-access-contract.ts');
  const cli = read('src/ops/operator-ui-auth-access-contract-cli.ts');
  const suite = read('test/operator-ui-auth-access-contract.ts');
  const doc = read('docs/PHASE_74_OPERATOR_UI_AUTH_ACCESS_CONTRACT.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${readme}`;

  for (const kw of [
    'Operator UI Auth/Access Contract Gate',
    'operator UI auth/access contract',
    'ops:operator-ui-auth-access-contract',
    'test:operator-ui-auth-access-contract',
    'npm run --silent ops:operator-ui-auth-access-contract -- -- --json',
    'operator-ui-auth-access-contract',
    'phase-74.v1',
    'not-implemented',
    'contract-only',
    '127.0.0.1 fixture preview only',
    'blocked until explicit future phase',
    'operator-local-secret-file',
    'reverse-proxy-forward-auth-attestation',
    'mTLS-or-local-network-attestation',
    'explicit Clint authorization and independent reviewer GO',
    'no public bind without a reviewed deployment/auth model',
    'no direct DB reads from UI runtime',
    'Sanitized packet source only after Phase 69 contract and auth/access review',
    'redaction-safe',
    'No credentials/tokens/cookies/session values in logs, docs, or evidence',
    'rate, size, method, and raw-target fail-closed behavior',
    '/api/*',
    '/packets',
    '/login',
    '/session',
    '/auth',
    '/token',
    '/callback',
    '/logout',
    '/oauth',
    '/sso',
    '/admin',
    'cookie/session/token/bearer/basic parsing',
    'env/config/file secret reads',
    'TLS/reverse-proxy/public-bind implementation',
    'frontend framework/browser JavaScript',
    'GET /manifest.json',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
    'Provider availability remains packet/count/advisory only',
  ]) assert(combined.includes(kw), `Phase 74 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'TorBox',
    'Plex',
    'Jellyfin',
    'Hermes',
    'writeFile',
    'createWriteStream',
    'createServer',
    'server.listen',
    'req.headers',
    '.headers.authorization',
    "headers['authorization']",
    'getHeader',
    'setHeader',
    'parseCookie',
    'cookieParser',
    'Set-Cookie',
    'Basic ',
    'Bearer ',
    'password=',
    'token=',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 74 source excludes ${forbidden}`);
});

test('operator UI packet endpoint readiness - Phase 75 is static preflight-only and not-ready', () => {
  assert(exists('src/ops/operator-ui-packet-endpoint-readiness.ts'), 'Phase 75 packet endpoint readiness source exists');
  assert(exists('src/ops/operator-ui-packet-endpoint-readiness-cli.ts'), 'Phase 75 packet endpoint readiness CLI exists');
  assert(exists('docs/PHASE_75_OPERATOR_UI_PACKET_ENDPOINT_READINESS.md'), 'Phase 75 packet endpoint readiness doc exists');
  assert(exists('test/operator-ui-packet-endpoint-readiness.ts'), 'Phase 75 packet endpoint readiness suite exists');
  assert(typeof pkg.scripts['test:operator-ui-packet-endpoint-readiness'] === 'string', 'Phase 75 test script present');
  assert(typeof pkg.scripts['ops:operator-ui-packet-endpoint-readiness'] === 'string', 'Phase 75 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-auth-access-contract.ts && tsx test/operator-ui-packet-endpoint-readiness.ts'),
    'Phase 75 suite follows Phase 74 auth/access contract in CI chain',
  );

  const source = read('src/ops/operator-ui-packet-endpoint-readiness.ts');
  const cli = read('src/ops/operator-ui-packet-endpoint-readiness-cli.ts');
  const suite = read('test/operator-ui-packet-endpoint-readiness.ts');
  const doc = read('docs/PHASE_75_OPERATOR_UI_PACKET_ENDPOINT_READINESS.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${readme}`;

  for (const kw of [
    'Sanitized Packet Endpoint Readiness Preflight',
    'operator UI packet endpoint readiness',
    'ops:operator-ui-packet-endpoint-readiness',
    'test:operator-ui-packet-endpoint-readiness',
    'npm run --silent ops:operator-ui-packet-endpoint-readiness -- -- --json',
    'operator-ui-packet-endpoint-readiness',
    'phase-75.v1',
    'OPERATOR_UI_PACKET_ENDPOINT_READINESS_REPORTED',
    'not-ready',
    'preflight-only',
    'Phase 69 packet source contract exists but endpoint is not implemented',
    'Phase 74 auth/access contract exists but auth is not implemented',
    'Static runtime route surface remains only GET /, GET /healthz, GET /manifest.json',
    'sanitized local packet endpoint remains blocked',
    'direct UI DB reads remain forbidden',
    'Provider availability remains packet/count/advisory only',
    'O4/O5 remain open/deferred unless separately proven',
    'FileCustodian remains reference harness only',
    'explicit Clint authorization and reviewer GO',
    'auth/access implementation phase completed and reviewed',
    'endpoint source must consume only sanitized redaction-safe operator packets',
    'no real titles, external IDs, provider names/logos, raw refs, infohashes, magnets, credentials, paths, artwork, user library data, or raw event payloads',
    'no provider calls, playback/download/scraping/media-server logic, direct DB access, or live packet ingestion',
    'route/method/body/raw-target hardening retained',
    'size/rate bounds defined before endpoint exists',
    'evidence/redaction tests added before any endpoint route is exposed',
    '/api/*',
    '/packets',
    '/packet',
    '/operator-packets',
    '/data',
    '/events',
    '/catalog',
    '/items',
    '/auth',
    '/login',
    '/session',
    '/token',
    'route handlers',
    'API framework',
    'DB/env/fs reads',
    'fetch/network calls',
    'browser JS/framework',
    'cookies/sessions/tokens',
    'blocked packet/data/auth paths return fixed 404 responses',
    'known routes reject unsupported methods with fixed 405 responses',
  ]) assert(combined.includes(kw), `Phase 75 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'TorBox',
    'Plex',
    'Jellyfin',
    'Hermes',
    'writeFile',
    'createWriteStream',
    'createServer',
    'server.listen',
    'req.headers',
    'res.end',
    'app.get',
    'router.',
    '.headers.authorization',
    "headers['authorization']",
    'getHeader',
    'setHeader',
    'parseCookie',
    'cookieParser',
    'Set-Cookie',
    'Basic ',
    'Bearer ',
    'password=',
    'token=',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 75 source excludes ${forbidden}`);
});

test('operator UI packet endpoint limits - Phase 76 is contract-only and not-implemented', () => {
  assert(exists('src/ops/operator-ui-packet-endpoint-limits.ts'), 'Phase 76 packet endpoint limits source exists');
  assert(exists('src/ops/operator-ui-packet-endpoint-limits-cli.ts'), 'Phase 76 packet endpoint limits CLI exists');
  assert(exists('docs/PHASE_76_OPERATOR_UI_PACKET_ENDPOINT_LIMITS.md'), 'Phase 76 packet endpoint limits doc exists');
  assert(exists('test/operator-ui-packet-endpoint-limits.ts'), 'Phase 76 packet endpoint limits suite exists');
  assert(typeof pkg.scripts['test:operator-ui-packet-endpoint-limits'] === 'string', 'Phase 76 test script present');
  assert(typeof pkg.scripts['ops:operator-ui-packet-endpoint-limits'] === 'string', 'Phase 76 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-packet-endpoint-readiness.ts && tsx test/operator-ui-packet-endpoint-limits.ts'),
    'Phase 76 suite follows Phase 75 packet endpoint readiness in CI chain',
  );

  const source = read('src/ops/operator-ui-packet-endpoint-limits.ts');
  const cli = read('src/ops/operator-ui-packet-endpoint-limits-cli.ts');
  const suite = read('test/operator-ui-packet-endpoint-limits.ts');
  const doc = read('docs/PHASE_76_OPERATOR_UI_PACKET_ENDPOINT_LIMITS.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${readme}`;

  for (const kw of [
    'Packet Endpoint Limits Contract',
    'operator UI packet endpoint limits',
    'ops:operator-ui-packet-endpoint-limits',
    'test:operator-ui-packet-endpoint-limits',
    'npm run --silent ops:operator-ui-packet-endpoint-limits -- -- --json',
    'operator-ui-packet-endpoint-limits',
    'phase-76.v1',
    'OPERATOR_UI_PACKET_ENDPOINT_LIMITS_REPORTED',
    'not-implemented',
    'contract-only',
    'sanitized-local-packet-endpoint',
    'only GET may ever serve packet snapshots in the first implementation',
    'HEAD remains rejected unless explicitly reviewed',
    'POST, PUT, PATCH, DELETE, OPTIONS, and other methods rejected with fixed sanitized responses',
    'request bodies ignored/rejected and never echoed',
    'max request target bytes: 2048',
    'max header count: 64',
    'max request body bytes: 0',
    'max response bytes: 262144',
    'max packet count: 64',
    'max string field bytes: 256',
    'max array length per field: 64',
    'loopback preview only',
    'max requests per minute per operator/runtime process: 60',
    'burst size: 10',
    'no remote/IP-based trust yet',
    'no persistence/counters implemented in this phase',
    'fixed 404',
    'fixed 405',
    'Allow: GET',
    'fixed 413',
    'fixed 429',
    'no echoing paths, query strings, headers, body snippets, credentials, raw refs, packet contents, provider details, or DB errors',
    'raw target bypass closed',
    'query strings cannot create behavior',
    'safe headers retained',
    'no browser JS/framework requirement',
    'no direct DB read',
    'no provider calls',
    'no playback/download/scraping/media-server behavior',
    'no live packet ingestion',
    'Phase 75 readiness remains not-ready until endpoint/auth implementation and evidence tests exist',
    'no packet endpoint/runtime enforcement/auth/data/provider/UI expansion is added',
  ]) assert(combined.includes(kw), `Phase 76 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'TorBox',
    'Plex',
    'Jellyfin',
    'Hermes',
    'writeFile',
    'createWriteStream',
    'createServer',
    'server.listen',
    'req.headers',
    'res.end',
    'app.get',
    'router.',
    '.headers.authorization',
    "headers['authorization']",
    'getHeader',
    'setHeader',
    'parseCookie',
    'cookieParser',
    'Set-Cookie',
    'Basic ',
    'Bearer ',
    'password=',
    'token=',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 76 source excludes ${forbidden}`);
});

test('operator UI packet endpoint evidence gate - Phase 77 is blocked evidence policy only', () => {
  assert(exists('src/ops/operator-ui-packet-endpoint-evidence-gate.ts'), 'Phase 77 packet endpoint evidence gate source exists');
  assert(exists('src/ops/operator-ui-packet-endpoint-evidence-gate-cli.ts'), 'Phase 77 packet endpoint evidence gate CLI exists');
  assert(exists('docs/PHASE_77_OPERATOR_UI_PACKET_ENDPOINT_EVIDENCE_GATE.md'), 'Phase 77 packet endpoint evidence gate doc exists');
  assert(exists('test/operator-ui-packet-endpoint-evidence-gate.ts'), 'Phase 77 packet endpoint evidence gate suite exists');
  assert(typeof pkg.scripts['test:operator-ui-packet-endpoint-evidence-gate'] === 'string', 'Phase 77 test script present');
  assert(typeof pkg.scripts['ops:operator-ui-packet-endpoint-evidence-gate'] === 'string', 'Phase 77 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-packet-endpoint-limits.ts && tsx test/operator-ui-packet-endpoint-evidence-gate.ts'),
    'Phase 77 suite follows Phase 76 packet endpoint limits in CI chain',
  );

  const source = read('src/ops/operator-ui-packet-endpoint-evidence-gate.ts');
  const cli = read('src/ops/operator-ui-packet-endpoint-evidence-gate-cli.ts');
  const suite = read('test/operator-ui-packet-endpoint-evidence-gate.ts');
  const doc = read('docs/PHASE_77_OPERATOR_UI_PACKET_ENDPOINT_EVIDENCE_GATE.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${readme}`;

  for (const kw of [
    'Packet Endpoint Evidence Gate',
    'operator UI packet endpoint evidence gate',
    'ops:operator-ui-packet-endpoint-evidence-gate',
    'test:operator-ui-packet-endpoint-evidence-gate',
    'npm run --silent ops:operator-ui-packet-endpoint-evidence-gate -- -- --json',
    'operator-ui-packet-endpoint-evidence-gate',
    'phase-77.v1',
    'OPERATOR_UI_PACKET_ENDPOINT_EVIDENCE_GATE_REPORTED',
    'blocked',
    'evidence-required',
    'endpointExposure',
    'not-implemented',
    'Phase 75 readiness remains not-ready',
    'Phase 76 limits remain contract-only and not-implemented',
    'static runtime route-surface regression evidence',
    'only GET /, GET /healthz, and GET /manifest.json',
    'reviewed local operator auth boundary',
    'request target, header, body, response, packet, string, and array limits',
    'GET-only initial endpoint',
    'HEAD rejected unless explicitly reviewed',
    'POST, PUT, PATCH, DELETE, OPTIONS, and OTHER receive fixed sanitized rejections',
    'fixed 404, 405, 413, and 429',
    'only a sanitized future packet producer may feed the endpoint',
    'no direct DB, provider, or raw-ref source',
    'fixtures and synthetic packets only',
    'oversized target, header, body, response',
    'method rejection',
    'blocked route',
    'raw-target bypass',
    'redaction sentinel',
    'independent reviewer GO',
    'operator packet and review record',
    'static-route-surface-regression-report',
    'local-operator-auth-boundary-review',
    'phase-76-limits-enforcement-test-report',
    'method-rejection-matrix-report',
    'failure-redaction-sentinel-report',
    'sanitized-packet-source-boundary-review',
    'synthetic-fixture-only-attestation',
    'endpoint-redaction-sentinel-test-report',
    'independent-reviewer-go-record',
    'operator-acceptance-record',
    'titles',
    'external IDs',
    'provider names/logos',
    'raw refs',
    'infohashes',
    'magnets',
    'URLs',
    'credentials',
    'tokens',
    'cookies',
    'DB URLs',
    'DB errors',
    'packet contents',
    'artifact contents',
    'no endpoint route handler',
    'no runtime auth implementation',
    'no API framework',
    'no DB/env/fs reads',
    'no network calls',
    'no provider integration',
    'no frontend or browser JavaScript',
    'no packet ingestion',
    'no playback/download/scraping/media-server behavior',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness only',
    'Provider availability remains packet/count/advisory only',
  ]) assert(combined.includes(kw), `Phase 77 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'TorBox',
    'Plex',
    'Jellyfin',
    'Hermes',
    'writeFile',
    'createWriteStream',
    'createServer',
    'server.listen',
    'req.headers',
    'res.end',
    'app.get',
    'router.',
    '.headers.authorization',
    "headers['authorization']",
    'getHeader',
    'setHeader',
    'parseCookie',
    'cookieParser',
    'Set-Cookie',
    'Basic ',
    'Bearer ',
    'password=',
    'token=',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 77 source excludes ${forbidden}`);
});

test('operator UI packet endpoint route dry-run - Phase 78 is blocked plan-only', () => {
  assert(exists('src/ops/operator-ui-packet-endpoint-route-dry-run.ts'), 'Phase 78 packet endpoint route dry-run source exists');
  assert(exists('src/ops/operator-ui-packet-endpoint-route-dry-run-cli.ts'), 'Phase 78 packet endpoint route dry-run CLI exists');
  assert(exists('docs/PHASE_78_OPERATOR_UI_PACKET_ENDPOINT_ROUTE_DRY_RUN.md'), 'Phase 78 packet endpoint route dry-run doc exists');
  assert(exists('test/operator-ui-packet-endpoint-route-dry-run.ts'), 'Phase 78 packet endpoint route dry-run suite exists');
  assert(typeof pkg.scripts['test:operator-ui-packet-endpoint-route-dry-run'] === 'string', 'Phase 78 test script present');
  assert(typeof pkg.scripts['ops:operator-ui-packet-endpoint-route-dry-run'] === 'string', 'Phase 78 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-packet-endpoint-evidence-gate.ts && tsx test/operator-ui-packet-endpoint-route-dry-run.ts'),
    'Phase 78 suite follows Phase 77 packet endpoint evidence gate in CI chain',
  );

  const source = read('src/ops/operator-ui-packet-endpoint-route-dry-run.ts');
  const cli = read('src/ops/operator-ui-packet-endpoint-route-dry-run-cli.ts');
  const suite = read('test/operator-ui-packet-endpoint-route-dry-run.ts');
  const doc = read('docs/PHASE_78_OPERATOR_UI_PACKET_ENDPOINT_ROUTE_DRY_RUN.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${readme}`;

  for (const kw of [
    'Packet Endpoint Route Dry-Run Plan',
    'operator UI packet endpoint route dry-run',
    'ops:operator-ui-packet-endpoint-route-dry-run',
    'test:operator-ui-packet-endpoint-route-dry-run',
    'npm run --silent ops:operator-ui-packet-endpoint-route-dry-run -- -- --json',
    'operator-ui-packet-endpoint-route-dry-run',
    'phase-78.v1',
    'OPERATOR_UI_PACKET_ENDPOINT_ROUTE_DRY_RUN_REPORTED',
    'blocked',
    'dry-run-plan-only',
    'routeExposure',
    'not-implemented',
    'sanitized-local-packet-endpoint',
    'future-local-packet-snapshot-route',
    'planned route is local loopback only in a future phase and remains blocked now',
    'GET only',
    'HEAD remains rejected unless explicitly reviewed',
    'POST, PUT, PATCH, DELETE, OPTIONS, and OTHER rejected with fixed sanitized responses',
    'request body byte limit remains 0',
    'request target max 2048 bytes',
    'max header count 64',
    'max response 262144 bytes',
    'max packet count 64',
    'max string field bytes 256',
    'max array length 64',
    '60 requests/min per operator runtime process',
    'burst 10',
    'loopback preview only',
    'no remote/IP trust',
    'no counters implemented now',
    'fixed 404',
    'fixed 405 with Allow GET only after endpoint exists',
    'fixed 413',
    'fixed 429',
    'paths, query strings, headers, bodies, credentials, raw refs, packet contents, provider details, and DB errors',
    'Phase 77 evidence gate must be satisfied and independently reviewed before implementation',
    'method matrix',
    'size matrix',
    'rate preview',
    'redaction sentinel',
    'raw target bypass',
    'blocked route',
    'auth boundary',
    'packet source boundary',
    'operator acceptance',
    'independent reviewer GO',
    'GET /, GET /healthz, GET /manifest.json',
    '/api/packets',
    '/packets',
    '/packet',
    '/operator-packets',
    '/data',
    '/events',
    '/catalog',
    '/items',
    '/auth',
    '/login',
    '/session',
    '/token',
    'Phase 75 readiness remains not-ready',
    'Phase 76 limits remain contract-only and not-implemented',
    'Phase 77 evidence gate remains blocked and evidence-required',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness only',
    'Provider availability remains packet/count/advisory only',
    'no endpoint/runtime/auth/provider/UI/data expansion is added',
  ]) assert(combined.includes(kw), `Phase 78 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'TorBox',
    'Plex',
    'Jellyfin',
    'Hermes',
    'writeFile',
    'createWriteStream',
    'createServer',
    'server.listen',
    'req.headers',
    'res.end',
    'app.get',
    'router.',
    '.headers.authorization',
    "headers['authorization']",
    'getHeader',
    'setHeader',
    'parseCookie',
    'cookieParser',
    'Set-Cookie',
    'Basic ',
    'Bearer ',
    'password=',
    'token=',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 78 source excludes ${forbidden}`);
});

test('operator UI local auth boundary - Phase 79 is selected contract-only and not-implemented', () => {
  assert(exists('src/ops/operator-ui-local-auth-boundary.ts'), 'Phase 79 local auth boundary source exists');
  assert(exists('src/ops/operator-ui-local-auth-boundary-cli.ts'), 'Phase 79 local auth boundary CLI exists');
  assert(exists('docs/PHASE_79_OPERATOR_UI_LOCAL_AUTH_BOUNDARY.md'), 'Phase 79 local auth boundary doc exists');
  assert(exists('test/operator-ui-local-auth-boundary.ts'), 'Phase 79 local auth boundary suite exists');
  assert(typeof pkg.scripts['test:operator-ui-local-auth-boundary'] === 'string', 'Phase 79 test script present');
  assert(typeof pkg.scripts['ops:operator-ui-local-auth-boundary'] === 'string', 'Phase 79 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-packet-endpoint-route-dry-run.ts && tsx test/operator-ui-local-auth-boundary.ts'),
    'Phase 79 suite follows Phase 78 packet endpoint route dry-run in CI chain',
  );

  const source = read('src/ops/operator-ui-local-auth-boundary.ts');
  const cli = read('src/ops/operator-ui-local-auth-boundary-cli.ts');
  const suite = read('test/operator-ui-local-auth-boundary.ts');
  const doc = read('docs/PHASE_79_OPERATOR_UI_LOCAL_AUTH_BOUNDARY.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${readme}`;

  for (const kw of [
    'Local Auth Boundary Selection',
    'operator UI local auth boundary',
    'ops:operator-ui-local-auth-boundary',
    'test:operator-ui-local-auth-boundary',
    'npm run --silent ops:operator-ui-local-auth-boundary -- -- --json',
    'operator-ui-local-auth-boundary',
    'phase-79.v1',
    'OPERATOR_UI_LOCAL_AUTH_BOUNDARY_REPORTED',
    'blocked',
    'auth-boundary-selection-only',
    'not-implemented',
    'local-operator-secret-file-with-explicit-path-and-redacted-evidence',
    'selected-for-future-review/not-implemented',
    'reverse-proxy-forward-auth-attestation',
    'mTLS-or-local-network-attestation',
    'browser-cookie-session',
    'bearer-token-api',
    'rejected-for-first-implementation',
    '127.0.0.1 fixture preview only',
    'remoteExposure',
    'explicit operator-provided file path only in a later reviewed phase',
    'no default secret path',
    'no environment variable secret value',
    'no CLI argument secret value',
    '<= 4096 bytes',
    'trim one trailing newline only',
    'reject empty or whitespace-only values',
    'reject values below minimum entropy or length',
    'constant-time comparison',
    'never log, echo, persist, hash-output, or include the secret value in evidence',
    'redaction-safe errors only',
    'loopback-only use unless a later reviewed remote access model exists',
    'no browser storage, cookie/session token, bearer/basic auth, or OAuth/Sso',
    '/login',
    '/auth',
    '/session',
    '/token',
    '/callback',
    '/logout',
    '/oauth',
    '/sso',
    '/admin',
    '/api/packets',
    '/packets',
    '/packet',
    '/operator-packets',
    'GET /, GET /healthz, GET /manifest.json',
    'Phase 74 auth contract remains contract-only and not-implemented',
    'Phase 75 readiness remains not-ready',
    'Phase 76 limits remain contract-only and not-implemented',
    'Phase 77 evidence gate remains blocked and evidence-required',
    'Phase 78 route dry-run remains blocked and dry-run-plan-only',
    'O4/O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness only',
    'Provider availability remains packet/count/advisory only',
    'no auth/runtime/route/provider/UI/data expansion is added',
  ]) assert(combined.includes(kw), `Phase 79 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'TorBox',
    'Plex',
    'Jellyfin',
    'Hermes',
    'writeFile',
    'createWriteStream',
    'createServer',
    'server.listen',
    'req.headers',
    'res.end',
    'app.get',
    'router.',
    '.headers.authorization',
    "headers['authorization']",
    'getHeader',
    'setHeader',
    'parseCookie',
    'cookieParser',
    'Set-Cookie',
    'Basic ',
    'Bearer ',
    'password=',
    'token=',
    'timingSafeEqual',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 79 source excludes ${forbidden}`);
});

test('operator UI local auth secret file preflight - Phase 80 is descriptor-only and not-implemented', () => {
  assert(exists('src/ops/operator-ui-local-auth-secret-file-preflight.ts'), 'Phase 80 local auth secret file preflight source exists');
  assert(exists('src/ops/operator-ui-local-auth-secret-file-preflight-cli.ts'), 'Phase 80 local auth secret file preflight CLI exists');
  assert(exists('docs/PHASE_80_OPERATOR_UI_LOCAL_AUTH_SECRET_FILE_PREFLIGHT.md'), 'Phase 80 local auth secret file preflight doc exists');
  assert(exists('test/operator-ui-local-auth-secret-file-preflight.ts'), 'Phase 80 local auth secret file preflight suite exists');
  assert(typeof pkg.scripts['test:operator-ui-local-auth-secret-file-preflight'] === 'string', 'Phase 80 test script present');
  assert(typeof pkg.scripts['ops:operator-ui-local-auth-secret-file-preflight'] === 'string', 'Phase 80 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-local-auth-boundary.ts && tsx test/operator-ui-local-auth-secret-file-preflight.ts'),
    'Phase 80 suite follows Phase 79 local auth boundary in CI chain',
  );

  const source = read('src/ops/operator-ui-local-auth-secret-file-preflight.ts');
  const cli = read('src/ops/operator-ui-local-auth-secret-file-preflight-cli.ts');
  const suite = read('test/operator-ui-local-auth-secret-file-preflight.ts');
  const doc = read('docs/PHASE_80_OPERATOR_UI_LOCAL_AUTH_SECRET_FILE_PREFLIGHT.md');
  const readme = read('README.md');
  const combined = `${source}\n${cli}\n${suite}\n${doc}\n${readme}`;

  for (const kw of [
    'Local Auth Secret File Preflight',
    'operator UI local auth secret-file preflight',
    'ops:operator-ui-local-auth-secret-file-preflight',
    'test:operator-ui-local-auth-secret-file-preflight',
    'npm run --silent ops:operator-ui-local-auth-secret-file-preflight -- -- <descriptor.json> --json',
    'operator-ui-local-auth-secret-file-preflight',
    'phase-80.v1',
    'OPERATOR_UI_LOCAL_AUTH_SECRET_FILE_PREFLIGHT_REPORTED',
    'ready-for-review/preflight-only',
    'blocked/preflight-only',
    'authImplementation',
    'not-implemented',
    'runtime auth remains blocked',
    'local-operator-secret-file-with-explicit-path-and-redacted-evidence',
    'single explicit operator JSON descriptor file',
    'descriptor path is never echoed',
    'descriptor values are never echoed',
    'future secret file path is not read',
    'future secret path is not validated against the filesystem',
    'operatorFilePathProvided',
    'defaultPathDisabled',
    'envSecretValueDisabled',
    'cliSecretValueDisabled',
    'maxSecretFileBytes',
    '<= 4096',
    'trimOneTrailingNewlineOnly',
    'rejectEmptyOrWhitespace',
    'rejectLowEntropyOrShort',
    'constantTimeComparisonPlanned',
    'secretNeverLoggedOrPersisted',
    'redactionSafeErrors',
    'loopbackOnly',
    'browserStorageCookieSessionBearerBasicOAuthDisabled',
    'reviewerGoRecorded',
    'operatorAcceptanceRecorded',
    'secretValue',
    'secretPath',
    'databaseUrl',
    'packetContents',
    'artifactContents',
    'DESCRIPTOR_FILE_REQUIRED',
    'DESCRIPTOR_FILE_READ_FAILED',
    'DESCRIPTOR_JSON_MALFORMED',
    'DESCRIPTOR_OBJECT_REQUIRED',
    'DESCRIPTOR_FILE_IS_DIRECTORY',
    'DESCRIPTOR_FILE_TOO_LARGE',
    'GET /, GET /healthz, GET /manifest.json',
    'no auth/runtime/route/provider/UI/data expansion is added',
  ]) assert(combined.includes(kw), `Phase 80 covers ${kw}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'TorBox',
    'Plex',
    'Jellyfin',
    'Hermes',
    'writeFile',
    'createWriteStream',
    'createServer',
    'server.listen',
    'req.headers',
    'res.end',
    'app.get',
    'router.',
    '.headers.authorization',
    "headers['authorization']",
    'getHeader',
    'setHeader',
    'parseCookie',
    'cookieParser',
    'Set-Cookie',
    'Basic ',
    'Bearer ',
    'password=',
    'token=',
    'timingSafeEqual',
  ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 80 source excludes ${forbidden}`);

  assert(!source.includes('node:fs'), 'Phase 80 pure module has no fs import');
  assert(cli.includes("from 'node:fs'"), 'Phase 80 CLI has bounded descriptor file read capability');
  assert(cli.includes('MAX_DESCRIPTOR_BYTES = 16 * 1024'), 'Phase 80 CLI descriptor read is bounded');
});

test('Phase 81 operator UI auth packet runtime is documented and bounded', () => {
  const combined = `${read('docs/PHASE_81_OPERATOR_UI_AUTH_PACKET_RUNTIME.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const kw of [
    'Phase 81',
    'Local Auth + Sanitized Packet Endpoint + UI Runtime Connection',
    'operator UI auth packet runtime',
    'test:operator-ui-auth-packet-runtime',
    'ops:operator-ui-static-runtime',
    '--operator-secret-file <path>',
    'X-Operator-UI-Secret',
    'GET /operator-ui/packets.json',
    'local-secret-file-enabled',
    'sanitized-local-packet-endpoint',
    'synthetic-fixture-only',
    'no cookies, sessions, bearer/basic auth, OAuth, localStorage, sessionStorage, persistent browser secret storage, query-string secrets, or URL secrets',
    'No DB reads',
    'no provider/debrid/Plex/Jellyfin/Hermes calls',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `Phase 81 covers ${kw}`);

  const source = [
    read('src/ops/operator-ui-static-runtime.ts'),
    read('src/ops/operator-ui-static-runtime-cli.ts'),
    read('src/ops/operator-ui-local-auth-runtime.ts'),
    read('src/ops/operator-ui-packet-endpoint.ts'),
  ].join('\n');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'Plex',
    'Jellyfin',
    'Hermes',
    'writeFile',
    'createWriteStream',
  ]) assert(!source.includes(forbidden), `Phase 81 source excludes ${forbidden}`);
});

test('Phase 82 operator UI auth packet acceptance evidence is documented and bounded', () => {
  const combined = `${read('docs/PHASE_82_OPERATOR_UI_AUTH_PACKET_ACCEPTANCE.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const kw of [
    'Phase 82',
    'Operator UI Auth Packet Acceptance Evidence',
    'operator UI auth packet acceptance',
    'ops:operator-ui-auth-packet-acceptance',
    'test:operator-ui-auth-packet-acceptance',
    'npm run --silent ops:operator-ui-auth-packet-acceptance -- -- --json',
    'operator-ui-auth-packet-acceptance',
    'phase-82.v1',
    'OPERATOR_UI_AUTH_PACKET_ACCEPTANCE_REPORTED',
    'accepted',
    'blocked',
    'local-loopback-fixture-only',
    'local-secret-file-enabled',
    'sanitized-local-packet-endpoint',
    'synthetic-fixture-only',
    'counts only',
    'fixed 404',
    'fixed 401',
    'fixed 405',
    'hash-pinned inline script',
    'same-origin connect',
    'No DB reads',
    'no provider or debrid integrations',
    'no live source, scraping, download, playback, or media-server behavior',
    'No user-provided secret values or user-provided secret paths',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness only, not production KMS',
  ]) assert(combined.includes(kw), `Phase 82 covers ${kw}`);

  const source = [
    read('src/ops/operator-ui-auth-packet-acceptance.ts'),
    read('src/ops/operator-ui-auth-packet-acceptance-cli.ts'),
  ].join('\n');
  assert(source.includes("from 'node:http'"), 'Phase 82 uses built-in local HTTP probing');
  assert(source.includes("from 'node:net'"), 'Phase 82 uses built-in raw loopback probing');
  assert(source.includes("from 'node:fs'"), 'Phase 82 uses bounded temporary secret file handling');
  assert(source.includes('mkdtempSync'), 'Phase 82 creates temporary secret file directory');
  assert(source.includes('rmSync(context.tempDir'), 'Phase 82 removes temporary secret file directory');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'TRUNCATE',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
    'cookieParser',
    'parseCookie',
    '.headers.authorization',
    "headers['authorization']",
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'TorBox',
    'Plex',
    'Jellyfin',
    'Hermes',
    'createWriteStream',
  ]) assert(!source.includes(forbidden), `Phase 82 source excludes ${forbidden}`);
});

test('Phase 83 launch gate audit is static and preserves launch blockers', () => {
  const combined = `${read('docs/PHASE_83_LAUNCH_GATE_AUDIT.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const kw of [
    'Phase 83',
    'Launch Gate Audit',
    'ops:launch-gate-audit',
    'test:launch-gate-audit',
    'npm run --silent ops:launch-gate-audit -- -- --json',
    'LAUNCH_GATE_AUDIT_REPORTED',
    'steps-1-2-3-launch-gap-audit',
    'launchReady: false',
    'status: blocked',
    'O4',
    'O5',
    'production security gates',
    'operator launch rehearsal',
    'real service validation',
    'TorBox',
    'Jellyfin',
    'Usenet',
    'No DB reads',
    'does not close O4 or O5',
    'FileCustodian remains a hardened reference harness only',
  ]) assert(combined.includes(kw), `Phase 83 covers ${kw}`);

  assert(exists('src/ops/launch-gate-audit.ts'), 'Phase 83 launch gate audit source exists');
  assert(exists('src/ops/launch-gate-audit-cli.ts'), 'Phase 83 launch gate audit CLI exists');
  assert(exists('test/launch-gate-audit.ts'), 'Phase 83 launch gate audit test exists');
  assert(pkg.scripts['ops:launch-gate-audit'] === 'tsx src/ops/launch-gate-audit-cli.ts', 'Phase 83 ops script present');
  assert(pkg.scripts['test:launch-gate-audit'] === 'tsx test/launch-gate-audit.ts', 'Phase 83 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-auth-packet-acceptance.ts && tsx test/launch-gate-audit.ts'),
    'Phase 83 aggregate test follows Phase 82',
  );

  const source = [
    read('src/ops/launch-gate-audit.ts'),
    read('src/ops/launch-gate-audit-cli.ts'),
  ].join('\n');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:dns',
    'node:fs',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'TRUNCATE',
    'readFile',
    'writeFile',
    'createWriteStream',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
  ]) assert(!source.includes(forbidden), `Phase 83 source excludes ${forbidden}`);
});

test('Phase 84 operator acceptance packet is static and preserves launch blockers', () => {
  const combined = `${read('docs/PHASE_84_OPERATOR_ACCEPTANCE_PACKET.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const kw of [
    'Phase 84',
    'Operator Acceptance Packet',
    'ops:operator-acceptance-packet',
    'test:operator-acceptance-packet',
    'npm run --silent ops:operator-acceptance-packet -- -- --json',
    'OPERATOR_ACCEPTANCE_PACKET_REPORTED',
    'operator-run-redaction-safe-launch-acceptance',
    'launchReady: false',
    'status: blocked',
    'O4',
    'O5',
    'FileCustodian',
    'Unraid',
    'TorBox',
    'Jellyfin',
    'Usenet',
    'No DB reads',
    'No launch approval',
    'No network calls or live service contact',
  ]) assert(combined.includes(kw), `Phase 84 covers ${kw}`);

  assert(exists('src/ops/operator-acceptance-packet.ts'), 'Phase 84 operator acceptance packet source exists');
  assert(exists('src/ops/operator-acceptance-packet-cli.ts'), 'Phase 84 operator acceptance packet CLI exists');
  assert(exists('test/operator-acceptance-packet.ts'), 'Phase 84 operator acceptance packet test exists');
  assert(pkg.scripts['ops:operator-acceptance-packet'] === 'tsx src/ops/operator-acceptance-packet-cli.ts', 'Phase 84 ops script present');
  assert(pkg.scripts['test:operator-acceptance-packet'] === 'tsx test/operator-acceptance-packet.ts', 'Phase 84 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/launch-gate-audit.ts && tsx test/operator-acceptance-packet.ts'),
    'Phase 84 aggregate test follows Phase 83',
  );

  const source = [
    read('src/ops/operator-acceptance-packet.ts'),
    read('src/ops/operator-acceptance-packet-cli.ts'),
  ].join('\n');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:dns',
    'node:fs',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'TRUNCATE',
    'readFile',
    'writeFile',
    'createWriteStream',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
  ]) assert(!source.includes(forbidden), `Phase 84 source excludes ${forbidden}`);
});

test('Phase 85 launch decision record preflight is bounded and never approves launch', () => {
  const combined = `${read('docs/PHASE_85_LAUNCH_DECISION_RECORD.md')}\n${read('README.md')}\n${read('package.json')}\n${read('test/deploy.ts')}`;
  for (const kw of [
    'Phase 85',
    'Launch Decision Record',
    'ops:launch-decision-record',
    'test:launch-decision-record',
    'npm run --silent ops:launch-decision-record -- -- <decision-record.json> --json',
    'phase-85-launch-decision-record',
    'phase-85-launch-decision-record-preflight',
    'single-operator-supplied-launch-decision-record-json-file',
    'phase-84-operator-acceptance-packet',
    'launchApproved: false',
    'productionReady: false',
    'O4',
    'O5',
    'FileCustodian',
    'No launch approval',
    'No evidence directory scanning',
    'No credential, environment, or database reads',
    'No network calls or live service contact',
  ]) assert(combined.includes(kw), `Phase 85 covers ${kw}`);

  assert(exists('docs/PHASE_85_LAUNCH_DECISION_RECORD.md'), 'Phase 85 launch decision doc exists');
  assert(exists('src/ops/launch-decision-record.ts'), 'Phase 85 pure launch decision source exists');
  assert(exists('src/ops/launch-decision-record-cli.ts'), 'Phase 85 launch decision CLI exists');
  assert(exists('test/launch-decision-record.ts'), 'Phase 85 launch decision test exists');
  assert(pkg.scripts['ops:launch-decision-record'] === 'tsx src/ops/launch-decision-record-cli.ts', 'Phase 85 ops script present');
  assert(pkg.scripts['test:launch-decision-record'] === 'tsx test/launch-decision-record.ts', 'Phase 85 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-acceptance-packet.ts && tsx test/launch-decision-record.ts'),
    'Phase 85 aggregate test follows Phase 84',
  );

  const pureSource = read('src/ops/launch-decision-record.ts');
  const cliSource = read('src/ops/launch-decision-record-cli.ts');
  const source = `${pureSource}\n${cliSource}`;
  assert(!pureSource.includes("from 'node:fs'"), 'Phase 85 pure module has no filesystem dependency');
  assert(cliSource.includes("from 'node:fs'"), 'Phase 85 CLI has explicit bounded file read dependency');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'TRUNCATE',
    'readFile',
    'writeFile',
    'createWriteStream',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
  ]) assert(!source.includes(forbidden), `Phase 85 source excludes ${forbidden}`);

  for (const required of [
    'launchApproved: false',
    'productionReady: false',
    'closesO4: false',
    'closesO5: false',
    'recordValuesEchoed: false',
    'artifactContentsIncluded: false',
    'credentialValuesIncluded: false',
    'credentialPathsIncluded: false',
    'rawRefsIncluded: false',
    'providerPayloadsIncluded: false',
    'liveServiceContact: false',
    'commandExecution: false',
  ]) assert(source.includes(required), `Phase 85 source preserves ${required}`);
});

test('Phase 86 launch candidate scope freeze is static and forbids runtime expansion', () => {
  const combined = `${read('docs/PHASE_86_LAUNCH_CANDIDATE_SCOPE_FREEZE.md')}\n${read('README.md')}\n${read('package.json')}\n${read('test/deploy.ts')}`;
  for (const kw of [
    'Phase 86',
    'Launch Candidate Scope Freeze',
    'ops:launch-candidate-scope-freeze',
    'test:launch-candidate-scope-freeze',
    'npm run --silent ops:launch-candidate-scope-freeze -- -- --json',
    'phase-86-launch-candidate-scope-freeze',
    'LAUNCH_CANDIDATE_SCOPE_FREEZE_REPORTED',
    'phase-85-launch-decision-record-preflight',
    'phase-84-operator-acceptance-packet',
    'launchApproved: false',
    'productionReady: false',
    'closesO4: false',
    'closesO5: false',
    'blocked-pending-operator-decision',
    'No launch approval',
    'No network calls or live service contact',
    'FileCustodian',
  ]) assert(combined.includes(kw), `Phase 86 covers ${kw}`);

  assert(exists('docs/PHASE_86_LAUNCH_CANDIDATE_SCOPE_FREEZE.md'), 'Phase 86 launch candidate scope doc exists');
  assert(exists('src/ops/launch-candidate-scope-freeze.ts'), 'Phase 86 scope freeze source exists');
  assert(exists('src/ops/launch-candidate-scope-freeze-cli.ts'), 'Phase 86 scope freeze CLI exists');
  assert(exists('test/launch-candidate-scope-freeze.ts'), 'Phase 86 scope freeze test exists');
  assert(pkg.scripts['ops:launch-candidate-scope-freeze'] === 'tsx src/ops/launch-candidate-scope-freeze-cli.ts', 'Phase 86 ops script present');
  assert(pkg.scripts['test:launch-candidate-scope-freeze'] === 'tsx test/launch-candidate-scope-freeze.ts', 'Phase 86 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/launch-decision-record.ts && tsx test/launch-candidate-scope-freeze.ts'),
    'Phase 86 aggregate test follows Phase 85',
  );

  const source = [
    read('src/ops/launch-candidate-scope-freeze.ts'),
    read('src/ops/launch-candidate-scope-freeze-cli.ts'),
  ].join('\n');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:dns',
    'node:fs',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'TRUNCATE',
    'readFile',
    'writeFile',
    'createWriteStream',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
  ]) assert(!source.includes(forbidden), `Phase 86 source excludes ${forbidden}`);

  for (const required of [
    'launchApproved: false',
    'productionReady: false',
    'closesO4: false',
    'closesO5: false',
    'No launch approval.',
    'No production-readiness approval.',
    'No O4 closure.',
    'No O5 closure.',
    'No network calls or live service contact.',
  ]) assert(source.includes(required), `Phase 86 source preserves ${required}`);
});

test('Phase 87 launch candidate metadata packet is static and approval-free', () => {
  const combined = `${read('docs/PHASE_87_LAUNCH_CANDIDATE_METADATA_PACKET.md')}\n${read('README.md')}\n${read('package.json')}\n${read('test/deploy.ts')}`;
  for (const kw of [
    'Phase 87',
    'Launch Candidate Metadata Packet',
    'ops:launch-candidate-metadata-packet',
    'test:launch-candidate-metadata-packet',
    'npm run --silent ops:launch-candidate-metadata-packet -- -- --json',
    'phase-87-launch-candidate-metadata-packet',
    'LAUNCH_CANDIDATE_METADATA_PACKET_REPORTED',
    'phase-86-launch-candidate-scope-freeze',
    'phase-85-launch-decision-record-preflight',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'closesO4: false',
    'closesO5: false',
    'No launch approval',
    'No network calls or live service contact',
    'FileCustodian',
  ]) assert(combined.includes(kw), `Phase 87 covers ${kw}`);

  assert(exists('docs/PHASE_87_LAUNCH_CANDIDATE_METADATA_PACKET.md'), 'Phase 87 metadata packet doc exists');
  assert(exists('src/ops/launch-candidate-metadata-packet.ts'), 'Phase 87 metadata packet source exists');
  assert(exists('src/ops/launch-candidate-metadata-packet-cli.ts'), 'Phase 87 metadata packet CLI exists');
  assert(exists('test/launch-candidate-metadata-packet.ts'), 'Phase 87 metadata packet test exists');
  assert(pkg.scripts['ops:launch-candidate-metadata-packet'] === 'tsx src/ops/launch-candidate-metadata-packet-cli.ts', 'Phase 87 ops script present');
  assert(pkg.scripts['test:launch-candidate-metadata-packet'] === 'tsx test/launch-candidate-metadata-packet.ts', 'Phase 87 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/launch-candidate-scope-freeze.ts && tsx test/launch-candidate-metadata-packet.ts'),
    'Phase 87 aggregate test follows Phase 86',
  );

  const source = [
    read('src/ops/launch-candidate-metadata-packet.ts'),
    read('src/ops/launch-candidate-metadata-packet-cli.ts'),
  ].join('\n');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:dns',
    'node:fs',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'TRUNCATE',
    'readFile',
    'writeFile',
    'createWriteStream',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
  ]) assert(!source.includes(forbidden), `Phase 87 source excludes ${forbidden}`);

  for (const required of [
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'closesO4: false',
    'closesO5: false',
    'commit-id-label',
    'tag-name-label',
    'reviewer-verdict-label',
    'pass-warn-fail-count-label',
    'No launch approval.',
    'No production-readiness approval.',
    'No release-candidate approval.',
    'No O4 closure.',
    'No O5 closure.',
    'No network calls or live service contact.',
  ]) assert(source.includes(required), `Phase 87 source preserves ${required}`);

  for (const forbidden of [
    ['Allowed labels include commit', 'ids'].join(' '),
    ['reviewer verdicts, and pass/warn/fail', 'counts'].join(' '),
    ['reviewed', 'conclusions'].join(' '),
    ['Retain only pass/warn/fail', 'counts'].join(' '),
    ['validation', 'conclusions'].join(' '),
    ['Record whether Usenet', 'fallback'].join('/'),
    ['Record the exact master', 'commit'].join(' '),
    ['Record whether O4 and O5 are', 'proven'].join(' '),
    ['reviewer GO/HOLD', 'label'].join(' '),
  ]) assert(!source.includes(forbidden) && !combined.includes(forbidden), `Phase 87 excludes broad metadata allowance ${forbidden}`);
});

test('Phase 88 launch candidate review checklist is static and approval-free', () => {
  assert(exists('docs/PHASE_88_LAUNCH_CANDIDATE_REVIEW_CHECKLIST.md'), 'Phase 88 review checklist doc exists');
  assert(exists('src/ops/launch-candidate-review-checklist.ts'), 'Phase 88 review checklist source exists');
  assert(exists('src/ops/launch-candidate-review-checklist-cli.ts'), 'Phase 88 review checklist CLI exists');
  assert(exists('test/launch-candidate-review-checklist.ts'), 'Phase 88 review checklist test exists');
  assert(pkg.scripts['ops:launch-candidate-review-checklist'] === 'tsx src/ops/launch-candidate-review-checklist-cli.ts', 'Phase 88 ops script present');
  assert(pkg.scripts['test:launch-candidate-review-checklist'] === 'tsx test/launch-candidate-review-checklist.ts', 'Phase 88 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/launch-candidate-metadata-packet.ts && tsx test/launch-candidate-review-checklist.ts'),
    'Phase 88 aggregate test follows Phase 87',
  );

  const source = [
    read('src/ops/launch-candidate-review-checklist.ts'),
    read('src/ops/launch-candidate-review-checklist-cli.ts'),
  ].join('\n');
  const phase88Surface = [
    source,
    read('docs/PHASE_88_LAUNCH_CANDIDATE_REVIEW_CHECKLIST.md'),
  ].join('\n');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:dns',
    'node:fs',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'TRUNCATE',
    'readFile',
    'writeFile',
    'createWriteStream',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
  ]) assert(!source.includes(forbidden), `Phase 88 source excludes ${forbidden}`);

  for (const required of [
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'closesO4: false',
    'closesO5: false',
    'hold-pending-human-review',
    'phase-87-launch-candidate-metadata-packet',
    'launch-candidate-metadata.redacted.json',
    'phase-86-launch-candidate-scope-freeze',
    'commit-id-label',
    'tag-name-label',
    'o4-decision-label',
    'o5-decision-label',
    'filecustodian-boundary-label',
    'packet-retains-actual-values',
    'No launch approval.',
    'No production-readiness approval.',
    'No release-candidate approval.',
    'No O4 closure.',
    'No O5 closure.',
    'No network calls or live service contact.',
  ]) assert(source.includes(required), `Phase 88 source preserves ${required}`);

  for (const forbidden of [
    'phase-87-launch-candidate-metadata.redacted.json',
    ['actual commit id is', 'allowed'].join(' '),
    ['launchApproved:', 'true'].join(' '),
    ['productionReady:', 'true'].join(' '),
    ['releaseCandidateApproved:', 'true'].join(' '),
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
  ]) assert(!source.includes(forbidden) && !phase88Surface.includes(forbidden), `Phase 88 excludes approval or value allowance ${forbidden}`);
});

test('Phase 89 launch candidate review handoff is static and approval-free', () => {
  assert(exists('docs/PHASE_89_LAUNCH_CANDIDATE_REVIEW_HANDOFF.md'), 'Phase 89 review handoff doc exists');
  assert(exists('src/ops/launch-candidate-review-handoff.ts'), 'Phase 89 review handoff source exists');
  assert(exists('src/ops/launch-candidate-review-handoff-cli.ts'), 'Phase 89 review handoff CLI exists');
  assert(exists('test/launch-candidate-review-handoff.ts'), 'Phase 89 review handoff test exists');
  assert(pkg.scripts['ops:launch-candidate-review-handoff'] === 'tsx src/ops/launch-candidate-review-handoff-cli.ts', 'Phase 89 ops script present');
  assert(pkg.scripts['test:launch-candidate-review-handoff'] === 'tsx test/launch-candidate-review-handoff.ts', 'Phase 89 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/launch-candidate-review-checklist.ts && tsx test/launch-candidate-review-handoff.ts'),
    'Phase 89 aggregate test follows Phase 88',
  );

  const source = [
    read('src/ops/launch-candidate-review-handoff.ts'),
    read('src/ops/launch-candidate-review-handoff-cli.ts'),
  ].join('\n');
  const phase89Doc = read('docs/PHASE_89_LAUNCH_CANDIDATE_REVIEW_HANDOFF.md');
  const phase89Surface = `${source}\n${phase89Doc}`;
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:dns',
    'node:fs',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'TRUNCATE',
    'readFile',
    'writeFile',
    'createWriteStream',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
  ]) assert(!source.includes(forbidden), `Phase 89 source excludes ${forbidden}`);

  for (const required of [
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'closesO4: false',
    'closesO5: false',
    'awaiting-independent-review',
    'phase-88-launch-candidate-review-checklist',
    'phase-87-launch-candidate-metadata-packet',
    'launch-candidate-metadata.redacted.json',
    'reviewer-go-label',
    'reviewer-hold-label',
    'o4-decision-label',
    'o5-decision-label',
    'filecustodian-boundary-label',
    'No launch approval.',
    'No production-readiness approval.',
    'No release-candidate approval.',
    'No O4 closure.',
    'No O5 closure.',
    'No network calls or live service contact.',
  ]) assert(source.includes(required), `Phase 89 source preserves ${required}`);

  for (const forbidden of [
    'phase-87-launch-candidate-metadata.redacted.json',
    ['actual commit id is', 'allowed'].join(' '),
    ['launchApproved:', 'true'].join(' '),
    ['productionReady:', 'true'].join(' '),
    ['releaseCandidateApproved:', 'true'].join(' '),
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
  ]) assert(!phase89Surface.includes(forbidden), `Phase 89 excludes approval or value allowance ${forbidden}`);

  for (const forbidden of [
    ['closed', 'without'].join(' '),
    ['residual-risk', 'acceptance'].join(' '),
    ['separately reviewed', 'evidence'].join(' '),
  ]) assert(!phase89Surface.includes(forbidden), `Phase 89 source/docs exclude O4/O5 exception ${forbidden}`);
});

test('Phase 90 final launch disposition is static and approval-free', () => {
  assert(exists('docs/PHASE_90_FINAL_LAUNCH_DISPOSITION.md'), 'Phase 90 final launch disposition doc exists');
  assert(exists('src/ops/final-launch-disposition.ts'), 'Phase 90 final launch disposition source exists');
  assert(exists('src/ops/final-launch-disposition-cli.ts'), 'Phase 90 final launch disposition CLI exists');
  assert(exists('test/final-launch-disposition.ts'), 'Phase 90 final launch disposition test exists');
  assert(pkg.scripts['ops:final-launch-disposition'] === 'tsx src/ops/final-launch-disposition-cli.ts', 'Phase 90 ops script present');
  assert(pkg.scripts['test:final-launch-disposition'] === 'tsx test/final-launch-disposition.ts', 'Phase 90 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/launch-candidate-review-handoff.ts && tsx test/final-launch-disposition.ts'),
    'Phase 90 aggregate test follows Phase 89',
  );

  const source = [
    read('src/ops/final-launch-disposition.ts'),
    read('src/ops/final-launch-disposition-cli.ts'),
  ].join('\n');
  const phase90Doc = read('docs/PHASE_90_FINAL_LAUNCH_DISPOSITION.md');
  const phase90Surface = `${source}\n${phase90Doc}`;
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:dns',
    'node:fs',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'TRUNCATE',
    'readFile',
    'writeFile',
    'createWriteStream',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
  ]) assert(!source.includes(forbidden), `Phase 90 source excludes ${forbidden}`);

  for (const required of [
    "launchDecision: 'hold'",
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'closesO4: false',
    'closesO5: false',
    'closesGate: false',
    'hold-pending-operator-decision',
    'phase-89-launch-candidate-review-handoff',
    'phase-88-launch-candidate-review-checklist',
    'operator-final-decision-label',
    'o4-disposition-label',
    'o5-disposition-label',
    'residual-risk-acceptance-label',
    'No launch approval.',
    'No production-readiness approval.',
    'No release-candidate approval.',
    'No O4 closure.',
    'No O5 closure.',
    'No network calls or live service contact.',
  ]) assert(source.includes(required), `Phase 90 source preserves ${required}`);

  for (const forbidden of [
    ['launchApproved:', 'true'].join(' '),
    ['productionReady:', 'true'].join(' '),
    ['releaseCandidateApproved:', 'true'].join(' '),
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
    ['closesGate:', 'true'].join(' '),
    ['actual commit id is', 'allowed'].join(' '),
  ]) assert(!phase90Surface.includes(forbidden), `Phase 90 excludes approval, closure, or value allowance ${forbidden}`);
});

test('Phase 91 production-time decision requests launch-candidate review without approval or gate closure', () => {
  assert(exists('docs/PHASE_91_PRODUCTION_TIME_DECISION.md'), 'Phase 91 production-time decision doc exists');
  assert(exists('src/ops/production-time-decision.ts'), 'Phase 91 production-time decision source exists');
  assert(exists('src/ops/production-time-decision-cli.ts'), 'Phase 91 production-time decision CLI exists');
  assert(exists('test/production-time-decision.ts'), 'Phase 91 production-time decision test exists');
  assert(pkg.scripts['ops:production-time-decision'] === 'tsx src/ops/production-time-decision-cli.ts', 'Phase 91 ops script present');
  assert(pkg.scripts['test:production-time-decision'] === 'tsx test/production-time-decision.ts', 'Phase 91 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/final-launch-disposition.ts && tsx test/production-time-decision.ts'),
    'Phase 91 aggregate test follows Phase 90',
  );

  const source = [
    read('src/ops/production-time-decision.ts'),
    read('src/ops/production-time-decision-cli.ts'),
  ].join('\n');
  const phase91Doc = read('docs/PHASE_91_PRODUCTION_TIME_DECISION.md');
  const combined = [
    source,
    phase91Doc,
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:dns',
    'node:fs',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'TRUNCATE',
    'readFile',
    'writeFile',
    'createWriteStream',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
  ]) assert(!source.includes(forbidden), `Phase 91 source excludes ${forbidden}`);

  for (const required of [
    'launchCandidateRequested: true',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'closesO4: false',
    'closesO5: false',
    'residualRiskAccepted: true',
    'launch-candidate-requested-with-deferred-risk-accepted',
    'phase-90-final-launch-disposition',
    'phase-89-launch-candidate-review-handoff',
    'phase-22-production-readiness-gate',
    'operator-accepted-deferred-risk',
    'turnkey production ready',
    'O4 is not closed',
    'O5 is not closed',
    'No launch approval.',
    'No production-readiness approval.',
    'No release-candidate approval.',
    'No O4 closure.',
    'No O5 closure.',
    'No network calls or live service contact.',
  ]) assert(combined.includes(required), `Phase 91 surface preserves ${required}`);

  for (const forbidden of [
    ['launchApproved:', 'true'].join(' '),
    ['productionReady:', 'true'].join(' '),
    ['releaseCandidateApproved:', 'true'].join(' '),
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
    ['closesGate:', 'true'].join(' '),
  ]) assert(!source.includes(forbidden), `Phase 91 excludes approval or closure ${forbidden}`);
});

test('Phase 92 launch candidate seal is static and does not approve production release', () => {
  assert(exists('docs/PHASE_92_LAUNCH_CANDIDATE_SEAL.md'), 'Phase 92 launch candidate seal doc exists');
  assert(exists('src/ops/launch-candidate-seal.ts'), 'Phase 92 launch candidate seal source exists');
  assert(exists('src/ops/launch-candidate-seal-cli.ts'), 'Phase 92 launch candidate seal CLI exists');
  assert(exists('test/launch-candidate-seal.ts'), 'Phase 92 launch candidate seal test exists');
  assert(pkg.scripts['ops:launch-candidate-seal'] === 'tsx src/ops/launch-candidate-seal-cli.ts', 'Phase 92 ops script present');
  assert(pkg.scripts['test:launch-candidate-seal'] === 'tsx test/launch-candidate-seal.ts', 'Phase 92 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/production-time-decision.ts && tsx test/launch-candidate-seal.ts'),
    'Phase 92 aggregate test follows Phase 91',
  );

  const source = [
    read('src/ops/launch-candidate-seal.ts'),
    read('src/ops/launch-candidate-seal-cli.ts'),
  ].join('\n');
  const phase92Doc = read('docs/PHASE_92_LAUNCH_CANDIDATE_SEAL.md');
  const combined = [
    source,
    phase92Doc,
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:dns',
    'node:fs',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'TRUNCATE',
    'readFile',
    'writeFile',
    'createWriteStream',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
  ]) assert(!source.includes(forbidden), `Phase 92 source excludes ${forbidden}`);

  for (const required of [
    'launchCandidateSealed: true',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'releaseApproved: false',
    'closesO4: false',
    'closesO5: false',
    'residualRiskAccepted: true',
    'sealed-for-launch-candidate-review',
    'phase-91-production-time-decision',
    'phase-90-final-launch-disposition',
    'phase-89-launch-candidate-review-handoff',
    'launch-candidate-1',
    'phase-92',
    'production release approved',
    'O4 still needs',
    'O5 still needs',
    'No launch approval.',
    'No production-readiness approval.',
    'No release-candidate approval.',
    'No production release approval.',
    'No O4 closure.',
    'No O5 closure.',
    'No network calls or live service contact.',
  ]) assert(combined.includes(required), `Phase 92 surface preserves ${required}`);

  for (const forbidden of [
    ['launchApproved:', 'true'].join(' '),
    ['productionReady:', 'true'].join(' '),
    ['releaseCandidateApproved:', 'true'].join(' '),
    ['releaseApproved:', 'true'].join(' '),
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
  ]) assert(!source.includes(forbidden), `Phase 92 excludes approval or closure ${forbidden}`);
});

test('Phase 93 semi-launch validation packet is static and defaults to HOLD', () => {
  assert(exists('docs/PHASE_93_SEMI_LAUNCH_VALIDATION_PACKET.md'), 'Phase 93 semi-launch validation packet doc exists');
  assert(exists('src/ops/semi-launch-validation-packet.ts'), 'Phase 93 semi-launch validation packet source exists');
  assert(exists('src/ops/semi-launch-validation-packet-cli.ts'), 'Phase 93 semi-launch validation packet CLI exists');
  assert(exists('test/semi-launch-validation-packet.ts'), 'Phase 93 semi-launch validation packet test exists');
  assert(pkg.scripts['ops:semi-launch-validation-packet'] === 'tsx src/ops/semi-launch-validation-packet-cli.ts', 'Phase 93 ops script present');
  assert(pkg.scripts['test:semi-launch-validation-packet'] === 'tsx test/semi-launch-validation-packet.ts', 'Phase 93 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/launch-candidate-seal.ts && tsx test/semi-launch-validation-packet.ts'),
    'Phase 93 aggregate test follows Phase 92',
  );

  const source = [
    read('src/ops/semi-launch-validation-packet.ts'),
    read('src/ops/semi-launch-validation-packet-cli.ts'),
  ].join('\n');
  const phase93Doc = read('docs/PHASE_93_SEMI_LAUNCH_VALIDATION_PACKET.md');
  const combined = [
    source,
    phase93Doc,
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:dns',
    'node:fs',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'TRUNCATE',
    'readFile',
    'writeFile',
    'createWriteStream',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
  ]) assert(!source.includes(forbidden), `Phase 93 source excludes ${forbidden}`);

  for (const required of [
    'semiLaunchCandidateVerdict: hold',
    'semiLaunchCandidateGo: false',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'releaseApproved: false',
    'closesO4: false',
    'closesO5: false',
    'operatorEvidenceCollected: false',
    'independentReviewRequired: true',
    'hold-pending-operator-evidence',
    'phase-92-launch-candidate-seal',
    'phase-91-production-time-decision',
    'launch-candidate-1',
    'phase-93',
    'semi-launch candidate approved',
    'No semi-launch GO.',
    'No launch approval.',
    'No production-readiness approval.',
    'No release-candidate approval.',
    'No production release approval.',
    'No O4 closure.',
    'No O5 closure.',
    'No network calls or live service contact.',
  ]) assert(combined.includes(required), `Phase 93 surface preserves ${required}`);

  for (const forbidden of [
    ['semiLaunchCandidateGo:', 'true'].join(' '),
    ['launchApproved:', 'true'].join(' '),
    ['productionReady:', 'true'].join(' '),
    ['releaseCandidateApproved:', 'true'].join(' '),
    ['releaseApproved:', 'true'].join(' '),
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
  ]) assert(!source.includes(forbidden), `Phase 93 excludes GO, approval, or closure ${forbidden}`);
});

test('Phase 94 operator validation run sheet is static and requires Clint validation', () => {
  assert(exists('docs/PHASE_94_OPERATOR_VALIDATION_RUN_SHEET.md'), 'Phase 94 operator validation run sheet doc exists');
  assert(exists('src/ops/operator-validation-run-sheet.ts'), 'Phase 94 operator validation run sheet source exists');
  assert(exists('src/ops/operator-validation-run-sheet-cli.ts'), 'Phase 94 operator validation run sheet CLI exists');
  assert(exists('test/operator-validation-run-sheet.ts'), 'Phase 94 operator validation run sheet test exists');
  assert(pkg.scripts['ops:operator-validation-run-sheet'] === 'tsx src/ops/operator-validation-run-sheet-cli.ts', 'Phase 94 ops script present');
  assert(pkg.scripts['test:operator-validation-run-sheet'] === 'tsx test/operator-validation-run-sheet.ts', 'Phase 94 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/semi-launch-validation-packet.ts && tsx test/operator-validation-run-sheet.ts'),
    'Phase 94 aggregate test follows Phase 93',
  );

  const source = [
    read('src/ops/operator-validation-run-sheet.ts'),
    read('src/ops/operator-validation-run-sheet-cli.ts'),
  ].join('\n');
  const phase94Doc = read('docs/PHASE_94_OPERATOR_VALIDATION_RUN_SHEET.md');
  const combined = [
    source,
    phase94Doc,
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const forbidden of [
    '@torbox/torbox-api',
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:dns',
    'node:fs',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    "from \"pg\"",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'TRUNCATE',
    'readFile',
    'writeFile',
    'createWriteStream',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
  ]) assert(!source.includes(forbidden), `Phase 94 source excludes ${forbidden}`);

  for (const required of [
    'operatorActionRequired: true',
    'semiLaunchCandidateGo: false',
    'operatorEvidenceCollected: false',
    'independentReviewRequired: true',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'releaseApproved: false',
    'closesO4: false',
    'closesO5: false',
    'ready-for-operator-validation',
    'phase-93-semi-launch-validation-packet',
    'launch-candidate-1',
    'operator validation complete',
    'No operator evidence collection by this command.',
    'No semi-launch GO.',
    'No launch approval.',
    'No production-readiness approval.',
    'No release-candidate approval.',
    'No production release approval.',
    'No O4 closure.',
    'No O5 closure.',
    'No network calls or live service contact.',
  ]) assert(combined.includes(required), `Phase 94 surface preserves ${required}`);

  for (const forbidden of [
    ['semiLaunchCandidateGo:', 'true'].join(' '),
    ['operatorEvidenceCollected:', 'true'].join(' '),
    ['launchApproved:', 'true'].join(' '),
    ['productionReady:', 'true'].join(' '),
    ['releaseCandidateApproved:', 'true'].join(' '),
    ['releaseApproved:', 'true'].join(' '),
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
  ]) assert(!source.includes(forbidden), `Phase 94 excludes GO, evidence completion, approval, or closure ${forbidden}`);
});

test('Phase 95 O4/O5 hardening plan is docs-only and does not close gates', () => {
  assert(exists('docs/PHASE_95_O4_O5_HARDENING_PLAN.md'), 'Phase 95 O4/O5 hardening plan doc exists');
  assert(exists('docs/PHASE_95_1_O4_O5_EVIDENCE_PACKET.md'), 'Phase 95.1 O4/O5 evidence packet doc exists');
  assert(exists('docs/PHASE_95_2_EXTERNAL_CUSTODIAN_ADAPTER_DESIGN.md'), 'Phase 95.2 external custodian adapter design doc exists');
  assert(exists('docs/PHASE_95_3_O5_MANAGED_KEK_CUSTODY_RUNBOOK.md'), 'Phase 95.3 O5 managed KEK custody runbook doc exists');
  assert(exists('docs/PHASE_95_4_IMPLEMENTATION_AUTHORIZATION_GATE.md'), 'Phase 95.4 implementation authorization gate doc exists');
  assert(exists('docs/PHASE_95_REVIEW_HANDOFF.md'), 'Phase 95 review handoff doc exists');
  assert(exists('docs/PHASE_95_IMPLEMENTATION_DECISION_TEMPLATE.md'), 'Phase 95 implementation decision template doc exists');
  assert(!exists('src/ops/o4-o5-hardening-plan.ts'), 'Phase 95 has no O4/O5 hardening implementation module');
  assert(!exists('src/ops/o4-o5-hardening-plan-cli.ts'), 'Phase 95 has no O4/O5 hardening CLI');
  assert(!exists('src/ops/o4-o5-evidence-packet.ts'), 'Phase 95.1 has no O4/O5 evidence packet implementation module');
  assert(!exists('src/ops/o4-o5-evidence-packet-cli.ts'), 'Phase 95.1 has no O4/O5 evidence packet CLI');
  assert(!exists('src/core/crypto/external-custodian-adapter.ts'), 'Phase 95.2 has no external custodian adapter implementation');
  assert(!exists('src/ops/external-custodian-adapter-cli.ts'), 'Phase 95.2 has no external custodian adapter CLI');
  assert(!exists('src/ops/managed-kek-custody.ts'), 'Phase 95.3 has no managed KEK custody implementation module');
  assert(!exists('src/ops/managed-kek-custody-cli.ts'), 'Phase 95.3 has no managed KEK custody CLI');
  assert(pkg.scripts['ops:o4-o5-hardening-plan'] === undefined, 'Phase 95 has no ops script');
  assert(pkg.scripts['test:o4-o5-hardening-plan'] === undefined, 'Phase 95 has no dedicated test script');
  assert(pkg.scripts['ops:o4-o5-evidence-packet'] === undefined, 'Phase 95.1 has no ops script');
  assert(pkg.scripts['test:o4-o5-evidence-packet'] === undefined, 'Phase 95.1 has no dedicated test script');
  assert(pkg.scripts['ops:external-custodian-adapter'] === undefined, 'Phase 95.2 has no ops script');
  assert(pkg.scripts['test:external-custodian-adapter'] === undefined, 'Phase 95.2 has no dedicated test script');
  assert(pkg.scripts['ops:managed-kek-custody'] === undefined, 'Phase 95.3 has no ops script');
  assert(pkg.scripts['test:managed-kek-custody'] === undefined, 'Phase 95.3 has no dedicated test script');

  const phase95Doc = read('docs/PHASE_95_O4_O5_HARDENING_PLAN.md');
  const phase951Doc = read('docs/PHASE_95_1_O4_O5_EVIDENCE_PACKET.md');
  const phase952Doc = read('docs/PHASE_95_2_EXTERNAL_CUSTODIAN_ADAPTER_DESIGN.md');
  const phase953Doc = read('docs/PHASE_95_3_O5_MANAGED_KEK_CUSTODY_RUNBOOK.md');
  const phase954Doc = read('docs/PHASE_95_4_IMPLEMENTATION_AUTHORIZATION_GATE.md');
  const phase95ReviewHandoff = read('docs/PHASE_95_REVIEW_HANDOFF.md');
  const phase95DecisionTemplate = read('docs/PHASE_95_IMPLEMENTATION_DECISION_TEMPLATE.md');
  const readme = read('README.md');
  const combined = `${phase95Doc}\n${phase951Doc}\n${phase952Doc}\n${phase953Doc}\n${phase954Doc}\n${phase95ReviewHandoff}\n${phase95DecisionTemplate}\n${readme}`;
  const phase95Surface = `${phase95Doc}\n${phase951Doc}\n${phase952Doc}\n${phase953Doc}\n${phase954Doc}\n${phase95ReviewHandoff}\n${phase95DecisionTemplate}`;

  for (const required of [
    'Phase 95 is a planning-only phase',
    'Phase 95.1 defines a docs-only O4/O5 readiness packet shape',
    'Phase 95.2 designs the first production external-custodian adapter boundary without implementing it',
    'Phase 95.3 designs managed KEK custody and rotation operations without changing runtime defaults',
    'Phase 95.4 defines the minimum operator decision required before any real O4/O5 implementation can',
    'It does not close O4 or O5.',
    'This packet does not close O4 or O5.',
    'This phase does not close O4 or O5.',
    'This phase does not close O5.',
    'This phase does not add a real custodian adapter',
    'This phase does not add a real custodian adapter, cloud SDK, vendor SDK, HTTP service, daemon',
    'Phase 95 must not introduce:',
    'cloud/KMS SDKs, vendor SDKs, real network clients, or live service calls',
    'The packet references existing preflight semantics rather than creating a new validator',
    'docs/PHASE_95_1_O4_O5_EVIDENCE_PACKET.md',
    'docs/PHASE_95_2_EXTERNAL_CUSTODIAN_ADAPTER_DESIGN.md',
    'docs/PHASE_95_3_O5_MANAGED_KEK_CUSTODY_RUNBOOK.md',
    'docs/PHASE_95_4_IMPLEMENTATION_AUTHORIZATION_GATE.md',
    'docs/PHASE_95_REVIEW_HANDOFF.md',
    'docs/PHASE_95_IMPLEMENTATION_DECISION_TEMPLATE.md',
    'custodianPreflightReportLabel',
    'kekPreflightReportLabel',
    'rewrapPlanEvidenceLabel',
    'Direction A - Local Custodian Sidecar',
    'Direction B - Managed KMS or External Custodian Service',
    'Failure-Mode Matrix',
    'runCustodianContract',
    'No Unraid topology is selected in this phase',
    'Mutating rewrap must never be implied by:',
    'Option A - Operator-Held Secret Media',
    'Option B - Managed Secret Store',
    'Option C - External Custodian-Owned KEK',
    'Runbook readiness does not mean:',
    'Required Decision Record',
    'Hold Conditions',
    'This gate authorizes implementation only',
    'Do not start implementation by inference',
    'Phase 95 is a planning-only O4/O5 hardening package',
    'Post-Review Next Step',
    'operator decision record under Phase 95.4',
    'Default state is HOLD',
    'decisionStatus',
    'no-implementation-authorized',
    'Until a valid decision record exists, continue planning or review only.',
    '"closesO4": false',
    '"closesO5": false',
    'Reviewer readiness does not mean:',
    'Stage 95.4 - Minimal Implementation Authorization Gate',
    'Before any real adapter or automation code is written, require a new explicit operator decision',
    'O4 and O5 are still described as open/deferred until live/operator evidence is reviewed',
    'FileCustodian remains a reference harness',
    'Phase 95 adds a planning-only O4/O5 hardening plan',
    '`docs/PHASE_95_O4_O5_HARDENING_PLAN.md`',
  ]) assert(combined.includes(required), `Phase 95 surface preserves ${required}`);

  for (const forbidden of [
    '@aws-sdk/',
    '@azure/',
    '@google-cloud/',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:tls',
    'globalThis.fetch',
    'fetch(',
    '@torbox/torbox-api',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
    'node-cron',
    'cron.schedule',
    'setInterval(',
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
    '"closesO4": true',
    '"closesO5": true',
    'O4 closed',
    'O5 closed',
  ]) assert(!phase95Surface.includes(forbidden), `Phase 95 docs exclude ${forbidden}`);
});

test('Phase 96 O4/O5 evidence decision packet authorizes only offline contract evidence', () => {
  assert(exists('docs/PHASE_96_O4_O5_EVIDENCE_DECISION_PACKET.md'), 'Phase 96 O4/O5 evidence decision packet doc exists');
  assert(exists('docs/PHASE_96_IMPLEMENTATION_DECISION_RECORD.redacted.json'), 'Phase 96 redacted decision record exists');
  assert(exists('src/ops/o4-o5-evidence-decision.ts'), 'Phase 96 evidence decision source exists');
  assert(exists('src/ops/o4-o5-evidence-decision-cli.ts'), 'Phase 96 evidence decision CLI exists');
  assert(exists('test/o4-o5-evidence-decision.ts'), 'Phase 96 evidence decision test exists');
  assert(pkg.scripts['ops:o4-o5-evidence-decision'] === 'tsx src/ops/o4-o5-evidence-decision-cli.ts', 'Phase 96 ops script present');
  assert(pkg.scripts['test:o4-o5-evidence-decision'] === 'tsx test/o4-o5-evidence-decision.ts', 'Phase 96 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/kek-evidence-preflight.ts && tsx test/o4-o5-evidence-decision.ts'),
    'Phase 96 aggregate test follows O4/O5 descriptor preflights',
  );

  const source = [
    read('src/ops/o4-o5-evidence-decision.ts'),
    read('src/ops/o4-o5-evidence-decision-cli.ts'),
  ].join('\n');
  const combined = [
    source,
    read('docs/PHASE_96_O4_O5_EVIDENCE_DECISION_PACKET.md'),
    read('docs/PHASE_96_IMPLEMENTATION_DECISION_RECORD.redacted.json'),
    read('README.md'),
    read('package.json'),
  ].join('\n');

  for (const required of [
    'phase-96-o4-o5-evidence-decision-packet',
    'contract-harness-expansion-without-live-service-contact',
    'runtimeImplementationAuthorized: false',
    'liveServiceContactAllowed: false',
    'closesO4: false',
    'closesO5: false',
    '"closesO4": false',
    '"closesO5": false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
    'No live service contact',
    'No provider, media-server, playback, download, scraping, or UI expansion',
    'This phase does not add a real custodian adapter',
    'runtimeImplementationAuthorized: false',
    'liveServiceContactAllowed: false',
  ]) assert(combined.includes(required), `Phase 96 surface preserves ${required}`);

  for (const forbidden of [
    '@aws-sdk/',
    '@azure/',
    '@google-cloud/',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:tls',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'process.env',
    'docker compose',
    '@torbox/torbox-api',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
    'node-cron',
    'cron.schedule',
    'setInterval(',
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
    '"closesO4": true',
    '"closesO5": true',
    'O4 closed',
    'O5 closed',
  ]) assert(!source.includes(forbidden), `Phase 96 source excludes ${forbidden}`);
});

test('Phase 97 operator UI preview launch packet is static and loopback-only', () => {
  assert(exists('docs/PHASE_97_OPERATOR_UI_PREVIEW_LAUNCH_PACKET.md'), 'Phase 97 preview launch packet doc exists');
  assert(exists('src/ops/operator-ui-preview-launch-packet.ts'), 'Phase 97 preview launch packet source exists');
  assert(exists('src/ops/operator-ui-preview-launch-packet-cli.ts'), 'Phase 97 preview launch packet CLI exists');
  assert(exists('test/operator-ui-preview-launch-packet.ts'), 'Phase 97 preview launch packet test exists');
  assert(pkg.scripts['ops:operator-ui-preview-launch-packet'] === 'tsx src/ops/operator-ui-preview-launch-packet-cli.ts', 'Phase 97 ops script present');
  assert(pkg.scripts['test:operator-ui-preview-launch-packet'] === 'tsx test/operator-ui-preview-launch-packet.ts', 'Phase 97 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-launch-readiness.ts && tsx test/operator-ui-preview-launch-packet.ts'),
    'Phase 97 aggregate test follows launch readiness',
  );

  const source = [
    read('src/ops/operator-ui-preview-launch-packet.ts'),
    read('src/ops/operator-ui-preview-launch-packet-cli.ts'),
  ].join('\n');
  const combined = [
    source,
    read('docs/PHASE_97_OPERATOR_UI_PREVIEW_LAUNCH_PACKET.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');

  for (const required of [
    'phase-97-operator-ui-preview-launch-packet',
    'remoteExposureAllowed: false',
    'liveDataAllowed: false',
    'providerContactAllowed: false',
    'loopback-only',
    'fixture-only',
    'Unraid fixture preview through SSH tunnel',
    'Remote exposure remains blocked',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
    'Binding the runtime to `0.0.0.0`',
    'provider/media-server data',
  ]) assert(combined.includes(required), `Phase 97 surface preserves ${required}`);

  for (const forbidden of [
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    'docker compose',
    'ADAPTER_MODE',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'writeFile',
    'createWriteStream',
    ['remoteExposureAllowed:', 'true'].join(' '),
    ['liveDataAllowed:', 'true'].join(' '),
    ['providerContactAllowed:', 'true'].join(' '),
  ]) assert(!source.includes(forbidden), `Phase 97 source excludes ${forbidden}`);
});

test('Phase 98 local sidecar custodian prototype is offline and contract-shaped', () => {
  assert(exists('docs/PHASE_98_LOCAL_SIDECAR_CUSTODIAN_PROTOTYPE.md'), 'Phase 98 local sidecar prototype doc exists');
  assert(exists('src/core/crypto/local-sidecar-custodian.ts'), 'Phase 98 local sidecar source exists');
  assert(exists('test/local-sidecar-custodian.ts'), 'Phase 98 local sidecar test exists');
  assert(pkg.scripts['test:local-sidecar-custodian'] === 'tsx test/local-sidecar-custodian.ts', 'Phase 98 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/custodian-acceptance.ts && tsx test/local-sidecar-custodian.ts'),
    'Phase 98 aggregate test follows custodian acceptance',
  );

  const source = read('src/core/crypto/local-sidecar-custodian.ts');
  const combined = [
    source,
    read('docs/PHASE_98_LOCAL_SIDECAR_CUSTODIAN_PROTOTYPE.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');

  for (const required of [
    'LocalSidecarCustodianClient',
    'LocalSidecarCustodianTransport',
    'dispatchLocalSidecarCustodianRequest',
    'external-self-hosted',
    'phase-98-prototype',
    'injected transport',
    'no sockets',
    'no daemon',
    'no live service contact',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
    'does not close O4',
  ]) assert(combined.includes(required), `Phase 98 surface preserves ${required}`);

  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'node:fs',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    'docker compose',
    '@aws-sdk',
    '@azure',
    '@google-cloud',
    'express',
    'fastify',
    'koa',
    'setInterval',
    'setTimeout',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 98 source excludes ${forbidden}`);
});

test('Phase 99 sidecar runtime design packet is static and Unraid-scoped', () => {
  assert(exists('docs/PHASE_99_SIDECAR_RUNTIME_DESIGN_PACKET.md'), 'Phase 99 sidecar runtime design doc exists');
  assert(exists('src/ops/sidecar-runtime-design-packet.ts'), 'Phase 99 sidecar runtime design source exists');
  assert(exists('src/ops/sidecar-runtime-design-packet-cli.ts'), 'Phase 99 sidecar runtime design CLI exists');
  assert(exists('test/sidecar-runtime-design-packet.ts'), 'Phase 99 sidecar runtime design test exists');
  assert(pkg.scripts['test:sidecar-runtime-design-packet'] === 'tsx test/sidecar-runtime-design-packet.ts', 'Phase 99 test script present');
  assert(pkg.scripts['ops:sidecar-runtime-design-packet'] === 'tsx src/ops/sidecar-runtime-design-packet-cli.ts', 'Phase 99 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/local-sidecar-custodian.ts && tsx test/sidecar-runtime-design-packet.ts'),
    'Phase 99 aggregate test follows Phase 98 sidecar prototype',
  );

  const source = `${read('src/ops/sidecar-runtime-design-packet.ts')}\n${read('src/ops/sidecar-runtime-design-packet-cli.ts')}`;
  const combined = [
    source,
    read('docs/PHASE_99_SIDECAR_RUNTIME_DESIGN_PACKET.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');

  for (const required of [
    'phase-99-sidecar-runtime-design-packet',
    'SIDECAR_RUNTIME_DESIGN_PACKET',
    'Unix domain socket',
    'owner-only filesystem permissions',
    'external-self-hosted',
    'runtimeImplemented: false',
    'liveValidationAllowed: false',
    'no daemon',
    'no socket listener',
    'no HTTP API',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 99 surface preserves ${required}`);

  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    'docker compose',
    'express',
    'fastify',
    'koa',
    'listen(',
    'createServer',
    'setInterval',
    'setTimeout',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 99 source excludes ${forbidden}`);
});

test('Phase 100 sidecar evidence harness packet is redaction-safe and does not close gates', () => {
  assert(exists('docs/PHASE_100_SIDECAR_EVIDENCE_HARNESS_PACKET.md'), 'Phase 100 sidecar evidence harness doc exists');
  assert(exists('src/ops/sidecar-evidence-harness-packet.ts'), 'Phase 100 sidecar evidence harness source exists');
  assert(exists('src/ops/sidecar-evidence-harness-packet-cli.ts'), 'Phase 100 sidecar evidence harness CLI exists');
  assert(exists('test/sidecar-evidence-harness-packet.ts'), 'Phase 100 sidecar evidence harness test exists');
  assert(pkg.scripts['test:sidecar-evidence-harness-packet'] === 'tsx test/sidecar-evidence-harness-packet.ts', 'Phase 100 test script present');
  assert(pkg.scripts['ops:sidecar-evidence-harness-packet'] === 'tsx src/ops/sidecar-evidence-harness-packet-cli.ts', 'Phase 100 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-runtime-design-packet.ts && tsx test/sidecar-evidence-harness-packet.ts'),
    'Phase 100 aggregate test follows Phase 99 runtime design',
  );

  const source = `${read('src/ops/sidecar-evidence-harness-packet.ts')}\n${read('src/ops/sidecar-evidence-harness-packet-cli.ts')}`;
  const combined = [
    source,
    read('docs/PHASE_100_SIDECAR_EVIDENCE_HARNESS_PACKET.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');

  for (const required of [
    'phase-100-sidecar-evidence-harness-packet',
    'SIDECAR_EVIDENCE_HARNESS_PACKET',
    'manifestValuesEchoed: false',
    'requiredLabels',
    'restoreWithoutSidecarFailsClosed',
    'no daemon',
    'no socket listener',
    'no HTTP API',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
    'never closes O4 or O5',
  ]) assert(combined.includes(required), `Phase 100 surface preserves ${required}`);

  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    'docker compose',
    'express',
    'fastify',
    'koa',
    'listen(',
    'createServer',
    'setInterval',
    'setTimeout',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 100 source excludes ${forbidden}`);
});

test('Phase 101/102 sidecar runtime prototype is local IPC only and evidence-safe', () => {
  assert(exists('docs/PHASE_101_102_SIDECAR_RUNTIME_PROTOTYPE.md'), 'Phase 101/102 sidecar runtime prototype doc exists');
  assert(exists('src/core/crypto/local-sidecar-runtime.ts'), 'Phase 101/102 sidecar runtime source exists');
  assert(exists('src/ops/sidecar-runtime-evidence.ts'), 'Phase 101/102 sidecar runtime evidence source exists');
  assert(exists('src/ops/sidecar-runtime-evidence-cli.ts'), 'Phase 101/102 sidecar runtime evidence CLI exists');
  assert(exists('test/sidecar-runtime-prototype.ts'), 'Phase 101/102 sidecar runtime prototype test exists');
  assert(pkg.scripts['test:sidecar-runtime-prototype'] === 'tsx test/sidecar-runtime-prototype.ts', 'Phase 101/102 test script present');
  assert(pkg.scripts['ops:sidecar-runtime-evidence'] === 'tsx src/ops/sidecar-runtime-evidence-cli.ts', 'Phase 101/102 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-evidence-harness-packet.ts && tsx test/sidecar-runtime-prototype.ts'),
    'Phase 101/102 aggregate test follows Phase 100 evidence harness',
  );

  const source = [
    read('src/core/crypto/local-sidecar-runtime.ts'),
    read('src/ops/sidecar-runtime-evidence.ts'),
    read('src/ops/sidecar-runtime-evidence-cli.ts'),
  ].join('\n');
  const combined = [
    source,
    read('docs/PHASE_101_102_SIDECAR_RUNTIME_PROTOTYPE.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');

  for (const required of [
    'phase-101-102-sidecar-runtime-evidence',
    'SIDECAR_RUNTIME_EVIDENCE_PACKET',
    'startLocalSidecarRuntime',
    'UnixSocketSidecarTransport',
    'local socket',
    'tcpListenerAllowed: false',
    'httpApiAllowed: false',
    'serviceInstallAllowed: false',
    'liveValidationAllowed: false',
    'providerContactAllowed: false',
    'closesO4: false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 101/102 surface preserves ${required}`);

  for (const forbidden of [
    'node:http',
    'node:https',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    '@aws-sdk',
    '@azure',
    '@google-cloud',
    'express',
    'fastify',
    'koa',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 101/102 source excludes ${forbidden}`);
});

test('Phase 103/104 durable sidecar state evidence preserves restart and restore fail-closed boundaries', () => {
  assert(exists('docs/PHASE_103_104_DURABLE_SIDECAR_STATE_EVIDENCE.md'), 'Phase 103/104 durable sidecar evidence doc exists');
  assert(exists('src/ops/sidecar-durable-state-evidence.ts'), 'Phase 103/104 durable sidecar evidence source exists');
  assert(exists('src/ops/sidecar-durable-state-evidence-cli.ts'), 'Phase 103/104 durable sidecar evidence CLI exists');
  assert(exists('test/sidecar-durable-state-evidence.ts'), 'Phase 103/104 durable sidecar evidence test exists');
  assert(pkg.scripts['test:sidecar-durable-state-evidence'] === 'tsx test/sidecar-durable-state-evidence.ts', 'Phase 103/104 test script present');
  assert(pkg.scripts['ops:sidecar-durable-state-evidence'] === 'tsx src/ops/sidecar-durable-state-evidence-cli.ts', 'Phase 103/104 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-runtime-prototype.ts && tsx test/sidecar-durable-state-evidence.ts'),
    'Phase 103/104 aggregate test follows Phase 101/102 runtime prototype',
  );

  const source = `${read('src/ops/sidecar-durable-state-evidence.ts')}\n${read('src/ops/sidecar-durable-state-evidence-cli.ts')}`;
  const combined = [
    source,
    read('docs/PHASE_103_104_DURABLE_SIDECAR_STATE_EVIDENCE.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');

  for (const required of [
    'phase-103-104-durable-sidecar-state-evidence',
    'DURABLE_SIDECAR_STATE_EVIDENCE',
    'restartPersistenceExercised: true',
    'restoreFailClosedExercised: true',
    'sidecarStateValuesEchoed: false',
    'serviceInstallAllowed: false',
    'closesO4: false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 103/104 surface preserves ${required}`);

  for (const forbidden of [
    'node:http',
    'node:https',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    '@aws-sdk',
    '@azure',
    '@google-cloud',
    'express',
    'fastify',
    'koa',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 103/104 source excludes ${forbidden}`);
});

test('Phase 105 sidecar Unraid service plan is static and does not mutate Unraid', () => {
  assert(exists('docs/PHASE_105_SIDECAR_UNRAID_SERVICE_PLAN.md'), 'Phase 105 Unraid service plan doc exists');
  assert(exists('src/ops/sidecar-unraid-service-plan.ts'), 'Phase 105 Unraid service plan source exists');
  assert(exists('src/ops/sidecar-unraid-service-plan-cli.ts'), 'Phase 105 Unraid service plan CLI exists');
  assert(exists('test/sidecar-unraid-service-plan.ts'), 'Phase 105 Unraid service plan test exists');
  assert(pkg.scripts['test:sidecar-unraid-service-plan'] === 'tsx test/sidecar-unraid-service-plan.ts', 'Phase 105 test script present');
  assert(pkg.scripts['ops:sidecar-unraid-service-plan'] === 'tsx src/ops/sidecar-unraid-service-plan-cli.ts', 'Phase 105 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-durable-state-evidence.ts && tsx test/sidecar-daemon.ts && tsx test/sidecar-factory-evidence.ts && tsx test/sidecar-factory-evidence-review.ts && tsx test/sidecar-factory-evidence-acceptance-record.ts && tsx test/o4-sidecar-closure-readiness.ts && tsx test/o4-closure-disposition.ts && tsx test/runtime-cutover-plan.ts && tsx test/sidecar-service-install.ts && tsx test/sidecar-unraid-service-plan.ts'),
    'Phase 105 aggregate test follows Phase 194 sidecar service install',
  );

  const source = `${read('src/ops/sidecar-unraid-service-plan.ts')}\n${read('src/ops/sidecar-unraid-service-plan-cli.ts')}`;
  const combined = [
    source,
    read('docs/PHASE_105_SIDECAR_UNRAID_SERVICE_PLAN.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');

  for (const required of [
    'phase-105-sidecar-unraid-service-plan',
    'SIDECAR_UNRAID_SERVICE_PLAN',
    'serviceInstalled: false',
    'serviceStarted: false',
    'mutatesUnraid: false',
    'tcpListenerAllowed: false',
    'httpApiAllowed: false',
    'lanExposureAllowed: false',
    'closesO4: false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 105 surface preserves ${required}`);

  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose up',
    'execSync',
    'spawnSync',
    'writeFile',
    'chmodSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 105 source excludes ${forbidden}`);
});

test('Phase 106 sidecar Unraid operator script packet is copy-paste only and non-executing', () => {
  assert(exists('docs/PHASE_106_SIDECAR_UNRAID_OPERATOR_SCRIPT_PACKET.md'), 'Phase 106 operator script packet doc exists');
  assert(exists('src/ops/sidecar-unraid-operator-script-packet.ts'), 'Phase 106 operator script packet source exists');
  assert(exists('src/ops/sidecar-unraid-operator-script-packet-cli.ts'), 'Phase 106 operator script packet CLI exists');
  assert(exists('test/sidecar-unraid-operator-script-packet.ts'), 'Phase 106 operator script packet test exists');
  assert(pkg.scripts['test:sidecar-unraid-operator-script-packet'] === 'tsx test/sidecar-unraid-operator-script-packet.ts', 'Phase 106 test script present');
  assert(pkg.scripts['ops:sidecar-unraid-operator-script-packet'] === 'tsx src/ops/sidecar-unraid-operator-script-packet-cli.ts', 'Phase 106 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-unraid-service-plan.ts && tsx test/sidecar-unraid-operator-script-packet.ts'),
    'Phase 106 aggregate test follows Phase 105 service plan',
  );

  const source = `${read('src/ops/sidecar-unraid-operator-script-packet.ts')}\n${read('src/ops/sidecar-unraid-operator-script-packet-cli.ts')}`;
  const combined = [source, read('docs/PHASE_106_SIDECAR_UNRAID_OPERATOR_SCRIPT_PACKET.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-106-sidecar-unraid-operator-script-packet',
    'SIDECAR_UNRAID_OPERATOR_SCRIPT_PACKET',
    'commandExecution: false',
    'operatorRunRequired: true',
    'mutatesUnraidNow: false',
    'serviceInstalled: false',
    'tcpListenerAllowed: false',
    'httpApiAllowed: false',
    'closesO4: false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 106 surface preserves ${required}`);
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'execSync',
    'spawnSync',
    'writeFile',
    'chmodSync',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 106 source excludes ${forbidden}`);
});

test('Phase 107 sidecar Unraid evidence capture defines redacted bundle only', () => {
  assert(exists('docs/PHASE_107_SIDECAR_UNRAID_EVIDENCE_CAPTURE.md'), 'Phase 107 evidence capture doc exists');
  assert(exists('src/ops/sidecar-unraid-evidence-capture.ts'), 'Phase 107 evidence capture source exists');
  assert(exists('src/ops/sidecar-unraid-evidence-capture-cli.ts'), 'Phase 107 evidence capture CLI exists');
  assert(exists('test/sidecar-unraid-evidence-capture.ts'), 'Phase 107 evidence capture test exists');
  assert(pkg.scripts['test:sidecar-unraid-evidence-capture'] === 'tsx test/sidecar-unraid-evidence-capture.ts', 'Phase 107 test script present');
  assert(pkg.scripts['ops:sidecar-unraid-evidence-capture'] === 'tsx src/ops/sidecar-unraid-evidence-capture-cli.ts', 'Phase 107 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-unraid-operator-script-packet.ts && tsx test/sidecar-unraid-evidence-capture.ts'),
    'Phase 107 aggregate test follows Phase 106 script packet',
  );

  const source = `${read('src/ops/sidecar-unraid-evidence-capture.ts')}\n${read('src/ops/sidecar-unraid-evidence-capture-cli.ts')}`;
  const combined = [source, read('docs/PHASE_107_SIDECAR_UNRAID_EVIDENCE_CAPTURE.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-107-sidecar-unraid-evidence-capture-packet',
    'SIDECAR_UNRAID_EVIDENCE_CAPTURE_PACKET',
    'single-redacted-sidecar-unraid-evidence-json-file',
    'evidenceValuesEchoed: false',
    'commandExecution: false',
    'serviceInstalled: false',
    'closesO4: false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 107 surface preserves ${required}`);
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'execSync',
    'spawnSync',
    'writeFile',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 107 source excludes ${forbidden}`);
});

test('Phase 108 sidecar Unraid review gate reads explicit evidence and closes no gates', () => {
  assert(exists('docs/PHASE_108_SIDECAR_UNRAID_REVIEW_GATE.md'), 'Phase 108 review gate doc exists');
  assert(exists('src/ops/sidecar-unraid-review-gate.ts'), 'Phase 108 review gate source exists');
  assert(exists('src/ops/sidecar-unraid-review-gate-cli.ts'), 'Phase 108 review gate CLI exists');
  assert(exists('test/sidecar-unraid-review-gate.ts'), 'Phase 108 review gate test exists');
  assert(pkg.scripts['test:sidecar-unraid-review-gate'] === 'tsx test/sidecar-unraid-review-gate.ts', 'Phase 108 test script present');
  assert(pkg.scripts['ops:sidecar-unraid-review-gate'] === 'tsx src/ops/sidecar-unraid-review-gate-cli.ts', 'Phase 108 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-unraid-evidence-capture.ts && tsx test/sidecar-unraid-review-gate.ts'),
    'Phase 108 aggregate test follows Phase 107 evidence capture',
  );

  const source = `${read('src/ops/sidecar-unraid-review-gate.ts')}\n${read('src/ops/sidecar-unraid-review-gate-cli.ts')}`;
  const combined = [source, read('docs/PHASE_108_SIDECAR_UNRAID_REVIEW_GATE.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-108-sidecar-unraid-review-gate',
    'SIDECAR_UNRAID_REVIEW_GATE',
    'single-redacted-sidecar-unraid-evidence-json-file',
    'commandExecution: false',
    'evidenceValuesEchoed: false',
    'reviewReadiness',
    'closesO4: false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 108 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 108 source excludes ${forbidden}`);
});

test('Phase 109 sidecar Unraid review summary reads explicit review output and closes no gates', () => {
  assert(exists('docs/PHASE_109_SIDECAR_UNRAID_REVIEW_SUMMARY.md'), 'Phase 109 review summary doc exists');
  assert(exists('src/ops/sidecar-unraid-review-summary.ts'), 'Phase 109 review summary source exists');
  assert(exists('src/ops/sidecar-unraid-review-summary-cli.ts'), 'Phase 109 review summary CLI exists');
  assert(exists('test/sidecar-unraid-review-summary.ts'), 'Phase 109 review summary test exists');
  assert(pkg.scripts['test:sidecar-unraid-review-summary'] === 'tsx test/sidecar-unraid-review-summary.ts', 'Phase 109 test script present');
  assert(pkg.scripts['ops:sidecar-unraid-review-summary'] === 'tsx src/ops/sidecar-unraid-review-summary-cli.ts', 'Phase 109 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-unraid-review-gate.ts && tsx test/sidecar-unraid-review-summary.ts'),
    'Phase 109 aggregate test follows Phase 108 review gate',
  );

  const source = `${read('src/ops/sidecar-unraid-review-summary.ts')}\n${read('src/ops/sidecar-unraid-review-summary-cli.ts')}`;
  const combined = [source, read('docs/PHASE_109_SIDECAR_UNRAID_REVIEW_SUMMARY.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-109-sidecar-unraid-review-summary',
    'SIDECAR_UNRAID_REVIEW_SUMMARY',
    'single-redacted-phase-108-review-gate-json-file',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'serviceInstalled: false',
    'providerContactAllowed: false',
    'closesO4: false',
    'closesO5: false',
    'O4/O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 109 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 109 source excludes ${forbidden}`);
});

test('Phase 110 sidecar Unraid acceptance record is redaction-safe and approval-free', () => {
  assert(exists('docs/PHASE_110_SIDECAR_UNRAID_ACCEPTANCE_RECORD.md'), 'Phase 110 acceptance record doc exists');
  assert(exists('src/ops/sidecar-unraid-acceptance-record.ts'), 'Phase 110 acceptance record source exists');
  assert(exists('src/ops/sidecar-unraid-acceptance-record-cli.ts'), 'Phase 110 acceptance record CLI exists');
  assert(exists('test/sidecar-unraid-acceptance-record.ts'), 'Phase 110 acceptance record test exists');
  assert(pkg.scripts['test:sidecar-unraid-acceptance-record'] === 'tsx test/sidecar-unraid-acceptance-record.ts', 'Phase 110 test script present');
  assert(pkg.scripts['ops:sidecar-unraid-acceptance-record'] === 'tsx src/ops/sidecar-unraid-acceptance-record-cli.ts', 'Phase 110 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-unraid-review-summary.ts && tsx test/sidecar-unraid-acceptance-record.ts'),
    'Phase 110 aggregate test follows Phase 109 summary',
  );

  const source = `${read('src/ops/sidecar-unraid-acceptance-record.ts')}\n${read('src/ops/sidecar-unraid-acceptance-record-cli.ts')}`;
  const combined = [source, read('docs/PHASE_110_SIDECAR_UNRAID_ACCEPTANCE_RECORD.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-110-sidecar-unraid-acceptance-record',
    'phase-110-sidecar-unraid-acceptance-preflight',
    'single-operator-supplied-sidecar-unraid-acceptance-record-json-file',
    'recordValuesEchoed: false',
    'commandExecution: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'closesO4: false',
    'closesO5: false',
    'O4/O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 110 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 110 source excludes ${forbidden}`);
});

test('Phase 111 sidecar Unraid review handoff is static and approval-free', () => {
  assert(exists('docs/PHASE_111_SIDECAR_UNRAID_REVIEW_HANDOFF.md'), 'Phase 111 review handoff doc exists');
  assert(exists('src/ops/sidecar-unraid-review-handoff.ts'), 'Phase 111 review handoff source exists');
  assert(exists('src/ops/sidecar-unraid-review-handoff-cli.ts'), 'Phase 111 review handoff CLI exists');
  assert(exists('test/sidecar-unraid-review-handoff.ts'), 'Phase 111 review handoff test exists');
  assert(pkg.scripts['test:sidecar-unraid-review-handoff'] === 'tsx test/sidecar-unraid-review-handoff.ts', 'Phase 111 test script present');
  assert(pkg.scripts['ops:sidecar-unraid-review-handoff'] === 'tsx src/ops/sidecar-unraid-review-handoff-cli.ts', 'Phase 111 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-unraid-acceptance-record.ts && tsx test/sidecar-unraid-review-handoff.ts'),
    'Phase 111 aggregate test follows Phase 110 acceptance record',
  );

  const source = `${read('src/ops/sidecar-unraid-review-handoff.ts')}\n${read('src/ops/sidecar-unraid-review-handoff-cli.ts')}`;
  const combined = [source, read('docs/PHASE_111_SIDECAR_UNRAID_REVIEW_HANDOFF.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-111-sidecar-unraid-review-handoff',
    'SIDECAR_UNRAID_REVIEW_HANDOFF',
    'awaiting-independent-review',
    'productionReady: false',
    'serviceInstallApproved: false',
    'providerModeEnabled: false',
    'closesO4: false',
    'closesO5: false',
    'O4/O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 111 surface preserves ${required}`);
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'process.env',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 111 source excludes ${forbidden}`);
});

test('Phase 112 sidecar Unraid production gate blockers are static and closure-free', () => {
  assert(exists('docs/PHASE_112_SIDECAR_UNRAID_PRODUCTION_GATE_BLOCKERS.md'), 'Phase 112 production gate blockers doc exists');
  assert(exists('src/ops/sidecar-unraid-production-gate-blockers.ts'), 'Phase 112 production gate blockers source exists');
  assert(exists('src/ops/sidecar-unraid-production-gate-blockers-cli.ts'), 'Phase 112 production gate blockers CLI exists');
  assert(exists('test/sidecar-unraid-production-gate-blockers.ts'), 'Phase 112 production gate blockers test exists');
  assert(pkg.scripts['test:sidecar-unraid-production-gate-blockers'] === 'tsx test/sidecar-unraid-production-gate-blockers.ts', 'Phase 112 test script present');
  assert(pkg.scripts['ops:sidecar-unraid-production-gate-blockers'] === 'tsx src/ops/sidecar-unraid-production-gate-blockers-cli.ts', 'Phase 112 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-unraid-review-handoff.ts && tsx test/sidecar-unraid-production-gate-blockers.ts'),
    'Phase 112 aggregate test follows Phase 111 review handoff',
  );

  const source = `${read('src/ops/sidecar-unraid-production-gate-blockers.ts')}\n${read('src/ops/sidecar-unraid-production-gate-blockers-cli.ts')}`;
  const combined = [source, read('docs/PHASE_112_SIDECAR_UNRAID_PRODUCTION_GATE_BLOCKERS.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-112-sidecar-unraid-production-gate-blockers',
    'SIDECAR_UNRAID_PRODUCTION_GATE_BLOCKERS',
    'phase-111-sidecar-unraid-review-handoff',
    'managed-custodian-sidecar-boundary-attestation-redacted',
    'managed-kek-custody-and-rotation-attestation-redacted',
    'productionReady: false',
    'serviceInstallApproved: false',
    'providerModeEnabled: false',
    'commandExecution: false',
    'closesO4: false',
    'closesO5: false',
    'O4/O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 112 surface preserves ${required}`);
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'process.env',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 112 source excludes ${forbidden}`);
});

test('Phase 113 sidecar Unraid custodian boundary preflight is redaction-safe and review-only', () => {
  assert(exists('docs/PHASE_113_SIDECAR_UNRAID_CUSTODIAN_BOUNDARY_PREFLIGHT.md'), 'Phase 113 custodian boundary preflight doc exists');
  assert(exists('src/ops/sidecar-unraid-custodian-boundary-preflight.ts'), 'Phase 113 custodian boundary preflight source exists');
  assert(exists('src/ops/sidecar-unraid-custodian-boundary-preflight-cli.ts'), 'Phase 113 custodian boundary preflight CLI exists');
  assert(exists('test/sidecar-unraid-custodian-boundary-preflight.ts'), 'Phase 113 custodian boundary preflight test exists');
  assert(pkg.scripts['test:sidecar-unraid-custodian-boundary-preflight'] === 'tsx test/sidecar-unraid-custodian-boundary-preflight.ts', 'Phase 113 test script present');
  assert(pkg.scripts['ops:sidecar-unraid-custodian-boundary-preflight'] === 'tsx src/ops/sidecar-unraid-custodian-boundary-preflight-cli.ts', 'Phase 113 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-unraid-production-gate-blockers.ts && tsx test/sidecar-unraid-custodian-boundary-preflight.ts'),
    'Phase 113 aggregate test follows Phase 112 blockers',
  );

  const source = `${read('src/ops/sidecar-unraid-custodian-boundary-preflight.ts')}\n${read('src/ops/sidecar-unraid-custodian-boundary-preflight-cli.ts')}`;
  const combined = [source, read('docs/PHASE_113_SIDECAR_UNRAID_CUSTODIAN_BOUNDARY_PREFLIGHT.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-113-sidecar-unraid-custodian-boundary-preflight',
    'single-redacted-sidecar-custodian-boundary-json-file',
    'managed-custodian-sidecar-boundary-attestation-redacted',
    'descriptorValuesEchoed: false',
    'commandExecution: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'productionReady: false',
    'closesO4: false',
    'closesO5: false',
    'O4/O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 113 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 113 source excludes ${forbidden}`);
});

test('Phase 114 sidecar Unraid custodian review verdict is redaction-safe and closure-gated', () => {
  assert(exists('docs/PHASE_114_SIDECAR_UNRAID_CUSTODIAN_REVIEW_VERDICT.md'), 'Phase 114 custodian review verdict doc exists');
  assert(exists('src/ops/sidecar-unraid-custodian-review-verdict.ts'), 'Phase 114 custodian review verdict source exists');
  assert(exists('src/ops/sidecar-unraid-custodian-review-verdict-cli.ts'), 'Phase 114 custodian review verdict CLI exists');
  assert(exists('test/sidecar-unraid-custodian-review-verdict.ts'), 'Phase 114 custodian review verdict test exists');
  assert(pkg.scripts['test:sidecar-unraid-custodian-review-verdict'] === 'tsx test/sidecar-unraid-custodian-review-verdict.ts', 'Phase 114 test script present');
  assert(pkg.scripts['ops:sidecar-unraid-custodian-review-verdict'] === 'tsx src/ops/sidecar-unraid-custodian-review-verdict-cli.ts', 'Phase 114 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-unraid-custodian-boundary-preflight.ts && tsx test/sidecar-unraid-custodian-review-verdict.ts'),
    'Phase 114 aggregate test follows Phase 113 boundary preflight',
  );

  const source = `${read('src/ops/sidecar-unraid-custodian-review-verdict.ts')}\n${read('src/ops/sidecar-unraid-custodian-review-verdict-cli.ts')}`;
  const combined = [source, read('docs/PHASE_114_SIDECAR_UNRAID_CUSTODIAN_REVIEW_VERDICT.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-114-sidecar-unraid-custodian-review-verdict',
    'phase-114-sidecar-unraid-custodian-review-verdict-preflight',
    'single-redacted-sidecar-custodian-review-verdict-json-file',
    'phase-113-sidecar-unraid-custodian-boundary-preflight',
    'GO',
    'HOLD',
    'REJECTED',
    'verdictValuesEchoed: false',
    'rawReviewerNotesIncluded: false',
    'commandExecution: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'productionReady: false',
    'closesO4: false',
    'closesO5: false',
    'O4/O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 114 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 114 source excludes ${forbidden}`);
});

test('Phase 115 sidecar Unraid O4 closure gate is redaction-safe and final-authorization-only', () => {
  assert(exists('docs/PHASE_115_SIDECAR_UNRAID_O4_CLOSURE_GATE.md'), 'Phase 115 O4 closure gate doc exists');
  assert(exists('src/ops/sidecar-unraid-o4-closure-gate.ts'), 'Phase 115 O4 closure gate source exists');
  assert(exists('src/ops/sidecar-unraid-o4-closure-gate-cli.ts'), 'Phase 115 O4 closure gate CLI exists');
  assert(exists('test/sidecar-unraid-o4-closure-gate.ts'), 'Phase 115 O4 closure gate test exists');
  assert(pkg.scripts['test:sidecar-unraid-o4-closure-gate'] === 'tsx test/sidecar-unraid-o4-closure-gate.ts', 'Phase 115 test script present');
  assert(pkg.scripts['ops:sidecar-unraid-o4-closure-gate'] === 'tsx src/ops/sidecar-unraid-o4-closure-gate-cli.ts', 'Phase 115 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-unraid-custodian-review-verdict.ts && tsx test/sidecar-unraid-o4-closure-gate.ts'),
    'Phase 115 aggregate test follows Phase 114 review verdict',
  );

  const source = `${read('src/ops/sidecar-unraid-o4-closure-gate.ts')}\n${read('src/ops/sidecar-unraid-o4-closure-gate-cli.ts')}`;
  const combined = [source, read('docs/PHASE_115_SIDECAR_UNRAID_O4_CLOSURE_GATE.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-115-sidecar-unraid-o4-closure-gate-preflight',
    'phase-113-sidecar-unraid-custodian-boundary-preflight',
    'phase-114-sidecar-unraid-custodian-review-verdict-preflight',
    'ready-for-final-o4-authorization',
    'closure-ready-pending-final-authorization',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'productionReady: false',
    'closesO4: false',
    'closesO5: false',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 115 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 115 source excludes ${forbidden}`);
});

test('Phase 116 sidecar Unraid O4 final authorization closes only O4', () => {
  assert(exists('docs/PHASE_116_SIDECAR_UNRAID_O4_FINAL_AUTHORIZATION.md'), 'Phase 116 O4 final authorization doc exists');
  assert(exists('src/ops/sidecar-unraid-o4-final-authorization.ts'), 'Phase 116 O4 final authorization source exists');
  assert(exists('src/ops/sidecar-unraid-o4-final-authorization-cli.ts'), 'Phase 116 O4 final authorization CLI exists');
  assert(exists('test/sidecar-unraid-o4-final-authorization.ts'), 'Phase 116 O4 final authorization test exists');
  assert(pkg.scripts['test:sidecar-unraid-o4-final-authorization'] === 'tsx test/sidecar-unraid-o4-final-authorization.ts', 'Phase 116 test script present');
  assert(pkg.scripts['ops:sidecar-unraid-o4-final-authorization'] === 'tsx src/ops/sidecar-unraid-o4-final-authorization-cli.ts', 'Phase 116 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-unraid-o4-closure-gate.ts && tsx test/sidecar-unraid-o4-final-authorization.ts'),
    'Phase 116 aggregate test follows Phase 115 closure gate',
  );

  const source = `${read('src/ops/sidecar-unraid-o4-final-authorization.ts')}\n${read('src/ops/sidecar-unraid-o4-final-authorization-cli.ts')}`;
  const combined = [source, read('docs/PHASE_116_SIDECAR_UNRAID_O4_FINAL_AUTHORIZATION.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-116-sidecar-unraid-o4-final-authorization',
    'phase-116-sidecar-unraid-o4-final-authorization-record',
    'phase-115-sidecar-unraid-o4-closure-gate-preflight',
    'o4-managed-custodian-boundary-only',
    'o4-authorized',
    'closed/authorized',
    'enabled O4 closure flag',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'productionReady: false',
    'closesO5: false',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 116 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 116 source excludes ${forbidden}`);
});

test('Phase 117 O5 KEK review verdict is redaction-safe and closure-gated', () => {
  assert(exists('docs/PHASE_117_O5_KEK_REVIEW_VERDICT.md'), 'Phase 117 O5 KEK review verdict doc exists');
  assert(exists('src/ops/o5-kek-review-verdict.ts'), 'Phase 117 O5 KEK review verdict source exists');
  assert(exists('src/ops/o5-kek-review-verdict-cli.ts'), 'Phase 117 O5 KEK review verdict CLI exists');
  assert(exists('test/o5-kek-review-verdict.ts'), 'Phase 117 O5 KEK review verdict test exists');
  assert(pkg.scripts['test:o5-kek-review-verdict'] === 'tsx test/o5-kek-review-verdict.ts', 'Phase 117 test script present');
  assert(pkg.scripts['ops:o5-kek-review-verdict'] === 'tsx src/ops/o5-kek-review-verdict-cli.ts', 'Phase 117 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-unraid-o4-final-authorization.ts && tsx test/o5-kek-review-verdict.ts'),
    'Phase 117 aggregate test follows Phase 116 O4 final authorization',
  );

  const source = `${read('src/ops/o5-kek-review-verdict.ts')}\n${read('src/ops/o5-kek-review-verdict-cli.ts')}`;
  const combined = [source, read('docs/PHASE_117_O5_KEK_REVIEW_VERDICT.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-117-o5-kek-review-verdict',
    'phase-117-o5-kek-review-verdict-preflight',
    'single-redacted-o5-kek-review-verdict-json-file',
    'phase-30-kek-evidence-preflight',
    'ready-for-o5-closure-gate',
    'GO',
    'HOLD',
    'REJECTED',
    'verdictValuesEchoed: false',
    'rawReviewerNotesIncluded: false',
    'commandExecution: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'productionReady: false',
    'closesO4: false',
    'closesO5: false',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 117 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 117 source excludes ${forbidden}`);
});

test('Phase 118 O5 KEK closure gate is redaction-safe and final-authorization-only', () => {
  assert(exists('docs/PHASE_118_O5_KEK_CLOSURE_GATE.md'), 'Phase 118 O5 KEK closure gate doc exists');
  assert(exists('src/ops/o5-kek-closure-gate.ts'), 'Phase 118 O5 KEK closure gate source exists');
  assert(exists('src/ops/o5-kek-closure-gate-cli.ts'), 'Phase 118 O5 KEK closure gate CLI exists');
  assert(exists('test/o5-kek-closure-gate.ts'), 'Phase 118 O5 KEK closure gate test exists');
  assert(pkg.scripts['test:o5-kek-closure-gate'] === 'tsx test/o5-kek-closure-gate.ts', 'Phase 118 test script present');
  assert(pkg.scripts['ops:o5-kek-closure-gate'] === 'tsx src/ops/o5-kek-closure-gate-cli.ts', 'Phase 118 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/o5-kek-review-verdict.ts && tsx test/o5-kek-closure-gate.ts'),
    'Phase 118 aggregate test follows Phase 117 O5 KEK review verdict',
  );

  const source = `${read('src/ops/o5-kek-closure-gate.ts')}\n${read('src/ops/o5-kek-closure-gate-cli.ts')}`;
  const combined = [source, read('docs/PHASE_118_O5_KEK_CLOSURE_GATE.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-118-o5-kek-closure-gate-preflight',
    'phase-30-kek-evidence-preflight',
    'phase-117-o5-kek-review-verdict-preflight',
    'ready-for-final-o5-authorization',
    'closure-ready-pending-final-authorization',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'productionReady: false',
    'closesO4: false',
    'closesO5: false',
    'O5 remains open',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 118 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 118 source excludes ${forbidden}`);
});

test('Phase 119 O5 KEK final authorization closes only O5', () => {
  assert(exists('docs/PHASE_119_O5_KEK_FINAL_AUTHORIZATION.md'), 'Phase 119 O5 final authorization doc exists');
  assert(exists('src/ops/o5-kek-final-authorization.ts'), 'Phase 119 O5 final authorization source exists');
  assert(exists('src/ops/o5-kek-final-authorization-cli.ts'), 'Phase 119 O5 final authorization CLI exists');
  assert(exists('test/o5-kek-final-authorization.ts'), 'Phase 119 O5 final authorization test exists');
  assert(pkg.scripts['test:o5-kek-final-authorization'] === 'tsx test/o5-kek-final-authorization.ts', 'Phase 119 test script present');
  assert(pkg.scripts['ops:o5-kek-final-authorization'] === 'tsx src/ops/o5-kek-final-authorization-cli.ts', 'Phase 119 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/o5-kek-closure-gate.ts && tsx test/o5-kek-final-authorization.ts'),
    'Phase 119 aggregate test follows Phase 118 O5 closure gate',
  );

  const source = `${read('src/ops/o5-kek-final-authorization.ts')}\n${read('src/ops/o5-kek-final-authorization-cli.ts')}`;
  const combined = [source, read('docs/PHASE_119_O5_KEK_FINAL_AUTHORIZATION.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-119-o5-kek-final-authorization',
    'phase-119-o5-kek-final-authorization-record',
    'phase-118-o5-kek-closure-gate-preflight',
    'o5-managed-kek-custody-only',
    'o5-authorized',
    'closed/authorized',
    'enabled O5 closure flag',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'productionReady: false',
    'closesO4: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 119 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 119 source excludes ${forbidden}`);
});

test('Phase 120 Unraid operator readiness bundle is offline planning only', () => {
  assert(exists('docs/PHASE_120_UNRAID_OPERATOR_READINESS_BUNDLE.md'), 'Phase 120 operator bundle doc exists');
  assert(exists('src/ops/unraid-operator-readiness-bundle.ts'), 'Phase 120 operator bundle source exists');
  assert(exists('src/ops/unraid-operator-readiness-bundle-cli.ts'), 'Phase 120 operator bundle CLI exists');
  assert(exists('test/unraid-operator-readiness-bundle.ts'), 'Phase 120 operator bundle test exists');
  assert(pkg.scripts['test:unraid-operator-readiness-bundle'] === 'tsx test/unraid-operator-readiness-bundle.ts', 'Phase 120 test script present');
  assert(pkg.scripts['ops:unraid-operator-readiness-bundle'] === 'tsx src/ops/unraid-operator-readiness-bundle-cli.ts', 'Phase 120 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/o5-kek-final-authorization.ts && tsx test/o5-disposition.ts && tsx test/launch-readiness-pass.ts && tsx test/launch-package.ts && tsx test/launch-candidate-dry-run.ts && tsx test/media-player-boundary.ts && tsx test/jellyfin-readonly-smoke.ts && tsx test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 120 aggregate test follows Phase 119 O5 final authorization through Phase 199 disposition',
  );

  const source = `${read('src/ops/unraid-operator-readiness-bundle.ts')}\n${read('src/ops/unraid-operator-readiness-bundle-cli.ts')}`;
  const combined = [source, read('docs/PHASE_120_UNRAID_OPERATOR_READINESS_BUNDLE.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-120-unraid-operator-readiness-bundle',
    'UNRAID_OPERATOR_READINESS_BUNDLE',
    'phase-116-sidecar-unraid-o4-final-authorization',
    'phase-119-o5-kek-final-authorization',
    'summarize-closed-o4-o5-evidence-for-unraid-deployment-planning',
    'o4Status: closed/authorized',
    'o5Status: closed/authorized',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'serviceInstallApproved: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: false',
    'closesO4: false',
    'closesO5: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 120 surface preserves ${required}`);
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 120 source excludes ${forbidden}`);
});

test('Phase 121 Unraid service install runbook is draft-only and mutation-free', () => {
  assert(exists('docs/PHASE_121_UNRAID_SERVICE_INSTALL_RUNBOOK.md'), 'Phase 121 service runbook doc exists');
  assert(exists('src/ops/unraid-service-install-runbook.ts'), 'Phase 121 service runbook source exists');
  assert(exists('src/ops/unraid-service-install-runbook-cli.ts'), 'Phase 121 service runbook CLI exists');
  assert(exists('test/unraid-service-install-runbook.ts'), 'Phase 121 service runbook test exists');
  assert(pkg.scripts['test:unraid-service-install-runbook'] === 'tsx test/unraid-service-install-runbook.ts', 'Phase 121 test script present');
  assert(pkg.scripts['ops:unraid-service-install-runbook'] === 'tsx src/ops/unraid-service-install-runbook-cli.ts', 'Phase 121 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-operator-readiness-bundle.ts && tsx test/unraid-service-install-runbook.ts'),
    'Phase 121 aggregate test follows Phase 120 operator readiness bundle',
  );

  const source = `${read('src/ops/unraid-service-install-runbook.ts')}\n${read('src/ops/unraid-service-install-runbook-cli.ts')}`;
  const combined = [source, read('docs/PHASE_121_UNRAID_SERVICE_INSTALL_RUNBOOK.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-121-unraid-service-install-runbook',
    'UNRAID_SERVICE_INSTALL_RUNBOOK',
    'phase-120-unraid-operator-readiness-bundle',
    'prepare-reviewed-unraid-service-install-and-rollback-plan-without-mutation',
    'draft-pending-operator-review',
    'o4Status: closed/authorized',
    'o5Status: closed/authorized',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstallApproved: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'mutatesUnraid: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: false',
    'closesO4: false',
    'closesO5: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 121 surface preserves ${required}`);
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 121 source excludes ${forbidden}`);
});

test('Phase 122 Unraid service runbook approval gate is review-only and install-free', () => {
  assert(exists('docs/PHASE_122_UNRAID_SERVICE_RUNBOOK_APPROVAL_GATE.md'), 'Phase 122 approval gate doc exists');
  assert(exists('src/ops/unraid-service-runbook-approval-gate.ts'), 'Phase 122 approval gate source exists');
  assert(exists('src/ops/unraid-service-runbook-approval-gate-cli.ts'), 'Phase 122 approval gate CLI exists');
  assert(exists('test/unraid-service-runbook-approval-gate.ts'), 'Phase 122 approval gate test exists');
  assert(pkg.scripts['test:unraid-service-runbook-approval-gate'] === 'tsx test/unraid-service-runbook-approval-gate.ts', 'Phase 122 test script present');
  assert(pkg.scripts['ops:unraid-service-runbook-approval-gate'] === 'tsx src/ops/unraid-service-runbook-approval-gate-cli.ts', 'Phase 122 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-service-install-runbook.ts && tsx test/unraid-service-runbook-approval-gate.ts'),
    'Phase 122 aggregate test follows Phase 121 service install runbook',
  );

  const source = `${read('src/ops/unraid-service-runbook-approval-gate.ts')}\n${read('src/ops/unraid-service-runbook-approval-gate-cli.ts')}`;
  const combined = [source, read('docs/PHASE_122_UNRAID_SERVICE_RUNBOOK_APPROVAL_GATE.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-122-unraid-service-runbook-approval-gate',
    'phase-122-unraid-service-runbook-approval-record',
    'phase-121-unraid-service-install-runbook',
    'gate-redacted-runbook-review-before-future-service-install-authorization',
    'ready-for-future-install-authorization',
    'readyForInstallAuthorization: true',
    'inputValuesEchoed: false',
    'rawReviewerNotesIncluded: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstallApproved: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'mutatesUnraid: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: false',
    'closesO4: false',
    'closesO5: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 122 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 122 source excludes ${forbidden}`);
});

test('Phase 123 Unraid service install authorization approves window only', () => {
  assert(exists('docs/PHASE_123_UNRAID_SERVICE_INSTALL_AUTHORIZATION.md'), 'Phase 123 install authorization doc exists');
  assert(exists('src/ops/unraid-service-install-authorization.ts'), 'Phase 123 install authorization source exists');
  assert(exists('src/ops/unraid-service-install-authorization-cli.ts'), 'Phase 123 install authorization CLI exists');
  assert(exists('test/unraid-service-install-authorization.ts'), 'Phase 123 install authorization test exists');
  assert(pkg.scripts['test:unraid-service-install-authorization'] === 'tsx test/unraid-service-install-authorization.ts', 'Phase 123 test script present');
  assert(pkg.scripts['ops:unraid-service-install-authorization'] === 'tsx src/ops/unraid-service-install-authorization-cli.ts', 'Phase 123 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-service-runbook-approval-gate.ts && tsx test/unraid-service-install-authorization.ts'),
    'Phase 123 aggregate test follows Phase 122 approval gate',
  );

  const source = `${read('src/ops/unraid-service-install-authorization.ts')}\n${read('src/ops/unraid-service-install-authorization-cli.ts')}`;
  const combined = [source, read('docs/PHASE_123_UNRAID_SERVICE_INSTALL_AUTHORIZATION.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-123-unraid-service-install-authorization',
    'phase-123-unraid-service-install-authorization-record',
    'phase-122-unraid-service-runbook-approval-gate',
    'authorize-future-operator-run-unraid-service-install-window-without-execution',
    'install-window-authorized',
    'serviceInstallApproved: true',
    'inputValuesEchoed: false',
    'rawAuthorizationNotesIncluded: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'mutatesUnraid: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: false',
    'closesO4: false',
    'closesO5: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 123 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 123 source excludes ${forbidden}`);
});

test('Phase 124 Unraid install evidence manifest is capture-only and mutation-free', () => {
  assert(exists('docs/PHASE_124_UNRAID_INSTALL_EVIDENCE_MANIFEST.md'), 'Phase 124 evidence manifest doc exists');
  assert(exists('src/ops/unraid-install-evidence-manifest.ts'), 'Phase 124 evidence manifest source exists');
  assert(exists('src/ops/unraid-install-evidence-manifest-cli.ts'), 'Phase 124 evidence manifest CLI exists');
  assert(exists('test/unraid-install-evidence-manifest.ts'), 'Phase 124 evidence manifest test exists');
  assert(pkg.scripts['test:unraid-install-evidence-manifest'] === 'tsx test/unraid-install-evidence-manifest.ts', 'Phase 124 test script present');
  assert(pkg.scripts['ops:unraid-install-evidence-manifest'] === 'tsx src/ops/unraid-install-evidence-manifest-cli.ts', 'Phase 124 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-service-install-authorization.ts && tsx test/unraid-install-evidence-manifest.ts'),
    'Phase 124 aggregate test follows Phase 123 install authorization',
  );

  const source = `${read('src/ops/unraid-install-evidence-manifest.ts')}\n${read('src/ops/unraid-install-evidence-manifest-cli.ts')}`;
  const combined = [source, read('docs/PHASE_124_UNRAID_INSTALL_EVIDENCE_MANIFEST.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-124-unraid-install-evidence-manifest',
    'UNRAID_INSTALL_EVIDENCE_MANIFEST',
    'phase-123-unraid-service-install-authorization',
    'define-redacted-evidence-required-after-authorized-operator-install-window',
    'ready-for-operator-capture',
    'serviceInstallApproved: true',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'mutatesUnraid: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: false',
    'closesO4: false',
    'closesO5: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 124 surface preserves ${required}`);
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 124 source excludes ${forbidden}`);
});

test('Phases 125-127 Unraid production gates are evidence/review/decision only', () => {
  assert(exists('docs/PHASE_125_127_UNRAID_PRODUCTION_GATES.md'), 'Phase 125-127 production gates doc exists');
  for (const rel of [
    'src/ops/unraid-install-evidence-capture-gate.ts',
    'src/ops/unraid-install-evidence-capture-gate-cli.ts',
    'src/ops/unraid-post-install-validation-review.ts',
    'src/ops/unraid-post-install-validation-review-cli.ts',
    'src/ops/unraid-production-readiness-decision.ts',
    'src/ops/unraid-production-readiness-decision-cli.ts',
    'test/unraid-production-gates.ts',
  ]) assert(exists(rel), `${rel} exists`);
  assert(pkg.scripts['test:unraid-production-gates'] === 'tsx test/unraid-production-gates.ts', 'Phase 125-127 test script present');
  assert(pkg.scripts['ops:unraid-install-evidence-capture-gate'] === 'tsx src/ops/unraid-install-evidence-capture-gate-cli.ts', 'Phase 125 ops script present');
  assert(pkg.scripts['ops:unraid-post-install-validation-review'] === 'tsx src/ops/unraid-post-install-validation-review-cli.ts', 'Phase 126 ops script present');
  assert(pkg.scripts['ops:unraid-production-readiness-decision'] === 'tsx src/ops/unraid-production-readiness-decision-cli.ts', 'Phase 127 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-install-evidence-manifest.ts && tsx test/unraid-production-gates.ts'),
    'Phase 125-127 aggregate test follows Phase 124 evidence manifest',
  );

  const source = [
    'src/ops/unraid-install-evidence-capture-gate.ts',
    'src/ops/unraid-install-evidence-capture-gate-cli.ts',
    'src/ops/unraid-post-install-validation-review.ts',
    'src/ops/unraid-post-install-validation-review-cli.ts',
    'src/ops/unraid-production-readiness-decision.ts',
    'src/ops/unraid-production-readiness-decision-cli.ts',
  ].map(read).join('\n');
  const combined = [source, read('docs/PHASE_125_127_UNRAID_PRODUCTION_GATES.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-125-unraid-install-evidence-capture-gate',
    'phase-126-unraid-post-install-validation-review',
    'phase-127-unraid-production-readiness-decision',
    'complete-ready-for-post-install-review',
    'ready-for-production-readiness-decision',
    'ready-for-final-human-production-approval',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 125-127 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 125-127 source excludes ${forbidden}`);
});

test('Phase 128 Unraid final human approval template is approval-template-only', () => {
  assert(exists('docs/PHASE_128_UNRAID_FINAL_HUMAN_APPROVAL_TEMPLATE.md'), 'Phase 128 approval template doc exists');
  assert(exists('src/ops/unraid-final-human-approval-template.ts'), 'Phase 128 approval template source exists');
  assert(exists('src/ops/unraid-final-human-approval-template-cli.ts'), 'Phase 128 approval template CLI exists');
  assert(exists('test/unraid-final-human-approval-template.ts'), 'Phase 128 approval template test exists');
  assert(pkg.scripts['test:unraid-final-human-approval-template'] === 'tsx test/unraid-final-human-approval-template.ts', 'Phase 128 test script present');
  assert(pkg.scripts['ops:unraid-final-human-approval-template'] === 'tsx src/ops/unraid-final-human-approval-template-cli.ts', 'Phase 128 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-production-gates.ts && tsx test/unraid-final-human-approval-template.ts'),
    'Phase 128 aggregate test follows Phase 125-127 production gates',
  );

  const source = `${read('src/ops/unraid-final-human-approval-template.ts')}\n${read('src/ops/unraid-final-human-approval-template-cli.ts')}`;
  const combined = [source, read('docs/PHASE_128_UNRAID_FINAL_HUMAN_APPROVAL_TEMPLATE.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-128-unraid-final-human-approval-template',
    'UNRAID_FINAL_HUMAN_APPROVAL_TEMPLATE',
    'phase-128-unraid-final-human-production-approval-record',
    'phase-127-unraid-production-readiness-decision',
    'awaiting-explicit-human-approval',
    'productionReady: false',
    'launchApproved: false',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 128 surface preserves ${required}`);
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 128 source excludes ${forbidden}`);
});

test('Phase 129 Unraid final human approval record is preflight-only', () => {
  assert(exists('docs/PHASE_129_UNRAID_FINAL_HUMAN_APPROVAL_RECORD.md'), 'Phase 129 final approval record doc exists');
  assert(exists('src/ops/unraid-final-human-approval-record.ts'), 'Phase 129 final approval record source exists');
  assert(exists('src/ops/unraid-final-human-approval-record-cli.ts'), 'Phase 129 final approval record CLI exists');
  assert(exists('test/unraid-final-human-approval-record.ts'), 'Phase 129 final approval record test exists');
  assert(pkg.scripts['test:unraid-final-human-approval-record'] === 'tsx test/unraid-final-human-approval-record.ts', 'Phase 129 test script present');
  assert(pkg.scripts['ops:unraid-final-human-approval-record'] === 'tsx src/ops/unraid-final-human-approval-record-cli.ts', 'Phase 129 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-final-human-approval-template.ts && tsx test/unraid-final-human-approval-record.ts'),
    'Phase 129 aggregate test follows Phase 128 approval template',
  );

  const source = `${read('src/ops/unraid-final-human-approval-record.ts')}\n${read('src/ops/unraid-final-human-approval-record-cli.ts')}`;
  const combined = [source, read('docs/PHASE_129_UNRAID_FINAL_HUMAN_APPROVAL_RECORD.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-129-unraid-final-human-approval-record-preflight',
    'phase-128-unraid-final-human-production-approval-record',
    'phase-128-unraid-final-human-approval-template',
    'phase-127-unraid-production-readiness-decision',
    'ready-for-operator-production-switch',
    'single-operator-supplied-final-human-approval-record-json-file',
    'recordValuesEchoed: false',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 129 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 129 source excludes ${forbidden}`);
});

test('Phase 130 Unraid production switch runbook is runbook-only', () => {
  assert(exists('docs/PHASE_130_UNRAID_PRODUCTION_SWITCH_RUNBOOK.md'), 'Phase 130 production switch runbook doc exists');
  assert(exists('src/ops/unraid-production-switch-runbook.ts'), 'Phase 130 production switch runbook source exists');
  assert(exists('src/ops/unraid-production-switch-runbook-cli.ts'), 'Phase 130 production switch runbook CLI exists');
  assert(exists('test/unraid-production-switch-runbook.ts'), 'Phase 130 production switch runbook test exists');
  assert(pkg.scripts['test:unraid-production-switch-runbook'] === 'tsx test/unraid-production-switch-runbook.ts', 'Phase 130 test script present');
  assert(pkg.scripts['ops:unraid-production-switch-runbook'] === 'tsx src/ops/unraid-production-switch-runbook-cli.ts', 'Phase 130 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-final-human-approval-record.ts && tsx test/unraid-production-switch-runbook.ts'),
    'Phase 130 aggregate test follows Phase 129 final human approval record',
  );

  const source = `${read('src/ops/unraid-production-switch-runbook.ts')}\n${read('src/ops/unraid-production-switch-runbook-cli.ts')}`;
  const combined = [source, read('docs/PHASE_130_UNRAID_PRODUCTION_SWITCH_RUNBOOK.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-130-unraid-production-switch-runbook',
    'phase-129-unraid-final-human-approval-record-preflight',
    'ready-for-explicit-operator-window',
    'unraid-live-operating-test-2026-07-08.redacted.md',
    'docker-compose.unraid.yml',
    'recordValuesEchoed: false',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 130 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'execSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 130 source excludes ${forbidden}`);
});

test('Phase 131 Unraid switch evidence capture is capture-only', () => {
  assert(exists('docs/PHASE_131_UNRAID_SWITCH_EVIDENCE_CAPTURE.md'), 'Phase 131 switch evidence capture doc exists');
  assert(exists('src/ops/unraid-switch-evidence-capture.ts'), 'Phase 131 switch evidence capture source exists');
  assert(exists('src/ops/unraid-switch-evidence-capture-cli.ts'), 'Phase 131 switch evidence capture CLI exists');
  assert(exists('test/unraid-switch-evidence-capture.ts'), 'Phase 131 switch evidence capture test exists');
  assert(pkg.scripts['test:unraid-switch-evidence-capture'] === 'tsx test/unraid-switch-evidence-capture.ts', 'Phase 131 test script present');
  assert(pkg.scripts['ops:unraid-switch-evidence-capture'] === 'tsx src/ops/unraid-switch-evidence-capture-cli.ts', 'Phase 131 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-production-switch-runbook.ts && tsx test/unraid-switch-evidence-capture.ts'),
    'Phase 131 aggregate test follows Phase 130 production switch runbook',
  );

  const source = `${read('src/ops/unraid-switch-evidence-capture.ts')}\n${read('src/ops/unraid-switch-evidence-capture-cli.ts')}`;
  const combined = [source, read('docs/PHASE_131_UNRAID_SWITCH_EVIDENCE_CAPTURE.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-131-unraid-switch-evidence-capture',
    'phase-130-unraid-production-switch-runbook',
    'phase-129-unraid-final-human-approval-record-preflight',
    'ready-for-explicit-operator-window',
    'ready-for-operator-capture-after-switch',
    'unraid-live-operating-test-2026-07-08.redacted.md',
    'docker-compose.unraid.yml',
    'post-switch-doctor-redacted-json',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 131 surface preserves ${required}`);
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 131 source excludes ${forbidden}`);
});

test('Phase 132 Unraid switch evidence review is review-only', () => {
  assert(exists('docs/PHASE_132_UNRAID_SWITCH_EVIDENCE_REVIEW.md'), 'Phase 132 switch evidence review doc exists');
  assert(exists('src/ops/unraid-switch-evidence-review.ts'), 'Phase 132 switch evidence review source exists');
  assert(exists('src/ops/unraid-switch-evidence-review-cli.ts'), 'Phase 132 switch evidence review CLI exists');
  assert(exists('test/unraid-switch-evidence-review.ts'), 'Phase 132 switch evidence review test exists');
  assert(pkg.scripts['test:unraid-switch-evidence-review'] === 'tsx test/unraid-switch-evidence-review.ts', 'Phase 132 test script present');
  assert(pkg.scripts['ops:unraid-switch-evidence-review'] === 'tsx src/ops/unraid-switch-evidence-review-cli.ts', 'Phase 132 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-switch-evidence-capture.ts && tsx test/unraid-switch-evidence-review.ts'),
    'Phase 132 aggregate test follows Phase 131 switch evidence capture',
  );

  const source = `${read('src/ops/unraid-switch-evidence-review.ts')}\n${read('src/ops/unraid-switch-evidence-review-cli.ts')}`;
  const combined = [source, read('docs/PHASE_132_UNRAID_SWITCH_EVIDENCE_REVIEW.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-132-unraid-switch-evidence-review',
    'phase-132-unraid-switch-evidence-record',
    'phase-131-unraid-switch-evidence-capture',
    'phase-130-unraid-production-switch-runbook',
    'single-operator-supplied-unraid-switch-evidence-json-file',
    'service-evidence-present',
    'ready-for-final-production-disposition',
    'evidenceValuesEchoed: false',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 132 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 132 source excludes ${forbidden}`);
});

test('Phase 133 Unraid production disposition is disposition-only', () => {
  assert(exists('docs/PHASE_133_UNRAID_PRODUCTION_DISPOSITION.md'), 'Phase 133 production disposition doc exists');
  assert(exists('src/ops/unraid-production-disposition.ts'), 'Phase 133 production disposition source exists');
  assert(exists('src/ops/unraid-production-disposition-cli.ts'), 'Phase 133 production disposition CLI exists');
  assert(exists('test/unraid-production-disposition.ts'), 'Phase 133 production disposition test exists');
  assert(pkg.scripts['test:unraid-production-disposition'] === 'tsx test/unraid-production-disposition.ts', 'Phase 133 test script present');
  assert(pkg.scripts['ops:unraid-production-disposition'] === 'tsx src/ops/unraid-production-disposition-cli.ts', 'Phase 133 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-switch-evidence-review.ts && tsx test/unraid-production-disposition.ts'),
    'Phase 133 aggregate test follows Phase 132 switch evidence review',
  );

  const source = `${read('src/ops/unraid-production-disposition.ts')}\n${read('src/ops/unraid-production-disposition-cli.ts')}`;
  const combined = [source, read('docs/PHASE_133_UNRAID_PRODUCTION_DISPOSITION.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-133-unraid-production-disposition',
    'phase-133-unraid-production-disposition-record',
    'phase-132-unraid-switch-evidence-review',
    'single-operator-supplied-unraid-production-disposition-json-file',
    'ready-for-final-production-disposition',
    'service-evidence-present',
    'ready-for-launch-readiness-decision',
    'dispositionValuesEchoed: false',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 133 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 133 source excludes ${forbidden}`);
});

test('Phase 134 Unraid launch readiness decision is launch-readiness-only', () => {
  assert(exists('docs/PHASE_134_UNRAID_LAUNCH_READINESS_DECISION.md'), 'Phase 134 launch readiness decision doc exists');
  assert(exists('src/ops/unraid-launch-readiness-decision.ts'), 'Phase 134 launch readiness decision source exists');
  assert(exists('src/ops/unraid-launch-readiness-decision-cli.ts'), 'Phase 134 launch readiness decision CLI exists');
  assert(exists('test/unraid-launch-readiness-decision.ts'), 'Phase 134 launch readiness decision test exists');
  assert(pkg.scripts['test:unraid-launch-readiness-decision'] === 'tsx test/unraid-launch-readiness-decision.ts', 'Phase 134 test script present');
  assert(pkg.scripts['ops:unraid-launch-readiness-decision'] === 'tsx src/ops/unraid-launch-readiness-decision-cli.ts', 'Phase 134 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-production-disposition.ts && tsx test/unraid-launch-readiness-decision.ts'),
    'Phase 134 aggregate test follows Phase 133 production disposition',
  );

  const source = `${read('src/ops/unraid-launch-readiness-decision.ts')}\n${read('src/ops/unraid-launch-readiness-decision-cli.ts')}`;
  const combined = [source, read('docs/PHASE_134_UNRAID_LAUNCH_READINESS_DECISION.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-134-unraid-launch-readiness-decision',
    'phase-133-unraid-production-disposition',
    'single-operator-supplied-unraid-production-disposition-json-file',
    'ready-for-launch-readiness-decision',
    'ready-for-final-launch-approval-record',
    'decisionValuesEchoed: false',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 134 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 134 source excludes ${forbidden}`);
});

test('Phase 135 Unraid final launch approval record is approval-only', () => {
  assert(exists('docs/PHASE_135_UNRAID_FINAL_LAUNCH_APPROVAL_RECORD.md'), 'Phase 135 final launch approval doc exists');
  assert(exists('src/ops/unraid-final-launch-approval-record.ts'), 'Phase 135 final launch approval source exists');
  assert(exists('src/ops/unraid-final-launch-approval-record-cli.ts'), 'Phase 135 final launch approval CLI exists');
  assert(exists('test/unraid-final-launch-approval-record.ts'), 'Phase 135 final launch approval test exists');
  assert(pkg.scripts['test:unraid-final-launch-approval-record'] === 'tsx test/unraid-final-launch-approval-record.ts', 'Phase 135 test script present');
  assert(pkg.scripts['ops:unraid-final-launch-approval-record'] === 'tsx src/ops/unraid-final-launch-approval-record-cli.ts', 'Phase 135 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-launch-readiness-decision.ts && tsx test/unraid-final-launch-approval-record.ts'),
    'Phase 135 aggregate test follows Phase 134 launch readiness decision',
  );

  const source = `${read('src/ops/unraid-final-launch-approval-record.ts')}\n${read('src/ops/unraid-final-launch-approval-record-cli.ts')}`;
  const combined = [source, read('docs/PHASE_135_UNRAID_FINAL_LAUNCH_APPROVAL_RECORD.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-135-unraid-final-launch-approval-record',
    'phase-134-unraid-launch-readiness-decision',
    'APPROVE_UNRAID_PRODUCTION_SWITCH',
    'ready-for-final-launch-approval-record',
    'ready-for-production-switch-execution-packet',
    'approvalValuesEchoed: false',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: true',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 135 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 135 source excludes ${forbidden}`);
});

test('Phase 136 Unraid production switch execution packet is packet-only', () => {
  assert(exists('docs/PHASE_136_UNRAID_PRODUCTION_SWITCH_EXECUTION_PACKET.md'), 'Phase 136 execution packet doc exists');
  assert(exists('src/ops/unraid-production-switch-execution-packet.ts'), 'Phase 136 execution packet source exists');
  assert(exists('src/ops/unraid-production-switch-execution-packet-cli.ts'), 'Phase 136 execution packet CLI exists');
  assert(exists('test/unraid-production-switch-execution-packet.ts'), 'Phase 136 execution packet test exists');
  assert(pkg.scripts['test:unraid-production-switch-execution-packet'] === 'tsx test/unraid-production-switch-execution-packet.ts', 'Phase 136 test script present');
  assert(pkg.scripts['ops:unraid-production-switch-execution-packet'] === 'tsx src/ops/unraid-production-switch-execution-packet-cli.ts', 'Phase 136 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-final-launch-approval-record.ts && tsx test/unraid-production-switch-execution-packet.ts'),
    'Phase 136 aggregate test follows Phase 135 final launch approval record',
  );

  const source = `${read('src/ops/unraid-production-switch-execution-packet.ts')}\n${read('src/ops/unraid-production-switch-execution-packet-cli.ts')}`;
  const combined = [source, read('docs/PHASE_136_UNRAID_PRODUCTION_SWITCH_EXECUTION_PACKET.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-136-unraid-production-switch-execution-packet',
    'phase-135-unraid-final-launch-approval-record',
    'ready-for-production-switch-execution-packet',
    'ready-for-real-unraid-production-switch',
    'packetValuesEchoed: false',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'mutatesUnraid: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: true',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 136 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'execSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 136 source excludes ${forbidden}`);
});

test('Phase 137 Unraid post-switch evidence review records operational service with warnings', () => {
  assert(exists('docs/PHASE_137_UNRAID_POST_SWITCH_EVIDENCE_REVIEW.md'), 'Phase 137 post-switch evidence doc exists');
  assert(exists('src/ops/unraid-post-switch-evidence-review.ts'), 'Phase 137 post-switch evidence source exists');
  assert(exists('src/ops/unraid-post-switch-evidence-review-cli.ts'), 'Phase 137 post-switch evidence CLI exists');
  assert(exists('test/unraid-post-switch-evidence-review.ts'), 'Phase 137 post-switch evidence test exists');
  assert(pkg.scripts['test:unraid-post-switch-evidence-review'] === 'tsx test/unraid-post-switch-evidence-review.ts', 'Phase 137 test script present');
  assert(pkg.scripts['ops:unraid-post-switch-evidence-review'] === 'tsx src/ops/unraid-post-switch-evidence-review-cli.ts', 'Phase 137 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-production-switch-execution-packet.ts && tsx test/unraid-post-switch-evidence-review.ts'),
    'Phase 137 aggregate test follows Phase 136 execution packet',
  );

  const source = `${read('src/ops/unraid-post-switch-evidence-review.ts')}\n${read('src/ops/unraid-post-switch-evidence-review-cli.ts')}`;
  const combined = [source, read('docs/PHASE_137_UNRAID_POST_SWITCH_EVIDENCE_REVIEW.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-137-unraid-post-switch-evidence-review',
    'phase-136-unraid-production-switch-execution-packet',
    'ready-for-real-unraid-production-switch',
    'service-running-with-open-hardening-warnings',
    'serviceInstalled: true',
    'serviceStarted: true',
    'launchApproved: true',
    'productionReady: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'o4Status: open-warning',
    'o5Status: open-warning',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 137 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 137 source excludes ${forbidden}`);
});

test('Phase 138 Unraid post-switch maintenance review records maintenance evidence', () => {
  assert(exists('docs/PHASE_138_UNRAID_POST_SWITCH_MAINTENANCE_REVIEW.md'), 'Phase 138 maintenance review doc exists');
  assert(exists('src/ops/unraid-post-switch-maintenance-review.ts'), 'Phase 138 maintenance review source exists');
  assert(exists('src/ops/unraid-post-switch-maintenance-review-cli.ts'), 'Phase 138 maintenance review CLI exists');
  assert(exists('test/unraid-post-switch-maintenance-review.ts'), 'Phase 138 maintenance review test exists');
  assert(pkg.scripts['test:unraid-post-switch-maintenance-review'] === 'tsx test/unraid-post-switch-maintenance-review.ts', 'Phase 138 test script present');
  assert(pkg.scripts['ops:unraid-post-switch-maintenance-review'] === 'tsx src/ops/unraid-post-switch-maintenance-review-cli.ts', 'Phase 138 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-post-switch-evidence-review.ts && tsx test/unraid-post-switch-maintenance-review.ts'),
    'Phase 138 aggregate test follows Phase 137 post-switch evidence review',
  );

  const source = `${read('src/ops/unraid-post-switch-maintenance-review.ts')}\n${read('src/ops/unraid-post-switch-maintenance-review-cli.ts')}`;
  const combined = [source, read('docs/PHASE_138_UNRAID_POST_SWITCH_MAINTENANCE_REVIEW.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-138-unraid-post-switch-maintenance-review',
    'phase-137-unraid-post-switch-evidence-review',
    'post-switch-maintenance-evidence-accepted',
    'serviceInstalled: true',
    'serviceStarted: true',
    'launchApproved: true',
    'productionReady: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 138 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 138 source excludes ${forbidden}`);
});

test('Phase 139 Unraid restart persistence review records restart evidence', () => {
  assert(exists('docs/PHASE_139_UNRAID_RESTART_PERSISTENCE_REVIEW.md'), 'Phase 139 restart persistence doc exists');
  assert(exists('src/ops/unraid-restart-persistence-review.ts'), 'Phase 139 restart persistence source exists');
  assert(exists('src/ops/unraid-restart-persistence-review-cli.ts'), 'Phase 139 restart persistence CLI exists');
  assert(exists('test/unraid-restart-persistence-review.ts'), 'Phase 139 restart persistence test exists');
  assert(pkg.scripts['test:unraid-restart-persistence-review'] === 'tsx test/unraid-restart-persistence-review.ts', 'Phase 139 test script present');
  assert(pkg.scripts['ops:unraid-restart-persistence-review'] === 'tsx src/ops/unraid-restart-persistence-review-cli.ts', 'Phase 139 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-post-switch-maintenance-review.ts && tsx test/unraid-restart-persistence-review.ts'),
    'Phase 139 aggregate test follows Phase 138 maintenance review',
  );

  const source = `${read('src/ops/unraid-restart-persistence-review.ts')}\n${read('src/ops/unraid-restart-persistence-review-cli.ts')}`;
  const combined = [source, read('docs/PHASE_139_UNRAID_RESTART_PERSISTENCE_REVIEW.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-139-unraid-restart-persistence-review',
    'phase-138-unraid-post-switch-maintenance-review',
    'restart-persistence-evidence-accepted',
    'serverRebooted: false',
    'serviceInstalled: true',
    'serviceStarted: true',
    'launchApproved: true',
    'productionReady: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 139 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 139 source excludes ${forbidden}`);
});

test('Phase 140 control surface Compose boundary stops before Compose changes', () => {
  assert(exists('docs/PHASE_140_CONTROL_SURFACE_COMPOSE_BOUNDARY.md'), 'Phase 140 control surface Compose boundary doc exists');
  assert(exists('src/ops/control-surface-compose-boundary.ts'), 'Phase 140 control surface Compose boundary source exists');
  assert(exists('src/ops/control-surface-compose-boundary-cli.ts'), 'Phase 140 control surface Compose boundary CLI exists');
  assert(exists('test/control-surface-compose-boundary.ts'), 'Phase 140 control surface Compose boundary test exists');
  assert(pkg.scripts['test:control-surface-compose-boundary'] === 'tsx test/control-surface-compose-boundary.ts', 'Phase 140 test script present');
  assert(pkg.scripts['ops:control-surface-compose-boundary'] === 'tsx src/ops/control-surface-compose-boundary-cli.ts', 'Phase 140 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/unraid-restart-persistence-review.ts && tsx test/control-surface-compose-boundary.ts'),
    'Phase 140 aggregate test follows Phase 139 restart persistence review',
  );

  const source = `${read('src/ops/control-surface-compose-boundary.ts')}\n${read('src/ops/control-surface-compose-boundary-cli.ts')}`;
  const combined = [source, read('docs/PHASE_140_CONTROL_SURFACE_COMPOSE_BOUNDARY.md'), read('README.md'), read('package.json')].join('\n');
  for (const required of [
    'phase-140-control-surface-compose-boundary',
    'phase-139-unraid-restart-persistence-review',
    'readyForComposeSection: true',
    'requiresHumanLoopBeforeCompose: true',
    'composeStarted: false',
    'arcaneSelected: false',
    'dockhandControlsInstalled: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'mutatesUnraid: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 140 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 140 source excludes ${forbidden}`);
});

test('Phase 142 Unraid launcher runtime compose is image-mode', () => {
  assert(exists('docs/PHASE_142_UNRAID_LAUNCHER_RUNTIME_COMPOSE.md'), 'Phase 142 launcher runtime doc exists');
  assert(exists('docker-compose.unraid.runtime.yml'), 'Phase 142 runtime compose exists');

  const combined = [
    unraidRuntimeCompose,
    read('docs/PHASE_142_UNRAID_LAUNCHER_RUNTIME_COMPOSE.md'),
    read('docs/PHASE_3_DEPLOYMENT.md'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'docker-compose.unraid.runtime.yml',
    'image: ${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}',
    'Launcher/runtime path',
    'Arcane',
    'public Unraid release entrypoint',
    'catalogauthority-postgres-1',
    'catalogauthority-ops-1',
    'one-shot',
    'expected to exit',
  ]) assert(combined.includes(required), `Phase 142 surface preserves ${required}`);
  assert(!/^\s+build:/m.test(unraidRuntimeCompose), 'Phase 142 runtime compose has no build context');
  assert(/^\s{2}app:/m.test(unraidRuntimeCompose), 'Phase 147 runtime compose has app service');
  assert(unraidRuntimeCompose.includes('"${OPERATOR_UI_HOST_PORT:-8099}:8099"'), 'Phase 147 runtime compose publishes intentional operator UI port');
  assert(!/(expose|EXPOSE)/.test(unraidRuntimeCompose), 'Phase 142 runtime compose exposes no ports');
});

test('Phase 144 runtime image override preserves local default and future published image path', () => {
  assert(exists('docs/PHASE_144_RUNTIME_IMAGE_OVERRIDE.md'), 'Phase 144 runtime image override doc exists');
  const combined = [
    unraidRuntimeCompose,
    read('docs/PHASE_144_RUNTIME_IMAGE_OVERRIDE.md'),
    read('docs/PHASE_3_DEPLOYMENT.md'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase 144',
    'CATALOG_AUTHORITY_OPS_IMAGE',
    '${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}',
    'repo-ops:latest',
    'ghcr.io/OWNER/catalog-authority-ops:TAG',
    'without editing the compose file',
    'does not publish an image',
    'does not publish',
    'one-shot',
  ]) assert(combined.toLowerCase().includes(required.toLowerCase()), `Phase 144 surface preserves ${required}`);
  assert(!/^\s+build:/m.test(unraidRuntimeCompose), 'Phase 144 runtime compose still has no build context');
  assert(unraidRuntimeCompose.includes('image: ${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}'), 'Phase 144 runtime app still uses configurable image');
  assert(unraidRuntimeCompose.includes('"${OPERATOR_UI_HOST_PORT:-8099}:8099"'), 'Phase 147 runtime app publishes intentional operator UI port');
  assert(!/(expose|EXPOSE)/.test(unraidRuntimeCompose), 'Phase 144 runtime compose exposes no ports');
});

test('Phase 145 image publishing readiness is local-only and build-context safe', () => {
  assert(exists('docs/PHASE_145_IMAGE_PUBLISHING_READINESS.md'), 'Phase 145 image publishing readiness doc exists');
  assert(exists('.dockerignore'), 'Docker build context ignore file exists');
  assert(pkg.scripts['image:build:local'] === 'docker build -t repo-ops:latest .', 'local image build script present');
  assert(pkg.scripts['image:inspect:local'] === 'docker image inspect repo-ops:latest', 'local image inspect script present');

  const combined = [
    dockerignore,
    read('docs/PHASE_145_IMAGE_PUBLISHING_READINESS.md'),
    read('docs/PHASE_3_DEPLOYMENT.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const required of [
    'Phase 145',
    'ghcr.io/OWNER/catalog-authority-ops:TAG',
    'repo-ops:latest',
    'image:build:local',
    'image:inspect:local',
    'explicit release approval',
    'does not publish an image',
    'contact a registry',
    'CATALOG_AUTHORITY_OPS_IMAGE',
    '.agentsroom',
    '.pgdata-*',
    'node_modules',
    '*.bundle',
  ]) assert(combined.includes(required), `Phase 145 surface preserves ${required}`);
  assert(!/docker\s+push/.test(pkg.scripts['image:build:local'] ?? ''), 'local build script does not push');
  assert(!/docker\s+push/.test(pkg.scripts['image:inspect:local'] ?? ''), 'local inspect script does not push');
});

test('Phase 146 long-running service boundary defines always-on shape without starting it', () => {
  assert(exists('docs/PHASE_146_LONG_RUNNING_SERVICE_BOUNDARY.md'), 'Phase 146 long-running service boundary doc exists');
  assert(exists('src/ops/long-running-service-boundary.ts'), 'Phase 146 long-running service boundary source exists');
  assert(exists('src/ops/long-running-service-boundary-cli.ts'), 'Phase 146 long-running service boundary CLI exists');
  assert(exists('test/long-running-service-boundary.ts'), 'Phase 146 long-running service boundary test exists');
  assert(pkg.scripts['test:long-running-service-boundary'] === 'tsx test/long-running-service-boundary.ts', 'Phase 146 test script present');
  assert(pkg.scripts['ops:long-running-service-boundary'] === 'tsx src/ops/long-running-service-boundary-cli.ts', 'Phase 146 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/control-surface-compose-boundary.ts && tsx test/long-running-service-boundary.ts'),
    'Phase 146 aggregate test follows Phase 140 control surface boundary',
  );

  const source = `${read('src/ops/long-running-service-boundary.ts')}\n${read('src/ops/long-running-service-boundary-cli.ts')}`;
  const combined = [
    source,
    read('docs/PHASE_146_LONG_RUNNING_SERVICE_BOUNDARY.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const required of [
    'phase-146-long-running-service-boundary',
    'API plus minimal operator UI',
    'backend orchestration rail',
    'It is not the streaming product',
    'local-admin-token-file',
    '/mnt/user/appdata/catalog/secrets/operator_ui_token',
    'read-only first',
    '8099',
    'system logs',
    'operation logs',
    'connector logs',
    'No accidental ports',
    'implementationStarted: false',
    'composeChanged: false',
    'serviceAdded: false',
    'portPublishedNow: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'phase-147-implement-first-always-on-service',
  ]) assert(combined.includes(required), `Phase 146 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 146 source excludes ${forbidden}`);
});

test('Phase 147 operator UI service is long-running, read-only, and intentionally exposed', () => {
  assert(exists('docs/PHASE_147_OPERATOR_UI_SERVICE.md'), 'Phase 147 operator UI service doc exists');
  assert(exists('src/ops/operator-ui-service.ts'), 'Phase 147 operator UI service source exists');
  assert(exists('src/ops/operator-ui-service-cli.ts'), 'Phase 147 operator UI service CLI exists');
  assert(exists('test/operator-ui-service.ts'), 'Phase 147 operator UI service test exists');
  assert(pkg.scripts['test:operator-ui-service'] === 'tsx test/operator-ui-service.ts', 'Phase 147 test script present');
  assert(pkg.scripts['ops:operator-ui-server'] === 'tsx src/ops/operator-ui-service-cli.ts', 'Phase 147 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/long-running-service-boundary.ts && tsx test/operator-ui-service.ts'),
    'Phase 147 aggregate test follows Phase 146 boundary',
  );

  const source = `${read('src/ops/operator-ui-service.ts')}\n${read('src/ops/operator-ui-service-cli.ts')}`;
  const combined = [
    source,
    unraidCompose,
    unraidRuntimeCompose,
    read('docs/PHASE_147_OPERATOR_UI_SERVICE.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const required of [
    'phase-147-operator-ui-service',
    'ops:operator-ui-server',
    'API plus minimal operator UI',
    'backend orchestration rail',
    'read-only-first',
    'local-admin-token-file',
    'redacted-system-operation-connector',
    'OPERATOR_UI_TOKEN_FILE',
    '/run/secrets/operator_ui_token',
    '/mnt/user/appdata/catalog/secrets/operator_ui_token',
    'X-Operator-UI-Secret',
    '8099:8099',
    'GET /healthz',
    'GET /api/status',
    'GET /api/logs',
    'restart: unless-stopped',
  ]) assert(combined.includes(required), `Phase 147 surface preserves ${required}`);

  assert(/^\s{2}app:/m.test(unraidCompose), 'canonical Unraid compose has app service');
  assert(/^\s{2}app:/m.test(unraidRuntimeCompose), 'runtime Unraid compose has app service');
  assert(unraidRuntimeCompose.includes('image: ${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}'), 'runtime app uses configurable image');
  assert(!/^\s+build:/m.test(unraidRuntimeCompose), 'runtime compose still has no build context');
  assert(unraidCompose.includes('build: .'), 'canonical app can build from repo context');
  assert(
    unraidCompose.includes('"8099:8099"') && unraidRuntimeCompose.includes('"${OPERATOR_UI_HOST_PORT:-8099}:8099"'),
    'both Unraid compose files publish the intentional port with runtime smoke override',
  );
  assert(!/(8098|8100):/.test(`${unraidCompose}\n${unraidRuntimeCompose}`), 'no adjacent accidental operator ports');

  for (const forbidden of [
    '@torbox/torbox-api',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'execSync',
    'spawnSync',
    'request-download-link',
    'magnet:',
  ]) assert(!source.includes(forbidden), `Phase 147 source excludes ${forbidden}`);
});

test('Phase 148 operator UI access helper is token-safe and UI-focused', () => {
  assert(exists('docs/PHASE_148_OPERATOR_UI_ACCESS.md'), 'Phase 148 operator UI access doc exists');
  assert(exists('src/ops/operator-ui-token.ts'), 'Phase 148 operator UI token source exists');
  assert(exists('src/ops/operator-ui-token-cli.ts'), 'Phase 148 operator UI token CLI exists');
  assert(exists('test/operator-ui-token.ts'), 'Phase 148 operator UI token test exists');
  assert(pkg.scripts['test:operator-ui-token'] === 'tsx test/operator-ui-token.ts', 'Phase 148 test script present');
  assert(pkg.scripts['ops:operator-ui-token'] === 'tsx src/ops/operator-ui-token-cli.ts', 'Phase 148 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-service.ts && tsx test/operator-ui-token.ts'),
    'Phase 148 aggregate test follows Phase 147 service',
  );

  const tokenSource = `${read('src/ops/operator-ui-token.ts')}\n${read('src/ops/operator-ui-token-cli.ts')}`;
  const serviceSource = read('src/ops/operator-ui-service.ts');
  const combined = [
    tokenSource,
    serviceSource,
    read('docs/PHASE_148_OPERATOR_UI_ACCESS.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const required of [
    'phase-148-operator-ui-token',
    'phase-148-operator-ui-access',
    'ops:operator-ui-token',
    '--show-path',
    '--status --json',
    '--rotate --confirm',
    '--print --confirm-print',
    '/mnt/user/appdata/catalog/secrets/operator_ui_token',
    '/run/secrets/operator_ui_token',
    'pass/warn/fail',
    'Needs Attention',
  ]) assert(combined.includes(required), `Phase 148 surface preserves ${required}`);

  for (const forbidden of [
    '@torbox/torbox-api',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'execSync',
    'spawnSync',
    'docker compose',
    'request-download-link',
    'magnet:',
  ]) assert(!tokenSource.includes(forbidden), `Phase 148 token source excludes ${forbidden}`);
});

test('Phase 143 Unraid ops launcher wraps runtime compose commands', () => {
  assert(exists('docs/PHASE_143_UNRAID_OPS_LAUNCHERS.md'), 'Phase 143 ops launcher doc exists');
  assert(exists('deploy/unraid-ops-launcher.sh'), 'Phase 143 ops launcher script exists');

  const combined = [
    unraidOpsLauncher,
    read('docs/PHASE_143_UNRAID_OPS_LAUNCHERS.md'),
    read('docs/PHASE_3_DEPLOYMENT.md'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'docker-compose.unraid.runtime.yml',
    'start-postgres',
    'status',
    'migrate',
    'doctor',
    'backup',
    'rewrap-plan',
    'ops:doctor -- --json',
    'ops:backup -- dump',
    'ops:rewrap-kek -- --plan --json',
    'CUSTODIAN_KEK_PREVIOUS_FILE',
    'custodian_kek_previous',
    '-v "$PREVIOUS_KEK_FILE:/run/secrets/custodian_kek_previous:ro"',
    'one-shot',
    'catalogauthority-postgres-1',
    'catalogauthority-ops-1',
  ]) assert(combined.includes(required), `Phase 143 surface preserves ${required}`);
  assert(unraidOpsLauncher.includes('docker compose -f "$COMPOSE_FILE"'), 'launcher uses configured runtime compose file');
  assert(!unraidOpsLauncher.includes('docker run'), 'launcher does not hand-build docker run commands');
  assert(!/ports:/.test(unraidOpsLauncher), 'launcher publishes no ports');
  assert(!/(node:http|node:https|globalThis\.fetch|fetch\()/.test(unraidOpsLauncher), 'launcher has no network/provider implementation');
});

test('Phase 149 Unraid UI launcher commands operate existing runtime services only', () => {
  assert(exists('docs/PHASE_149_UNRAID_UI_LAUNCHER_COMMANDS.md'), 'Phase 149 UI launcher doc exists');
  const combined = [
    unraidOpsLauncher,
    read('docs/PHASE_149_UNRAID_UI_LAUNCHER_COMMANDS.md'),
    read('docs/PHASE_143_UNRAID_OPS_LAUNCHERS.md'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-149-unraid-ui-launcher-commands',
    'start-ui',
    'restart-ui',
    'ui-logs',
    'ui-token-status',
    'ui-token-rotate',
    'compose up -d postgres app',
    'compose up -d --force-recreate app',
    'compose logs --tail',
    'ops:operator-ui-token -- --status --json',
    'ops:operator-ui-token -- --rotate --confirm --json',
    'catalogauthority-app-1',
    'Arcane',
    'User Scripts',
  ]) assert(combined.includes(required), `Phase 149 surface preserves ${required}`);
  assert(
    !`${unraidOpsLauncher}\n${read('docs/PHASE_149_UNRAID_UI_LAUNCHER_COMMANDS.md')}`.includes('--print --confirm-print'),
    'Phase 149 launcher docs do not add a print-token shortcut',
  );
  for (const forbidden of [
    '@torbox/torbox-api',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'globalThis.fetch',
    'request-download-link',
    'magnet:',
  ]) assert(!unraidOpsLauncher.includes(forbidden), `Phase 149 launcher excludes ${forbidden}`);
});

test('Phase 150 operator UI live check is redaction-safe and launcher-backed', () => {
  assert(exists('docs/PHASE_150_OPERATOR_UI_LIVE_CHECK.md'), 'Phase 150 live check doc exists');
  assert(exists('src/ops/operator-ui-live-check.ts'), 'Phase 150 live check source exists');
  assert(exists('src/ops/operator-ui-live-check-cli.ts'), 'Phase 150 live check CLI exists');
  assert(exists('test/operator-ui-live-check.ts'), 'Phase 150 live check test exists');
  assert(pkg.scripts['test:operator-ui-live-check'] === 'tsx test/operator-ui-live-check.ts', 'Phase 150 test script present');
  assert(pkg.scripts['ops:operator-ui-live-check'] === 'tsx src/ops/operator-ui-live-check-cli.ts', 'Phase 150 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-token.ts && tsx test/operator-ui-live-check.ts'),
    'Phase 150 aggregate test follows token helper',
  );

  const source = `${read('src/ops/operator-ui-live-check.ts')}\n${read('src/ops/operator-ui-live-check-cli.ts')}`;
  const combined = [
    source,
    unraidOpsLauncher,
    read('docs/PHASE_150_OPERATOR_UI_LIVE_CHECK.md'),
    read('docs/PHASE_149_UNRAID_UI_LAUNCHER_COMMANDS.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const required of [
    'phase-150-operator-ui-live-check',
    'ops:operator-ui-live-check',
    'test:operator-ui-live-check',
    'ui-live-check',
    'http://app:8099',
    '/healthz',
    '/api/status',
    '/api/logs',
    'redaction-safe',
    'token-output',
    'secret-output',
  ]) assert(combined.includes(required), `Phase 150 surface preserves ${required}`);
  assert(!source.includes('--print --confirm-print'), 'Phase 150 live check does not include token print path');
  for (const forbidden of [
    '@torbox/torbox-api',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'request-download-link',
    'magnet:',
    'docker compose',
  ]) assert(!source.includes(forbidden), `Phase 150 source excludes ${forbidden}`);
});

test('Phase 151 operator UI live evidence saves clean redaction-safe JSON', () => {
  assert(exists('docs/PHASE_151_OPERATOR_UI_LIVE_EVIDENCE.md'), 'Phase 151 live evidence doc exists');
  const combined = [
    unraidOpsLauncher,
    read('docs/PHASE_151_OPERATOR_UI_LIVE_EVIDENCE.md'),
    read('docs/PHASE_150_OPERATOR_UI_LIVE_CHECK.md'),
    read('docs/PHASE_149_UNRAID_UI_LAUNCHER_COMMANDS.md'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-151-operator-ui-live-evidence',
    'ui-live-check-save',
    'CATALOG_AUTHORITY_EVIDENCE_DIR',
    '/mnt/user/appdata/catalog/backups/evidence',
    'operator-ui-live-check-',
    'run_ops_silent ops:operator-ui-live-check',
    'compose run -T --interactive=false --rm ops --silent',
    '.tmp-$$',
    'chmod 600',
    'redaction-safe',
  ]) assert(combined.includes(required), `Phase 151 surface preserves ${required}`);
  assert(!`${unraidOpsLauncher}\n${read('docs/PHASE_151_OPERATOR_UI_LIVE_EVIDENCE.md')}`.includes('--print --confirm-print'), 'Phase 151 has no print-token shortcut');
  for (const forbidden of [
    '@torbox/torbox-api',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'request-download-link',
    'magnet:',
  ]) assert(!unraidOpsLauncher.includes(forbidden), `Phase 151 launcher excludes ${forbidden}`);
});

test('Phase 152 operator UI evidence review validates saved live-check evidence', () => {
  assert(exists('docs/PHASE_152_OPERATOR_UI_EVIDENCE_REVIEW.md'), 'Phase 152 evidence review doc exists');
  assert(exists('src/ops/operator-ui-evidence-review.ts'), 'Phase 152 evidence review source exists');
  assert(exists('src/ops/operator-ui-evidence-review-cli.ts'), 'Phase 152 evidence review CLI exists');
  assert(exists('test/operator-ui-evidence-review.ts'), 'Phase 152 evidence review test exists');
  assert(pkg.scripts['test:operator-ui-evidence-review'] === 'tsx test/operator-ui-evidence-review.ts', 'Phase 152 test script present');
  assert(pkg.scripts['ops:operator-ui-evidence-review'] === 'tsx src/ops/operator-ui-evidence-review-cli.ts', 'Phase 152 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-live-check.ts && tsx test/operator-ui-evidence-review.ts'),
    'Phase 152 aggregate test follows live check',
  );

  const source = `${read('src/ops/operator-ui-evidence-review.ts')}\n${read('src/ops/operator-ui-evidence-review-cli.ts')}`;
  const combined = [
    source,
    unraidOpsLauncher,
    read('docs/PHASE_152_OPERATOR_UI_EVIDENCE_REVIEW.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const required of [
    'phase-152-operator-ui-evidence-review',
    'ops:operator-ui-evidence-review',
    'test:operator-ui-evidence-review',
    'ui-evidence-review',
    '--max-age-hours',
    'CATALOG_AUTHORITY_EVIDENCE_MAX_AGE_HOURS',
    'valid JSON',
    'schema',
    'recent',
    'passing',
    'nonzero',
  ]) assert(combined.includes(required), `Phase 152 surface preserves ${required}`);
  for (const forbidden of [
    '@torbox/torbox-api',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'request-download-link',
    'magnet:',
    'docker compose',
  ]) assert(!source.includes(forbidden), `Phase 152 source excludes ${forbidden}`);
});

test('Phase 153 Arcane operator runbook maps safe buttons to exact launcher commands', () => {
  assert(exists('docs/PHASE_153_ARCANE_OPERATOR_RUNBOOK.md'), 'Phase 153 Arcane runbook exists');
  const doc = read('docs/PHASE_153_ARCANE_OPERATOR_RUNBOOK.md');
  const combined = [doc, read('README.md')].join('\n');
  for (const required of [
    'phase-153-arcane-operator-runbook',
    '/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh',
    '| `start-ui` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh start-ui` |',
    '| `status` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh status` |',
    '| `ui-live-check` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check` |',
    '| `ui-live-check-save` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save` |',
    '| `ui-logs` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-logs` |',
    '| `ui-token-status` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-token-status` |',
    '| `restart-ui` | `/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh restart-ui` |',
    'token printing',
    'backup restore',
    'KEK rotation',
  ]) assert(combined.includes(required), `Phase 153 runbook preserves ${required}`);
  for (const forbidden of [
    'request-download-link',
    'magnet:',
    'ops:backup -- restore',
    'ops:rewrap-kek',
    '--print --confirm-print',
  ]) assert(!doc.includes(forbidden), `Phase 153 runbook excludes ${forbidden}`);
});

test('Phase 154 release packaging documents one public Unraid deploy path', () => {
  assert(exists('RELEASE.md'), 'Phase 154 release guide exists');
  assert(exists('docs/PHASE_154_RELEASE_PACKAGING.md'), 'Phase 154 release packaging doc exists');
  const release = read('RELEASE.md');
  const phase154 = read('docs/PHASE_154_RELEASE_PACKAGING.md');
  const deployment = read('docs/PHASE_3_DEPLOYMENT.md');
  const readme = read('README.md');
  const publicDocs = [release, phase154, deployment].join('\n');
  const combined = [publicDocs, readme].join('\n');

  for (const required of [
    'phase-154-release-packaging',
    'Current launch package: `phase-200` / `0d08052`',
    '/mnt/user/appdata/catalog/repo',
    '/mnt/user/appdata/catalog',
    '/mnt/user/appdata/catalog/secrets',
    'docker-compose.unraid.runtime.yml',
    'repo-ops:latest',
    'ghcr.io/catalog-authority/catalog-authority-ops:<tag>',
    'CATALOG_AUTHORITY_OPS_IMAGE',
    'CATALOG_AUTHORITY_APPDATA_DIR',
    'npm run image:build:local',
    '/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check',
  ]) assert(combined.includes(required), `Phase 154 release surface preserves ${required}`);

  for (const forbidden of [
    'docker-compose.deploy.yml',
    'docker-compose.unraid.yml',
    'ghcr.io/OWNER',
    './secrets',
  ]) assert(!publicDocs.includes(forbidden), `Phase 154 public docs exclude ${forbidden}`);
});

test('Phase 155 public deploy smoke is clean-clone and evidence-reviewed', () => {
  assert(exists('docs/PHASE_155_PUBLIC_DEPLOY_SMOKE.md'), 'Phase 155 public smoke doc exists');
  const doc = read('docs/PHASE_155_PUBLIC_DEPLOY_SMOKE.md');
  const combined = [doc, read('README.md'), read('RELEASE.md'), unraidRuntimeCompose].join('\n');
  for (const required of [
    'phase-155-public-deploy-smoke',
    'git clone /mnt/user/appdata/catalog/repo',
    'docker-compose.unraid.runtime.yml',
    'CATALOG_AUTHORITY_APPDATA_DIR',
    'OPERATOR_UI_HOST_PORT',
    'docker compose -p "$SMOKE_PROJECT"',
    'run -T --interactive=false --rm ops',
    'npm ci',
    'npm run image:build:local',
    'ops:init',
    'ops:operator-ui-live-check',
    'ops:operator-ui-evidence-review',
    'down --remove-orphans',
  ]) assert(combined.includes(required), `Phase 155 smoke surface preserves ${required}`);
  for (const forbidden of [
    'docker-compose.deploy.yml',
    'docker-compose.unraid.yml',
    'ghcr.io/OWNER',
    'request-download-link',
    'magnet:',
  ]) assert(!doc.includes(forbidden), `Phase 155 smoke doc excludes ${forbidden}`);
});

test('Phases 161 and 162 document live UI access and normal operator workflow', () => {
  assert(exists('docs/PHASE_161_OPERATOR_UI_ACCESS_VALIDATION.md'), 'Phase 161 access validation doc exists');
  assert(exists('docs/PHASE_162_OPERATOR_WORKFLOW_RUNBOOK.md'), 'Phase 162 operator workflow runbook exists');
  const phaseDocs = [
    read('docs/PHASE_161_OPERATOR_UI_ACCESS_VALIDATION.md'),
    read('docs/PHASE_162_OPERATOR_WORKFLOW_RUNBOOK.md'),
  ].join('\n');
  const combined = [
    phaseDocs,
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-161-operator-ui-access-validation',
    'phase-162-operator-workflow-runbook',
    'http://192.168.1.31:8099/',
    'unauthenticated `/api/status`: HTTP `401`',
    'unauthenticated `/api/logs`: HTTP `401`',
    '/mnt/user/projects/CatalogAuthority',
    '/mnt/user/appdata/catalog/repo/docker-compose.unraid.runtime.yml',
    'CATALOG_AUTHORITY_OPS_IMAGE=repo-ops:latest',
    'CATALOG_AUTHORITY_APPDATA_DIR=/mnt/user/appdata/catalog',
    'OPERATOR_UI_HOST_PORT=8099',
    '/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check',
    '/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save',
    '/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-evidence-review',
  ]) assert(combined.includes(required), `Phase 161/162 docs preserve ${required}`);
  for (const forbidden of [
    '--print --confirm-print',
    'ops:backup -- restore',
    'ops:rewrap-kek',
    'request-download-link',
    'magnet:',
  ]) assert(!phaseDocs.includes(forbidden), `Phase 161/162 docs exclude ${forbidden}`);
});

test('Phases 163 through 165 snapshot release state and scheduled UI evidence without closing O4/O5', () => {
  assert(exists('docs/PHASE_163_RELEASE_SNAPSHOT.md'), 'Phase 163 release snapshot doc exists');
  assert(exists('docs/PHASE_164_SCHEDULED_UI_EVIDENCE_JOB.md'), 'Phase 164 scheduled evidence doc exists');
  assert(exists('docs/PHASE_165_PRODUCTION_GATE_REVIEW.md'), 'Phase 165 production gate review doc exists');
  assert(exists('deploy/unraid-ui-evidence-check.sh'), 'Phase 164 evidence wrapper exists');
  const phaseDocs = [
    read('docs/PHASE_163_RELEASE_SNAPSHOT.md'),
    read('docs/PHASE_164_SCHEDULED_UI_EVIDENCE_JOB.md'),
    read('docs/PHASE_165_PRODUCTION_GATE_REVIEW.md'),
    read('deploy/unraid-ui-evidence-check.sh'),
  ].join('\n');
  const combined = `${phaseDocs}\n${read('README.md')}`;
  for (const required of [
    'phase-163-release-snapshot',
    'phase-164-scheduled-ui-evidence-job',
    'phase-165-production-gate-review',
    '/mnt/user/projects/CatalogAuthority',
    'http://192.168.1.31:8099/',
    '/boot/config/plugins/user.scripts/scripts/catalog-ui-evidence-check',
    '/mnt/user/appdata/catalog/repo/deploy/unraid-ui-evidence-check.sh',
    'ui-live-check-save',
    'ui-evidence-review',
    'O4 remains open',
    'O5 remains open',
    'must not be described as turnkey production-ready with managed custody',
  ]) assert(combined.includes(required), `Phase 163/164/165 surface preserves ${required}`);
  for (const forbidden of [
    '--print --confirm-print',
    'ops:backup -- restore',
    'ops:rewrap-kek',
    'request-download-link',
    'magnet:',
  ]) assert(!phaseDocs.includes(forbidden), `Phase 163/164/165 docs exclude ${forbidden}`);
});

test('Phases 166 through 168 consolidate O4/O5 evidence direction without closing gates', () => {
  assert(exists('docs/PHASE_166_O4_O5_EVIDENCE_PACKET.md'), 'Phase 166 O4/O5 evidence packet doc exists');
  assert(exists('docs/PHASE_167_O4_CUSTODIAN_DIRECTION_DECISION.md'), 'Phase 167 O4 custodian direction doc exists');
  assert(exists('docs/PHASE_168_O5_KEK_CUSTODY_DIRECTION_DECISION.md'), 'Phase 168 O5 KEK direction doc exists');
  const phaseDocs = [
    read('docs/PHASE_166_O4_O5_EVIDENCE_PACKET.md'),
    read('docs/PHASE_167_O4_CUSTODIAN_DIRECTION_DECISION.md'),
    read('docs/PHASE_168_O5_KEK_CUSTODY_DIRECTION_DECISION.md'),
  ].join('\n');
  const combined = `${phaseDocs}\n${read('README.md')}`;
  for (const required of [
    'phase-166-o4-o5-evidence-packet',
    'phase-167-o4-custodian-direction-decision',
    'phase-168-o5-kek-custody-direction-decision',
    'ops:custodian-evidence-preflight',
    'ops:kek-evidence-preflight',
    'ops:o4-o5-evidence-decision',
    'ops:rewrap-kek -- --plan --json',
    'external local sidecar custodian',
    'manual operator KEK custody',
    'sidecar-owned KEK custody',
    'O4 remains open',
    'O5 remains open',
    'does not close O4',
    'does not close O5',
    'no provider contact',
    'no scraping',
    'no downloading',
    'no playback',
    'FileCustodian` remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 166/167/168 surface preserves ${required}`);
  for (const forbidden of [
    'request-download-link',
    'magnet:',
    '--print --confirm-print',
    'productionReady: true',
    'O4 closed',
    'O5 closed',
    'provider mode enabled',
  ]) assert(!phaseDocs.includes(forbidden), `Phase 166/167/168 docs exclude ${forbidden}`);
});

test('Phases 169 through 171 provide redacted O4/O5 templates and review flow only', () => {
  for (const rel of [
    'docs/PHASE_169_O4_O5_EVIDENCE_TEMPLATES.md',
    'docs/PHASE_170_O4_O5_EVIDENCE_CAPTURE_RUNBOOK.md',
    'docs/PHASE_171_O4_O5_REVIEW_CHECKLIST.md',
    'docs/templates/O4_CUSTODIAN_DESCRIPTOR.redacted.json',
    'docs/templates/O5_KEK_DESCRIPTOR.redacted.json',
    'docs/templates/O4_O5_DECISION_RECORD.redacted.json',
    'docs/templates/O4_O5_EVIDENCE_PACKET.redacted.json',
  ]) assert(exists(rel), `${rel} exists`);

  const templateJsonFiles = [
    'docs/templates/O4_CUSTODIAN_DESCRIPTOR.redacted.json',
    'docs/templates/O5_KEK_DESCRIPTOR.redacted.json',
    'docs/templates/O4_O5_DECISION_RECORD.redacted.json',
    'docs/templates/O4_O5_EVIDENCE_PACKET.redacted.json',
  ];
  for (const rel of templateJsonFiles) {
    const parsed = JSON.parse(read(rel)) as unknown;
    assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${rel} is valid object JSON`);
  }

  const phaseDocs = [
    read('docs/PHASE_169_O4_O5_EVIDENCE_TEMPLATES.md'),
    read('docs/PHASE_170_O4_O5_EVIDENCE_CAPTURE_RUNBOOK.md'),
    read('docs/PHASE_171_O4_O5_REVIEW_CHECKLIST.md'),
    ...templateJsonFiles.map((rel) => read(rel)),
  ].join('\n');
  const combined = `${phaseDocs}\n${read('README.md')}`;
  for (const required of [
    'phase-169-o4-o5-evidence-templates',
    'phase-170-o4-o5-evidence-capture-runbook',
    'phase-171-o4-o5-review-checklist',
    'O4_CUSTODIAN_DESCRIPTOR.redacted.json',
    'O5_KEK_DESCRIPTOR.redacted.json',
    'O4_O5_DECISION_RECORD.redacted.json',
    'O4_O5_EVIDENCE_PACKET.redacted.json',
    'ops:custodian-evidence-preflight',
    'ops:kek-evidence-preflight',
    'ops:o4-o5-evidence-decision',
    'ops:rewrap-kek -- --plan --json',
    'O4 remains open',
    'O5 remains open',
    'does not close O4',
    'does not close O5',
    'no provider contact',
    'no scraping',
    'no downloading',
    'no playback',
    'media-server mutation',
  ]) assert(combined.includes(required), `Phase 169/170/171 surface preserves ${required}`);
  for (const forbidden of [
    'request-download-link',
    'magnet:',
    '--print --confirm-print',
    'productionReady: true',
    'O4 closed',
    'O5 closed',
    'provider mode enabled',
    'raw command output blob',
  ]) assert(!phaseDocs.includes(forbidden), `Phase 169/170/171 docs exclude ${forbidden}`);
});

test('Phase 172 O4/O5 evidence packet review checks packet envelope only', () => {
  assert(exists('docs/PHASE_172_O4_O5_EVIDENCE_PACKET_REVIEW.md'), 'Phase 172 packet review doc exists');
  assert(exists('src/ops/o4-o5-evidence-packet-review.ts'), 'Phase 172 packet review source exists');
  assert(exists('src/ops/o4-o5-evidence-packet-review-cli.ts'), 'Phase 172 packet review CLI exists');
  assert(exists('test/o4-o5-evidence-packet-review.ts'), 'Phase 172 packet review test exists');
  assert(pkg.scripts['test:o4-o5-evidence-packet-review'] === 'tsx test/o4-o5-evidence-packet-review.ts', 'Phase 172 test script present');
  assert(pkg.scripts['ops:o4-o5-evidence-packet-review'] === 'tsx src/ops/o4-o5-evidence-packet-review-cli.ts', 'Phase 172 ops script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/o4-o5-evidence-decision.ts && tsx test/o4-o5-evidence-packet-review.ts'),
    'Phase 172 aggregate test follows Phase 96 decision packet',
  );
  const source = `${read('src/ops/o4-o5-evidence-packet-review.ts')}\n${read('src/ops/o4-o5-evidence-packet-review-cli.ts')}`;
  const combined = [
    source,
    read('docs/PHASE_172_O4_O5_EVIDENCE_PACKET_REVIEW.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const required of [
    'phase-172-o4-o5-evidence-packet-review',
    'ops:o4-o5-evidence-packet-review',
    'valid JSON',
    'schema',
    'open-gates',
    'forbidden-boundary',
    'redaction',
    'O4 remains open',
    'O5 remains open',
    'does not close O4',
    'does not close O5',
    'no provider contact',
    'no scraping',
    'no downloading',
    'no playback',
  ]) assert(combined.includes(required), `Phase 172 surface preserves ${required}`);
  for (const forbidden of [
    '@torbox/torbox-api',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'request-download-link',
    'magnet:',
    'docker compose',
    'globalThis.fetch',
  ]) assert(!source.includes(forbidden), `Phase 172 source excludes ${forbidden}`);
});

test('Phases 173 through 175 capture and review O4/O5 packets without closing gates', () => {
  assert(exists('docs/PHASE_173_O4_O5_PACKET_CAPTURE.md'), 'Phase 173 packet capture doc exists');
  assert(exists('docs/PHASE_174_ARCANE_O4_O5_PACKET_REVIEW.md'), 'Phase 174 Arcane packet review doc exists');
  assert(exists('docs/PHASE_175_O4_SIDECAR_READINESS_GATE.md'), 'Phase 175 sidecar readiness gate doc exists');
  const phaseDocs = [
    read('docs/PHASE_173_O4_O5_PACKET_CAPTURE.md'),
    read('docs/PHASE_174_ARCANE_O4_O5_PACKET_REVIEW.md'),
    read('docs/PHASE_175_O4_SIDECAR_READINESS_GATE.md'),
    read('docs/PHASE_153_ARCANE_OPERATOR_RUNBOOK.md'),
  ].join('\n');
  const combined = [
    phaseDocs,
    unraidOpsLauncher,
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-173-o4-o5-packet-capture',
    'phase-174-arcane-o4-o5-packet-review',
    'phase-175-o4-sidecar-readiness-gate',
    'o4-o5-evidence-capture',
    'o4-o5-packet-review',
    '/mnt/user/appdata/catalog/backups/evidence/o4-o5',
    'ops:custodian-evidence-preflight',
    'ops:kek-evidence-preflight',
    'ops:o4-o5-evidence-decision',
    'ops:o4-o5-evidence-packet-review',
    'o4-o5-packet-review.redacted.json',
    'ready-for-sidecar-design-review',
    'O4 remains open',
    'O5 remains open',
    'does not close O4',
    'does not close O5',
    'no provider contact',
    'no scraping',
    'no downloading',
    'no playback',
    'media-server library writes',
  ]) assert(combined.includes(required), `Phase 173/174/175 surface preserves ${required}`);
  for (const launcherRequired of [
    'capture_o4_o5_evidence',
    'write_file_safely',
    'o4-o5-evidence-capture)',
    'o4-o5-packet-review)',
    'docs/templates/O4_CUSTODIAN_DESCRIPTOR.redacted.json',
    'docs/templates/O5_KEK_DESCRIPTOR.redacted.json',
    'docs/templates/O4_O5_DECISION_RECORD.redacted.json',
    'docs/templates/O4_O5_EVIDENCE_PACKET.redacted.json',
  ]) assert(unraidOpsLauncher.includes(launcherRequired), `launcher preserves ${launcherRequired}`);
  for (const forbidden of [
    '--print --confirm-print',
    'ops:backup -- restore',
    'request-download-link',
    'magnet:',
    'provider mode enabled',
    'O4 closed',
    'O5 closed',
  ]) assert(!phaseDocs.includes(forbidden), `Phase 173/174/175 docs exclude ${forbidden}`);
});

test('Phases 176 through 178 define Launch v1 with explicit O4/O5 open warnings', () => {
  assert(exists('docs/PHASE_176_FINAL_LAUNCH_CANDIDATE_SWEEP.md'), 'Phase 176 final sweep doc exists');
  assert(exists('docs/PHASE_177_LAUNCH_V1_OPERATOR_RUNBOOK.md'), 'Phase 177 launch runbook exists');
  assert(exists('docs/PHASE_178_LAUNCH_V1_DECISION_RECORD.md'), 'Phase 178 launch decision record exists');
  const phaseDocs = [
    read('docs/PHASE_176_FINAL_LAUNCH_CANDIDATE_SWEEP.md'),
    read('docs/PHASE_177_LAUNCH_V1_OPERATOR_RUNBOOK.md'),
    read('docs/PHASE_178_LAUNCH_V1_DECISION_RECORD.md'),
  ].join('\n');
  const combined = `${phaseDocs}\n${read('README.md')}`;
  for (const required of [
    'phase-176-final-launch-candidate-sweep',
    'phase-177-launch-v1-operator-runbook',
    'phase-178-launch-v1-decision-record',
    'launch-v1-operator-backend-with-open-o4-o5-warnings',
    'self-hosted backend/operator foundation',
    'accepted open warning',
    'O4 remains open',
    'O5 remains open',
    'does not close O4',
    'does not close O5',
    'ui-live-check-save',
    'ui-evidence-review',
    'o4-o5-evidence-capture',
    'o4-o5-packet-review',
    'Catalog Authority Launch v1 is ready',
    'no provider/media behavior',
  ]) assert(combined.includes(required), `Phase 176/177/178 surface preserves ${required}`);
  for (const forbidden of [
    'request-download-link',
    'magnet:',
    '--print --confirm-print',
    'O4 closed',
    'O5 closed',
    'provider mode enabled',
    'turnkey production-ready managed custody.',
  ]) assert(!phaseDocs.includes(forbidden), `Phase 176/177/178 docs exclude ${forbidden}`);
});

test('Phases 179 and 180 package Launch v1 for easier Unraid and Arcane launch', () => {
  assert(exists('docs/PHASE_179_LAUNCH_V1_RELEASE_PACKAGE.md'), 'Phase 179 release package doc exists');
  assert(exists('docs/PHASE_180_ARCANE_FINAL_BUTTON_CHECKLIST.md'), 'Phase 180 Arcane checklist doc exists');
  const phaseDocs = [
    read('docs/PHASE_179_LAUNCH_V1_RELEASE_PACKAGE.md'),
    read('docs/PHASE_180_ARCANE_FINAL_BUTTON_CHECKLIST.md'),
    read('RELEASE.md'),
  ].join('\n');
  const combined = `${phaseDocs}\n${read('README.md')}`;
  for (const required of [
    'phase-179-launch-v1-release-package',
    'phase-180-arcane-final-button-checklist',
    'Current launch package: `phase-200` / `0d08052`',
    'git clone https://github.com/cdb8457/streaming-catalog-authority.git',
    'docker-compose.unraid.runtime.yml',
    'repo-ops:latest',
    'ui-live-check',
    'ui-live-check-save',
    'ui-evidence-review',
    'o4-o5-evidence-capture',
    'o4-o5-packet-review',
    'ui-token-status',
    'Catalog Authority is ready as a self-hosted backend/operator foundation',
    'O4: `O4_CLOSED`',
    'O5: `O5_DEFERRED_ACCEPTED`',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
    'does not close O4',
    'does not close O5',
    'no provider live mode',
  ]) assert(combined.includes(required), `Phase 179/180 surface preserves ${required}`);
  for (const forbidden of [
    '--print --confirm-print',
    'ops:backup -- restore',
    'request-download-link',
    'magnet:',
    'provider mode enabled',
  ]) assert(!phaseDocs.includes(forbidden), `Phase 179/180 docs exclude ${forbidden}`);
});

test('Phases 181 through 183 define sidecar custody design without implementation or gate closure', () => {
  assert(exists('docs/PHASE_181_SIDECAR_CUSTODIAN_API_CONTRACT.md'), 'Phase 181 sidecar API contract exists');
  assert(exists('docs/PHASE_182_SIDECAR_DURABLE_STATE_DESIGN.md'), 'Phase 182 sidecar durable state design exists');
  assert(exists('docs/PHASE_183_UNRAID_SIDECAR_COMPOSE_PLAN.md'), 'Phase 183 sidecar Compose plan exists');
  const phaseDocs = [
    read('docs/PHASE_181_SIDECAR_CUSTODIAN_API_CONTRACT.md'),
    read('docs/PHASE_182_SIDECAR_DURABLE_STATE_DESIGN.md'),
    read('docs/PHASE_183_UNRAID_SIDECAR_COMPOSE_PLAN.md'),
  ].join('\n');
  const combined = `${phaseDocs}\n${read('README.md')}`;
  for (const required of [
    'phase-181-sidecar-custodian-api-contract',
    'phase-182-sidecar-durable-state-design',
    'phase-183-unraid-sidecar-compose-plan',
    'ready-for-sidecar-api-design-review',
    'ready-for-sidecar-state-design-review',
    'ready-for-sidecar-compose-design-review',
    'Unix domain socket',
    'custodian-sidecar',
    '/mnt/user/appdata/catalog/sidecar/state',
    '/mnt/user/appdata/catalog/sidecar/run',
    '/mnt/user/appdata/catalog/sidecar/logs',
    'provision',
    'commitProvision',
    'destroy',
    'listStaleProvisioning',
    'O4 remains open',
    'O5 remains open',
    'does not close O4',
    'does not close O5',
  ]) assert(combined.includes(required), `Phase 181/182/183 surface preserves ${required}`);
  for (const forbidden of [
    'ports:',
    '0.0.0.0',
    'request-download-link',
    'magnet:',
    'provider mode enabled',
    'O4 closed',
    'O5 closed',
    'Plex/Jellyfin mutation is enabled',
  ]) assert(!phaseDocs.includes(forbidden), `Phase 181/182/183 docs exclude ${forbidden}`);
});

test('Phases 184 through 186 define sidecar implementation readiness without runtime cutover', () => {
  assert(exists('docs/PHASE_184_SIDECAR_IMPLEMENTATION_WORKPLAN.md'), 'Phase 184 implementation workplan exists');
  assert(exists('docs/PHASE_185_SIDECAR_TEST_MATRIX.md'), 'Phase 185 test matrix exists');
  assert(exists('docs/PHASE_186_SIDECAR_RUNTIME_CUTOVER_GATE.md'), 'Phase 186 runtime cutover gate exists');
  const phaseDocs = [
    read('docs/PHASE_184_SIDECAR_IMPLEMENTATION_WORKPLAN.md'),
    read('docs/PHASE_185_SIDECAR_TEST_MATRIX.md'),
    read('docs/PHASE_186_SIDECAR_RUNTIME_CUTOVER_GATE.md'),
  ].join('\n');
  const combined = `${phaseDocs}\n${read('README.md')}`;
  for (const required of [
    'phase-184-sidecar-implementation-workplan',
    'phase-185-sidecar-test-matrix',
    'phase-186-sidecar-runtime-cutover-gate',
    'ready-for-sidecar-implementation-planning-review',
    'ready-for-sidecar-test-matrix-review',
    'ready-for-sidecar-cutover-gate-review',
    '/mnt/user/appdata/catalog/sidecar/state',
    '/mnt/user/appdata/catalog/sidecar/logs',
    'Unix domain socket',
    'custodian-sidecar',
    'CUSTODIAN_MODE',
    'contractKitPassed',
    'socketUnavailableFailClosed',
    'restartPersistenceExercised',
    'restoreMismatchFailClosed',
    'lostAckIdempotent',
    'staleProvisionalsListedWithoutSecrets',
    'corruptStateFailClosed',
    'attestationOwnedBySidecar',
    'redactionSafe',
    'operator approval record',
    'rollback plan',
    'O4 remains open',
    'O5 remains open',
    'does not close O4',
    'does not close O5',
  ]) assert(combined.includes(required), `Phase 184/185/186 surface preserves ${required}`);
  for (const forbidden of [
    'ports:',
    '0.0.0.0',
    'request-download-link',
    'magnet:',
    'provider mode enabled',
    'O4 closed',
    'O5 closed',
    'Plex/Jellyfin mutation is enabled',
  ]) assert(!phaseDocs.includes(forbidden), `Phase 184/185/186 docs exclude ${forbidden}`);
});

test('Phase 187 adds a local sidecar daemon executable without production cutover', () => {
  assert(exists('docs/PHASE_187_SIDECAR_DAEMON_EXECUTABLE.md'), 'Phase 187 sidecar daemon executable doc exists');
  assert(exists('src/ops/sidecar-daemon.ts'), 'Phase 187 sidecar daemon source exists');
  assert(exists('src/ops/sidecar-daemon-cli.ts'), 'Phase 187 sidecar daemon CLI exists');
  assert(exists('test/sidecar-daemon.ts'), 'Phase 187 sidecar daemon test exists');
  assert(pkg.scripts['ops:sidecar-daemon'] === 'tsx src/ops/sidecar-daemon-cli.ts', 'Phase 187 ops script present');
  assert(pkg.scripts['test:sidecar-daemon'] === 'tsx test/sidecar-daemon.ts', 'Phase 187 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-durable-state-evidence.ts && tsx test/sidecar-daemon.ts'),
    'Phase 187 aggregate test follows durable sidecar state evidence',
  );
  const source = [
    read('src/ops/sidecar-daemon.ts'),
    read('src/ops/sidecar-daemon-cli.ts'),
  ].join('\n');
  const phaseSurface = `${source}\n${read('docs/PHASE_187_SIDECAR_DAEMON_EXECUTABLE.md')}`;
  const combined = `${phaseSurface}\n${read('README.md')}`;
  for (const required of [
    'phase-187-sidecar-daemon-executable',
    'phase-187-sidecar-daemon-self-test',
    'SIDECAR_DAEMON_SELF_TEST',
    'ops:sidecar-daemon',
    '--self-test',
    '--serve',
    'SIDECAR_SOCKET_PATH',
    'SIDECAR_STATE_DIR',
    'SIDECAR_COMPLETION_SECRET_FILE',
    'SIDECAR_KEK_FILE',
    'local Unix socket or Windows named pipe only',
    'FileCustodian remains a reference harness',
    'usesFileCustodianReferenceHarness: true',
    'serviceInstallAllowed: false',
    'composeChangeAllowed: false',
    'runtimeCutoverAllowed: false',
    'providerContactAllowed: false',
    'playbackAllowed: false',
    'mediaServerMutationAllowed: false',
    'O4 remains open',
    'O5 remains open',
    'does not close O4',
    'does not close O5',
  ]) assert(combined.includes(required), `Phase 187 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    '@aws-sdk',
    '@azure',
    '@google-cloud',
    'express',
    'fastify',
    'koa',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 187 source excludes ${forbidden}`);
  for (const forbidden of [
    'ports:',
    '0.0.0.0',
    'request-download-link',
    'magnet:',
    'provider mode enabled',
    'O4 closed',
    'O5 closed',
    'Plex/Jellyfin mutation is enabled',
  ]) assert(!phaseSurface.includes(forbidden), `Phase 187 phase surface excludes ${forbidden}`);
});

test('Phase 188 adds sidecar custodian factory mode without runtime cutover', () => {
  assert(exists('docs/PHASE_188_SIDECAR_FACTORY_MODE.md'), 'Phase 188 sidecar factory mode doc exists');
  const source = `${read('src/core/crypto/custodian-factory.ts')}\n${read('test/custodian-contract.ts')}`;
  const phaseSurface = `${source}\n${read('docs/PHASE_188_SIDECAR_FACTORY_MODE.md')}`;
  const combined = `${phaseSurface}\n${read('README.md')}`;
  for (const required of [
    'phase-188-sidecar-factory-mode',
    "export type CustodianMode = 'memory' | 'file' | 'sidecar'",
    "SUPPORTED_MODES: readonly CustodianMode[] = ['memory', 'file', 'sidecar']",
    "mode: 'sidecar'",
    'CUSTODIAN_MODE=sidecar',
    'CUSTODIAN_SIDECAR_SOCKET_PATH',
    'LocalSidecarCustodianClient',
    'UnixSocketSidecarTransport',
    'assertLocalSocketPath',
    'factory sidecar config parses without app-held secret or KEK',
    'factory sidecar config requires local IPC path and rejects network endpoints',
    'factory sidecar mode talks to local socket',
    'without app-held secret or KEK',
    'O4 remains open',
    'O5 remains open',
    'does not close O4',
    'does not close O5',
  ]) assert(combined.includes(required), `Phase 188 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    '@aws-sdk',
    '@azure',
    '@google-cloud',
    'express',
    'fastify',
    'koa',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 188 source excludes ${forbidden}`);
  for (const forbidden of [
    'ports:',
    '0.0.0.0',
    'request-download-link',
    'magnet:',
    'provider mode enabled',
    'O4 closed',
    'O5 closed',
    'Plex/Jellyfin mutation is enabled',
  ]) assert(!phaseSurface.includes(forbidden), `Phase 188 phase surface excludes ${forbidden}`);
});

test('Phase 189 adds sidecar factory evidence without production cutover', () => {
  assert(exists('docs/PHASE_189_SIDECAR_FACTORY_EVIDENCE.md'), 'Phase 189 sidecar factory evidence doc exists');
  assert(exists('src/ops/sidecar-factory-evidence.ts'), 'Phase 189 sidecar factory evidence source exists');
  assert(exists('src/ops/sidecar-factory-evidence-cli.ts'), 'Phase 189 sidecar factory evidence CLI exists');
  assert(exists('test/sidecar-factory-evidence.ts'), 'Phase 189 sidecar factory evidence test exists');
  assert(pkg.scripts['ops:sidecar-factory-evidence'] === 'tsx src/ops/sidecar-factory-evidence-cli.ts', 'Phase 189 ops script present');
  assert(pkg.scripts['test:sidecar-factory-evidence'] === 'tsx test/sidecar-factory-evidence.ts', 'Phase 189 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-daemon.ts && tsx test/sidecar-factory-evidence.ts && tsx test/sidecar-factory-evidence-review.ts'),
    'Phase 189 aggregate test sits after daemon and before sidecar evidence review',
  );
  const source = [
    read('src/ops/sidecar-factory-evidence.ts'),
    read('src/ops/sidecar-factory-evidence-cli.ts'),
  ].join('\n');
  const phaseSurface = `${source}\n${read('docs/PHASE_189_SIDECAR_FACTORY_EVIDENCE.md')}`;
  const combined = `${phaseSurface}\n${read('README.md')}\n${read('package.json')}`;
  for (const required of [
    'phase-189-sidecar-factory-evidence',
    'SIDECAR_FACTORY_EVIDENCE',
    'ops:sidecar-factory-evidence',
    'test:sidecar-factory-evidence',
    'daemonWrapperExercised: true',
    'custodianFactorySidecarModeExercised: true',
    'localSocketOnly: true',
    'appHeldCompletionSecretRequired: false',
    'appHeldKekRequired: false',
    'serviceInstallAllowed: false',
    'composeChangeAllowed: false',
    'runtimeCutoverAllowed: false',
    'providerContactAllowed: false',
    'playbackAllowed: false',
    'mediaServerMutationAllowed: false',
    'closesO4: false',
    'closesO5: false',
    'O4 remains open',
    'O5 remains open',
  ]) assert(combined.includes(required), `Phase 189 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    '@aws-sdk',
    '@azure',
    '@google-cloud',
    'express',
    'fastify',
    'koa',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 189 source excludes ${forbidden}`);
  for (const forbidden of [
    'ports:',
    '0.0.0.0',
    'request-download-link',
    'magnet:',
    'provider mode enabled',
    'O4 closed',
    'O5 closed',
    'Plex/Jellyfin mutation is enabled',
  ]) assert(!phaseSurface.includes(forbidden), `Phase 189 phase surface excludes ${forbidden}`);
});

test('Phase 190 adds static sidecar factory evidence review without sidecar startup', () => {
  assert(exists('docs/PHASE_190_SIDECAR_FACTORY_EVIDENCE_REVIEW.md'), 'Phase 190 sidecar factory evidence review doc exists');
  assert(exists('src/ops/sidecar-factory-evidence-review.ts'), 'Phase 190 sidecar factory evidence review source exists');
  assert(exists('src/ops/sidecar-factory-evidence-review-cli.ts'), 'Phase 190 sidecar factory evidence review CLI exists');
  assert(exists('test/sidecar-factory-evidence-review.ts'), 'Phase 190 sidecar factory evidence review test exists');
  assert(pkg.scripts['ops:sidecar-factory-evidence-review'] === 'tsx src/ops/sidecar-factory-evidence-review-cli.ts', 'Phase 190 ops script present');
  assert(pkg.scripts['test:sidecar-factory-evidence-review'] === 'tsx test/sidecar-factory-evidence-review.ts', 'Phase 190 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-factory-evidence.ts && tsx test/sidecar-factory-evidence-review.ts && tsx test/sidecar-factory-evidence-acceptance-record.ts'),
    'Phase 190 aggregate test sits after Phase 189 evidence',
  );
  const source = [
    read('src/ops/sidecar-factory-evidence-review.ts'),
    read('src/ops/sidecar-factory-evidence-review-cli.ts'),
  ].join('\n');
  const phaseSurface = `${source}\n${read('docs/PHASE_190_SIDECAR_FACTORY_EVIDENCE_REVIEW.md')}`;
  const combined = `${phaseSurface}\n${read('README.md')}\n${read('package.json')}`;
  for (const required of [
    'phase-190-sidecar-factory-evidence-review',
    'ops:sidecar-factory-evidence-review',
    'test:sidecar-factory-evidence-review',
    'valid JSON',
    'required Phase 189 evidence fields',
    'overall evidence and every required check passed',
    'review keeps sidecar evidence local and non-mutating',
    'redaction-safe labels',
    'closesO4',
    'closesO5',
    'O4 remains open',
    'O5 remains open',
  ]) assert(combined.includes(required), `Phase 190 surface preserves ${required}`);
  for (const forbidden of [
    'node:http',
    'node:https',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    '@aws-sdk',
    '@azure',
    '@google-cloud',
    'express',
    'fastify',
    'koa',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'startSidecarDaemon',
    'custodianFromEnv',
  ]) assert(!source.includes(forbidden), `Phase 190 source excludes ${forbidden}`);
  for (const forbidden of [
    'ports:',
    '0.0.0.0',
    'request-download-link',
    'magnet:',
    'provider mode enabled',
    'O4 closed',
    'O5 closed',
    'Plex/Jellyfin mutation is enabled',
  ]) assert(!phaseSurface.includes(forbidden), `Phase 190 phase surface excludes ${forbidden}`);
});

test('Phase 191 sidecar evidence acceptance record is publishable and closure-free', () => {
  assert(exists('docs/PHASE_191_SIDECAR_EVIDENCE_ACCEPTANCE_RECORD.md'), 'Phase 191 sidecar evidence acceptance record exists');
  assert(exists('test/sidecar-factory-evidence-acceptance-record.ts'), 'Phase 191 sidecar evidence acceptance record test exists');
  assert(pkg.scripts['test:sidecar-factory-evidence-acceptance-record'] === 'tsx test/sidecar-factory-evidence-acceptance-record.ts', 'Phase 191 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-factory-evidence-review.ts && tsx test/sidecar-factory-evidence-acceptance-record.ts && tsx test/o4-sidecar-closure-readiness.ts'),
    'Phase 191 aggregate test sits after Phase 190 review',
  );
  const doc = read('docs/PHASE_191_SIDECAR_EVIDENCE_ACCEPTANCE_RECORD.md');
  const suite = read('test/sidecar-factory-evidence-acceptance-record.ts');
  const combined = `${doc}\n${suite}\n${read('README.md')}\n${read('package.json')}`;
  for (const required of [
    'phase-191-sidecar-evidence-acceptance-record',
    'phase-189-sidecar-factory-evidence',
    'phase-190-sidecar-factory-evidence-review',
    'sha256:a3b1c61af28ac37b8e24ed7cfb941eb128a119a201036263e4ac2e7daee1fe8a',
    'sha256:f75d46172af9ff3c1a1c452dad4a1914958908e6a2210871510c017d6fdea0f2',
    'Phase 190 review verdict: `ok:true`',
    'Phase 190 failed files: `0`',
    'accepted-for-o4-closure-readiness-input',
    'evidence chain is intact',
    'local socket / local IPC only',
    'no public TCP listener',
    'no service install',
    'no Compose change',
    'no runtime custody cutover',
    'O4 status: `open/deferred`',
    'O5 status: `open/deferred`',
    'This record does not close O4 and does not close O5.',
  ]) assert(combined.includes(required), `Phase 191 surface preserves ${required}`);
  for (const forbidden of [
    'postgres://',
    'postgresql://',
    '-----BEGIN',
    'ssh-ed25519',
    'token:',
    'password:',
    'secret:',
    'kek:',
    'dek:',
    'wrappedHex',
    'dekBase64',
    '/mnt/user/',
    '/boot/config/',
    'C:\\',
    '\\\\.\\pipe\\',
    'http://',
    'https://',
    '192.168.',
    'localhost:',
  ]) assert(!doc.includes(forbidden), `Phase 191 record excludes ${forbidden}`);
});

test('Phase 192 O4 sidecar closure readiness gate is closure-eligible after Phase 197', () => {
  assert(exists('docs/PHASE_192_O4_SIDECAR_CLOSURE_READINESS.md'), 'Phase 192 O4 closure readiness doc exists');
  assert(exists('test/o4-sidecar-closure-readiness.ts'), 'Phase 192 O4 closure readiness test exists');
  assert(pkg.scripts['test:o4-sidecar-closure-readiness'] === 'tsx test/o4-sidecar-closure-readiness.ts', 'Phase 192 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-factory-evidence-acceptance-record.ts && tsx test/o4-sidecar-closure-readiness.ts && tsx test/o4-closure-disposition.ts && tsx test/runtime-cutover-plan.ts && tsx test/sidecar-service-install.ts && tsx test/sidecar-unraid-service-plan.ts'),
    'Phase 192 aggregate test sits after Phase 191 acceptance record',
  );
  const doc = read('docs/PHASE_192_O4_SIDECAR_CLOSURE_READINESS.md');
  const suite = read('test/o4-sidecar-closure-readiness.ts');
  const combined = `${doc}\n${suite}\n${read('README.md')}\n${read('package.json')}`;
  for (const required of [
    'phase-192-o4-sidecar-closure-readiness',
    'phase-191-sidecar-evidence-acceptance-record',
    'commit `7990ac2`',
    'tag `phase-191`',
    'sha256:a3b1c61af28ac37b8e24ed7cfb941eb128a119a201036263e4ac2e7daee1fe8a',
    'sha256:f75d46172af9ff3c1a1c452dad4a1914958908e6a2210871510c017d6fdea0f2',
    'Phase 190 review verdict: `ok:true`',
    '| Criterion | Required Evidence | Current State | Status |',
    'Phase 191 acceptance record exists, is redaction-safe, and cites Phase 190 passing evidence',
    '`satisfied`',
    'Runtime cutover plan exists and is reviewed',
    'Satisfied by `docs/PHASE_193_RUNTIME_CUTOVER_PLAN.md`',
    'Sidecar service installed on Unraid, local socket only, no public ports',
    'Satisfied by `docs/PHASE_194_UNRAID_SIDECAR_SERVICE_INSTALL.md`',
    'Production custody switched with post-switch evidence, persistence checks restarted, UI/API healthy',
    'Satisfied by `docs/PHASE_197_PRODUCTION_CUSTODY_SWITCH_RETRY.md`',
    '`satisfied-phase-197`',
    'Readiness verdict: `O4_READY_PENDING_EXECUTION`',
    'O4 status after Phase 197: `closure-eligible`',
    'O5 status after this gate: `open/deferred`',
    'does not close O4 and does not close O5',
  ]) assert(combined.includes(required), `Phase 192 surface preserves ${required}`);
  for (const forbidden of [
    'postgres://',
    'postgresql://',
    '-----BEGIN',
    'ssh-ed25519',
    'token:',
    'password:',
    'secret:',
    'kek:',
    'dek:',
    'wrappedHex',
    'dekBase64',
    '/mnt/user/',
    '/boot/config/',
    'C:\\',
    '\\\\.\\pipe\\',
    'http://',
    'https://',
    '192.168.',
    'localhost:',
    'o4Status: closed/authorized',
    'authorizationStatus: o4-authorized',
    'authorizesO4Closure: true',
  ]) assert(!doc.includes(forbidden), `Phase 192 record excludes ${forbidden}`);
});

test('Phase 193 runtime cutover plan defines file-to-sidecar execution without mutation', () => {
  assert(exists('docs/PHASE_193_RUNTIME_CUTOVER_PLAN.md'), 'Phase 193 runtime cutover plan doc exists');
  assert(exists('test/runtime-cutover-plan.ts'), 'Phase 193 runtime cutover plan test exists');
  assert(pkg.scripts['test:runtime-cutover-plan'] === 'tsx test/runtime-cutover-plan.ts', 'Phase 193 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/o4-sidecar-closure-readiness.ts && tsx test/o4-closure-disposition.ts && tsx test/runtime-cutover-plan.ts && tsx test/sidecar-service-install.ts && tsx test/sidecar-unraid-service-plan.ts'),
    'Phase 193 aggregate test sits after Phase 192 readiness gate',
  );
  const doc = read('docs/PHASE_193_RUNTIME_CUTOVER_PLAN.md');
  const suite = read('test/runtime-cutover-plan.ts');
  const combined = `${doc}\n${suite}\n${read('README.md')}\n${read('package.json')}`;
  for (const required of [
    'phase-193-runtime-cutover-plan',
    'plan-only phase',
    'This plan satisfies the Phase 193 criterion in the Phase 192 gate.',
    'does not satisfy Phase 194 or Phase 195',
    'Phase 194 sidecar service install evidence exists',
    'fresh backup of custody-relevant state',
    'CUSTODIAN_MODE: file',
    'CUSTODIAN_MODE: sidecar',
    'CUSTODIAN_SIDECAR_SOCKET_PATH: /run/catalog-sidecar/catalog-sidecar.sock',
    '## Cutover Sequence',
    '## Verification Matrix',
    '## Rollback',
    'Rollback direction: `CUSTODIAN_MODE=sidecar` back to `CUSTODIAN_MODE=file`.',
    'Rollback triggers:',
    'Data-safety notes:',
    '## Abort Points',
    'O4 status after this phase: `open/deferred`',
    'O5 status after this phase: `open/deferred`',
    'Phase 194 is now unblocked.',
  ]) assert(combined.includes(required), `Phase 193 surface preserves ${required}`);
  for (const forbidden of [
    'postgres://',
    'postgresql://',
    '-----BEGIN',
    'ssh-ed25519',
    'token:',
    'password:',
    'secret:',
    'kek:',
    'dek:',
    'wrappedHex',
    'dekBase64',
    '/mnt/user/',
    '/boot/config/',
    'C:\\',
    '\\\\.\\pipe\\',
    'http://',
    'https://',
    '192.168.',
    'localhost:',
    'o4Status: closed/authorized',
    'authorizationStatus: o4-authorized',
    'authorizesO4Closure: true',
  ]) assert(!doc.includes(forbidden), `Phase 193 plan excludes ${forbidden}`);
});

test('Phase 194 sidecar service install adds socket-only idle service without custody switch', () => {
  assert(exists('docs/PHASE_194_UNRAID_SIDECAR_SERVICE_INSTALL.md'), 'Phase 194 sidecar service install doc exists');
  assert(exists('test/sidecar-service-install.ts'), 'Phase 194 sidecar service install test exists');
  assert(pkg.scripts['test:sidecar-service-install'] === 'tsx test/sidecar-service-install.ts', 'Phase 194 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/runtime-cutover-plan.ts && tsx test/sidecar-service-install.ts && tsx test/sidecar-unraid-service-plan.ts'),
    'Phase 194 aggregate test sits after Phase 193 runtime plan',
  );
  const sidecarMatch = unraidRuntimeCompose.match(/  sidecar:\r?\n[\s\S]*?\r?\n  app:\r?\n/);
  assert(sidecarMatch, 'sidecar service block exists before app');
  const sidecar = sidecarMatch![0];
  for (const required of [
    'restart: unless-stopped',
    'SIDECAR_SOCKET_PATH: /run/catalog-sidecar/catalog-sidecar.sock',
    'SIDECAR_STATE_DIR: /var/lib/catalog-sidecar/state',
    'SIDECAR_COMPLETION_SECRET_FILE: /run/secrets/completion_secret',
    'SIDECAR_KEK_FILE: /run/secrets/custodian_kek',
    'NPM_CONFIG_CACHE: /tmp/npm-cache',
    'command: ["ops:sidecar-daemon", "--", "--serve"]',
    'test -S /run/catalog-sidecar/catalog-sidecar.sock',
    '${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/sidecar/run:/run/catalog-sidecar',
    '${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/sidecar/state:/var/lib/catalog-sidecar/state',
    'read_only: true',
    'cap_drop:',
    '- ALL',
    'security_opt:',
    '- no-new-privileges:true',
    'pids_limit: 128',
    'mem_limit: 256m',
  ]) assert(sidecar.includes(required), `Phase 194 sidecar block preserves ${required}`);
  for (const forbidden of [
    'ports:',
    'network_mode: host',
    'privileged: true',
    '/var/run/docker.sock',
    '0.0.0.0',
  ]) assert(!sidecar.includes(forbidden), `Phase 194 sidecar block excludes ${forbidden}`);
  assert(unraidRuntimeCompose.includes('  sidecar:'), 'Phase 194 sidecar service remains present after later switch');

  const doc = read('docs/PHASE_194_UNRAID_SIDECAR_SERVICE_INSTALL.md');
  const suite = read('test/sidecar-service-install.ts');
  const combined = `${doc}\n${suite}\n${read('README.md')}\n${read('package.json')}`;
  for (const required of [
    'phase-194-unraid-sidecar-service-install',
    'installed-and-idle',
    'App custody mode after install: `file`',
    'Ops custody mode after install: `file`',
    'phase-194-sidecar-install-evidence',
    'phase-194-sidecar-health-evidence',
    'phase-194-sidecar-exposure-proof',
    'phase-194-sidecar-restart-persistence',
    'phase-194-app-custody-unchanged',
    'This phase satisfies the Phase 194 criterion in the Phase 192 gate',
    'Phase 195 remains unsatisfied',
    'O4 remains open',
    'O5 remains open',
  ]) assert(combined.includes(required), `Phase 194 surface preserves ${required}`);
});

test('Phase 196 cutover doctor/parser fix is schema-aware and retry-safe', () => {
  assert(exists('docs/PHASE_196_CUTOVER_PARSER_FIX.md'), 'Phase 196 parser fix doc exists');
  assert(exists('src/ops/cutover-doctor-check.ts'), 'Phase 196 parser source exists');
  assert(exists('src/ops/cutover-doctor-check-cli.ts'), 'Phase 196 parser CLI exists');
  assert(exists('test/cutover-parser.ts'), 'Phase 196 parser test exists');
  assert(exists('test/fixtures/phase-196/phase-195-post-switch-doctor.raw.txt'), 'Phase 196 real doctor fixture exists');
  assert(pkg.scripts['test:cutover-parser'] === 'tsx test/cutover-parser.ts', 'Phase 196 test script present');
  assert(pkg.scripts['ops:cutover-doctor-check'] === 'tsx src/ops/cutover-doctor-check-cli.ts', 'Phase 196 ops script present');
  const combined = [
    read('docs/PHASE_196_CUTOVER_PARSER_FIX.md'),
    read('docs/PHASE_193_RUNTIME_CUTOVER_PLAN.md'),
    read('src/ops/cutover-doctor-check.ts'),
    read('src/ops/cutover-doctor-check-cli.ts'),
    read('test/cutover-parser.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-196-cutover-parser-fix',
    'phase-195-post-switch-doctor.raw.txt',
    'schema-aware cutover parser',
    "status: 'parse-error'",
    "status: 'unhealthy'",
    "status: 'healthy'",
    'retryable',
    'ops:cutover-doctor-check',
    'post-switch doctor parser returns retryable `parse-error`',
    'O4 status after Phase 196: `open/deferred`',
    'O5 status after Phase 196: `open/deferred`',
    'Phase 197 switch',
  ]) assert(combined.includes(required), `Phase 196 surface preserves ${required}`);
});

test('Phase 197 production custody switch retry makes sidecar mode the runtime invariant', () => {
  assert(exists('docs/PHASE_197_PRODUCTION_CUSTODY_SWITCH_RETRY.md'), 'Phase 197 switch retry doc exists');
  assert(pkg.scripts['test:production-custody-switch'] === 'tsx test/production-custody-switch.ts', 'Phase 197 production switch test script present');
  assert((unraidRuntimeCompose.match(/CUSTODIAN_MODE: sidecar/g) ?? []).length >= 2, 'Phase 197 app and ops are sidecar mode');
  assert(!unraidRuntimeCompose.includes('CUSTODIAN_MODE: file'), 'Phase 197 runtime no longer asserts file mode');
  assert((unraidRuntimeCompose.match(/CUSTODIAN_SIDECAR_SOCKET_PATH: \/run\/catalog-sidecar\/catalog-sidecar\.sock/g) ?? []).length >= 2, 'Phase 197 app and ops receive socket path');
  assert(!unraidRuntimeCompose.includes('CUSTODIAN_KEYSTORE_DIR: /var/lib/catalog/keystore'), 'Phase 197 removes file keystore env from app/ops');
  assert(!unraidRuntimeCompose.includes('CUSTODIAN_KEK_FILE: /run/secrets/custodian_kek'), 'Phase 197 removes app/ops KEK env');
  const combined = [
    read('docs/PHASE_197_PRODUCTION_CUSTODY_SWITCH_RETRY.md'),
    read('docs/PHASE_192_O4_SIDECAR_CLOSURE_READINESS.md'),
    read('test/production-custody-switch.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-197-production-custody-switch-retry',
    'production-sidecar-custody-active',
    'attempt=1 doctor_exit=0 parser_exit=0 verdict=healthy',
    'O4 status after Phase 197: `closure-eligible`',
    'O5 status after Phase 197: `open/deferred`',
    'satisfied-phase-197',
    'sidecar exposure proof',
    'Persistence evidence manifest digest',
    'O5 is unchanged and remains the only custody',
  ]) assert(combined.includes(required), `Phase 197 surface preserves ${required}`);
});

test('Phase 198 O4 final closure disposition records O4_CLOSED and leaves O5 open', () => {
  assert(exists('docs/PHASE_198_O4_FINAL_CLOSURE_DISPOSITION.md'), 'Phase 198 O4 final disposition doc exists');
  assert(exists('test/o4-closure-disposition.ts'), 'Phase 198 O4 final disposition test exists');
  assert(pkg.scripts['test:o4-closure-disposition'] === 'tsx test/o4-closure-disposition.ts', 'Phase 198 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/o4-sidecar-closure-readiness.ts && tsx test/o4-closure-disposition.ts && tsx test/runtime-cutover-plan.ts'),
    'Phase 198 aggregate test follows Phase 192 readiness',
  );
  const combined = [
    read('docs/PHASE_198_O4_FINAL_CLOSURE_DISPOSITION.md'),
    read('test/o4-closure-disposition.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-198-o4-final-closure-disposition',
    'O4 final status: `O4_CLOSED`',
    'phase-198-evidence-chain-satisfied',
    'Phase 195 attempted the production custody switch and rolled back.',
    'Phase 196 identified the root cause as a false negative',
    'attempt=1 doctor_exit=0 parser_exit=0 verdict=healthy',
    'Sidecar single-instance recovery',
    'Socket permission drift',
    'O5 final disposition: `open/deferred`',
    'O4 closure does not close O5',
  ]) assert(combined.includes(required), `Phase 198 surface preserves ${required}`);
  const doc = read('docs/PHASE_198_O4_FINAL_CLOSURE_DISPOSITION.md');
  for (const forbidden of [
    'O5_CLOSED',
    'provider mode enabled',
    'playback enabled',
  ]) assert(!doc.includes(forbidden), `Phase 198 record excludes ${forbidden}`);
});

test('Phase 199 O5 final disposition records accepted deferral and launch warning', () => {
  assert(exists('docs/PHASE_199_O5_FINAL_DISPOSITION.md'), 'Phase 199 O5 final disposition doc exists');
  assert(exists('test/o5-disposition.ts'), 'Phase 199 O5 disposition test exists');
  assert(pkg.scripts['test:o5-disposition'] === 'tsx test/o5-disposition.ts', 'Phase 199 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/o5-kek-final-authorization.ts && tsx test/o5-disposition.ts && tsx test/launch-readiness-pass.ts && tsx test/launch-package.ts && tsx test/launch-candidate-dry-run.ts && tsx test/media-player-boundary.ts && tsx test/jellyfin-readonly-smoke.ts && tsx test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 199 aggregate test follows O5 authorization preflight',
  );
  const combined = [
    read('docs/PHASE_199_O5_FINAL_DISPOSITION.md'),
    read('test/o5-disposition.ts'),
    read('README.md'),
    read('docs/RELEASE_CHECKLIST.md'),
    read('docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md'),
  ].join('\n');
  for (const required of [
    'phase-199-o5-final-disposition',
    'O5_DEFERRED_ACCEPTED',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
    'O4_CLOSED',
    'commit `a3681d3`',
    'tag `phase-198`',
    'suspected KEK compromise',
    '90 days have elapsed',
    'Phase 200 launch/readiness review is unblocked',
  ]) assert(combined.includes(required), `Phase 199 surface preserves ${required}`);
  const doc = read('docs/PHASE_199_O5_FINAL_DISPOSITION.md');
  for (const forbidden of [
    'postgres://',
    'postgresql://',
    '-----BEGIN',
    'ssh-ed25519',
    'token:',
    'password:',
    'secret:',
    'kek:',
    'dek:',
    'wrappedHex',
    'dekBase64',
    '/mnt/user/',
    '/boot/config/',
    'C:\\',
    '\\\\.\\pipe\\',
    'http://',
    'https://',
    '192.168.',
    'localhost:',
  ]) assert(!doc.includes(forbidden), `Phase 199 record excludes ${forbidden}`);
});

test('Phase 200 launch readiness pass records ready with accepted warning', () => {
  assert(exists('docs/PHASE_200_LAUNCH_READINESS_PASS.md'), 'Phase 200 launch readiness doc exists');
  assert(exists('test/launch-readiness-pass.ts'), 'Phase 200 launch readiness test exists');
  assert(pkg.scripts['test:launch-readiness-pass'] === 'tsx test/launch-readiness-pass.ts', 'Phase 200 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/o5-disposition.ts && tsx test/launch-readiness-pass.ts && tsx test/launch-package.ts && tsx test/launch-candidate-dry-run.ts && tsx test/media-player-boundary.ts && tsx test/jellyfin-readonly-smoke.ts && tsx test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 200 aggregate test follows O5 disposition',
  );
  const combined = [
    read('docs/PHASE_200_LAUNCH_READINESS_PASS.md'),
    read('test/launch-readiness-pass.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-200-launch-readiness-pass',
    'LAUNCH_READY_WITH_ACCEPTED_WARNINGS',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
    'O4_CLOSED',
    'O5_DEFERRED_ACCEPTED',
    'phase-200-unraid-sync-4998c65de',
    'phase-200-repo-ops-latest-build',
    'phase-200-ui-live-check-ok-true',
    'no streaming product claim',
  ]) assert(combined.includes(required), `Phase 200 surface preserves ${required}`);
  const doc = read('docs/PHASE_200_LAUNCH_READINESS_PASS.md');
  for (const forbidden of [
    'O5_CLOSED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '/mnt/user/',
    '192.168.',
  ]) assert(!doc.includes(forbidden), `Phase 200 record excludes ${forbidden}`);
});

test('Phase 201 launch package exposes operator handoff without scope expansion', () => {
  assert(exists('docs/PHASE_201_LAUNCH_PACKAGE.md'), 'Phase 201 launch package doc exists');
  assert(exists('test/launch-package.ts'), 'Phase 201 launch package test exists');
  assert(pkg.scripts['test:launch-package'] === 'tsx test/launch-package.ts', 'Phase 201 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/launch-readiness-pass.ts && tsx test/launch-package.ts && tsx test/launch-candidate-dry-run.ts && tsx test/media-player-boundary.ts && tsx test/jellyfin-readonly-smoke.ts && tsx test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 201 aggregate test follows launch readiness pass',
  );
  const combined = [
    read('docs/PHASE_201_LAUNCH_PACKAGE.md'),
    read('test/launch-package.ts'),
    read('README.md'),
    read('RELEASE.md'),
  ].join('\n');
  for (const required of [
    'phase-201-launch-package',
    'LAUNCH_PACKAGE_READY_WITH_ACCEPTED_WARNINGS',
    'LAUNCH_READY_WITH_ACCEPTED_WARNINGS',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
    'O4_CLOSED',
    'O5_DEFERRED_ACCEPTED',
    'Current launch package: `phase-200` / `0d08052`',
    '/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check',
    'no streaming product claim',
  ]) assert(combined.includes(required), `Phase 201 surface preserves ${required}`);
  const doc = read('docs/PHASE_201_LAUNCH_PACKAGE.md');
  for (const forbidden of [
    'O5_CLOSED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
  ]) assert(!doc.includes(forbidden), `Phase 201 record excludes ${forbidden}`);
});

test('Phase 202 launch candidate consumer dry run preserves the public launch path', () => {
  assert(exists('docs/PHASE_202_LAUNCH_CANDIDATE_DRY_RUN.md'), 'Phase 202 consumer dry-run doc exists');
  assert(exists('test/launch-candidate-dry-run.ts'), 'Phase 202 consumer dry-run test exists');
  assert(pkg.scripts['test:launch-candidate-dry-run'] === 'tsx test/launch-candidate-dry-run.ts', 'Phase 202 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/launch-package.ts && tsx test/launch-candidate-dry-run.ts && tsx test/media-player-boundary.ts && tsx test/jellyfin-readonly-smoke.ts && tsx test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 202 aggregate test follows launch package',
  );
  const combined = [
    read('docs/PHASE_202_LAUNCH_CANDIDATE_DRY_RUN.md'),
    read('test/launch-candidate-dry-run.ts'),
    read('README.md'),
    read('RELEASE.md'),
  ].join('\n');
  for (const required of [
    'phase-202-launch-candidate-consumer-dry-run',
    'LAUNCH_CANDIDATE_CONSUMER_DRY_RUN_READY_WITH_ACCEPTED_WARNINGS',
    'Operator handoff package: `phase-201` / `9378a07`',
    'Consumer dry-run gate: `docs/PHASE_202_LAUNCH_CANDIDATE_DRY_RUN.md`',
    'git clone https://github.com/cdb8457/streaming-catalog-authority.git .',
    'docker compose -f docker-compose.unraid.runtime.yml up -d postgres app sidecar',
    '/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
    'no provider or media runtime behavior enabled',
  ]) assert(combined.includes(required), `Phase 202 surface preserves ${required}`);
  const doc = read('docs/PHASE_202_LAUNCH_CANDIDATE_DRY_RUN.md');
  for (const forbidden of [
    'O5_CLOSED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
  ]) assert(!doc.includes(forbidden), `Phase 202 record excludes ${forbidden}`);
});

test('Phase 203 media-player boundary selection chooses Jellyfin without enabling runtime', () => {
  assert(exists('docs/PHASE_203_MEDIA_PLAYER_BOUNDARY_SELECTION.md'), 'Phase 203 media-player boundary doc exists');
  assert(exists('test/media-player-boundary.ts'), 'Phase 203 media-player boundary test exists');
  assert(pkg.scripts['test:media-player-boundary'] === 'tsx test/media-player-boundary.ts', 'Phase 203 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/launch-candidate-dry-run.ts && tsx test/media-player-boundary.ts && tsx test/jellyfin-readonly-smoke.ts && tsx test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 203 aggregate test follows launch candidate dry run',
  );
  const combined = [
    read('docs/PHASE_203_MEDIA_PLAYER_BOUNDARY_SELECTION.md'),
    read('test/media-player-boundary.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-203-media-player-boundary-selection',
    'JELLYFIN_SELECTED_FOR_BOUNDARY_CONTROLLED_TESTING',
    'Plex status: `DEFERRED`',
    'Emby status: `DEFERRED_LIKELY_FOLLOWS_JELLYFIN_PATTERNS`',
    'GET /System/Info',
    'GET /Items?Recursive=true&Fields=ProviderIds&IncludeItemTypes=Movie,Series&StartIndex=<n>&Limit=<n>',
    'Rung 3: Phase 206 Optional Write-Capable Disposable Collection',
    'JELLYFIN_ENABLE_NETWORK` defaults off',
    'JELLYFIN_ALLOW_LIVE_PUBLISH` defaults off',
    'O5_DEFERRED_ACCEPTED',
  ]) assert(combined.includes(required), `Phase 203 surface preserves ${required}`);
  const doc = read('docs/PHASE_203_MEDIA_PLAYER_BOUNDARY_SELECTION.md');
  for (const forbidden of [
    'O5_CLOSED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
  ]) assert(!doc.includes(forbidden), `Phase 203 record excludes ${forbidden}`);
});

test('Phase 204 Jellyfin read-only smoke is guarded and write-free', () => {
  assert(exists('docs/PHASE_204_JELLYFIN_READ_ONLY_SMOKE.md'), 'Phase 204 Jellyfin read-only smoke doc exists');
  assert(exists('test/jellyfin-readonly-smoke.ts'), 'Phase 204 Jellyfin read-only smoke test exists');
  assert(pkg.scripts['test:jellyfin-readonly-smoke'] === 'tsx test/jellyfin-readonly-smoke.ts', 'Phase 204 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/media-player-boundary.ts && tsx test/jellyfin-readonly-smoke.ts && tsx test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 204 aggregate test follows media-player boundary and precedes Unraid readiness bundle',
  );
  const combined = [
    read('docs/PHASE_204_JELLYFIN_READ_ONLY_SMOKE.md'),
    read('test/jellyfin-readonly-smoke.ts'),
    read('src/core/adapters/jellyfin/smoke.ts'),
    read('src/core/adapters/jellyfin/mapping.ts'),
    read('src/core/adapters/jellyfin/http-client.ts'),
  ].join('\n');
  for (const required of [
    'phase-204-jellyfin-read-only-smoke',
    'JELLYFIN_READ_ONLY_SMOKE_READY',
    'buildSystemInfoRequest',
    'getServerInfo',
    'GET /System/Info',
    'GET /Items?Recursive=true&Fields=ProviderIds&IncludeItemTypes=Movie,Series&StartIndex=<n>&Limit=<n>',
    'JELLYFIN_API_KEY_FILE',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(combined.includes(required), `Phase 204 surface preserves ${required}`);
  const doc = read('docs/PHASE_204_JELLYFIN_READ_ONLY_SMOKE.md');
  for (const forbidden of [
    'O5_CLOSED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `Phase 204 record excludes ${forbidden}`);
});

test('Phase 205 Jellyfin read-only mapping emits counts-only evidence', () => {
  assert(exists('docs/PHASE_205_JELLYFIN_READ_ONLY_MAPPING.md'), 'Phase 205 Jellyfin read-only mapping doc exists');
  assert(exists('src/core/adapters/jellyfin/read-only-mapping.ts'), 'Phase 205 Jellyfin read-only mapping source exists');
  assert(exists('test/jellyfin-readonly-mapping.ts'), 'Phase 205 Jellyfin read-only mapping test exists');
  assert(pkg.scripts['test:jellyfin-readonly-mapping'] === 'tsx test/jellyfin-readonly-mapping.ts', 'Phase 205 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/jellyfin-readonly-smoke.ts && tsx test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 205 aggregate test follows read-only smoke and precedes Unraid readiness bundle',
  );
  const combined = [
    read('docs/PHASE_205_JELLYFIN_READ_ONLY_MAPPING.md'),
    read('src/core/adapters/jellyfin/read-only-mapping.ts'),
    read('test/jellyfin-readonly-mapping.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-205-jellyfin-readonly-mapping',
    'JELLYFIN_READ_ONLY_MAPPING_READY',
    'withPublishableIdentity',
    "['providerRefs']",
    'findItemsByRefs',
    'itemDigest',
    'refsConsidered',
    'jellyfinMatches',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(combined.includes(required), `Phase 205 surface preserves ${required}`);
  const doc = read('docs/PHASE_205_JELLYFIN_READ_ONLY_MAPPING.md');
  for (const forbidden of [
    'O5_CLOSED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `Phase 205 record excludes ${forbidden}`);
});

test('Phase 206 Jellyfin disposable write proof is gated and self-cleaning', () => {
  assert(exists('docs/PHASE_206_JELLYFIN_DISPOSABLE_WRITE_PROOF.md'), 'Phase 206 Jellyfin disposable write doc exists');
  assert(exists('test/jellyfin-disposable-write.ts'), 'Phase 206 Jellyfin disposable write test exists');
  assert(pkg.scripts['test:jellyfin-disposable-write'] === 'tsx test/jellyfin-disposable-write.ts', 'Phase 206 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 206 aggregate test follows read-only mapping and precedes Unraid readiness bundle',
  );
  const combined = [
    read('docs/PHASE_206_JELLYFIN_DISPOSABLE_WRITE_PROOF.md'),
    read('test/jellyfin-disposable-write.ts'),
    read('src/core/adapters/jellyfin/smoke.ts'),
    read('src/ops/jellyfin-smoke-cli.ts'),
    read('src/core/adapters/jellyfin/real-factory.ts'),
  ].join('\n');
  for (const required of [
    'phase-206-jellyfin-disposable-write-proof',
    'JELLYFIN_DISPOSABLE_WRITE_PROOF_READY',
    'runWriteSmoke',
    'createTaggedCollection',
    'findCollectionByToken',
    'deleteCollection',
    'verify-gone',
    'CLEANUP NOT CONFIRMED',
    'JELLYFIN_ALLOW_LIVE_PUBLISH',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(combined.includes(required), `Phase 206 surface preserves ${required}`);
  const doc = read('docs/PHASE_206_JELLYFIN_DISPOSABLE_WRITE_PROOF.md');
  for (const forbidden of [
    'O5_CLOSED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `Phase 206 record excludes ${forbidden}`);
});

test('Phase 207 Jellyfin evidence review decision defers launch pending live evidence', () => {
  assert(exists('docs/PHASE_207_JELLYFIN_EVIDENCE_REVIEW_DECISION.md'), 'Phase 207 Jellyfin decision doc exists');
  assert(exists('test/jellyfin-evidence-review-decision.ts'), 'Phase 207 Jellyfin decision test exists');
  assert(pkg.scripts['test:jellyfin-evidence-review-decision'] === 'tsx test/jellyfin-evidence-review-decision.ts', 'Phase 207 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 207 aggregate test follows disposable write proof and precedes Unraid readiness bundle',
  );
  const combined = [
    read('docs/PHASE_207_JELLYFIN_EVIDENCE_REVIEW_DECISION.md'),
    read('test/jellyfin-evidence-review-decision.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-207-jellyfin-evidence-review-decision',
    'JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE',
    'phase-203',
    'phase-204',
    'phase-205',
    'phase-206',
    'Jellyfin integration is not approved for launch yet',
    'Default Compose files must not enable Jellyfin networking or write mode',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(combined.includes(required), `Phase 207 surface preserves ${required}`);
  const doc = read('docs/PHASE_207_JELLYFIN_EVIDENCE_REVIEW_DECISION.md');
  for (const forbidden of [
    'O5_CLOSED',
    'JELLYFIN_INTEGRATION_LAUNCHED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `Phase 207 record excludes ${forbidden}`);
});

test('Phase 208 existing Jellyfin live evidence preflight forbids installs and port collisions', () => {
  assert(exists('docs/PHASE_208_EXISTING_JELLYFIN_LIVE_EVIDENCE_PREFLIGHT.md'), 'Phase 208 Jellyfin preflight doc exists');
  assert(exists('test/jellyfin-live-evidence-preflight.ts'), 'Phase 208 Jellyfin preflight test exists');
  assert(pkg.scripts['test:jellyfin-live-evidence-preflight'] === 'tsx test/jellyfin-live-evidence-preflight.ts', 'Phase 208 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 208 aggregate test follows evidence review decision and precedes Unraid readiness bundle',
  );
  const combined = [
    read('docs/PHASE_208_EXISTING_JELLYFIN_LIVE_EVIDENCE_PREFLIGHT.md'),
    read('test/jellyfin-live-evidence-preflight.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-208-existing-jellyfin-live-evidence-preflight',
    'EXISTING_JELLYFIN_DISCOVERED_LIVE_EVIDENCE_PREFLIGHT_READY',
    'LIVE_EVIDENCE_PREFLIGHT_READY_NO_INSTALL',
    'port `8096`',
    'port `8920`',
    'port `8099`',
    'port `32400`',
    'ss -ltnp',
    'docker ps --format',
    'never start a second Jellyfin instance',
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(combined.includes(required), `Phase 208 surface preserves ${required}`);
  const doc = read('docs/PHASE_208_EXISTING_JELLYFIN_LIVE_EVIDENCE_PREFLIGHT.md');
  for (const forbidden of [
    'O5_CLOSED',
    'JELLYFIN_INTEGRATION_LAUNCHED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `Phase 208 record excludes ${forbidden}`);
});

test('Phase 209 Jellyfin live read-only smoke runner is secret-file-only and write-free', () => {
  assert(exists('docs/PHASE_209_JELLYFIN_LIVE_READONLY_SMOKE_RUNNER.md'), 'Phase 209 Jellyfin live runner doc exists');
  assert(exists('src/ops/jellyfin-live-readonly-smoke.ts'), 'Phase 209 Jellyfin live runner module exists');
  assert(exists('src/ops/jellyfin-live-readonly-smoke-cli.ts'), 'Phase 209 Jellyfin live runner CLI exists');
  assert(exists('test/jellyfin-live-readonly-smoke-runner.ts'), 'Phase 209 Jellyfin live runner test exists');
  assert(pkg.scripts['ops:jellyfin-live-readonly-smoke'] === 'tsx src/ops/jellyfin-live-readonly-smoke-cli.ts', 'Phase 209 ops script present');
  assert(pkg.scripts['test:jellyfin-live-readonly-smoke-runner'] === 'tsx test/jellyfin-live-readonly-smoke-runner.ts', 'Phase 209 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 209 aggregate test follows live evidence preflight and precedes Unraid readiness bundle',
  );
  const combined = [
    read('docs/PHASE_209_JELLYFIN_LIVE_READONLY_SMOKE_RUNNER.md'),
    read('src/ops/jellyfin-live-readonly-smoke.ts'),
    read('test/jellyfin-live-readonly-smoke-runner.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-209-jellyfin-live-readonly-smoke-runner',
    'JELLYFIN_LIVE_READONLY_SMOKE_RUNNER_READY',
    'LIVE_READONLY_SMOKE_RUNNER_READY_NO_EVIDENCE_CAPTURED',
    'phase-209-jellyfin-live-readonly-smoke',
    'JELLYFIN_API_KEY_FILE',
    'JELLYFIN_API_KEY must not be set',
    'JELLYFIN_ALLOW_LIVE_PUBLISH must not be true',
    'GET /System/Info',
    'GET /Items',
    'hostEchoed: false',
    'apiKeyEchoed: false',
    'evidenceDigest',
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(combined.includes(required), `Phase 209 surface preserves ${required}`);
  const doc = read('docs/PHASE_209_JELLYFIN_LIVE_READONLY_SMOKE_RUNNER.md');
  for (const forbidden of [
    'O5_CLOSED',
    'JELLYFIN_INTEGRATION_LAUNCHED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `Phase 209 record excludes ${forbidden}`);
});

test('Phase 210 Jellyfin live evidence capture preflight records missing secret without live smoke', () => {
  assert(exists('docs/PHASE_210_JELLYFIN_LIVE_EVIDENCE_CAPTURE_PREFLIGHT.md'), 'Phase 210 Jellyfin live capture preflight doc exists');
  assert(exists('test/jellyfin-live-evidence-capture-preflight.ts'), 'Phase 210 Jellyfin live capture preflight test exists');
  assert(pkg.scripts['test:jellyfin-live-evidence-capture-preflight'] === 'tsx test/jellyfin-live-evidence-capture-preflight.ts', 'Phase 210 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 210 aggregate test follows live read-only runner and precedes Unraid readiness bundle',
  );
  const combined = [
    read('docs/PHASE_210_JELLYFIN_LIVE_EVIDENCE_CAPTURE_PREFLIGHT.md'),
    read('test/jellyfin-live-evidence-capture-preflight.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-210-jellyfin-live-evidence-capture-preflight',
    'JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING',
    'LIVE_EVIDENCE_CAPTURE_READY_AFTER_SECRET_SETUP',
    'Jellyfin listener present on port `8096`',
    'Jellyfin API key secret file missing',
    '/mnt/user/appdata/catalog/secrets/jellyfin_api_key',
    'no live smoke was run in this phase',
    'JELLYFIN_API_KEY_FILE=/mnt/user/appdata/catalog/secrets/jellyfin_api_key',
    'phase-210-jellyfin-live-readonly-smoke.json',
    'writeMode: false',
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(combined.includes(required), `Phase 210 surface preserves ${required}`);
  const doc = read('docs/PHASE_210_JELLYFIN_LIVE_EVIDENCE_CAPTURE_PREFLIGHT.md');
  for (const forbidden of [
    'O5_CLOSED',
    'JELLYFIN_INTEGRATION_LAUNCHED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `Phase 210 record excludes ${forbidden}`);
});

test('Phase 211 Jellyfin live evidence capture command saves redaction-safe smoke JSON', () => {
  assert(exists('docs/PHASE_211_JELLYFIN_LIVE_EVIDENCE_CAPTURE_COMMAND.md'), 'Phase 211 Jellyfin live capture command doc exists');
  assert(exists('src/ops/jellyfin-live-evidence-capture.ts'), 'Phase 211 Jellyfin live capture module exists');
  assert(exists('src/ops/jellyfin-live-evidence-capture-cli.ts'), 'Phase 211 Jellyfin live capture CLI exists');
  assert(exists('test/jellyfin-live-evidence-capture.ts'), 'Phase 211 Jellyfin live capture test exists');
  assert(pkg.scripts['ops:jellyfin-live-evidence-capture'] === 'tsx src/ops/jellyfin-live-evidence-capture-cli.ts', 'Phase 211 ops script present');
  assert(pkg.scripts['test:jellyfin-live-evidence-capture'] === 'tsx test/jellyfin-live-evidence-capture.ts', 'Phase 211 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 211 aggregate test follows capture preflight and precedes Unraid readiness bundle',
  );
  const combined = [
    read('docs/PHASE_211_JELLYFIN_LIVE_EVIDENCE_CAPTURE_COMMAND.md'),
    read('src/ops/jellyfin-live-evidence-capture.ts'),
    read('test/jellyfin-live-evidence-capture.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-211-jellyfin-live-evidence-capture-command',
    'JELLYFIN_LIVE_EVIDENCE_CAPTURE_COMMAND_READY_SECRET_BLOCKED',
    'LIVE_EVIDENCE_CAPTURE_COMMAND_READY_AWAITING_SECRET',
    'phase-211-jellyfin-live-evidence-capture',
    'phase-209-jellyfin-live-readonly-smoke',
    'ops:jellyfin-live-evidence-capture',
    '--out /mnt/user/appdata/catalog/evidence/phase-211-jellyfin-live-readonly-smoke.json',
    'JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING',
    'evidenceDigest',
    'bytesWritten',
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(combined.includes(required), `Phase 211 surface preserves ${required}`);
  const doc = read('docs/PHASE_211_JELLYFIN_LIVE_EVIDENCE_CAPTURE_COMMAND.md');
  for (const forbidden of [
    'O5_CLOSED',
    'JELLYFIN_INTEGRATION_LAUNCHED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `Phase 211 record excludes ${forbidden}`);
});

test('Phase 212 Jellyfin secret readiness gate validates secret file without live contact', () => {
  assert(exists('docs/PHASE_212_JELLYFIN_SECRET_READINESS_GATE.md'), 'Phase 212 Jellyfin secret readiness doc exists');
  assert(exists('src/ops/jellyfin-secret-readiness.ts'), 'Phase 212 Jellyfin secret readiness module exists');
  assert(exists('src/ops/jellyfin-secret-readiness-cli.ts'), 'Phase 212 Jellyfin secret readiness CLI exists');
  assert(exists('test/jellyfin-secret-readiness.ts'), 'Phase 212 Jellyfin secret readiness test exists');
  assert(pkg.scripts['ops:jellyfin-secret-readiness'] === 'tsx src/ops/jellyfin-secret-readiness-cli.ts', 'Phase 212 ops script present');
  assert(pkg.scripts['test:jellyfin-secret-readiness'] === 'tsx test/jellyfin-secret-readiness.ts', 'Phase 212 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 212 aggregate test follows capture command and precedes Unraid readiness bundle',
  );
  const combined = [
    read('docs/PHASE_212_JELLYFIN_SECRET_READINESS_GATE.md'),
    read('src/ops/jellyfin-secret-readiness.ts'),
    read('test/jellyfin-secret-readiness.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-212-jellyfin-secret-readiness-gate',
    'JELLYFIN_SECRET_READINESS_GATE_READY',
    'SECRET_READINESS_COMMAND_READY_LIVE_CAPTURE_STILL_BLOCKED',
    'phase-212-jellyfin-secret-readiness',
    'JELLYFIN_SECRET_READY',
    'JELLYFIN_SECRET_NOT_READY',
    'secretValueEchoed: false',
    'secretPathEchoed: false',
    'DIRECT_SECRET_ENV_SET',
    'SECRET_FILE_MODE_TOO_OPEN',
    'does not contact Jellyfin',
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(combined.includes(required), `Phase 212 surface preserves ${required}`);
  const doc = read('docs/PHASE_212_JELLYFIN_SECRET_READINESS_GATE.md');
  for (const forbidden of [
    'O5_CLOSED',
    'JELLYFIN_INTEGRATION_LAUNCHED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `Phase 212 record excludes ${forbidden}`);
});

test('Phase 213 Jellyfin container command shape fix documents repo-ops execution', () => {
  assert(exists('docs/PHASE_213_JELLYFIN_CONTAINER_COMMAND_SHAPE_FIX.md'), 'Phase 213 Jellyfin container command shape doc exists');
  assert(exists('test/jellyfin-container-command-shape.ts'), 'Phase 213 Jellyfin container command shape test exists');
  assert(pkg.scripts['test:jellyfin-container-command-shape'] === 'tsx test/jellyfin-container-command-shape.ts', 'Phase 213 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 213 aggregate test follows secret readiness and precedes Unraid readiness bundle',
  );
  const combined = [
    read('docs/PHASE_213_JELLYFIN_CONTAINER_COMMAND_SHAPE_FIX.md'),
    read('test/jellyfin-container-command-shape.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-213-jellyfin-container-command-shape-fix',
    'JELLYFIN_CONTAINER_COMMAND_SHAPE_READY',
    'CONTAINER_COMMAND_SHAPE_FIXED_SECRET_STILL_MISSING',
    'direct host `npm run ops:jellyfin-secret-readiness` exits `127`',
    'docker run --rm',
    'repo-ops:latest',
    '-v /mnt/user/appdata/catalog/secrets/jellyfin_api_key:/run/secrets/jellyfin_api_key:ro',
    '-v /mnt/user/appdata/catalog/evidence:/evidence',
    '--out /evidence/phase-211-jellyfin-live-readonly-smoke.json',
    'mounting a missing secret path',
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(combined.includes(required), `Phase 213 surface preserves ${required}`);
  const doc = read('docs/PHASE_213_JELLYFIN_CONTAINER_COMMAND_SHAPE_FIX.md');
  for (const forbidden of [
    'O5_CLOSED',
    'JELLYFIN_INTEGRATION_LAUNCHED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `Phase 213 record excludes ${forbidden}`);
});

test('Phase 214 Jellyfin secret install operator packet documents safe secret setup', () => {
  assert(exists('docs/PHASE_214_JELLYFIN_SECRET_INSTALL_OPERATOR_PACKET.md'), 'Phase 214 Jellyfin secret install packet doc exists');
  assert(exists('test/jellyfin-secret-install-operator-packet.ts'), 'Phase 214 Jellyfin secret install packet test exists');
  assert(pkg.scripts['test:jellyfin-secret-install-operator-packet'] === 'tsx test/jellyfin-secret-install-operator-packet.ts', 'Phase 214 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 214 aggregate test follows container command shape and precedes Unraid readiness bundle',
  );
  const combined = [
    read('docs/PHASE_214_JELLYFIN_SECRET_INSTALL_OPERATOR_PACKET.md'),
    read('test/jellyfin-secret-install-operator-packet.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-214-jellyfin-secret-install-operator-packet',
    'JELLYFIN_SECRET_INSTALL_PACKET_READY',
    'SECRET_INSTALL_PACKET_READY_LIVE_CAPTURE_STILL_BLOCKED',
    'read -rsp',
    'unset JELLYFIN_KEY',
    'chmod 600',
    'Do not use `echo <api-key> > ...`',
    'docker run --rm',
    'repo-ops:latest',
    'JELLYFIN_SECRET_READY',
    'does not contact Jellyfin',
    'does not install Jellyfin',
    'does not expose or publish any new port',
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(combined.includes(required), `Phase 214 surface preserves ${required}`);
  const doc = read('docs/PHASE_214_JELLYFIN_SECRET_INSTALL_OPERATOR_PACKET.md');
  for (const forbidden of [
    'O5_CLOSED',
    'JELLYFIN_INTEGRATION_LAUNCHED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `Phase 214 record excludes ${forbidden}`);
});

test('Phase 215 Jellyfin live capture launcher guards post-secret execution', () => {
  assert(exists('deploy/unraid-jellyfin-live-capture.sh'), 'Phase 215 Jellyfin live capture launcher exists');
  assert(exists('docs/PHASE_215_JELLYFIN_LIVE_CAPTURE_LAUNCHER.md'), 'Phase 215 Jellyfin live capture launcher doc exists');
  assert(exists('test/jellyfin-live-capture-launcher.ts'), 'Phase 215 Jellyfin live capture launcher test exists');
  assert(pkg.scripts['test:jellyfin-live-capture-launcher'] === 'tsx test/jellyfin-live-capture-launcher.ts', 'Phase 215 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 215 aggregate test follows secret install packet and precedes Unraid readiness bundle',
  );
  const combined = [
    read('deploy/unraid-jellyfin-live-capture.sh'),
    read('docs/PHASE_215_JELLYFIN_LIVE_CAPTURE_LAUNCHER.md'),
    read('test/jellyfin-live-capture-launcher.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-215-jellyfin-live-capture-launcher',
    'JELLYFIN_LIVE_CAPTURE_LAUNCHER_READY',
    'LAUNCHER_READY_SECRET_STILL_REQUIRED',
    '[ ! -f "$SECRET_FILE" ]',
    '[ ! -s "$SECRET_FILE" ]',
    'ops:jellyfin-secret-readiness',
    'ops:jellyfin-live-evidence-capture',
    '--add-host=host.docker.internal:host-gateway',
    'phase-211-jellyfin-live-readonly-smoke.json',
    'does not contact Jellyfin during tests',
    'does not publish ports',
    'does not change Compose',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(combined.includes(required), `Phase 215 surface preserves ${required}`);
  const doc = read('docs/PHASE_215_JELLYFIN_LIVE_CAPTURE_LAUNCHER.md');
  for (const forbidden of [
    'O5_CLOSED',
    'JELLYFIN_INTEGRATION_LAUNCHED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `Phase 215 record excludes ${forbidden}`);
});

test('Phase 216 Arcane Jellyfin live capture button exposes only guarded launcher', () => {
  assert(exists('docs/PHASE_216_ARCANE_JELLYFIN_LIVE_CAPTURE_BUTTON.md'), 'Phase 216 Arcane Jellyfin button doc exists');
  assert(exists('test/arcane-jellyfin-live-capture-button.ts'), 'Phase 216 Arcane Jellyfin button test exists');
  assert(pkg.scripts['test:arcane-jellyfin-live-capture-button'] === 'tsx test/arcane-jellyfin-live-capture-button.ts', 'Phase 216 test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'),
    'Phase 216 aggregate test follows live capture launcher and precedes Unraid readiness bundle',
  );
  const combined = [
    read('docs/PHASE_216_ARCANE_JELLYFIN_LIVE_CAPTURE_BUTTON.md'),
    read('docs/PHASE_153_ARCANE_OPERATOR_RUNBOOK.md'),
    read('test/arcane-jellyfin-live-capture-button.ts'),
    read('README.md'),
  ].join('\n');
  for (const required of [
    'phase-216-arcane-jellyfin-live-capture-button',
    'ARCANE_JELLYFIN_LIVE_CAPTURE_BUTTON_READY',
    'BUTTON_READY_SECRET_STILL_REQUIRED',
    '`jellyfin-live-capture`',
    '/mnt/user/appdata/catalog/repo/deploy/unraid-jellyfin-live-capture.sh tmdb 603',
    'must not contain the Jellyfin API key value',
    'JELLYFIN_ALLOW_LIVE_PUBLISH=true',
    'failure before network contact when the secret is missing',
    'does not publish ports',
    'does not change Compose',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(combined.includes(required), `Phase 216 surface preserves ${required}`);
  const doc = read('docs/PHASE_216_ARCANE_JELLYFIN_LIVE_CAPTURE_BUTTON.md');
  for (const forbidden of [
    'O5_CLOSED',
    'JELLYFIN_INTEGRATION_LAUNCHED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `Phase 216 record excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
