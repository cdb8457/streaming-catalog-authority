import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asMap, parseYaml, stringList, yamlStrings, type YamlMap, type YamlValue } from './helpers/compose-yaml.js';
import { removeQuietly, runScript, usableBash, type Shell } from '../src/ops/usable-shell.js';

// Phase 249 — the release LIFECYCLE acceptance CONTRACT, checked the way a machine with no Docker daemon can
// check it: statically (the workflow wiring, the orchestrator's structure and boundaries, the honest
// limitation of the prior-version fixture) and by executing the parts that need no daemon (the orchestrator's
// skip/fail semantics, and the arm-before-up teardown driven against an injected compose failure across the
// full up → keep-volumes-down → up lifecycle). The real fresh/restart/upgrade/rollback run is a CI job,
// asserted here to exist and be wired correctly, never faked.

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

console.log('Running Phase 249 release lifecycle acceptance contract suite:\n');

const ORCHESTRATOR = 'deploy/ci/release-lifecycle-acceptance.sh';
const RC_TEARDOWN = 'deploy/ci/acceptance/rc-teardown.sh';
const REDACT = 'deploy/ci/acceptance/redact-artifacts.sh';
const DOC = 'docs/PHASE_249_LIFECYCLE_ACCEPTANCE.md';

const orchestrator = read(ORCHESTRATOR);

// ---------------------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------------------

