import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCatalogSnapshot } from '../src/core/catalog/import-snapshot.js';
import { produceCatalogSnapshot } from '../src/core/catalog/external-export.js';
import { checkJellyfinBaseUrl } from '../src/core/adapters/jellyfin/url-policy.js';
import { asMap, parseYaml } from './helpers/compose-yaml.js';

// Phase 266-268 — the CONTRACT of the Jellyfin control plane acceptance, checked the way a machine with no
// Docker daemon and no browser can check it: statically, and by parsing the shipped fixture with the
// PRODUCT'S OWN parser and the PRODUCT'S OWN address policy. The real browser-against-real-Compose run is a
// CI job, asserted here to exist and to be wired correctly, and never faked or claimed.
//
// THE THINGS THIS SUITE EXISTS TO KEEP HONEST.
//   - The acceptance NEVER contacts a real media server, a provider, an Unraid host or a media path. The
//     server on the other end is a file in this repository, on the Compose network, with no host port.
//   - The fake server's library and the snapshot fixture agree, so the leg that proves matching-by-reference
//     cannot pass vacuously against a library that holds nothing.
//   - Every tag the orchestrator greps for exists in the spec, and every tag in the spec is run. A leg that
//     is defined and never run proves nothing, and a grep that matches nothing is not a pass.
//   - The SHIPPED release bundle carries no Jellyfin wiring at all: the override is an acceptance artifact,
//     not a product change.
//   - The orchestrator never publishes, pushes, tags, deploys, or runs the real-library promotion script.

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
/** Line endings are a checkout artifact, never content: a Windows working copy delivers CRLF. */
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').split('\r\n').join('\n');
const exists = (rel: string): boolean => existsSync(join(root, rel));

console.log('Running Phase 266-268 Jellyfin control plane acceptance contract suite:\n');

const ORCHESTRATOR = 'deploy/ci/jellyfin-control-acceptance.sh';
const SPEC = 'deploy/ci/acceptance/jellyfin.spec.mjs';
const CONFIG = 'deploy/ci/acceptance/jellyfin.playwright.config.mjs';
const OVERRIDE = 'deploy/ci/acceptance/docker-compose.jellyfin-fake.yml';
const FAKE = 'deploy/ci/acceptance/fake-jellyfin/server.mjs';
// Phase 274. What is CHECKED IN is an EXPORT of an external system; the canonical snapshot the gate imports
// is PRODUCED from it during the run, by the product's own command.
const EXPORT_FIXTURE = 'deploy/ci/acceptance/fixtures/jellyfin-acceptance-export.json';
const DOC = 'docs/PHASE_266_268_JELLYFIN_CONTROL_PLANE.md';
const WORKFLOW = '.github/workflows/runtime-image.yml';

test('every piece of the Jellyfin acceptance is present', () => {
  for (const file of [ORCHESTRATOR, SPEC, CONFIG, OVERRIDE, FAKE, EXPORT_FIXTURE, DOC]) {
    assert(exists(file), `${file} exists`);
  }
  // And the ready-made canonical snapshot is GONE, so the gate cannot go back to copying one.
  assert(!exists('deploy/ci/acceptance/fixtures/jellyfin-acceptance-snapshot.json'),
    'no ready-made canonical snapshot may sit in fixtures/ for the gate to copy');
});

test('the orchestrator keeps the skip/fail discipline, and never publishes anything', () => {
  const script = read(ORCHESTRATOR);
  assert(script.startsWith('#!/usr/bin/env bash'), 'it is a bash script');
  assert(script.includes('set -euo pipefail'), 'it fails on the first error and on an unset variable');
  assert(script.includes('REQUIRE_ACCEPTANCE=1'), 'it documents the CI-required mode');
  assert(/if \[ "\$\{REQUIRE_ACCEPTANCE\}" = "1" \]; then\n\s+fail /.test(script),
    'REQUIRE_ACCEPTANCE=1 turns a missing prerequisite into a hard failure');
  assert(script.includes('exit 3'), 'and a developer machine gets a distinct skip code');

  // Teardown is ARMED BEFORE the stack is created, or a partial `up` leaks containers and volumes.
  const armIndex = script.indexOf('RC_COMPOSE_ATTEMPTED=1');
  const upIndex = script.indexOf('docker compose up -d');
  assert(armIndex !== -1 && upIndex !== -1 && armIndex < upIndex, 'teardown is armed before the first `up`');
  assert(script.includes('trap cleanup EXIT'), 'and teardown always runs');
  assert(script.includes('down -v --remove-orphans'), 'and it removes volumes');
  assert(script.includes('wait_for_fake "the fake Jellyfin listener did not accept an authenticated read within the bounded wait"'),
    'the fake listener itself must be ready before any baseline measurement can be trusted');
  assert(script.includes('jf_compose logs --tail 120 jellyfin-fake'),
    'a fake-listener readiness failure carries bounded service diagnostics');

  // It is a GATE, not a release step.
  for (const forbidden of ['docker push', 'docker login', 'gh release', 'git tag', 'git push', 'npm publish',
    'unraid-real-library-promotion', 'deploy/unraid-', '/mnt/user/']) {
    assert(!script.includes(forbidden), `the acceptance must never do: ${forbidden}`);
  }
  // A local-only image tag, never a registry reference.
  assert(script.includes('catalog-authority-ops:jellyfin-acceptance'), 'it builds a local-only tag');
  assert(!/ghcr\.io|docker\.io/.test(script), 'and names no registry');
});

