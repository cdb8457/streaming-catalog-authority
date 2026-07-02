import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Phase 3 Stage 3.4 — static structural checks for the deployment artifacts.
 *
 * Dependency-free (no YAML lib, no Docker): asserts the compose topology, secret-file wiring, and
 * the no-HTTP/no-ports CLI shape by inspecting the files. The REAL compose smoke test
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
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string> };

test('compose — defines postgres + one-shot ops services', () => {
  assert(/^\s{2}postgres:/m.test(compose), 'postgres service');
  assert(/^\s{2}ops:/m.test(compose), 'ops service');
  assert(/entrypoint:\s*\["npm",\s*"run"\]/.test(compose), 'ops is a one-shot npm-run container');
});

test('compose — postgres has a pg_isready healthcheck', () => {
  assert(/healthcheck:/.test(compose) && /pg_isready/.test(compose), 'pg_isready healthcheck present');
});

test('compose — keystore is a SEPARATE volume from pgdata and backups', () => {
  for (const v of ['pgdata:', 'keystore:', 'backups:']) assert(compose.includes(v), `${v} volume declared`);
  assert(compose.includes('/var/lib/postgresql/data'), 'pgdata mount path');
  assert(compose.includes('/var/lib/catalog/keystore'), 'keystore mount path (distinct from pgdata)');
});

test('compose — secrets delivered via *_FILE (no inline secret values)', () => {
  for (const v of ['POSTGRES_PASSWORD_FILE', 'ADMIN_DATABASE_URL_FILE', 'DATABASE_URL_FILE', 'COMPLETION_SECRET_FILE', 'CUSTODIAN_KEK_FILE']) {
    assert(compose.includes(v), `${v} used`);
  }
  assert(/^secrets:/m.test(compose), 'top-level secrets section');
  // no raw secret-looking assignments for the sensitive vars
  assert(!/COMPLETION_SECRET:\s*\S/.test(compose), 'no inline COMPLETION_SECRET value');
  assert(!/CUSTODIAN_KEK:\s*\S/.test(compose), 'no inline CUSTODIAN_KEK value');
});

test('compose — CLI pattern: no ports / no HTTP daemon', () => {
  assert(!/ports:/.test(compose), 'no published ports (not an HTTP service)');
  assert(!/(expose|EXPOSE)/.test(compose), 'no exposed port');
});