test('every piece of the lifecycle harness is present', () => {
  for (const file of [ORCHESTRATOR, RC_TEARDOWN, REDACT, DOC]) {
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

test('a lifecycle job exists, on Linux, and is structurally read-only', () => {
  assert('lifecycle' in jobs, 'the workflow has a lifecycle job');
  assertEq(job('lifecycle')['runs-on'], 'ubuntu-latest', 'it runs on Linux, where Docker exists');
  assertEq(job('lifecycle').permissions, undefined, 'it declares no permissions, inheriting read-only');
  assertEq(asMap(workflow.permissions ?? null, 'workflow permissions').contents, 'read',
    'and the workflow default is still read-only');
});

test('the lifecycle job cannot publish anything and uses no registry credentials', () => {
  const text = jobText('lifecycle');
  assert(!/contents:\s*write/.test(text), 'it never grants itself contents: write');
  assert(!/packages:\s*write/.test(text), 'nor packages: write');
  assert(!/docker push|push:\s*true|docker\/login-action/.test(text), 'it cannot push or log in to a registry');
  assert(!/gh release (upload|create|edit|delete)/.test(text), 'it cannot touch a release');
  assert(!/git push|git tag|gh pr merge/.test(text), 'it pushes nothing, tags nothing, merges nothing');
  assert(!/secrets\.GITHUB_TOKEN|registry|ghcr\.io/i.test(text), 'it references no registry or registry token');
  assert(/release-lifecycle-acceptance\.sh/.test(text), 'it runs the lifecycle orchestrator');
});

test('the lifecycle job forces no-silent-skip and always tears down, uploading only sanitized failures', () => {
  const stepList = steps('lifecycle');
  const runStep = stepList.find((s) => String(s.run ?? '').includes('release-lifecycle-acceptance.sh'));
  assert(runStep !== undefined, 'the orchestrator runs as a step');
  assertEq(String(asMap(runStep!.env ?? null, 'env').REQUIRE_ACCEPTANCE), '1',
    'with REQUIRE_ACCEPTANCE=1 so it fails rather than skips in CI');

  const teardown = stepList.find((s) => String(s.if ?? '') === 'always()' && /rm|down/.test(String(s.run ?? '')));
  assert(teardown !== undefined, 'a teardown step runs on if: always()');
  const teardownRun = String(teardown!.run ?? '');
  assert(teardownRun.includes('catalogauthority-lifecycle'), 'and it is scoped to the isolated lifecycle project');
  assert(teardownRun.includes('lifecycle-prior') && teardownRun.includes('lifecycle-candidate'),
    'and removes exactly the two local fixture image tags');
  assert(!teardownRun.includes('catalogauthority-local'), 'it never touches the Phase 248 project');

  const upload = stepList.find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact'));
  assert(upload !== undefined, 'diagnostics can be uploaded');
  assertEq(String(upload!.if ?? ''), 'failure()', 'but ONLY on failure');
  const withBlock = asMap(upload!.with ?? null, 'upload with');
  const retention = Number(withBlock['retention-days']);
  assert(retention > 0 && retention <= 14, `retention is short (<=14 days), got ${retention}`);
  assert(String(withBlock.path).includes('rc-lifecycle-artifacts'), 'it uploads the lifecycle artifact directory');
});

test('the suites job runs the Phase 249 focused suite', () => {
  assert(jobText('suites').includes('test:phase249-local'), 'CI runs test:phase249-local in the suites job');
});

// ---------------------------------------------------------------------------------------------------------
// Publish gate: lifecycle is a required, non-skippable dependency
// ---------------------------------------------------------------------------------------------------------

test('publish cannot run unless the lifecycle acceptance succeeded too', () => {
  // This assertion FAILS on the pre-Phase-249 graph (publish needed only suites,image,bundle,release-candidate)
  // and passes once lifecycle is a required dependency.
  const publish = job('publish');
  const needs = stringList(publish.needs ?? null, 'needs');
  assert(needs.includes('lifecycle'), 'publish needs the lifecycle acceptance to have succeeded before it can run');
  // Phase 252 added the final rehearsal as a required gate; publish now depends on all six.
  for (const required of ['suites', 'image', 'bundle', 'release-candidate', 'lifecycle', 'rehearsal']) {
    assert(needs.includes(required), `publish needs ${required}`);
  }
  assertEq([...needs].sort().join(','), 'bundle,image,lifecycle,rehearsal,release-candidate,suites',
    'publish depends on exactly the six gates, nothing more, nothing less');

  // Skipped-job semantics: lifecycle carries no `if:`, so it runs on every event that can reach publish and
  // is never conditionally skipped; publish (no status function in its `if:`) is skipped if any need is not
  // "success". So a failed or cancelled lifecycle blocks the release.
  assertEq(job('lifecycle').if, undefined,
    'lifecycle has no if: — it runs on every event, including the release and dispatch that reach publish');
  const condition = String(publish.if ?? '');
  assert(condition.includes("github.event_name == 'release'"), 'a published release can still publish');
  assert(condition.includes('workflow_dispatch') && condition.includes('inputs.publish'), 'or a deliberate dispatch');
  assert(!/always\(\)|failure\(\)|cancelled\(\)/.test(condition),
    'publish uses no status function that would let it run despite a failed dependency');
});

// ---------------------------------------------------------------------------------------------------------
// The orchestrator: isolation, the lifecycle it proves, and reuse of the Phase 248 harness
// ---------------------------------------------------------------------------------------------------------

test('the lifecycle runs in an isolated project, port, tags and directories', () => {
  assert(/COMPOSE_PROJECT_NAME="catalogauthority-lifecycle"/.test(orchestrator),
    'it uses its own Compose project name');
  assert(!/COMPOSE_PROJECT_NAME="catalogauthority-local"/.test(orchestrator),
    'distinct from the Phase 248 acceptance project (catalogauthority-local)');
  assert(/lifecycle-prior/.test(orchestrator) && /lifecycle-candidate/.test(orchestrator),
    'its two image tags are lifecycle-specific and local-only');
  assert(/rc-lifecycle-(bundle|archive|staging|artifacts)/.test(orchestrator), 'its directories are lifecycle-specific');
  assert(/LIFECYCLE_HOST_PORT|8109/.test(orchestrator), 'it publishes on its own host port, not 8099');
});

test('the orchestrator builds a prior-version fixture and a candidate, both local-only, never published', () => {
  assert((orchestrator.match(/docker build/g) ?? []).length >= 2, 'it builds two images');
  assert(/IMAGE_VERSION=\$\{PRIOR_VERSION\}/.test(orchestrator), 'the prior fixture is built with the prior version');
  assert(/IMAGE_VERSION=\$\{CANDIDATE_VERSION\}/.test(orchestrator), 'the candidate is built with the candidate version');
  assert(!/docker push|push:\s*true|docker\/login-action|ghcr\.io/i.test(orchestrator),
    'it never pushes, logs in to a registry, or names the release registry');
  assert(!/gh release (upload|create|edit|delete)|git push|git tag/.test(orchestrator),
    'and touches no release, tag or branch');
});

test('the orchestrator exercises the whole documented lifecycle', () => {
  for (const [needle, what] of [
    ['fresh setup', 'fresh setup/start'],
    ['assert_version', 'authenticated version reporting'],
    ['/healthz', 'health'],
    ['assert_records_visible', 'read-only promotion-record visibility'],
    ['lifecycle_marker', 'persisted Postgres state'],
    ['token_before', 'persisted operator token'],
    ['restart', 'graceful restart'],
    ['upgrade to the candidate', 'upgrade'],
    ['rollback to the prior', 'rollback'],
  ] as const) {
    assert(orchestrator.includes(needle), `it covers ${what} (${needle})`);
  }
  // The version is checked at each stage: prior, candidate, prior again.
  assert((orchestrator.match(/assert_version /g) ?? []).length >= 3, 'version is asserted at prior, candidate, and rollback');
});

test('the DB-not-published check reads real host bindings, not the fragile Publishers rendering', () => {
  // `docker compose ps --format '{{.Publishers}}'` reports the container target port even with no host
  // binding, so it cannot tell an exposed-only Postgres from a published one. The orchestrator must inspect
  // the container's actual NetworkSettings.Ports through the tested predicate. Fails against the pre-fix script.
  assert(/the database port is published to the host/.test(orchestrator), 'it still asserts the DB is not host-published');
  assert(/NetworkSettings\.Ports/.test(orchestrator), 'it inspects NetworkSettings.Ports');
  assert(/container-port-publication-cli\.ts/.test(orchestrator), 'through the tested predicate CLI');
  assert(!/--format '\{\{\.Publishers\}\}' postgres/.test(orchestrator),
    'and no longer greps the Publishers rendering');
});

test('persistence is proven across restart, upgrade and rollback — token and Postgres marker both checked', () => {
  // The token is compared to the value captured before any lifecycle op, at restart, upgrade and rollback.
  assert((orchestrator.match(/= "\$\{token_before\}"/g) ?? []).length >= 3,
    'the operator token is compared to its original value after restart, upgrade and rollback');
  // The Postgres marker is read back after restart, upgrade and rollback.
  assert((orchestrator.match(/phase249-marker/g) ?? []).length >= 4,
    'the seeded Postgres marker is checked after restart, upgrade and rollback');
});

test('the orchestrator arms teardown before every up, keeps volumes between phases, and down -v only on teardown', () => {
  // Every `up` goes through rc_compose_up (which arms RC_COMPOSE_ATTEMPTED first); no bare `docker compose up`.
  assert(/source .*rc-teardown\.sh/.test(orchestrator), 'it reuses the shared teardown library');
  assert(!/docker compose up/.test(orchestrator), 'there is no bare `docker compose up` that could start resources unarmed');
  assert((orchestrator.match(/rc_compose_up "\$\{EXTRACTED\}"/g) ?? []).length >= 3,
    'the stack is started via the arming helper at each phase (fresh, upgrade, rollback)');
  assert(/rc_compose_down "\$\{EXTRACTED\}"/.test(orchestrator), 'teardown goes through the scoped down -v helper');
  // The intermediate lifecycle down KEEPS volumes: `docker compose down` with NO -v.
  assert(/keep_volumes_down/.test(orchestrator), 'it has a volume-preserving lifecycle down');
  // Capture the whole function body up to a line that is just `}` (a bare `[^}]*` would stop at the `}` in
  // `${EXTRACTED}`).
  const keep = /keep_volumes_down\(\) \{[\s\S]*?\n\}/.exec(orchestrator);
  assert(keep !== null, 'keep_volumes_down is defined');
  assert(/docker compose down --remove-orphans/.test(keep![0]) && !/down -v/.test(keep![0]),
    'and it does `docker compose down` WITHOUT -v, so the named volumes (pgdata, keystore) survive');
});

test('the orchestrator reuses the Phase 248 redaction/staging/promote artifact flow', () => {
  assert(/STAGING_DIR/.test(orchestrator) && /ARTIFACT_DIR/.test(orchestrator), 'staging vs upload directories');
  assert(/redact-artifacts\.sh" "\$\{STAGING_DIR\}"/.test(orchestrator), 'the shared redaction gate runs over staging');
  assert(/mv "\$\{STAGING_DIR\}"\/\* "\$\{ARTIFACT_DIR\}\/"/.test(orchestrator), 'artifacts are promoted only after the gate');
  assert(/rm -rf "\$\{ARTIFACT_DIR\}"/.test(orchestrator), 'and on a gate failure the upload dir is removed, not populated');
});

test('the orchestrator reads the token without printing it and masks it in CI', () => {
  assert(/setup\.sh >\/dev\/null/.test(orchestrator), 'setup output (which prints the token) is suppressed');
  assert(/::add-mask::/.test(orchestrator), 'the token is masked in the CI log');
  assert(!/echo.*\$\{?TOKEN/.test(orchestrator.replace(/::add-mask::\$\{TOKEN\}/g, '')), 'the token is never echoed');
});

test('the orchestrator honours the hard boundaries', () => {
  const lower = orchestrator.toLowerCase();
  for (const forbidden of ['unraid-real-library-promotion', '/mnt/user/media/movies', 'jellyfin', 'phase231', 'ghcr.io']) {
    assert(!lower.includes(forbidden), `the orchestrator never references ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The honest limitation of the prior-version fixture
// ---------------------------------------------------------------------------------------------------------

test('the fixture limitation is stated honestly, in the orchestrator and the doc', () => {
  // No false schema-compatibility claim: the fixture is the same source, and the docs/comments say what it
  // proves (lifecycle mechanics) and what it cannot (real cross-version schema migration).
  assert(/same source/i.test(orchestrator), 'the orchestrator says the fixture is the same source');
  assert(/schema/i.test(orchestrator) && /cannot|does not|not.*prove/i.test(orchestrator),
    'and that it cannot prove real schema migration');

  const doc = read(DOC);
  assert(/same source/i.test(doc), 'the doc says the prior fixture is the same source, differently labelled');
  assert(/schema/i.test(doc), 'the doc addresses schema migration');
  assert(/cannot prove|does not prove|not.*prove|until a real prior release/i.test(doc),
    'and states plainly what the fixture cannot prove until a real prior release exists');
});

// ---------------------------------------------------------------------------------------------------------
// The Phase 249 documentation
// ---------------------------------------------------------------------------------------------------------

test('the Phase 249 doc states coverage, the local command, CI-required status, isolation and boundaries', () => {
  const doc = read(DOC);
  for (const required of [
    'Phase 249',
    'acceptance:release-lifecycle',
    'REQUIRE_ACCEPTANCE=1',
    'CI-required',
    'lifecycle',
    'upgrade',
    'rollback',
    'catalogauthority-lifecycle',
  ]) {
    assert(doc.includes(required), `the doc mentions ${required}`);
  }
  assert(/isolat/i.test(doc), 'it describes isolation');
  assert(/persist/i.test(doc), 'it describes persistence');
  assert(/never publish|incapable of publishing|not.*publish/i.test(doc), 'it distinguishes acceptance from publishing');
});

// ---------------------------------------------------------------------------------------------------------
// Executed for real, without a Docker daemon
// ---------------------------------------------------------------------------------------------------------

const bash: Shell | null = usableBash();

function dockerDaemonReachable(): boolean {
  const run = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'],
    { encoding: 'utf8', timeout: 15000, shell: process.platform === 'win32' });
  return run.status === 0;
}

test('without a Docker daemon the orchestrator SKIPs (exit 3) and never claims to have run', () => {
  if (bash === null) { console.log('        (skipped: no usable bash on this host)'); return; }
  if (dockerDaemonReachable()) {
    console.log('        (note: Docker IS reachable here, so live skip-execution is exercised by CI\'s lifecycle job, not here)');
    return;
  }
  const run = runScript(bash, join(root, ORCHESTRATOR), { cwd: root, timeout: 120000 });
  assertEq(run.status, 3, `the orchestrator exits 3 (SKIP) when Docker is unavailable: ${run.stderr ?? ''}`);
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert(/SKIP:/.test(out) && /CI-required/.test(out) && /NOT executed/.test(out),
    'it says the lifecycle acceptance is CI-required and was not executed');
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
// Adversarial: a partial-up failure AT A LATER LIFECYCLE PHASE still tears the isolated stack down, with
// volumes removed, and the intermediate keep-volumes down never passes -v. No Docker daemon.
// ---------------------------------------------------------------------------------------------------------

test('a partial-up failure after an upgrade cycle still tears down (down -v); the keep-volumes down never used -v', () => {
  if (bash === null) { console.log('        (skipped: no usable bash on this host)'); return; }
  const ws = mkdtempSync(join(tmpdir(), 'p249-lifecycle-'));
  try {
    const extracted = join(ws, 'project');
    mkdirSync(extracted, { recursive: true });
    const logFile = join(ws, 'docker.log').replace(/\\/g, '/');
    const upFlag = join(ws, 'up.flag').replace(/\\/g, '/');
    const libPath = join(root, RC_TEARDOWN).replace(/\\/g, '/');
    const driver = join(ws, 'driver.sh');
    // A fake `docker`: the FIRST `compose up` succeeds (fresh start), a keep-volumes `down` (no -v) between
    // phases succeeds, and the SECOND `compose up` (the upgrade) FAILS after partially acting. The teardown
    // `down -v` in cleanup must still run. Case order matters: match `down -v` before plain `down`.
    writeFileSync(driver, [
      'set -euo pipefail',
      'docker() {',
      `  echo "docker $*" >> "${logFile}"`,
      '  case "$*" in',
      `    *"compose up"*) if [ -f "${upFlag}" ]; then echo "UP2-FAIL" >> "${logFile}"; return 1; fi; echo "UP1-OK" >> "${logFile}"; : > "${upFlag}"; return 0 ;;`,
      `    *"compose down -v"*) echo "TEARDOWN-DOWN-V" >> "${logFile}"; return 0 ;;`,
      `    *"compose down"*) echo "KEEP-DOWN-NO-V" >> "${logFile}"; return 0 ;;`,
      '    *) return 0 ;;',
      '  esac',
      '}',
      `source "${libPath}"`,
      'RC_COMPOSE_ATTEMPTED=0',
      `EXTRACTED="${extracted.replace(/\\/g, '/')}"`,
      // Mirror the orchestrator's inline keep_volumes_down exactly.
      'keep_volumes_down() { ( cd "${EXTRACTED}" && docker compose down --remove-orphans ); }',
      'cleanup() { local c=$?; if [ "${RC_COMPOSE_ATTEMPTED}" = "1" ]; then rc_compose_down "${EXTRACTED}"; fi; exit "$c"; }',
      'trap cleanup EXIT',
      'rc_compose_up "${EXTRACTED}"',   // fresh: UP1-OK
      'keep_volumes_down',              // upgrade down: KEEP-DOWN-NO-V
      'rc_compose_up "${EXTRACTED}"',   // upgrade up: UP2-FAIL -> set -e -> cleanup -> TEARDOWN-DOWN-V
      `echo "REACHED-END" >> "${logFile}"`,
      '',
    ].join('\n'));

    const run = runScript(bash, driver, { cwd: ws, timeout: 60000 });
    assert(run.status !== 0, `the driver fails when the upgrade up fails: status=${String(run.status)}`);
    const log = existsSync(join(ws, 'docker.log')) ? readFileSync(join(ws, 'docker.log'), 'utf8') : '';
    assert(/UP1-OK/.test(log), 'the fresh start came up');
    assert(/KEEP-DOWN-NO-V/.test(log), 'the between-phase down kept volumes (no -v)');
    assert(/UP2-FAIL/.test(log), 'the upgrade up failed partway');
    assert(/TEARDOWN-DOWN-V/.test(log), 'and cleanup still tore the stack down with -v, removing volumes');
    assert(!/REACHED-END/.test(log), 'the script did not continue past the failed upgrade');
  } finally { removeQuietly(ws); }
});

test('teardown is NOT attempted when the first up was never reached', () => {
  if (bash === null) { console.log('        (skipped: no usable bash on this host)'); return; }
  const ws = mkdtempSync(join(tmpdir(), 'p249-noteardown-'));
  try {
    const logFile = join(ws, 'docker.log').replace(/\\/g, '/');
    const libPath = join(root, RC_TEARDOWN).replace(/\\/g, '/');
    const driver = join(ws, 'driver.sh');
    writeFileSync(driver, [
      'set -euo pipefail',
      `docker() { echo "docker $*" >> "${logFile}"; case "$*" in *"compose down"*) echo "DOWN-ATTEMPTED" >> "${logFile}" ;; esac; return 0; }`,
      `source "${libPath}"`,
      'RC_COMPOSE_ATTEMPTED=0',
      `EXTRACTED="${join(ws, 'project').replace(/\\/g, '/')}"`,
      'cleanup() { local c=$?; if [ "${RC_COMPOSE_ATTEMPTED}" = "1" ]; then rc_compose_down "${EXTRACTED}"; fi; exit "$c"; }',
      'trap cleanup EXIT',
      'false  # a failure BEFORE the first up',
      '',
    ].join('\n'));
    const run = runScript(bash, driver, { cwd: ws, timeout: 60000 });
    assert(run.status !== 0, 'the driver failed before up');
    const log = existsSync(join(ws, 'docker.log')) ? readFileSync(join(ws, 'docker.log'), 'utf8') : '';
    assert(!/DOWN-ATTEMPTED/.test(log), 'teardown was not attempted because no up was ever armed');
  } finally { removeQuietly(ws); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
