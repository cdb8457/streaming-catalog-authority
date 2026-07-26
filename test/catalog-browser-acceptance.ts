import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asMap, parseYaml, stringList, yamlStrings, type YamlMap, type YamlValue } from './helpers/compose-yaml.js';
import { removeQuietly, runScript, usableBash, type Shell } from '../src/ops/usable-shell.js';
import {
  acceptanceRun, classifyAcceptanceRun, describeAcceptanceRun, unreachableDocker, type AcceptanceRun,
} from './helpers/docker-acceptance.js';
import { parseCatalogSnapshot } from '../src/core/catalog/import-snapshot.js';

// Phase 262 — the CONTRACT of the catalog import-and-browse acceptance, checked the way a machine with no
// Docker daemon and no browser can check it: statically, by parsing the shipped snapshot fixture with the
// PRODUCT'S OWN parser, and by executing the parts that need neither (the orchestrator's skip/fail
// semantics). The real browser-against-real-Compose run is a CI job, asserted here to exist and to be wired
// correctly, and never faked or claimed.
//
// The distinction this suite exists to keep honest: a missing local Docker daemon is a NAMED SKIP with a
// distinct exit code, and under REQUIRE_ACCEPTANCE=1 — which is what CI sets — it is a hard FAILURE. There
// is no path by which "we could not run it" is reported as "it passed".

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
/** Line endings are a checkout artifact, never content: a Windows working copy delivers CRLF, and an
 *  assertion that reads a shipped script must not depend on which platform checked it out (Phase 258). */
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').split('\r\n').join('\n');
const exists = (rel: string): boolean => existsSync(join(root, rel));

console.log('Running Phase 262 catalog import-and-browse acceptance contract suite:\n');

const ORCHESTRATOR = 'deploy/ci/catalog-acceptance.sh';
const SPEC = 'deploy/ci/acceptance/catalog.spec.mjs';
const CONFIG = 'deploy/ci/acceptance/catalog.playwright.config.mjs';
const FIXTURE = 'deploy/ci/acceptance/fixtures/catalog-acceptance-snapshot.json';
const DOC = 'docs/PHASE_262_CATALOG_BROWSER_ACCEPTANCE.md';
const RC_ORCHESTRATOR = 'deploy/ci/release-candidate-acceptance.sh';

const SECRET_REF = 'tt-acceptance-ref-value-must-never-be-shown';
const RECORD_COUNT = 28;

// ---------------------------------------------------------------------------------------------------------
// The pieces exist
// ---------------------------------------------------------------------------------------------------------

