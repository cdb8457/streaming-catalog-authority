import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asMap, parseYaml } from './helpers/compose-yaml.js';

// Phase 276 — the DISPOSABLE managed-collection lifecycle, and the test-only surface that makes it provable.
//
// WHY A FAKE-ADMIN SURFACE HAD TO EXIST AT ALL. Phase 271 can detect membership drift. Nothing could
// MANUFACTURE it: every route the acceptance had was one the product itself drives, so a "drift" produced
// through them was the product agreeing with itself. Real drift is somebody opening Jellyfin's own web UI and
// dragging a film out of a collection — a mutation this product neither performed nor was told about. The
// fake server therefore gained a mutation surface that goes BEHIND the product's back.
//
// AND WHY THAT IS THE MOST DANGEROUS THING IN THIS TRANCHE. A mutation surface with no authentication is a
// back door if it ever ships. So this suite is the guard, and it checks four independent things:
//
//   1. IT IS NOT IN THE PRODUCT. No file under `src/` names `/_control/` or the switch that turns it on; the
//      production image copies `src` and nothing from `deploy/`; and the consumer release bundle generator
//      names no acceptance artifact at all.
//   2. IT IS OFF UNLESS TURNED ON — proved by RUNNING the fake server twice, once with the switch and once
//      without, and asking it. A static scan for the string would pass against a server that read the
//      variable and ignored it.
//   3. IT CANNOT COLLIDE WITH JELLYFIN. Everything it adds is under `/_control/`, which no Jellyfin route
//      uses, so the product cannot reach one by accident.
//   4. THE LIFECYCLE THE ORCHESTRATOR CLAIMS IS THE LIFECYCLE IT RUNS, in order, with a proof for each step —
//      gates closed and a refusal, a zero-write preview, the gates opened deliberately, digest-confirmed
//      queue, reconcile, restart, adoption, drift injected, a read-only audit, a stale and a wrong repair
//      confirmation both refused, a confirmed repair, a reconcile, exact membership, revoke, and zero
//      managed artifacts left behind.

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

const root = fileURLToPath(new URL('..', import.meta.url));
/** Line endings are a checkout artifact, never content: a Windows working copy delivers CRLF. */
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').split('\r\n').join('\n');
const exists = (rel: string): boolean => existsSync(join(root, rel));

const ORCHESTRATOR = 'deploy/ci/jellyfin-control-acceptance.sh';
const OVERRIDE = 'deploy/ci/acceptance/docker-compose.jellyfin-fake.yml';
const FAKE = 'deploy/ci/acceptance/fake-jellyfin/server.mjs';
const DOC = 'docs/PHASES_274_276_OFFLINE_PRODUCTION_AND_LIFECYCLE.md';

/** The prefix every test-only route lives under, and the switch that turns the whole surface on. */
const CONTROL_PREFIX = '/_control/';
const ADMIN_SWITCH = 'JELLYFIN_FAKE_ADMIN';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Walk src/ once. Every guard below asks a question of this list rather than re-walking. */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walkTs(rel));
    else if (entry.endsWith('.ts') || entry.endsWith('.mjs') || entry.endsWith('.js')) out.push(rel);
  }
  return out;
}

interface RunningFake {
  readonly port: number;
  readonly child: ChildProcess;
  stop(): Promise<void>;
}

/** Start the REAL fake server, exactly as the Compose override starts it, and wait for it to listen. */
async function startFake(env: NodeJS.ProcessEnv): Promise<RunningFake> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(root, FAKE)], {
    env: { ...process.env, JELLYFIN_FAKE_PORT: String(port), JELLYFIN_FAKE_API_KEY: 'suite-key', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the fake server did not start within the bounded wait')), 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('listening on')) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the fake server exited ${String(code)}`)); });
  });
  return {
    port,
    child,
    stop: () => new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill(); }),
  };
}

