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
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

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

test('jellyfin mapping — Phase 14 pagination is present + bounded; doc wired', () => {
  const map = read('src/core/adapters/jellyfin/mapping.ts');
  assert(/StartIndex/.test(map) && /Limit/.test(map), 'find requests carry StartIndex + Limit (paginated)');
  const hc = read('src/core/adapters/jellyfin/http-client.ts');
  assert(hc.includes('getAllPages') && /MAX_PAGES/.test(hc), 'client walks pages with a bounded MAX_PAGES cap');
  assert(exists('docs/PHASE_14_JELLYFIN_HARDENING.md'), 'Phase 14 hardening doc exists');
  const doc = read('docs/PHASE_14_JELLYFIN_HARDENING.md');
  for (const kw of ['pagination', 'StartIndex', 'MAX_PAGES', 'PROVISIONAL', '--write']) assert(doc.includes(kw), `doc covers ${kw}`);
});

test('production readiness gate — Phase 22 consolidates the 9 criteria + statuses; no stale refs', () => {
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

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
