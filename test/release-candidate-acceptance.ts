import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asMap, parseYaml, stringList, yamlStrings, type YamlMap, type YamlValue } from './helpers/compose-yaml.js';
import { removeQuietly, runScript, usableBash, type Shell } from '../src/ops/usable-shell.js';

// Phase 248 — the release-candidate acceptance CONTRACT, checked the way a machine with no Docker daemon and
// no browser can check it: statically, and by executing the parts that need neither (the redaction gate, and
// the orchestrator's skip/fail semantics). The real browser-against-real-Compose run is a CI job, asserted
// here to exist and to be wired correctly, never faked.

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

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const exists = (rel: string): boolean => existsSync(join(root, rel));

console.log('Running Phase 248 release-candidate acceptance contract suite:\n');

const ORCHESTRATOR = 'deploy/ci/release-candidate-acceptance.sh';
const SPEC = 'deploy/ci/acceptance/operator-ui.spec.mjs';
const CONFIG = 'deploy/ci/acceptance/playwright.config.mjs';
const HARNESS_PKG = 'deploy/ci/acceptance/package.json';
const HARNESS_LOCK = 'deploy/ci/acceptance/package-lock.json';
const REDACT = 'deploy/ci/acceptance/redact-artifacts.sh';
const DOC = 'docs/PHASE_248_RELEASE_CANDIDATE_ACCEPTANCE.md';

// ---------------------------------------------------------------------------------------------------------
// The files exist
// ---------------------------------------------------------------------------------------------------------