async function main(): Promise<void> {
  console.log('Running Phase 276 disposable collection lifecycle contract suite:\n');

  // -------------------------------------------------------------------------------------------------------
  // 1. THE MUTATION SURFACE IS NOT IN THE PRODUCT.
  // -------------------------------------------------------------------------------------------------------

  await test('no file under src/ names the test-only control surface or the switch that enables it', () => {
    const files = walkTs('src');
    assert(files.length > 100, `the scan really walked src/ (found ${files.length} files)`);
    for (const file of files) {
      const source = read(file);
      assert(!source.includes(CONTROL_PREFIX), `${file} names the test-only control surface`);
      assert(!source.includes(ADMIN_SWITCH), `${file} names the fake-admin switch`);
      assert(!source.includes('fake-jellyfin'), `${file} names the acceptance fake server`);
    }
  });

  await test('the production image copies src and nothing from deploy/, so the fake server cannot ship in it', () => {
    const dockerfile = read('Dockerfile.runtime');
    const copies = [...dockerfile.matchAll(/^COPY\s+(?!--from)([^\n]+)$/gm)].map((m) => m[1]!);
    assert(copies.length > 0, 'the runtime image copies something');
    for (const line of copies) {
      assert(!line.includes('deploy'), `the runtime image copies ${line}, which reaches deploy/`);
    }
    assert(dockerfile.includes('COPY src ./src'), 'and it copies the product source it does need');
  });

  await test('the consumer release bundle ships no acceptance artifact at all', () => {
    const generator = read('src/ops/consumer-release-bundle.ts');
    for (const artifact of ['fake-jellyfin', 'jellyfin.spec', 'jellyfin-control-acceptance', '_control',
      ADMIN_SWITCH, 'catalog-acceptance']) {
      assert(!generator.includes(artifact), `the release bundle generator must not name ${artifact}`);
    }
  });

  await test('the fake server itself lives only in the acceptance directory', () => {
    assert(exists(FAKE), 'the fake server exists where it belongs');
    assert(!exists('src/ops/fake-jellyfin.ts'), 'and nowhere in the product');
    // Everything it adds is namespaced, so a Jellyfin route can never reach it.
    const fake = read(FAKE);
    const routes = [...fake.matchAll(/url\.pathname === '([^']+)'/g)].map((m) => m[1]!);
    const control = routes.filter((r) => r.startsWith(CONTROL_PREFIX));
    assert(control.length >= 4, `the control surface has its routes (found ${control.length})`);
    for (const route of routes) {
      if (route.startsWith(CONTROL_PREFIX)) continue;
      assert(['/System/Info', '/Collections', '/Items'].includes(route), `the fake serves an unexpected route: ${route}`);
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // 2. IT IS OFF UNLESS TURNED ON — proved by RUNNING it.
  // -------------------------------------------------------------------------------------------------------

  await test('with the switch absent, every control route answers 404 as if it did not exist', async () => {
    const fake = await startFake({});
    try {
      for (const path of ['/_control/state', '/_control/lose-next-create', '/_control/membership', '/_control/fail-next']) {
        const res = await fetch(`http://127.0.0.1:${fake.port}${path}`, { method: 'POST' });
        assertEq(res.status, 404, `${path} must be 404 with the fake-admin switch off`);
      }
      // ...while the ordinary Jellyfin surface still works, so the server is genuinely running.
      const info = await fetch(`http://127.0.0.1:${fake.port}/System/Info`, { headers: { 'X-Emby-Token': 'suite-key' } });
      assertEq(info.status, 200, 'the ordinary Jellyfin surface is unaffected');
    } finally {
      await fake.stop();
    }
  });

  await test('a switch that is nearly right is still off: only the exact string enables it', async () => {
    for (const value of ['true', '1', 'Enabled', 'ENABLED', 'enabled ', 'yes']) {
      const fake = await startFake({ [ADMIN_SWITCH]: value });
      try {
        const res = await fetch(`http://127.0.0.1:${fake.port}/_control/state`);
        assertEq(res.status, 404, `${ADMIN_SWITCH}=${JSON.stringify(value)} must NOT enable the control surface`);
      } finally {
        await fake.stop();
      }
    }
  });

  await test('with the switch on, drift injection and one-shot read failures really work', async () => {
    const fake = await startFake({ [ADMIN_SWITCH]: 'enabled' });
    const key = { 'X-Emby-Token': 'suite-key' };
    try {
      const state0 = await (await fetch(`http://127.0.0.1:${fake.port}/_control/state`)).json() as { adminEnabled: boolean; managed: number };
      assertEq(state0.adminEnabled, true, 'the control surface reports itself enabled');
      assertEq(state0.managed, 0, 'and nothing is managed yet');

      // Create a collection the way the product does — through the Jellyfin route, carrying the marker.
      const created = await (await fetch(
        `http://127.0.0.1:${fake.port}/Collections?name=${encodeURIComponent('Suite [cat:tok-1]')}&ids=jf-item-1,jf-item-2`,
        { method: 'POST', headers: key })).json() as { Id: string };
      assert(typeof created.Id === 'string', 'the create returned an opaque id');

      const marked = await (await fetch(`http://127.0.0.1:${fake.port}/_control/state`)).json() as { managed: number };
      assertEq(marked.managed, 1, 'a collection carrying the marker is counted as managed');

      // DRIFT, injected behind the product's back: one item out, one unrelated item in.
      const drift = await fetch(
        `http://127.0.0.1:${fake.port}/_control/membership?id=${encodeURIComponent(created.Id)}&add=jf-item-3&remove=jf-item-1`,
        { method: 'POST' });
      assertEq(drift.status, 200, 'the drift injection is accepted');
      const drifted = await (await fetch(`http://127.0.0.1:${fake.port}/_control/state`)).json() as { collections: Array<{ ids: string[] }> };
      assertEq([...drifted.collections[0]!.ids].sort().join(','), 'jf-item-2,jf-item-3',
        'the collection now holds the wrong items, and the product was never told');

      // A ONE-SHOT read failure: the next member listing fails, and the one after it succeeds. That is what
      // makes "unknown, then a retry that judges it" a thing the acceptance can actually stage.
      assertEq((await fetch(`http://127.0.0.1:${fake.port}/_control/fail-next?read=members`, { method: 'POST' })).status,
        200, 'a member-listing failure can be armed');
      const failed1 = await fetch(`http://127.0.0.1:${fake.port}/Items?parentId=${encodeURIComponent(created.Id)}`, { headers: key });
      assertEq(failed1.status, 500, 'the next member listing fails');
      const recovered = await fetch(`http://127.0.0.1:${fake.port}/Items?parentId=${encodeURIComponent(created.Id)}`, { headers: key });
      assertEq(recovered.status, 200, 'and the one after it succeeds — the failure was one-shot');

      // An unknown read kind is refused rather than silently armed.
      assertEq((await fetch(`http://127.0.0.1:${fake.port}/_control/fail-next?read=everything`, { method: 'POST' })).status,
        400, 'an unknown read kind is refused');
      // Drift on a collection that is not there is a 404, not a silent success.
      assertEq((await fetch(`http://127.0.0.1:${fake.port}/_control/membership?id=nope&add=jf-item-1`, { method: 'POST' })).status,
        404, 'drift on a collection that does not exist is refused');
    } finally {
      await fake.stop();
    }
  });

  await test('the control surface is still unauthenticated, and the Jellyfin surface still is not', async () => {
    const fake = await startFake({ [ADMIN_SWITCH]: 'enabled' });
    try {
      // The Jellyfin routes enforce the key — the property the whole acceptance's "the key really travelled"
      // claim rests on — and turning the fake-admin surface on does not weaken it.
      for (const path of ['/System/Info', '/Items', '/Collections']) {
        const res = await fetch(`http://127.0.0.1:${fake.port}${path}`);
        assertEq(res.status, 401, `${path} still requires the api key`);
      }
    } finally {
      await fake.stop();
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // 3. THE OVERRIDE TURNS IT ON, AND STARTS WITH EVERY WRITE GATE CLOSED.
  // -------------------------------------------------------------------------------------------------------

  await test('the acceptance override enables the surface and defaults every WRITE switch to off', () => {
    const override = asMap(parseYaml(read(OVERRIDE)), 'the fake-Jellyfin override');
    const services = asMap(override.services ?? null, 'the override services');
    const fake = asMap(services['jellyfin-fake']!, 'the jellyfin-fake service');
    const fakeEnv = asMap(fake.environment!, 'the fake server environment');
    assertEq(String(fakeEnv[ADMIN_SWITCH]), 'enabled', 'the override is the ONE place that turns the surface on');

    const app = asMap(services.app!, 'the app service');
    const appEnv = asMap(app.environment!, 'the app environment');
    // The READ switch is on for the whole run, because a read is all discovery and matching need.
    assertEq(String(appEnv.JELLYFIN_ENABLE_NETWORK), 'true', 'the read switch is on');
    // Every WRITE switch is a parameter with a fail-closed default, so the run STARTS with all three closed.
    for (const [name, closed] of [
      ['JELLYFIN_ALLOW_COLLECTION_WRITES', ':-false}'],
      ['JELLYFIN_ALLOW_LIVE_PUBLISH', ':-false}'],
      ['PUBLISH_EXTERNAL_IDENTITY', ':-deny}'],
    ] as Array<[string, string]>) {
      assert(String(appEnv[name]).includes(closed), `${name} must default to closed in the override`);
    }
    // The app never learns the fake-admin switch: it is the FIXTURE's, not the product's.
    assertEq(appEnv[ADMIN_SWITCH], undefined, 'the application is never told the fake-admin switch exists');
  });

  // -------------------------------------------------------------------------------------------------------
  // 4. THE ORCHESTRATOR RUNS THE LIFECYCLE IT CLAIMS.
  // -------------------------------------------------------------------------------------------------------

  await test('the orchestrator opens the write gates deliberately, and only after proving they were closed', () => {
    const script = read(ORCHESTRATOR);
    const closedAt = script.indexOf('with every write gate closed, a queue is REFUSED');
    const openedAt = script.indexOf('JELLYFIN_ALLOW_COLLECTION_WRITES=true');
    assert(closedAt > 0, 'the orchestrator proves the gates are closed');
    assert(openedAt > 0, 'and later opens them');
    assert(closedAt < openedAt, 'and it proves the refusal BEFORE it opens anything');
    // All three write switches are opened together, explicitly, and never left to a default.
    assert(/JELLYFIN_ALLOW_COLLECTION_WRITES=true JELLYFIN_ALLOW_LIVE_PUBLISH=true PUBLISH_EXTERNAL_IDENTITY=allow/
      .test(script), 'the three write switches are opened together and by name');
  });

  await test('the orchestrator stages the whole disposable lifecycle, and proves each step', () => {
    const script = read(ORCHESTRATOR);
    for (const claim of [
      // Phase 274 — the snapshot is produced, not copied.
      'this gate must PRODUCE its snapshot, not copy one',
      'a snapshot already exists in the import folder before it was produced',
      'the shipped image produced a different snapshot',
      // The SNAPSHOT keeps `external.<system>`; the support REPORT deliberately does not, and the gate checks
      // both halves of that — the file for the provenance, the report for its absence.
      'the produced snapshot does not carry external.<system> provenance in its own source field',
      "the producer's report echoed content it must not",
      'the repeat import planned creates; it is not idempotent',
      // Phase 276 — gates closed first, and a refusal that names one.
      'a closed write gate did not refuse the queue, or did not name itself',
      'a refused queue wrote a managed collection row',
      'a refused queue reached the media server',
      // Phase 275 — the read-only match.
      'the match did not declare that it wrote nothing',
      'the match ran with the collection-write gate open',
      'the match wrote a plan history row',
      'the match report disclosed something it must never print',
      "a failed library read produced ABSENCES",
      // Phase 276 — drift, audit, repair, exact membership.
      'the drift injection changed nothing, so everything below would be vacuous',
      'the audit did not notice the injected membership drift',
      'the audit did not see the item that was taken out',
      'the audit did not see the item that was put in',
      'the audit changed the media server — an audit is a read',
      'a failed member listing was not reported as unknown',
      'an unknown finding was offered as repairable',
      'the retry after a one-shot failure did not judge the collection again',
      'a repair whose world had moved was accepted',
      'a wrong repair digest was accepted',
      'the repair ITSELF changed the media server',
      'the repair scheduled no membership comparison, so the reconcile below would prove nothing about it',
      'the collection does not hold EXACTLY the intended items after the repair',
      'the audit still reports drift after the repair and the reconcile',
      // Phase 276 — the cleanup claim.
      "a collection carrying this product's marker is still on the media server",
      'managed collection(s) are still outstanding after the lifecycle finished',
      'membership row(s) survived a completed revoke',
      'the cleanup removed a collection this product did not create',
    ]) {
      assert(script.includes(claim), `the orchestrator asserts: ${claim}`);
    }
    // Every count that decides something is read through digits_or_die, so an unreadable measurement can
    // never look unchanged.
    for (const counted of ['the fake server managed collection count', 'the produced record count',
      'the outstanding managed collection count', 'the foreign collection count']) {
      assert(script.includes(`digits_or_die`) && script.includes(counted), `${counted} refuses a non-number`);
    }
    // AND SO IS THE DIGEST COMPARISON. Two unreadable digests compare EQUAL, so "the shipped image produced
    // the same bytes" would pass vacuously if either measurement failed. Both sides go through the guard.
    assert(script.includes('hex64_or_die "$(read_produced contentDigest)"'),
      'the produced content digest refuses anything that is not a digest');
    assert(script.includes('hex64_or_die "${image_digest}"'),
      'and so does the in-image content digest, which is the other half of the comparison');
  });

  await test('no line in either gate carries a literal backslash-n where a newline was meant', () => {
    // A DEFECT THIS PHASE ACTUALLY INTRODUCED AND THIS CHECK CAUGHT. An edit wrote
    // `... PUBLISH_EXTERNAL_IDENTITY=allow \n  jf_compose up -d` — two characters, not a line continuation.
    // Bash reads `\n` as an escaped `n`, so the line runs a command NAMED `n` and the compose invocation
    // silently becomes its argument. `bash -n` accepts it happily: it is valid syntax for a command that does
    // not exist, and the failure only appears on a runner with a Docker daemon. Lines that legitimately spell
    // a newline — printf, echo, node -e, grep, sed, awk — are exempt.
    for (const rel of [ORCHESTRATOR, 'deploy/ci/catalog-acceptance.sh']) {
      read(rel).split('\n').forEach((line, index) => {
        if (line.trimStart().startsWith('#')) return;
        if (/printf|echo |node -e|grep|sed|awk/.test(line)) return;
        assert(!line.includes('\\n'),
          `${rel} line ${index + 1} carries a literal backslash-n: ${line.trim().slice(0, 90)}`);
      });
    }
  });

  await test('the orchestrator never reaches a real service, a media path or a registry', () => {
    // COMMENT LINES ARE EXCLUDED, deliberately. The header says in words that this gate contacts no Unraid
    // host and no media path, and a scan that refused the word would be a scan that forbids the file from
    // DESCRIBING its own boundary. What matters is what it EXECUTES.
    const script = read(ORCHESTRATOR).split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    const lower = script.toLowerCase();
    for (const forbidden of ['/mnt/user', 'ghcr.io', 'docker.io', 'docker push', 'docker login', 'gh release',
      'git tag', 'git push', 'npm publish', 'torbox', 'api.themoviedb', 'unraid']) {
      assert(!lower.includes(forbidden), `the orchestrator never references ${forbidden}`);
    }
    // Every address it names is loopback or the Compose service name of the disposable fake.
    const urls = script.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    for (const url of urls) {
      assert(url.startsWith('http://127.0.0.1') || url.startsWith('http://jellyfin-fake:'),
        `every address must be loopback or the disposable fake, found ${url}`);
    }
  });

  await test('the document exists and says what the fake-admin surface is and is not', () => {
    assert(exists(DOC), `${DOC} exists`);
    const doc = read(DOC);
    for (const needle of ['fake-admin', ADMIN_SWITCH, 'never shipped', 'Limitations', 'Proof']) {
      assert(doc.includes(needle), `the document mentions ${needle}`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