test('every piece of the catalog acceptance is present', () => {
  for (const file of [ORCHESTRATOR, SPEC, CONFIG, FIXTURE, DOC]) {
    assert(exists(file), `${file} exists`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The fixture, validated by the PRODUCT's own parser
//
// A fixture the product would reject proves nothing about the product, and the failure would only appear
// inside a Docker job that most contributors cannot run. Parsing it here, with the same function the import
// CLI calls, moves that failure to a suite anyone can run in a second.
// ---------------------------------------------------------------------------------------------------------

test('the snapshot fixture is a valid snapshot, by the shipped parser, with the shape the spec assumes', () => {
  const snapshot = parseCatalogSnapshot(read(FIXTURE));
  assertEq(snapshot.items.length, RECORD_COUNT, 'the fixture holds the record count the spec asserts');
  assertEq(snapshot.source, 'acceptance-fixture', 'a source of its own, so it can never collide with real data');

  // Exactly one record carries an imdb reference — the filter in the spec has exactly one answer.
  const imdb = snapshot.items.filter((item) => item.providerRefs.some((ref) => ref.type === 'imdb'));
  assertEq(imdb.length, 1, 'exactly one record carries an imdb reference');
  assertEq(imdb[0]!.title, 'Zulu Acceptance Fixture 26', 'and it is the record the spec looks for');
  assertEq(imdb[0]!.providerRefs.find((r) => r.type === 'imdb')!.value, SECRET_REF,
    'its reference value is the sentinel the acceptance proves is never disclosed');

  // The hostile record: markup as DATA, carried through unchanged. The import must not mangle a title, and
  // the browser must not execute one.
  const hostile = snapshot.items.filter((item) => item.title.includes('<script>'));
  assertEq(hostile.length, 1, 'exactly one hostile-titled record');
  assert(hostile[0]!.title.includes('onerror=window.__catXss=1'), 'the hostile title survives parsing verbatim');

  // One record with no year at all: an undated record has to sort last in BOTH directions.
  assertEq(snapshot.items.filter((item) => item.year === null).length, 1, 'exactly one undated record');

  // More than one default page (25), so paging is actually exercised.
  assert(snapshot.items.length > 25, 'the fixture spans more than one default page');

  // Deterministic: parsing it twice produces the same digest and the same derived ids.
  const again = parseCatalogSnapshot(read(FIXTURE));
  assertEq(again.digest, snapshot.digest, 'the fixture parses to a stable digest');
  assertEq(again.items.map((i) => i.itemId).join(','), snapshot.items.map((i) => i.itemId).join(','),
    'and to stable derived record ids');
});

test('the fixture names no live service, host or private coordinate', () => {
  const lower = read(FIXTURE).toLowerCase();
  for (const forbidden of ['jellyfin', 'unraid', '/mnt/user', 'torbox', 'http://', 'https://', 'ghcr.io']) {
    assert(!lower.includes(forbidden), `the fixture never references ${forbidden}`);
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

test('a catalog-acceptance job exists, on Linux, and is structurally read-only', () => {
  assert('catalog-acceptance' in jobs, 'the workflow has a catalog-acceptance job');
  assertEq(job('catalog-acceptance')['runs-on'], 'ubuntu-latest', 'it runs on Linux, where Docker exists');
  assertEq(job('catalog-acceptance').permissions, undefined, 'it declares no permissions, inheriting read-only');
  assertEq(asMap(workflow.permissions ?? null, 'workflow permissions').contents, 'read',
    'and the workflow default is still read-only');
});

test('the catalog-acceptance job cannot publish anything', () => {
  const text = jobText('catalog-acceptance');
  assert(!/contents:\s*write/.test(text), 'it never grants itself contents: write');
  assert(!/packages:\s*write/.test(text), 'nor packages: write');
  assert(!/docker push|push:\s*true|docker\/login-action/.test(text), 'it cannot push or log in to a registry');
  assert(!/gh release (upload|create|edit|delete)/.test(text), 'it cannot touch a release');
  assert(!/git push|git tag|gh pr merge/.test(text), 'it pushes nothing, tags nothing, merges nothing');
  assert(/catalog-acceptance\.sh/.test(text), 'it runs the catalog acceptance orchestrator');
});

test('the catalog-acceptance job installs the pinned harness and forces no-silent-skip', () => {
  const text = jobText('catalog-acceptance');
  assert(/npm --prefix deploy\/ci\/acceptance ci/.test(text), 'it installs the pinned harness from its lockfile');
  assert(/playwright install/.test(text) && /chromium/.test(text), 'and installs the pinned Chromium');
  const runStep = steps('catalog-acceptance').find((s) => String(s.run ?? '').includes('catalog-acceptance.sh'));
  assert(runStep !== undefined, 'the orchestrator runs as a step');
  const env = asMap(runStep!.env ?? null, 'orchestrator env');
  assertEq(String(env.REQUIRE_ACCEPTANCE), '1', 'with REQUIRE_ACCEPTANCE=1 so it fails rather than skips in CI');
});

test('the catalog-acceptance job always tears down its OWN project and uploads only sanitized failures', () => {
  const stepList = steps('catalog-acceptance');
  const teardown = stepList.find((s) => String(s.if ?? '') === 'always()' && /down|rm/.test(String(s.run ?? '')));
  assert(teardown !== undefined, 'a teardown step runs on if: always()');
  const teardownText = String(teardown!.run ?? '');
  assert(/catalogauthority-catalogacceptance/.test(teardownText), 'scoped to this job\'s own compose project label');
  assert(!/project=catalogauthority-local\b/.test(teardownText),
    'and it never removes the release-candidate job\'s project');
  assert(/docker volume/.test(teardownText), 'it removes volumes too');

  const upload = stepList.find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact'));
  assert(upload !== undefined, 'diagnostics can be uploaded');
  assertEq(String(upload!.if ?? ''), 'failure()', 'but ONLY on failure');
  const withBlock = asMap(upload!.with ?? null, 'upload with');
  const retention = Number(withBlock['retention-days']);
  assert(retention > 0 && retention <= 14, `retention is short (<=14 days), got ${retention}`);
  assert(String(withBlock.path).includes('catalog-acceptance-artifacts'), 'it uploads its own artifact directory');
});

test('publish cannot run unless the catalog acceptance succeeded too', () => {
  const needs = stringList(job('publish').needs ?? null, 'needs');
  assert(needs.includes('catalog-acceptance'), 'publish needs catalog-acceptance');
  // A needed job that is SKIPPED skips publish, so this gate must run on every event that can reach publish.
  assertEq(job('catalog-acceptance').if, undefined,
    'catalog-acceptance carries no if: — it runs on every event, including the release and dispatch that reach publish');
  const condition = String(job('publish').if ?? '');
  assert(!/always\(\)|failure\(\)|cancelled\(\)/.test(condition),
    'publish uses no status function that would let it run despite a failed dependency');
});

test('the suites job runs the Phase 261 and Phase 262 focused suites', () => {
  const text = jobText('suites');
  assert(text.includes('test:phase262-local'), 'CI runs test:phase262-local in the suites job');
  assert(text.includes('test:phase261-local'), 'CI runs test:phase261-local in the suites job');
});

test('no existing gate was weakened: every non-publish job still inherits read-only', () => {
  for (const name of Object.keys(jobs)) {
    if (name === 'publish') continue;
    assertEq(job(name).permissions, undefined, `${name} inherits read-only`);
  }
  const perms = asMap(job('publish').permissions ?? null, 'publish perms');
  assertEq(perms.contents, 'write', 'publish alone may write contents');
  assertEq(job('publish').environment, 'release', 'and still runs in the protected release environment');
});

// ---------------------------------------------------------------------------------------------------------
// The orchestrator: what it covers, and what it must never touch
// ---------------------------------------------------------------------------------------------------------

const orchestrator = read(ORCHESTRATOR);

test('the orchestrator runs the shipped consumer artifact, standalone, on a locally built image', () => {
  assert(orchestrator.includes('consumer-release-bundle-cli.ts'), 'it assembles the real consumer bundle');
  assert(/tar -xzf/.test(orchestrator), 'it extracts the archive');
  for (const forbidden of ['package.json', 'node_modules', 'src', 'tsconfig.json']) {
    assert(orchestrator.includes(forbidden), `it checks the extracted release has no ${forbidden}`);
  }
  assert(/docker build/.test(orchestrator), 'it builds the production image locally');
  assert(!/docker push|push:\s*true|docker\/login-action/.test(orchestrator), 'it never pushes or logs in');
  assert(!/gh release (upload|create|edit|delete)|git push|git tag/.test(orchestrator), 'and touches no release, tag or branch');
  assert(!/:latest/.test(orchestrator), 'no floating image tag appears anywhere');
});

test('the orchestrator is ISOLATED from the release-candidate acceptance in every shared resource', () => {
  const rc = read(RC_ORCHESTRATOR);
  // Compose project: the catalog run names its own, and the RC run keeps the shipped default.
  assert(/COMPOSE_PROJECT_NAME=/.test(orchestrator), 'it sets its own compose project name');
  assert(/catalogauthority-catalogacceptance/.test(orchestrator), 'a project name distinct from the shipped one');
  assert(!/COMPOSE_PROJECT_NAME=/.test(rc), 'and it did not change the release-candidate run to use one');
  // Host port, image tag and artifact directories all differ, so both can run on one machine.
  assert(/8098/.test(orchestrator) && !/8098/.test(rc), 'it publishes the UI on its own loopback port');
  assert(/catalog-authority-ops:catalog-acceptance/.test(orchestrator), 'its image tag is its own');
  assert(!/catalog-authority-ops:catalog-acceptance/.test(rc), 'and not one the release-candidate run uses');
  assert(/catalog-acceptance-artifacts/.test(orchestrator) && /catalog-acceptance-staging/.test(orchestrator),
    'its artifact and staging directories are its own');
  assert(!/rc-acceptance-artifacts/.test(orchestrator), 'it never writes into the release-candidate upload directory');
});

test('the orchestrator arms teardown BEFORE up, tears down on every exit, and gates artifacts', () => {
  assert(/trap cleanup EXIT/.test(orchestrator), 'a cleanup trap runs on every exit');
  assert(/trap 'exit 130' INT/.test(orchestrator) && /trap 'exit 143' TERM/.test(orchestrator),
    'and cancellation (INT/TERM) re-exits so the same cleanup runs');
  assert(/source .*rc-teardown\.sh/.test(orchestrator), 'it sources the shared, separately-tested teardown library');
  assert(/rc_compose_up "\$\{EXTRACTED\}"/.test(orchestrator), 'the stack is started via the arming helper');
  assert(!/docker compose up/.test(orchestrator.replace(/rc_compose_up/g, '')) || /docker compose up -d >\/dev\/null/.test(orchestrator),
    'the only bare `up` is the documented restart, never the initial unarmed start');
  assert(/rc_compose_down "\$\{EXTRACTED\}"/.test(orchestrator), 'teardown goes through the scoped helper');
  assert(/RC_COMPOSE_ATTEMPTED/.test(orchestrator), 'cleanup keys off the armed-before-up flag');
  assert(/redact-artifacts\.sh/.test(orchestrator), 'the redaction gate runs before anything can be uploaded');
  assert(/mv "\$\{STAGING_DIR\}"\/\* "\$\{ARTIFACT_DIR\}\/"/.test(orchestrator),
    'artifacts are promoted into the upload directory only after the gate passes');
  assert(/rm -rf "\$\{ARTIFACT_DIR\}"/.test(orchestrator), 'and on a gate failure the upload directory is removed, not populated');
});

test('the orchestrator covers the whole consumer workflow, in order, with a proof for each claim', () => {
  const required: Array<[RegExp, string]> = [
    [/migrate/, 'it asserts the bootstrap/migrate one-shot ran'],
    [/exit 0 \(got|did not exit 0/, 'and that the one-shot exited zero'],
    [/import.*:ro|read-only|Destination "\/var\/lib\/catalog\/import"/, 'it checks the import mount is read-only'],
    [/touch \/var\/lib\/catalog\/import/, 'and proves it by trying to write into it from the container'],
    [/cp "\$\{FIXTURE\}"/, 'it places the snapshot through the shipped host-side import folder'],
    [/example-catalog-snapshot\.json/, 'and checks the documented example ships with the bundle'],
    [/--grep "@empty"/, 'it drives the browser against the EMPTY installation first'],
    [/ops:catalog-import -- --file [^\n]*\n/, 'it runs the documented import command'],
    [/PREVIEW \(nothing was written\)/, 'it requires the preview to announce itself'],
    [/the preview created rows/, 'it proves a preview writes no rows'],
    [/the preview appended events/, 'and appends no events'],
    [/--apply/, 'it applies the import'],
    [/--grep "@imported"/, 'then drives the browser against the imported catalog'],
    [/browsing changed the item count/, 'it proves browsing writes no rows'],
    [/browsing appended events/, 'and appends no events'],
    [/idempotency/i, 'it re-applies the same snapshot'],
    [/not idempotent/, 'and fails if the repeat run creates anything'],
    [/persistence/i, 'it restarts the stack'],
    [/did not survive a restart/, 'and requires the records to survive'],
    [/appeared in the server logs/, 'it checks the logs disclose nothing'],
    [/count_rows/, 'counts are read from the database inside the stack, not inferred'],
    [/digits_or_die/, 'a count that could not be READ is a failure, never a count that did not CHANGE'],
    [/require_tests_ran/, 'a browser leg that ran zero tests is a failure, not a pass'],
  ];
  for (const [pattern, what] of required) {
    assert(pattern.test(orchestrator), `the orchestrator: ${what}`);
  }
});

test('the orchestrator honours every boundary this phase must not cross', () => {
  const lower = orchestrator.toLowerCase();
  for (const forbidden of [
    'unraid-real-library-promotion', '/mnt/user/media/movies', 'jellyfin', 'phase231', 'ghcr.io',
    'torbox', 'tmdb.org', 'api.', 'unraid',
  ]) {
    assert(!lower.includes(forbidden), `the orchestrator never references ${forbidden}`);
  }
  // Everything it talks to is loopback.
  const urls = orchestrator.match(/https?:\/\/[^\s"']+/g) ?? [];
  for (const url of urls) {
    assert(url.startsWith('http://127.0.0.1'), `every URL is loopback, found ${url}`);
  }
});

test('the orchestrator reads the token without printing it and masks it in CI', () => {
  assert(/setup\.sh >\/dev\/null/.test(orchestrator), 'setup output (which prints the token) is suppressed');
  assert(/::add-mask::/.test(orchestrator), 'the token is masked in the CI log');
  assert(!/echo.*\$\{?TOKEN/.test(orchestrator.replace(/::add-mask::\$\{TOKEN\}/g, '')), 'the token is never echoed');
});

// ---------------------------------------------------------------------------------------------------------
// The browser spec
// ---------------------------------------------------------------------------------------------------------

test('the spec covers every required real-browser assertion', () => {
  const spec = read(SPEC);
  const required: Array<[RegExp, string]> = [
    [/@empty/, 'has an empty-installation leg'],
    [/@imported/, 'and an imported-catalog leg'],
    [/toHaveText\('EMPTY'\)/, 'checks the empty state by its exact name'],
    [/toHaveText\('RESULTS'\)/, 'and the populated state by its exact name'],
    [/import/i, 'checks the empty state points at importing'],
    [/#catTotal/, 'reads the record count'],
    [/#catMatched/, 'reads the matched count'],
    [/#catPage/, 'reads the page indicator'],
    [/#catNext/, 'pages forward'],
    [/#catPrev/, 'and back'],
    [/no record appears on both pages/, 'proves paging shows each record once'],
    [/#catSearch/, 'searches'],
    [/NO_MATCH/, 'checks a no-match search is reported as such'],
    [/#catRefType/, 'filters by provider reference type'],
    [/#catYearFrom/, 'filters by year'],
    [/#catSort/, 'sorts'],
    [/#catDetail/, 'opens a record detail'],
    [/the value is never shown/, 'checks the detail masks the reference value'],
    [/SECRET_REF/, 'asserts the reference value is nowhere'],
    [/__catXss/, 'checks a hostile title does not execute'],
    [/catResults img/, 'checks the hostile markup created no element'],
    [/401/, 'checks the catalog routes require the token'],
    [/405/, 'checks the catalog routes are GET-only'],
    [/localStorage/, 'checks localStorage'],
    [/sessionStorage/, 'checks sessionStorage'],
    [/indexedDB/i, 'checks IndexedDB'],
    [/cookies\(\)/, 'checks cookies'],
    [/outerHTML/, 'checks DOM serialization'],
    [/consoleErrors/, 'collects console errors'],
    [/__cspViolations/, 'observes CSP violations in the engine'],
    [/reload/, 'checks a reload leaves nothing behind'],
  ];
  for (const [pattern, what] of required) {
    assert(pattern.test(spec), `the spec ${what}`);
  }
});

test('the spec never echoes the token, and takes it only from the environment', () => {
  const spec = read(SPEC);
  assert(/OPERATOR_UI_ACCEPTANCE_TOKEN/.test(spec), 'the token comes from the isolated environment');
  assert(!/console\.log\([^)]*TOKEN/.test(spec), 'the token is never console.logged');
  assert(/includes\(TOKEN\)\)\.toBe\(false\)/.test(spec), 'token checks use expect(x.includes(TOKEN)).toBe(false)');
  assert(!/toContain\(TOKEN\)|not\.toContain\(TOKEN\)/.test(spec), 'no matcher receives the token directly');
  // The same discipline for the provider reference value: it is a secret of the operator's, not ours.
  assert(!/toContain\(SECRET_REF\)|not\.toContain\(SECRET_REF\)/.test(spec), 'no matcher receives the reference value');
});

test('the spec refuses to run without the values that make its assertions meaningful', () => {
  const spec = read(SPEC);
  assert(/OPERATOR_UI_ACCEPTANCE_TOKEN is required/.test(spec), 'an empty token is a hard error, not a skipped check');
  assert(/CATALOG_ACCEPTANCE_SECRET_REF is required/.test(spec),
    'an empty sentinel is a hard error — otherwise every "is not disclosed" assertion would pass vacuously');
});

test('the Playwright config keeps artifacts failure-only, headless, and pointed at this spec', () => {
  const config = read(CONFIG);
  assert(/screenshot:\s*'only-on-failure'/.test(config), 'screenshots are captured only on failure');
  assert(/trace:\s*'retain-on-failure'/.test(config), 'traces are retained only on failure');
  assert(/headless:\s*true/.test(config), 'it runs headless');
  assert(/video:\s*'off'/.test(config), 'no video is recorded');
  assert(/testMatch:\s*\/catalog\\\.spec\\\.mjs\//.test(config), 'it runs the catalog spec, and only that spec');
  assert(/127\.0\.0\.1/.test(config), 'and defaults to loopback');
});

test('the harness stays out of the shipped product', () => {
  const rootPkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const all = { ...(rootPkg.dependencies ?? {}), ...(rootPkg.devDependencies ?? {}) };
  assert(!('@playwright/test' in all), 'the root package.json does not depend on Playwright');
  assertEq(Object.keys(rootPkg.dependencies ?? {}).sort().join(','), 'pg,tsx', 'runtime deps are still exactly pg and tsx');
});

// ---------------------------------------------------------------------------------------------------------
// The orchestrator's skip/fail semantics — executed for real, with the Docker daemon MADE unreachable
//
// The condition is CREATED rather than predicted (see test/helpers/docker-acceptance.ts): the contract is
// therefore exercised identically on a laptop with no daemon and on a CI runner with a healthy one.
// ---------------------------------------------------------------------------------------------------------

const bash: Shell | null = usableBash();

function runWithUnreachableDocker(shell: Shell, extra: NodeJS.ProcessEnv = {}): AcceptanceRun {
  const docker = unreachableDocker();
  const ws = mkdtempSync(join(tmpdir(), 'p262-nodocker-'));
  try {
    return acceptanceRun(runScript(shell, join(root, ORCHESTRATOR), {
      cwd: root,
      timeout: 120000,
      env: {
        ...docker.env,
        CAT_STAGING_DIR: join(ws, 'staging'),
        CAT_ARTIFACT_DIR: join(ws, 'artifacts'),
        ...extra,
      },
    }));
  } finally { docker.dispose(); removeQuietly(ws); }
}

test('with the Docker daemon unreachable the orchestrator SKIPs (exit 3) and never claims to have run', () => {
  if (bash === null) { console.log('        (skipped: no usable bash on this host)'); return; }
  const run = runWithUnreachableDocker(bash);
  assertEq(classifyAcceptanceRun(run), 'HONEST_SKIP',
    `an unreachable daemon must produce exit 3 WITH a SKIP notice: ${describeAcceptanceRun(run)}`);
  assertEq(run.status, 3, `the orchestrator exits 3 (SKIP): ${describeAcceptanceRun(run)}`);
  assert(/the Docker daemon is not reachable/.test(run.output),
    `and names the daemon as the prerequisite it lacked: ${describeAcceptanceRun(run)}`);
  assert(/CI-required/.test(run.output) && /NOT executed/.test(run.output),
    'it says the acceptance is CI-required and was not executed');
});

test('with REQUIRE_ACCEPTANCE=1 and an unreachable daemon the orchestrator FAILs (exit 1), never a silent skip', () => {
  if (bash === null) { console.log('        (skipped: no usable bash on this host)'); return; }
  const run = runWithUnreachableDocker(bash, { REQUIRE_ACCEPTANCE: '1' });
  assertEq(classifyAcceptanceRun(run), 'REFUSED_TO_SKIP',
    `under REQUIRE_ACCEPTANCE=1 a missing prerequisite is a failure, not a skip: ${describeAcceptanceRun(run)}`);
  assertEq(run.status, 1, `it exits 1 (FAIL): ${describeAcceptanceRun(run)}`);
  assert(/REQUIRE_ACCEPTANCE=1/.test(run.output), 'and says why it refused to skip');
  assert(!/^SKIP:/m.test(run.output), 'it prints no SKIP notice at all');
});

// ---------------------------------------------------------------------------------------------------------
// The documentation
// ---------------------------------------------------------------------------------------------------------

test('the Phase 262 doc states the exact command, the proof boundary, the skip rule and the limitations', () => {
  const doc = read(DOC);
  for (const required of [
    'Phase 262',
    'deploy/ci/catalog-acceptance.sh',
    'REQUIRE_ACCEPTANCE=1',
    'CI-required',
    'catalog-acceptance',
    'Limitations',
  ]) {
    assert(doc.includes(required), `the doc mentions ${required}`);
  }
  assert(/Docker/.test(doc) && /Chromium|browser/.test(doc), 'it names the Docker + browser prerequisites');
  assert(/skip/i.test(doc) && /never/i.test(doc), 'it states that a skip is never a pass');
  assert(/preview/i.test(doc) && /idempoten/i.test(doc), 'it describes the preview and idempotency proofs');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