test('every piece of the acceptance harness is present', () => {
  for (const file of [ORCHESTRATOR, SPEC, CONFIG, HARNESS_PKG, HARNESS_LOCK, REDACT, DOC]) {
    assert(exists(file), `${file} exists`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The CI workflow contract
// ---------------------------------------------------------------------------------------------------------

const workflow = parseYaml(read('.github/workflows/runtime-image.yml'));
const jobs = asMap(workflow.jobs ?? null, 'jobs');
const job = (name: string): YamlMap => asMap(jobs[name] ?? null, `job ${name}`);
const steps = (name: string): YamlMap[] => (job(name).steps as YamlValue[]).map((step) => asMap(step, 'step'));
const jobText = (name: string): string => yamlStrings(job(name)).join('\n');

test('a release-candidate job exists, on Linux, and is structurally read-only', () => {
  assert('release-candidate' in jobs, 'the workflow has a release-candidate job');
  assertEq(job('release-candidate')['runs-on'], 'ubuntu-latest', 'it runs on Linux, where Docker exists');
  // No permissions block -> inherits the workflow default, which is read-only.
  assertEq(job('release-candidate').permissions, undefined, 'it declares no permissions, inheriting read-only');
  assertEq(asMap(workflow.permissions ?? null, 'workflow permissions').contents, 'read',
    'and the workflow default is still read-only');
});

test('the release-candidate job cannot publish anything', () => {
  const text = jobText('release-candidate');
  assert(!/contents:\s*write/.test(text), 'it never grants itself contents: write');
  assert(!/packages:\s*write/.test(text), 'nor packages: write');
  assert(!/docker push|push:\s*true|docker\/login-action/.test(text), 'it cannot push or log in to a registry');
  assert(!/gh release (upload|create|edit|delete)/.test(text), 'it cannot touch a release');
  assert(!/git push|git tag|gh pr merge/.test(text), 'it pushes nothing, tags nothing, merges nothing');
  // It builds a LOCAL image only; if it builds, it is with a local tag and never pushed.
  assert(/release-candidate-acceptance\.sh/.test(text), 'it runs the acceptance orchestrator');
});

test('the release-candidate job installs a pinned browser harness and forces no-silent-skip', () => {
  const text = jobText('release-candidate');
  assert(/npm --prefix deploy\/ci\/acceptance ci/.test(text), 'it installs the pinned harness from its lockfile');
  assert(/playwright install/.test(text) && /chromium/.test(text), 'and installs the pinned Chromium');
  // REQUIRE_ACCEPTANCE=1 turns a missing daemon/browser into a hard failure — CI must not silently skip.
  const runStep = steps('release-candidate').find((s) => String(s.run ?? '').includes('release-candidate-acceptance.sh'));
  assert(runStep !== undefined, 'the orchestrator runs as a step');
  const env = asMap(runStep!.env ?? null, 'orchestrator env');
  assertEq(String(env.REQUIRE_ACCEPTANCE), '1', 'with REQUIRE_ACCEPTANCE=1 so it fails rather than skips in CI');
});

test('the release-candidate job always tears down and uploads only sanitized failure diagnostics', () => {
  const stepList = steps('release-candidate');
  const teardown = stepList.find((s) => String(s.if ?? '') === 'always()' && /down|rm/.test(String(s.run ?? '')));
  assert(teardown !== undefined, 'a teardown step runs on if: always()');
  assert(/docker (rm|volume rm|compose .*down)/.test(String(teardown!.run ?? '')), 'and it removes containers/volumes');

  const upload = stepList.find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact'));
  assert(upload !== undefined, 'diagnostics can be uploaded');
  assertEq(String(upload!.if ?? ''), 'failure()', 'but ONLY on failure');
  const withBlock = asMap(upload!.with ?? null, 'upload with');
  const retention = Number(withBlock['retention-days']);
  assert(retention > 0 && retention <= 14, `retention is short (<=14 days), got ${retention}`);
  assert(String(withBlock.path).includes('rc-acceptance-artifacts'), 'it uploads the acceptance artifact directory');
});

test('adding the job did not weaken the existing publish gate', () => {
  // The publish job is still the only writer; its needs are unchanged and it still runs in a protected env.
  const publish = job('publish');
  assertEq(stringList(publish.needs ?? null, 'needs').sort().join(','), 'bundle,image,suites',
    'publish still needs exactly the three checked jobs');
  assertEq(publish.environment, 'release', 'and still runs in the release environment');
  const perms = asMap(publish.permissions ?? null, 'publish perms');
  assertEq(perms.contents, 'write', 'publish alone may write contents');
  // Every non-publish job, including the new one, inherits read-only and cannot publish.
  for (const name of Object.keys(jobs)) {
    if (name === 'publish') continue;
    assertEq(job(name).permissions, undefined, `${name} inherits read-only`);
  }
});

test('the suites job runs the Phase 248 focused suite', () => {
  assert(jobText('suites').includes('test:phase248-local'), 'CI runs test:phase248-local in the suites job');
});

// ---------------------------------------------------------------------------------------------------------
// The orchestrator: coverage of the release-candidate flow, and its boundaries
// ---------------------------------------------------------------------------------------------------------

const orchestrator = read(ORCHESTRATOR);

test('the orchestrator assembles the exact bundle, extracts it standalone, and proves no source is needed', () => {
  assert(orchestrator.includes('consumer-release-bundle-cli.ts'), 'it assembles the real consumer bundle');
  assert(/tar -xzf/.test(orchestrator), 'it extracts the archive');
  for (const forbidden of ['package.json', 'node_modules', 'src', 'tsconfig.json', 'Dockerfile']) {
    assert(orchestrator.includes(forbidden), `it checks the extracted release has no ${forbidden}`);
  }
  assert(/it is not standalone/.test(orchestrator), 'and fails if the extraction is not standalone');
});

test('the orchestrator builds a LOCAL image and never publishes', () => {
  assert(/docker build/.test(orchestrator), 'it builds the production image locally');
  assert(/local-only tag/.test(orchestrator) || /rc-acceptance/.test(orchestrator), 'with a local-only tag');
  assert(!/docker push|push:\s*true|docker\/login-action/.test(orchestrator), 'it never pushes or logs in');
  assert(!/gh release (upload|create|edit|delete)|git push|git tag/.test(orchestrator), 'and touches no release, tag or branch');
});

test('the orchestrator proves the standalone container contract', () => {
  for (const probe of ['ReadonlyRootfs', 'no-new-privileges', 'CapDrop', 'docker.sock', 'promotion-records']) {
    assert(orchestrator.includes(probe), `it inspects ${probe}`);
  }
  assert(/does not run as the non-root node user|Config.User/.test(orchestrator), 'it checks the non-root user');
  assert(/the database port is published to the host/.test(orchestrator), 'it checks the DB is not host-published');
  assert(/restart/.test(orchestrator) && /persist/.test(orchestrator), 'it checks graceful restart and persistence');
});

test('the orchestrator reads the token without printing it and masks it in CI', () => {
  assert(/setup\.sh >\/dev\/null/.test(orchestrator), 'setup output (which prints the token) is suppressed');
  assert(/::add-mask::/.test(orchestrator), 'the token is masked in the CI log');
  assert(!/echo.*\$\{?TOKEN/.test(orchestrator.replace(/::add-mask::\$\{TOKEN\}/g, '')), 'the token is never echoed');
});

test('the orchestrator always tears down volumes and containers, and gates artifacts on every exit', () => {
  assert(/trap cleanup EXIT/.test(orchestrator), 'a cleanup trap runs on every exit');
  assert(/docker compose down -v/.test(orchestrator), 'teardown removes volumes');
  assert(/redact-artifacts\.sh/.test(orchestrator), 'and the redaction gate runs before anything can upload');
});

test('the orchestrator honours no boundary violations', () => {
  const lower = orchestrator.toLowerCase();
  for (const forbidden of ['unraid-real-library-promotion', '/mnt/user/media/movies', 'jellyfin', 'phase231', 'ghcr.io']) {
    assert(!lower.includes(forbidden), `the orchestrator never references ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The pinned browser harness and the spec's coverage
// ---------------------------------------------------------------------------------------------------------

test('the browser harness pins an exact Playwright version, in both package.json and its lockfile', () => {
  const pkg = JSON.parse(read(HARNESS_PKG)) as { devDependencies: Record<string, string>; dependencies?: Record<string, string> };
  const version = pkg.devDependencies['@playwright/test'];
  assert(version !== undefined, '@playwright/test is a dependency of the harness');
  assert(/^\d+\.\d+\.\d+$/.test(version), `it is pinned to an exact version, got ${version}`);
  const lock = JSON.parse(read(HARNESS_LOCK)) as { packages: Record<string, { version?: string }> };
  const locked = lock.packages['node_modules/@playwright/test']?.version;
  assertEq(locked, version, 'the lockfile pins the same exact version');
});

test('the harness is isolated from the shipped product: the root package.json never depends on it', () => {
  const rootPkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const all = { ...(rootPkg.dependencies ?? {}), ...(rootPkg.devDependencies ?? {}) };
  assert(!('@playwright/test' in all), 'the root package.json does not depend on Playwright');
  assert(!('playwright' in all), 'nor on playwright');
  // The production closure the release-delivery suite pins (pg, tsx) is untouched by this phase.
  assertEq(Object.keys(rootPkg.dependencies ?? {}).sort().join(','), 'pg,tsx', 'runtime deps are still exactly pg and tsx');
});

test('the Playwright config keeps artifacts failure-only and headless', () => {
  const config = read(CONFIG);
  assert(/screenshot:\s*'only-on-failure'/.test(config), 'screenshots are captured only on failure');
  assert(/trace:\s*'retain-on-failure'/.test(config), 'traces are retained only on failure');
  assert(/headless:\s*true/.test(config), 'it runs headless');
  assert(/video:\s*'off'/.test(config), 'no video is recorded');
  assert(/operator-ui/.test(config) && /spec/.test(config), 'it runs the operator UI spec');
});

test('the spec covers every required real-browser assertion', () => {
  const spec = read(SPEC);
  const required: Array<[RegExp, string]> = [
    [/content-security-policy/i, 'reads the real CSP header'],
    [/unsafe-inline/, 'asserts no unsafe-inline'],
    [/consoleErrors/, 'collects console errors'],
    [/pageerror/i, 'collects page errors'],
    [/requestfailed/i, 'collects failed requests'],
    [/serviceWorker/, 'checks for a service worker'],
    [/__cspViolations/, 'observes CSP violations in the engine'],
    [/mixed content|https:\/\//, 'checks for mixed content'],
    [/unauthenticated guidance|First-run checklist/, 'verifies unauthenticated guidance'],
    [/wrong token|not the token/, 'exercises a wrong token'],
    [/AGREES/, 'checks version/bundle agreement'],
    [/#verdict/, 'loads the installation verdict'],
    [/#logCount/, 'loads logs'],
    [/#chainOutcome/, 'loads the promotion chain'],
    [/api\/version/, 'exercises the version route'],
    [/#clear/, 'exercises clear-token'],
    [/reload/, 'checks reload clears the token'],
    [/Tab/, 'checks keyboard order'],
    [/outlineWidth|outlineStyle/, 'checks visible focus'],
    [/aria-live/, 'checks the live status region'],
    [/setViewportSize\(\{ width: 320/, 'checks a 320px mobile viewport'],
    [/scrollWidth/, 'checks for horizontal overflow'],
    [/localStorage/, 'checks localStorage'],
    [/sessionStorage/, 'checks sessionStorage'],
    [/indexedDB/i, 'checks IndexedDB'],
    [/cookies\(\)/, 'checks cookies'],
    [/outerHTML/, 'checks DOM serialization'],
    [/401/, 'checks operational routes are 401 without a token'],
    [/healthz/, 'checks health is minimal'],
    [/__inlineRan/, 'checks inline script is blocked'],
    [/__dataRan/, 'checks data: script is blocked'],
    [/__blobRan/, 'checks blob: script is blocked'],
    [/__jsRan/, 'checks javascript: URL is blocked'],
    [/__xss/, 'checks a hostile displayed string does not execute'],
  ];
  for (const [pattern, what] of required) {
    assert(pattern.test(spec), `the spec ${what}`);
  }
});

test('the spec never echoes the token into a failure message', () => {
  const spec = read(SPEC);
  // The token is obtained only from the environment and never printed.
  assert(/OPERATOR_UI_ACCEPTANCE_TOKEN/.test(spec), 'the token comes from the isolated environment');
  assert(!/console\.log\([^)]*TOKEN/.test(spec), 'the token is never console.logged');
  // Token comparisons use the boolean form so a failing matcher cannot echo the token.
  assert(/includes\(TOKEN\)\)\.toBe\(false\)/.test(spec), 'token checks use expect(x.includes(TOKEN)).toBe(false)');
  assert(!/toContain\(TOKEN\)|not\.toContain\(TOKEN\)/.test(spec), 'no matcher receives the token directly');
});

// ---------------------------------------------------------------------------------------------------------
// The redaction gate — executed for real (no Docker or browser needed)
// ---------------------------------------------------------------------------------------------------------

const bash: Shell | null = usableBash();

function runRedact(dir: string, token: string): { status: number | null; out: string } {
  const shell = bash!;
  const run = runScript(shell, join(root, REDACT), {
    cwd: root,
    args: [dir],
    env: { ...process.env, OPERATOR_UI_ACCEPTANCE_TOKEN: token },
  });
  return { status: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

test('the redaction gate passes clean artifacts and fails on the exact token', () => {
  if (bash === null) { console.log('        (skipped: no usable bash on this host)'); return; }
  const token = 'PhAsE248FixtureToken1234567890abcdEFGH=';
  const ws = mkdtempSync(join(tmpdir(), 'p248-redact-'));
  try {
    mkdirSync(join(ws, 'traces'), { recursive: true });
    writeFileSync(join(ws, 'server-logs.txt'), 'INFO system UI_SERVED nothing secret here\n');
    writeFileSync(join(ws, 'report.json'), '{"stats":{"expected":10}}');
    // A trace legitimately contains long base64 — it must NOT trip the shape heuristic.
    writeFileSync(join(ws, 'traces', 'trace.jpeg'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij+/base64image');
    const clean = runRedact(ws, token);
    assertEq(clean.status, 0, `a clean artifact set passes: ${clean.out}`);

    // The exact token in the server log fails collection and removes the file.
    writeFileSync(join(ws, 'server-logs.txt'), `leaked ${token} here\n`);
    const leaked = runRedact(ws, token);
    assertEq(leaked.status, 1, 'the exact token fails the gate');
    assert(!existsSync(join(ws, 'server-logs.txt')), 'and the offending file is removed');
  } finally { removeQuietly(ws); }
});

test('the redaction gate fails on token-shaped material in a plain-text log', () => {
  if (bash === null) { console.log('        (skipped: no usable bash on this host)'); return; }
  const ws = mkdtempSync(join(tmpdir(), 'p248-redact2-'));
  try {
    // 40+ char base64 run in OUR OWN log (the server pre-redacts, so this would be a genuine alarm).
    writeFileSync(join(ws, 'server-logs.txt'), 'run aGVsbG93b3JsZGxvbmdlbm91Z2hiYXNlNjRydW5oZXJleHl6MTIz end\n');
    const res = runRedact(ws, 'unrelated-token-value');
    assertEq(res.status, 1, 'token-shaped material in a log fails the gate');
  } finally { removeQuietly(ws); }
});

// ---------------------------------------------------------------------------------------------------------
// The orchestrator's skip/fail semantics — executed for real WHEN Docker is unavailable here
// ---------------------------------------------------------------------------------------------------------

function dockerDaemonReachable(): boolean {
  const run = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'],
    { encoding: 'utf8', timeout: 15000, shell: process.platform === 'win32' });
  return run.status === 0;
}

test('without a Docker daemon the orchestrator SKIPs (exit 3) and never claims to have run', () => {
  if (bash === null) { console.log('        (skipped: no usable bash on this host)'); return; }
  if (dockerDaemonReachable()) {
    console.log('        (note: Docker IS reachable here, so live skip-execution is exercised by CI\'s release-candidate job, not here)');
    return;
  }
  const run = runScript(bash, join(root, ORCHESTRATOR), { cwd: root, timeout: 120000 });
  assertEq(run.status, 3, `the orchestrator exits 3 (SKIP) when Docker is unavailable: ${run.stderr ?? ''}`);
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert(/SKIP:/.test(out), 'it prints a SKIP notice');
  assert(/CI-required/.test(out) && /NOT executed/.test(out), 'it says the acceptance is CI-required and was not executed');
});

test('with REQUIRE_ACCEPTANCE=1 and no daemon the orchestrator FAILs (exit 1), never a silent skip', () => {
  if (bash === null) { console.log('        (skipped: no usable bash on this host)'); return; }
  if (dockerDaemonReachable()) {
    console.log('        (note: Docker IS reachable here; the hard-fail path is exercised by CI, not here)');
    return;
  }
  const run = runScript(bash, join(root, ORCHESTRATOR), {
    cwd: root, timeout: 120000, env: { ...process.env, REQUIRE_ACCEPTANCE: '1' },
  });
  assertEq(run.status, 1, `it exits 1 (FAIL) under REQUIRE_ACCEPTANCE=1: ${run.stdout ?? ''}`);
  assert(/REQUIRE_ACCEPTANCE=1/.test(`${run.stdout ?? ''}${run.stderr ?? ''}`), 'and says why it refused to skip');
});

// ---------------------------------------------------------------------------------------------------------
// The documentation
// ---------------------------------------------------------------------------------------------------------

test('the Phase 248 doc states coverage, the local command, CI-required status, and the publish distinction', () => {
  const doc = read(DOC);
  for (const required of [
    'Phase 248',
    'acceptance:release-candidate',
    'REQUIRE_ACCEPTANCE=1',
    'CI-required',
    'release-candidate',
    'incapable of publishing',
  ]) {
    assert(doc.includes(required), `the doc mentions ${required}`);
  }
  assert(/Docker/.test(doc) && /Chromium|browser/.test(doc), 'it names the Docker + browser prerequisites');
  assert(/troubleshoot/i.test(doc), 'it has a troubleshooting section');
  assert(/acceptance/i.test(doc) && /publish/i.test(doc), 'it distinguishes acceptance from publishing');
  assert(/reverse[- ]proxy/i.test(doc) || /proxy/i.test(doc), 'it addresses reverse-proxy CSP interference');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