test('compose — `docker compose run ops` invocations must NOT double-prefix npm run', () => {
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

test('package.json — ops + deploy scripts wired; no HTTP framework dep', () => {
  for (const s of ['ops:migrate', 'ops:backup', 'test:backup-ops', 'test:deploy', 'smoke:compose']) {
    assert(typeof pkg.scripts[s] === 'string', `script ${s} present`);
  }
  assert(/test\/backup-ops\.ts/.test(pkg.scripts.test ?? ''), 'backup-ops in the test chain');
  assert(/test\/deploy\.ts/.test(pkg.scripts.test ?? ''), 'deploy in the test chain');
  assert(/docker-compose\.deploy\.yml/.test(pkg.scripts['smoke:compose'] ?? ''), 'smoke uses the deploy compose');
  const deps = Object.keys(pkg.dependencies ?? {});
  for (const banned of ['express', 'fastify', 'koa', 'http-server', 'age', 'aws-sdk', '@aws-sdk/client-kms',
    'node-fetch', 'undici', 'axios', 'got', 'puppeteer', 'cheerio', 'ws', 'plex-api', 'real-debrid', 'torbox']) {
    assert(!deps.includes(banned), `no ${banned} dependency`);
  }
});

test('adapter boundary — no network/provider leakage in src/core/adapters (Phase 7)', () => {
  const dir = fileURLToPath(new URL('../src/core/adapters', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert(files.length >= 3, 'adapter module present');
  const network = /(from\s*['"]node:(http|https|net|tls|dns)['"]|from\s*['"](node-fetch|undici|axios|got|ws|puppeteer|cheerio)['"]|\bfetch\s*\()/;
  const providers = /(real[-_ ]?debrid|torbox|\bplex\b|jellyfin|scrap(e|ing)|\bdownload\b|playback)/i;
  for (const f of files) {
    const src = readFileSync(`${dir}/${f}`, 'utf8');
    assert(!network.test(src), `src/core/adapters/${f} makes no network import/call`);
    assert(!providers.test(src), `src/core/adapters/${f} names no real provider / scraping / playback`);
  }
  assert(exists('docs/PHASE_7_ADAPTER_BOUNDARY.md'), 'adapter boundary doc exists');
  const doc = read('docs/PHASE_7_ADAPTER_BOUNDARY.md');
  for (const kw of ['AdapterRefView', 'withProviderRef', 'advisory', 'ADAPTER_MODE', 'deferred']) assert(doc.includes(kw), `doc covers ${kw}`);
  assert((pkg.scripts.test ?? '').includes('test/adapter-privacy.ts') && (pkg.scripts.test ?? '').includes('test/adapter-contract.ts'), 'adapter suites in the CI chain');
});

test('publisher boundary — Phase 8 doc + suites wired; erasure-conflict noted', () => {
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

test('erasure policy — Phase 9 publish module clean; doc + suites wired', () => {
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

test('jellyfin adapter — Phase 10 fake/local only: no network, no OTHER providers; doc + suites wired', () => {
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

test('jellyfin HTTP (Phase 11) — injected-fetch only in core; gated; smoke opt-in + out of CI', () => {
  const dir = fileURLToPath(new URL('../src/core/adapters/jellyfin', import.meta.url));
  // the core adapter must NEVER reference a bare/global fetch — network only flows via the injected seam.
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

test('publish outbox — Phase 12 doc + suites wired; create only via the outbox', () => {
  assert(exists('docs/PHASE_12_PUBLISH_OUTBOX.md'), 'outbox doc exists');
  const doc = read('docs/PHASE_12_PUBLISH_OUTBOX.md');
  for (const kw of ['correlation_token', 'outbox', 'adopt', 'reconcile', 'JELLYFIN_ALLOW_LIVE_PUBLISH']) assert(doc.includes(kw), `doc covers ${kw}`);
  assert((pkg.scripts.test ?? '').includes('test/publish-outbox.ts') && (pkg.scripts.test ?? '').includes('test/jellyfin-outbox.ts'), 'outbox suites in the CI chain');
  // the bare create stays disabled — the ONLY real-create path is the outbox (createTaggedCollection).
  const hc = read('src/core/adapters/jellyfin/http-client.ts');
  assert(hc.includes('JellyfinPublishDisabledError') && /createCollection\([^)]*\)[^{]*\{[^}]*throw/.test(hc), 'bare createCollection stays disabled');
  assert(hc.includes('createTaggedCollection'), 'outbox-only tagged create exists');
  assert(typeof pkg.scripts['ops:publish-reconcile'] === 'string', 'ops:publish-reconcile present');
  assert(!(pkg.scripts.test ?? '').includes('publish-reconcile'), 'the reconcile CLI is NOT in the CI chain');
});

test('jellyfin smoke — Phase 13 validation: doc + suite wired; globalThis.fetch limited to operator CLIs', () => {
  assert(exists('docs/PHASE_13_JELLYFIN_VALIDATION.md'), 'validation doc exists');
  const doc = read('docs/PHASE_13_JELLYFIN_VALIDATION.md');
  for (const kw of ['--write', 'self-clean', 'find-by-token', 'SearchTerm', 'redaction-safe']) assert(doc.includes(kw), `doc covers ${kw}`);
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-smoke.ts'), 'smoke-report suite in the CI chain');
  const cli = read('src/ops/jellyfin-smoke-cli.ts');
  assert(cli.includes('--write') && cli.includes('runReadOnlySmoke') && cli.includes('runWriteSmoke'), 'smoke CLI has read-only + --write modes');
  assert(cli.includes('isJellyfinLivePublishAllowed'), '--write gated by ALLOW_LIVE_PUBLISH');
  // globalThis.fetch must live ONLY in the two explicit operator entrypoints.
  const withFetch = walkTs(fileURLToPath(new URL('../src', import.meta.url)))
    .filter((f) => readFileSync(f, 'utf8').includes('globalThis.fetch'))
    .map((f) => f.replace(/\\/g, '/'));
  assert(withFetch.length === 2, `exactly two src files use globalThis.fetch (got: ${withFetch.join(', ')})`);
  assert(withFetch.every((f) => /src\/ops\/(jellyfin-smoke-cli|publish-reconcile-cli)\.ts$/.test(f)), 'globalThis.fetch only in the operator smoke/reconcile CLIs');
});

test('ops entrypoints exist', () => {
  assert(exists('src/ops/migrate-cli.ts'), 'migrate-cli');
  assert(exists('src/ops/backup-cli.ts'), 'backup-cli');
});

test('docs — PHASE_3_DEPLOYMENT covers Unraid, *_FILE, keystore separation, operator age', () => {
  assert(exists('docs/PHASE_3_DEPLOYMENT.md'), 'deployment doc exists');
  const doc = read('docs/PHASE_3_DEPLOYMENT.md');
  for (const kw of ['Unraid', '_FILE', 'keystore', 'age', 'O4']) assert(doc.includes(kw), `doc mentions ${kw}`);
  assert(/separate volume/i.test(doc), 'doc states keystore/pgdata separation');
});

test('docs — production-gate wording is accurate (memory guard is CLOSED/enforced)', () => {
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

test('unraid template — one-shot, no ports, *_FILE secrets, separate keystore (Stage 5.3)', () => {
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

test('ops lifecycle — Phase 6 CLIs + docs are wired (version/verify/rehearse/doctor --json)', () => {
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

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