test('every helper the orchestrator calls is defined before the first line that could call it', () => {
  // A shell resolves a function name at CALL time against what has been defined so far, so a helper added
  // below its first use fails with "command not found" — and only on a runner that reaches that step. This is
  // the same check Phase 262 added after exactly that happened.
  const lines = read(ORCHESTRATOR).split('\n');
  const definedAt = new Map<string, number>();
  lines.forEach((line, index) => {
    const match = /^([a-z_][a-z0-9_]*)\(\) \{/.exec(line);
    if (match !== null && !definedAt.has(match[1]!)) definedAt.set(match[1]!, index);
  });
  assert(definedAt.size >= 6, `the orchestrator defines helpers (found ${definedAt.size})`);
  for (const [name, defined] of definedAt) {
    // The first CALL: a line that mentions the name and is neither its own definition nor a comment.
    const firstCall = lines.findIndex((line, index) =>
      index !== defined && !line.trimStart().startsWith('#') && new RegExp(`(^|[^\\w-])${name}(\\s|\\)|$|")`).test(line));
    if (firstCall === -1) continue; // defined and never called: dead, but not the defect this checks for
    assert(firstCall > defined, `${name} is called at line ${firstCall + 1} but defined at line ${defined + 1}`);
  }
});

test('the fake media server is local, dependency-free, authenticated, and implements only what is needed', () => {
  const fake = read(FAKE);
  assert(!/^import .* from '(?!node:)/m.test(fake), 'the fake server has no third-party dependency');
  assert(fake.includes("createServer"), 'it is a plain node http server');
  assert(fake.includes('x-emby-token'), 'it enforces the api key header');
  assert(fake.includes("send(res, 401"), 'and answers 401 without it');
  assert(fake.includes('JELLYFIN_FAKE_API_KEY is required'), 'and refuses to start unauthenticated');
  // The four Jellyfin endpoints, and the two namespaced control paths, and nothing else.
  for (const path of ['/System/Info', '/Collections', '/Items/', '/Items', '/_control/lose-next-create', '/_control/state']) {
    assert(fake.includes(path), `it serves ${path}`);
  }
  assert(!/fetch\(|https?:\/\/(?!127\.0\.0\.1)/.test(fake.replace(/^\/\/.*$/gm, '')),
    'the fake server contacts nothing itself');
});

test('the fake server holds exactly the references the PRODUCED snapshot carries', () => {
  // If these two drift, the leg that proves matching-by-provider-reference passes against a library that
  // holds nothing, and proves nothing at all. The snapshot is produced from the export exactly as the gate
  // produces it, so this compares the fake library against what the run will really import.
  const snapshot = parseCatalogSnapshot(produceCatalogSnapshot(read(EXPORT_FIXTURE)).text);
  assertEq(snapshot.source, 'external.acceptance-external', 'the produced records declare external provenance');
  const fixtureRefs = snapshot.items.flatMap((item) => (item.providerRefs ?? []).map((ref) => ref.value));
  assert(fixtureRefs.length >= 2, 'the fixture carries references');
  const fake = read(FAKE);
  const held = fixtureRefs.filter((value) => fake.includes(value));
  assertEq(held.length, 2, `exactly two fixture references are in the fake library (found ${held.length})`);
  // ...and one fixture record deliberately has NO reference, so "blocked" is exercised.
  assert(snapshot.items.some((item) => (item.providerRefs ?? []).length === 0),
    'the fixture carries a record with no reference, so a plan reports one as blocked');
  // ...and one whose reference the fake does NOT hold, so the selection is not accidentally everything.
  assert(fixtureRefs.some((value) => !fake.includes(value)),
    'the fixture carries a reference the fake server does not hold');
});

test('the compose override reaches the fake server privately, by a name the address policy admits', () => {
  const override = asMap(parseYaml(read(OVERRIDE)), 'the fake-Jellyfin override');
  const services = asMap(override.services ?? null, 'the override services');
  const fake = asMap(services['jellyfin-fake']!, 'the jellyfin-fake service');
  const app = asMap(services.app!, 'the app service');

  // NO HOST PORT. The fake is reachable from the stack and from nowhere else.
  assertEq(fake.ports, undefined, 'the fake server publishes no host port');
  assert(Array.isArray(fake.expose), 'it only exposes a port on the compose network');

  // The app addresses it by its COMPOSE SERVICE NAME, and that address must pass the product's own policy.
  const environment = asMap(app.environment!, 'the app environment');
  const baseUrl = String(environment.JELLYFIN_BASE_URL);
  assertEq(baseUrl, 'http://jellyfin-fake:8096', 'the app addresses the fake by its service name');
  const verdict = checkJellyfinBaseUrl(baseUrl);
  assert(verdict.ok, `the override's address must pass the product's own policy (${verdict.rejection})`);
  assertEq(verdict.hostClass, 'local-name', 'and it passes as a local name');

  // The KEY IS A FILE, because the control plane refuses an inline one. Assert BOTH halves.
  assert(String(environment.JELLYFIN_API_KEY_FILE).length > 0, 'the key comes from a file');
  assertEq(environment.JELLYFIN_API_KEY, undefined, 'and never from an inline variable');

  // The write switches are PARAMETERS with fail-closed defaults, so the orchestrator turns them on for one
  // stage and the file itself never hard-codes "on".
  assert(String(environment.JELLYFIN_ALLOW_COLLECTION_WRITES).includes(':-false}'),
    'the collection-write switch defaults to off in the override');
  assert(String(environment.PUBLISH_EXTERNAL_IDENTITY).includes(':-deny}'),
    'and publish consent defaults to deny');

  // The fake server runs with the same containment discipline as everything else in this product.
  assertEq(fake.read_only, true, 'the fake server container is read-only');
  assertEq(fake.user, 'node', 'and non-root');
  assert(Array.isArray(fake.cap_drop) && (fake.cap_drop as string[]).includes('ALL'), 'and drops every capability');
});

test('every tag the orchestrator runs exists in the spec, and every tag in the spec is run', () => {
  const script = read(ORCHESTRATOR);
  const spec = read(SPEC);
  const specTags = [...spec.matchAll(/test\('(@[a-z-]+)/g)].map((m) => m[1]!);
  assert(specTags.length >= 6, `the spec defines legs (found ${specTags.length})`);
  const runTags = [...script.matchAll(/run_leg "(@[a-z-]+)"/g)].map((m) => m[1]!);
  assert(runTags.length >= 6, `the orchestrator runs legs (found ${runTags.length})`);
  for (const tag of runTags) {
    assert(specTags.includes(tag), `the orchestrator greps for ${tag}, which no test declares`);
  }
  for (const tag of specTags) {
    assert(runTags.includes(tag), `the spec declares ${tag}, which the orchestrator never runs`);
  }
  // A leg that ran zero tests is a failed leg, read from Playwright's own report rather than trusted.
  assert(script.includes('ran 0 tests'), 'a leg that ran nothing is a failure, not a pass');
  assert(script.includes('report.json'), 'and the count comes from the report');
});

test('the spec scans for everything that must never be on the page, and drives the real controls', () => {
  const spec = read(SPEC);
  for (const forbidden of ['SECRET_REF', 'TOKEN', 'jf-item-1', 'fake-server-id', 'Somebody elses private collection']) {
    assert(spec.includes(forbidden), `the spec scans for ${forbidden}`);
  }
  // The digest is TYPED, never pre-filled — the property the whole confirmation rests on.
  assert(spec.includes("toHaveValue('')"), 'the confirm box starts empty');
  assert(spec.includes("page.fill('#colConfirm'"), 'and the spec types the digest into it');
  assert(spec.includes('#colExecute'), 'and drives the real queue button');
  assert(spec.includes('toBeDisabled()'), 'and asserts it is disabled before a preview');
});

test('the removal leg is a LIFECYCLE in the browser, not a queue the shell finishes', () => {
  const spec = read(SPEC);
  const script = read(ORCHESTRATOR);

  // The browser must carry the removal out itself...
  assert(spec.includes("page.click('#colRevokeBtn')"), 'the remove leg drives the real Revoke control');
  // ...and see for itself that it worked, through the product's own read-only discovery surface rather than
  // through a shell command reading the fixture behind the product's back.
  assert(spec.includes("#jfManagedCount"), 'and reads the media server back through discovery');
  assert(/toHaveText\('0'/.test(spec), 'and asserts the managed count reached zero');

  // AND THE SHELL MUST NOT FINISH THE JOB FOR IT. Between the remove leg and the end of its section there is
  // no revoke POST: a leg whose deletion is performed by curl proves the queue, not the lifecycle. The check
  // is scoped to that section because the ERASURE step above it legitimately drives a revoke over HTTP.
  const from = script.indexOf('run_leg "@jf-remove"');
  assert(from > 0, 'the orchestrator runs the remove leg');
  const rest = script.slice(from);
  const end = rest.indexOf('# ------');
  const section = end === -1 ? rest : rest.slice(0, end);
  assert(!section.includes('/api/collections/revoke'),
    'the orchestrator must not POST a revoke for the browser removal leg');
  assert(section.includes("SELECT status FROM managed_collections"),
    'it corroborates the durable state afterwards instead');
});

test('the orchestrator proves the claims it says it proves', () => {
  const script = read(ORCHESTRATOR);
  for (const claim of [
    'DISABLED', 'contacted something', 'queued a per-record intent', 'created a collection on the media server',
    'produced a duplicate', 'a repeat reconcile created something', 'did not survive a restart',
    'viewing changed the media server',
    // Phase 269/270: ONE plan is ONE collection, and a PARTIAL erasure leaves the rest standing.
    'a plan must not become one collection per record',
    'still in the collection',
    'a PARTIAL erasure removed the whole collection',
    'a membership row for the forgotten record survived its removal',
    // Phase 271: the drift audit is a read, and the repair is digest-confirmed and writes durable state only.
    'the audit did not notice the externally deleted collection',
    'the audit changed the durable state',
    'a wrong repair digest was accepted',
    'the repair itself created something on the media server',
    'the repaired collection was not recreated by the ordinary pass',
    // Phase 269/272: the browser removal leg is a lifecycle, and the shell corroborates it rather than
    // performing it.
    'the browser reported a deletion the media server did not perform',
    'rather than a completed revoke',
    'an external copy is still queued for revocation after the browser reported it deleted',
    // Phase 272: the command line is not a bypass, and it discloses nothing.
    'the CLI accepted a wrong confirmation digest',
    'the collection CLI printed something it must never print',
    'a refused CLI apply changed the media server',
  ]) {
    assert(script.includes(claim), `the orchestrator asserts: ${claim}`);
  }
  // The counts are read through digits_or_die, so an unreadable measurement can never look unchanged.
  assert(script.includes('digits_or_die "${raw}" "the row count for'), 'row counts refuse a non-number');
  assert(script.includes('digits_or_die "${raw}" "the fake server collection count"'), 'so does the external count');
  assert(script.includes('digits_or_die "${raw}" "the fake server collection member count"'),
    'and so does the MEMBERSHIP count, which is the other half of what a grouped collection claims');
});

test('the shipped release bundle carries no Jellyfin wiring, and the orchestrator checks that too', () => {
  const script = read(ORCHESTRATOR);
  assert(script.includes('the shipped release bundle mentions JELLYFIN_'),
    'the orchestrator fails if the bundle ever ships Jellyfin configuration');
  // The bundle generator's own file list must not name any acceptance artifact.
  const generator = read('src/ops/consumer-release-bundle.ts');
  for (const artifact of ['jellyfin-fake', 'jellyfin.spec', 'fake-jellyfin', 'jellyfin-control-acceptance']) {
    assert(!generator.includes(artifact), `the release bundle must not ship ${artifact}`);
  }
});

test('CI runs this acceptance, and the release cannot publish without it', () => {
  const workflow = read(WORKFLOW);
  assert(workflow.includes('deploy/ci/jellyfin-control-acceptance.sh'), 'the workflow runs the orchestrator');
  assert(workflow.includes('jellyfin-acceptance:'), 'as a named job');
  assert(/needs: \[[^\]]*jellyfin-acceptance[^\]]*\]/.test(workflow),
    'and the publish job cannot run without it');
  assert(workflow.includes('REQUIRE_ACCEPTANCE: 1') || workflow.includes('REQUIRE_ACCEPTANCE: "1"'),
    'and CI runs it in the mode where a missing prerequisite is a failure');
  for (const script of ['test:phase266-local', 'test:phase267-local', 'test:phase268-local', 'test:phase268-acceptance']) {
    assert(workflow.includes(script), `the workflow runs ${script}`);
  }
});

test('the document says what the acceptance proves and what it does not', () => {
  const doc = read(DOC);
  for (const needle of ['fake Jellyfin', 'Limitations', 'Proof', 'jellyfin-control-acceptance.sh']) {
    assert(doc.includes(needle), `the document mentions ${needle}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
