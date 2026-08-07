import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  TORBOX_ASSUMED_LIFETIME_MS, TORBOX_LINK_LIFETIME_MS, TORBOX_REQUESTDL, TORBOX_SOURCE_KINDS,
  TorBoxRefError, TorBoxResolveError, buildRequestUrl, classifyStatus, findSecretShapes, formatStableRef,
  parseResolveBody, parseStableRef, redactError,
} from '../src/core/adapters/torbox-resolver.js';
// The per-read ceiling the gates are held to, imported so the heredoc's re-typed copy can be compared
// against the contract rather than against another literal.
import { MOUNT_READ_DEADLINE_MS } from '../src/core/projection/real-provider.js';
import { createTorBoxFixture, objectBytes, type TorBoxFault } from '../src/ops/torbox-fixture-service.js';
import { createResolverService, readSecretFile } from '../src/ops/torbox-resolver-service.js';

// The TorBox resolver, attacked offline.
//
// WHAT MAKES THIS SUITE DIFFERENT FROM PARSING TESTS. The point of the adapter is that a TorBox object
// becomes an ordinary read-only file. A suite that only checked `parseStableRef` would pass while the
// resolver was never invoked at all. So the core of what follows stands up the FIXTURE, stands up the REAL
// resolver service against it, and drives the real service over HTTP the way the projection daemon drives
// it — same POST body, same bearer, same three response fields. Every fault below is injected into a real
// listener and observed through a real client.
//
// THE ONE THING IT CANNOT DO IS TALK TO TORBOX. No test here contacts a real account, reads a real
// credential, or searches for one. What it proves is that the adapter speaks the contract TorBox publishes;
// whether TorBox honours its own contract is a question only the operator-run real gate can answer.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const repoFile = (path: string): string => readFileSync(join(HERE, '..', path), 'utf8');

/**
 * A path in the spelling the SHELL will read, not the one the platform stores.
 *
 * WHAT THIS IS AND, JUST AS IMPORTANTLY, WHAT IT IS NOT. Backslashes reaching a shell as argv are consumed
 * as escapes, so a native `C:\Users\…` handed to a POSIX shell can arrive as `C:Usersclint…`. Forward
 * slashes avoid that, and on a POSIX host there are no backslashes to replace, so this is a no-op there
 * rather than a second code path.
 *
 * IT IS NOT, HOWEVER, WHAT MADE THE WRAPPER TEST FAIL ON WINDOWS, AND THE COMMIT THAT ADDED IT SAID IT WAS.
 * Measured against each candidate binary directly: Git Bash runs a script at BOTH spellings, and the `bash`
 * first on PATH on a stock Windows box — `C:\WINDOWS\system32\bash.exe`, which is WSL — runs it at NEITHER,
 * because a Windows drive path is not addressable from inside WSL at all (it wants `/mnt/c/…`). The
 * determinant was never the separator; it was WHICH `bash` got the call. `posixShell` below is the fix, and
 * this remains for the argv hygiene it does provide.
 */
const shPath = (path: string): string => path.replace(/\\/g, '/');

/**
 * Blocks the suite could not execute here, counted so a green summary cannot hide them.
 *
 * A TEST THAT RETURNS EARLY STILL PRINTS `ok`. Several tests below need a POSIX shell, or POSIX process and
 * permission semantics, for part of what they assert; without this a Windows reader saw every line green and
 * had no way to know which halves never ran. Each skip names itself here and the count is printed with the
 * totals.
 */
const skippedBlocks: string[] = [];
const skipBlock = (what: string): void => {
  skippedBlocks.push(what);
  console.log(`  ..  SKIPPED on ${process.platform}: ${what}`);
};

// ---------------------------------------------------------------------------------------------------------
// THE SHELL THIS SUITE DRIVES SHIPPED SCRIPTS WITH, CHOSEN BY EXECUTION RATHER THAN BY NAME
// ---------------------------------------------------------------------------------------------------------
//
// THE DEFECT, WHICH SURVIVED TWO COMMITS AND WAS PUBLISHED AS A PASSING FIGURE BOTH TIMES. Four tests here
// drive a shipped shell program, and they invoked it as `spawnSync('bash', …)` — whatever `bash` PATH
// happens to resolve first. On a stock Windows install that is `C:\WINDOWS\system32\bash.exe`, the WSL
// launcher, which cannot address a Windows drive path in any spelling; the wrapper test therefore FAILED
// rather than ran, and the failure was indistinguishable from a real regression in the wrapper. It passed
// only when the suite happened to be started from a shell that had put Git Bash's `bin` first, which is why
// the recorded Windows figure did not reproduce from an ordinary PowerShell launch.
//
// SO THE SHELL IS CHOSEN BY ASKING IT TO DO THE JOB, NOT BY ASKING WHAT IT IS CALLED. Each candidate is made
// to execute a real script at the exact path spelling the suite will use and print a sentinel. A candidate
// that cannot is not a POSIX shell as far as this suite is concerned, whatever its name — and if none can,
// every test that needs one SKIPS BY NAME rather than failing, because a suite that could not run the
// wrapper has not checked the wrapper and must not report either verdict.
//
// A RELATED DEFECT WAS SOLVED DIFFERENTLY ELSEWHERE, AND THE DIFFERENCE IS DELIBERATE.
// `test/projection-jellyfin-dataplane.ts` keeps whatever `bash` it finds and TRANSLATES the path into that
// shell's convention (`toBashPath`, plus `WSLENV` so variables survive the boundary). That is right there,
// where the wrapper only ever invokes a stub. It is wrong here: these wrappers run `npm`, `npx` and `docker`
// out of this checkout, and a WSL bash would be a different machine with a different toolchain. What this
// suite needs is the shell the repository is actually operated with.
const SHELL_SENTINEL = 'projection-posix-shell-ok';

/** Where a Git-for-Windows `bash.exe` lives, derived from the `git` that is installed rather than guessed. */
function gitBashCandidates(): readonly string[] {
  const found: string[] = [];
  // `git --exec-path` answers e.g. `C:/Program Files/Git/mingw64/libexec/git-core`; the shell sits at
  // `<install root>/bin/bash.exe`. Walking up from the answer finds it wherever Git was installed, which a
  // hard-coded `C:\Program Files` would not.
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (execPath.status === 0) {
    let dir = String(execPath.stdout).trim().replace(/\\/g, '/');
    for (let up = 0; up < 4 && dir.includes('/'); up += 1) {
      found.push(`${dir}/bin/bash.exe`);
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
  }
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    if (root !== undefined && root !== '') found.push(`${shPath(root)}/Git/bin/bash.exe`);
  }
  return found;
}

/**
 * Candidates in the order they should be preferred.
 *
 * ON WINDOWS, BARE `bash` IS TRIED LAST AND THAT ORDERING IS THE WHOLE POINT: it is the one most likely to
 * be WSL. On a POSIX host bare `bash` is tried FIRST, because there it is the right answer — with the
 * absolute paths after it so that a PATH which has been poisoned, shadowed or emptied still resolves to a
 * real shell rather than making the suite skip a check it could have run.
 */
function shellCandidates(): readonly string[] {
  if (process.platform === 'win32') return [...gitBashCandidates(), 'bash'];
  return ['bash', '/bin/bash', '/usr/bin/bash', '/bin/sh'];
}

/** Can this candidate actually execute a script at the spelling this suite hands out? */
function shellCanRunAScript(command: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'tbshell-'));
  const script = join(dir, 'probe.sh');
  writeFileSync(script, `#!/bin/sh\nprintf '%s' '${SHELL_SENTINEL}'\n`);
  try { chmodSync(script, 0o755); } catch { /* Windows has no executable bit; the shell is given the path */ }
  const result = spawnSync(command, [shPath(script)], { encoding: 'utf8', timeout: 30_000 });
  return result.status === 0 && String(result.stdout ?? '').includes(SHELL_SENTINEL);
}

let shellChoice: { readonly command: string | null } | undefined;

/** The chosen shell, or `null` when nothing on this host can run a script at this path. Memoised. */
function posixShell(): string | null {
  if (shellChoice === undefined) {
    shellChoice = { command: shellCandidates().find(shellCanRunAScript) ?? null };
  }
  return shellChoice.command;
}

/**
 * The chosen shell where a caller has already established there is one.
 *
 * Every call site is behind a guard that skips by name when `posixShell()` is null, so reaching this with
 * nothing selected is a defect in the guard rather than a property of the host — and it throws rather than
 * quietly falling back to bare `bash`, which is the behaviour this whole mechanism exists to remove.
 */
function shellOrThrow(): string {
  const command = posixShell();
  if (command === null) throw new Error('no POSIX shell was selected, and this block requires one');
  return command;
}

/** For the selection regression, which has to re-resolve under a deliberately poisoned PATH. */
function resetShellChoice(): void { shellChoice = undefined; }

/** The reason a block cannot run, named for what is missing rather than for the platform. */
const NO_SHELL = 'no POSIX shell on this host can execute a script at the workspace path';

let passed = 0;
let failed = 0;
const failures: [string, unknown][] = [];

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push([name, error]);
    console.log(`FAIL  ${name}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const TOKEN = 'fixture-api-key-0123456789abcdef';
const GATE = 'gate-secret-fedcba9876543210';
const SIZE = 4 * 1024 * 1024;
const REF_TORRENT = 'torbox:torrent:1234:0';
const REF_WEBDL = 'torbox:webdl:5678:1';
const REF_USENET = 'torbox:usenet:9012:2';

// ---------------------------------------------------------------------------------------------------------
// A live fixture and a live resolver, for the tests that need the whole path
// ---------------------------------------------------------------------------------------------------------

interface Harness {
  readonly resolverUrl: string;
  readonly fixture: ReturnType<typeof createTorBoxFixture>;
  readonly credentialFile: string;
  readonly gateFile: string;
  close(): Promise<void>;
}

async function harness(over: { token?: string; allowPlaintextLink?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'torbox-'));
  const credentialFile = join(dir, 'credential');
  const gateFile = join(dir, 'gate');
  writeFileSync(credentialFile, `${over.token ?? TOKEN}\n`);
  writeFileSync(gateFile, `${GATE}\n`);
  if (process.platform !== 'win32') {
    chmodSync(credentialFile, 0o600);
    chmodSync(gateFile, 0o600);
  }

  const fixture = createTorBoxFixture({
    objects: [
      { ref: REF_TORRENT, sizeBytes: SIZE },
      { ref: REF_WEBDL, sizeBytes: SIZE },
      { ref: REF_USENET, sizeBytes: SIZE },
    ],
    token: TOKEN,
    publicOrigin: 'http://127.0.0.1:0',
    disallowedOrigin: 'http://127.0.0.1:1',
  });
  await new Promise<void>((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
  const fixturePort = (fixture.server.address() as AddressInfo).port;
  const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;
  // THE FIXTURE MINTS LINKS NAMING ITSELF, and a listener bound to port 0 does not know its own port until
  // it is listening. Without this the minted links would name port 0 and the two-hop shape would collapse.
  fixture.setPublicOrigin(fixtureOrigin);

  const service = createResolverService({
    host: '127.0.0.1', port: 0, credentialFile, gateSecretFile: gateFile, apiOrigin: fixtureOrigin,
    requestTimeoutMs: 2_000, maxAttempts: 3,
    // THE OFFLINE FIXTURE SERVES PLAINTEXT ON LOOPBACK, so most tests here need the exemption. It is
    // opt-OUT rather than opt-in for this harness alone; the module's own default is to REFUSE plaintext,
    // and the two tests below prove that default is what a caller who says nothing gets.
    allowPlaintextLink: over.allowPlaintextLink ?? true,
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  const resolverPort = (service.address() as AddressInfo).port;

  return {
    resolverUrl: `http://127.0.0.1:${resolverPort}/resolve`,
    fixture,
    credentialFile,
    gateFile,
    close: async () => {
      await new Promise<void>((resolve) => service.close(() => resolve()));
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    },
  };
}

/** Drives the resolver EXACTLY as `projectiond/internal/source/resolver.go` does. */
async function askResolver(url: string, objectRef: string, bearer = GATE): Promise<{
  status: number; body: { url?: string; headers?: Record<string, string>; expiresAtUnixMs?: number };
}> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ objectRef }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = {}; }
  return { status: response.status, body };
}

async function main(): Promise<void> {
  console.log('\ntorbox resolver (offline)\n');

  // -------------------------------------------------------------------------------------------------------
  // The published contract, as recorded from TorBox's own SDK source
  // -------------------------------------------------------------------------------------------------------

  await test('THE THREE ENDPOINTS AND THEIR WIRE PARAMETER NAMES ARE THE OFFICIAL ONES', () => {
    // These four strings per family are the entire integration surface. They were taken from TorBox's own
    // SDK source rather than from prose, because prose says `torrentId` where the wire says `torrent_id` —
    // and a resolver that sent the camelCase spelling would be silently ignored and answer 400 forever.
    assert(TORBOX_REQUESTDL.torrent.path === '/v1/api/torrents/requestdl', 'the torrent path');
    assert(TORBOX_REQUESTDL.torrent.idParam === 'torrent_id', 'the torrent id parameter');
    assert(TORBOX_REQUESTDL.webdl.path === '/v1/api/webdl/requestdl', 'the webdl path');
    assert(TORBOX_REQUESTDL.webdl.idParam === 'web_id', 'the webdl id parameter');
    assert(TORBOX_REQUESTDL.usenet.path === '/v1/api/usenet/requestdl', 'the usenet path');
    assert(TORBOX_REQUESTDL.usenet.idParam === 'usenet_id', 'the usenet id parameter');
  });

  await test('THE REQUEST CARRIES THE CREDENTIAL AS A QUERY PARAMETER, WHICH IS WHY IT IS A SECRET', () => {
    // TorBox authenticates requestdl with ?token=, not a header. That makes the REQUEST URL a bearer
    // credential, and it is the single fact that shapes every redaction rule in this adapter.
    const url = buildRequestUrl(parseStableRef(REF_TORRENT), TOKEN);
    assert(url.searchParams.get('token') === TOKEN, 'the token is a query parameter');
    assert(url.searchParams.get('torrent_id') === '1234', 'the item id is a query parameter');
    assert(url.searchParams.get('file_id') === '0', 'as is the file id');
    assert(url.origin === 'https://api.torbox.app', 'and the default origin is the official one');
    // `redirect` MUST NEVER BE SET: with it TorBox answers 3xx toward a CDN host, and this contract needs
    // the JSON body — while the data plane refuses to follow redirects at all.
    assert(!url.searchParams.has('redirect'), 'redirect is never requested');
    assert(findSecretShapes(url.toString(), 'url').length > 0,
      'and the resulting URL is recognised by the scrubber as something that must never be printed');
  });

  await test('A REFERENCE CANNOT SMUGGLE A PARAMETER INTO THE URL', () => {
    // If the parser were ever loosened, the escaping still has to hold.
    for (const hostile of ['torbox:torrent:1&file_id=9:0', 'torbox:torrent:1:0&admin=1',
      'torbox:torrent:../../x:0', 'torbox:torrent:1 2:0', 'torbox:torrent:+1:0', 'torbox:torrent:0x10:0']) {
      let threw = false;
      try { parseStableRef(hostile); } catch { threw = true; }
      assert(threw, `the parser accepted ${JSON.stringify(hostile)}`);
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // Reference parsing
  // -------------------------------------------------------------------------------------------------------

  await test('A WELL-FORMED REFERENCE ROUND-TRIPS FOR ALL THREE KINDS', () => {
    for (const ref of [REF_TORRENT, REF_WEBDL, REF_USENET]) {
      assert(formatStableRef(parseStableRef(ref)) === ref, `${ref} did not round-trip`);
    }
    assert(TORBOX_SOURCE_KINDS.length === 3, 'there are exactly three source kinds');
  });

  await test('EVERY MALFORMED REFERENCE IS REFUSED, AND THE FAILURE NEVER QUOTES IT BACK', () => {
    // A malformed reference is still somebody's account data, and a parser is most tempted to quote its
    // input at exactly the moment it must not.
    const hostile = [
      '', 'torbox', 'torbox:torrent', 'torbox:torrent:1', 'torbox:torrent:1:0:extra',
      'http:torrent:1:0', 'torbox:magnet:1:0', 'torbox:TORRENT:1:0',
      'torbox:torrent:-1:0', 'torbox:torrent:01:0', 'torbox:torrent:1.0:0', 'torbox:torrent:1e3:0',
      'torbox:torrent::0', 'torbox:torrent:1:', 'torbox:torrent:1:-0',
      `torbox:torrent:${'9'.repeat(30)}:0`, `torbox:torrent:1:0${' '.repeat(200)}`,
    ];
    for (const raw of hostile) {
      let error: unknown;
      try { parseStableRef(raw); } catch (caught) { error = caught; }
      assert(error instanceof TorBoxRefError, `the parser accepted ${JSON.stringify(raw)}`);
      const message = (error as Error).message;
      assert(!message.includes(raw) || raw === '',
        `the failure quoted the reference back: ${message.slice(0, 60)}`);
      assert(findSecretShapes(message, 'msg').length === 0, 'and it must carry no secret shape');
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // Response handling — fail closed on anything ambiguous
  // -------------------------------------------------------------------------------------------------------

  await test('A WELL-FORMED SUCCESS YIELDS A BOUNDED, SHORTER-THAN-DOCUMENTED EXPIRY', () => {
    const now = 1_000_000;
    const resolved = parseResolveBody(
      { success: true, detail: 'Got download link', error: null, data: 'https://cdn.invalid/a?sig=b' }, now);
    assert(resolved.url === 'https://cdn.invalid/a?sig=b', 'the URL is carried through');
    assert(resolved.expiresAtUnixMs === now + TORBOX_ASSUMED_LIFETIME_MS, 'the expiry is the assumed one');
    // TorBox documents three hours and returns no expiry field. Treating a link as good for the full window
    // means the first read after 2h59m races the expiry, and the failure is a stall rather than a refresh.
    assert(TORBOX_ASSUMED_LIFETIME_MS < TORBOX_LINK_LIFETIME_MS,
      'the assumed lifetime must be strictly shorter than the documented one');
  });

  await test('EVERY AMBIGUOUS PROVIDER BODY IS REFUSED RATHER THAN GUESSED', () => {
    // TorBox marks all four response fields optional, so a body can be valid JSON, arrive with HTTP 200 and
    // still say nothing usable. Every guess here would hand the data plane something that is not a URL.
    const bodies: [unknown, string][] = [
      [null, 'null'],
      ['a string', 'a bare string'],
      [[], 'an array'],
      [{}, 'an empty object'],
      [{ data: 'https://cdn.invalid/a' }, 'a link with no success flag'],
      [{ success: false, data: 'https://cdn.invalid/a' }, 'a link with success false'],
      [{ success: 'true', data: 'https://cdn.invalid/a' }, 'a stringy success'],
      [{ success: true }, 'success with no data'],
      [{ success: true, data: '' }, 'success with an empty link'],
      [{ success: true, data: 42 }, 'success with a numeric link'],
      [{ success: true, data: 'not-a-url' }, 'success with a non-URL'],
      [{ success: true, data: 'http://cdn.invalid/a' }, 'a plaintext link'],
      [{ success: true, data: 'ftp://cdn.invalid/a' }, 'a non-http scheme'],
    ];
    for (const [body, what] of bodies) {
      let threw = false;
      try { parseResolveBody(body, 0); } catch (error) {
        threw = error instanceof TorBoxResolveError;
        assert(findSecretShapes((error as Error).message, 'msg').length === 0,
          `the refusal of ${what} carried a secret shape`);
      }
      assert(threw, `${what} was accepted`);
    }
  });

  await test('THE PROVIDER’S OWN detail AND error STRINGS ARE NEVER REPEATED OUTWARD', () => {
    // Those fields routinely carry the item name, and on some errors the request URL.
    let message = '';
    try {
      parseResolveBody({
        success: false,
        detail: 'failed for https://api.torbox.app/v1/api/torrents/requestdl?token=SECRET&torrent_id=9',
        error: 'The Godfather (1972).mkv',
      }, 0);
    } catch (error) { message = (error as Error).message; }
    assert(message !== '', 'it must refuse');
    assert(findSecretShapes(message, 'msg').length === 0,
      `the refusal repeated the provider's message: ${message.slice(0, 80)}`);
    assert(!message.includes('Godfather'), 'and it must not carry a filename');
  });

  await test('STATUS CLASSIFICATION MAKES AUTH TERMINAL AND 429 RETRYABLE', () => {
    assert(classifyStatus(200) === 'ok', '200');
    for (const status of [401, 403]) {
      // Terminal HERE on purpose: the one-refresh-per-read rule lives above this. Retrying an auth failure
      // inside the resolver would spend the operator's rate limit rediscovering the same answer.
      assert(classifyStatus(status) === 'auth', `${status} is an auth failure, not a retry`);
    }
    for (const status of [404, 410]) assert(classifyStatus(status) === 'unknown-ref', `${status}`);
    for (const status of [408, 429, 500, 502, 503, 504]) {
      assert(classifyStatus(status) === 'retryable', `${status} must be retryable`);
    }
    for (const status of [301, 302, 307, 400, 405, 418]) {
      assert(classifyStatus(status) === 'terminal', `${status} must be terminal`);
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // Credential handling
  // -------------------------------------------------------------------------------------------------------

  await test('A CREDENTIAL FILE IS REFUSED UNLESS IT IS PRIVATE, PRESENT AND PLAUSIBLE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torbox-cred-'));
    const path = join(dir, 'credential');

    let threw = false;
    try { readSecretFile(path, 'x'); } catch { threw = true; }
    assert(threw, 'a missing credential file was accepted');

    writeFileSync(path, '');
    threw = false;
    try { readSecretFile(path, 'x'); } catch { threw = true; }
    assert(threw, 'an empty credential file was accepted');

    writeFileSync(path, '   \n  ');
    threw = false;
    try { readSecretFile(path, 'x'); } catch { threw = true; }
    assert(threw, 'a whitespace-only credential file was accepted');

    writeFileSync(path, 'x'.repeat(9_000));
    threw = false;
    try { readSecretFile(path, 'x'); } catch { threw = true; }
    assert(threw, 'an oversized credential file was accepted');

    writeFileSync(path, TOKEN);
    if (process.platform !== 'win32') {
      for (const mode of [0o644, 0o640, 0o604, 0o666, 0o777]) {
        chmodSync(path, mode);
        threw = false;
        try { readSecretFile(path, 'x'); } catch { threw = true; }
        assert(threw, `a credential file at mode ${mode.toString(8)} was accepted`);
      }
      chmodSync(path, 0o600);
    }
    assert(readSecretFile(path, 'x') === TOKEN, 'and a private, plausible file is read');
  });

  // -------------------------------------------------------------------------------------------------------
  // THE WHOLE PATH: a real resolver service, a real fixture, driven the way the daemon drives it
  // -------------------------------------------------------------------------------------------------------

  await test('ALL THREE SOURCE KINDS RESOLVE END TO END THROUGH THE REAL SERVICE', async () => {
    // This is the test that would notice the adapter never being invoked. It stands up the fixture and the
    // service and drives the service over HTTP with the daemon's own request shape.
    const h = await harness();
    try {
      for (const ref of [REF_TORRENT, REF_WEBDL, REF_USENET]) {
        const answer = await askResolver(h.resolverUrl, ref);
        assert(answer.status === 200, `${ref} did not resolve: ${answer.status}`);
        assert(typeof answer.body.url === 'string' && answer.body.url.includes('/cdn/'),
          `${ref} did not yield a CDN link`);
        // THE THREE FIELDS THE DAEMON DECODES, and nothing else is required of the response.
        assert(typeof answer.body.expiresAtUnixMs === 'number' && answer.body.expiresAtUnixMs > Date.now(),
          'the expiry must be in the future');
        assert(JSON.stringify(answer.body.headers) === '{}',
          'no headers: a TorBox CDN link is pre-signed, and attaching the API key would hand the '
          + 'operator account credential to whatever host the link names');
      }
      assert(h.fixture.counters.resolveRequests === 3, 'the fixture saw exactly three resolutions');
      assert(h.fixture.counters.badTokenRequests === 0, 'and the credential was accepted every time');
    } finally { await h.close(); }
  });

  await test('THE RESOLVED LINK ACTUALLY SERVES THE RIGHT BYTES BY RANGE, BACKWARD AND AT THE TAIL', async () => {
    // A resolver that returned a syntactically valid URL to nothing would pass every test above.
    const h = await harness();
    try {
      const answer = await askResolver(h.resolverUrl, REF_TORRENT);
      const link = answer.body.url as string;

      // The tail, past 90% — where a container index lives and where a stream-from-zero implementation fails.
      const tailOffset = Math.floor(SIZE * 0.91);
      const tail = await fetch(link, { headers: { Range: `bytes=${tailOffset}-${tailOffset + 4095}` } });
      assert(tail.status === 206, `a ranged GET must be answered 206, got ${tail.status}`);
      assert(tail.headers.get('content-range') === `bytes ${tailOffset}-${tailOffset + 4095}/${SIZE}`,
        'with an exact Content-Range naming the right total');
      const tailBytes = Buffer.from(await tail.arrayBuffer());
      assert(tailBytes.equals(objectBytes(REF_TORRENT, tailOffset, 4096)), 'and the right bytes');

      // Then BACKWARD, to a lower offset than one already read.
      const back = await fetch(link, { headers: { Range: 'bytes=0-4095' } });
      assert(back.status === 206, 'a backward ranged read must also be 206');
      const backBytes = Buffer.from(await back.arrayBuffer());
      assert(backBytes.equals(objectBytes(REF_TORRENT, 0, 4096)), 'and carry the right bytes');
      assert(!backBytes.equals(tailBytes), 'and the two windows must differ, or the fixture is not real');
    } finally { await h.close(); }
  });

  await test('AN EXPIRED LINK IS RECOVERED BY EXACTLY ONE FRESH RESOLUTION', async () => {
    // The data plane's rule is at most one refresh per read. What is proved here is the half this adapter
    // owns: a second resolution of the same reference yields a DIFFERENT, working link, so a refresh is
    // capable of recovering. `projectiond/internal/source/http_test.go` owns the once-and-only-once half.
    const h = await harness();
    try {
      const first = (await askResolver(h.resolverUrl, REF_TORRENT)).body.url as string;
      h.fixture.expireAllLinks();
      const stale = await fetch(first, { headers: { Range: 'bytes=0-15' } });
      assert(stale.status === 401, `an expired link must answer 401, got ${stale.status}`);

      const second = (await askResolver(h.resolverUrl, REF_TORRENT)).body.url as string;
      assert(second !== first, 'a refresh must mint a new link, not return the dead one');
      const fresh = await fetch(second, { headers: { Range: 'bytes=0-15' } });
      assert(fresh.status === 206, 'and the new link must work');
      assert(h.fixture.counters.resolveRequests === 2, 'at the cost of exactly one extra resolution');
    } finally { await h.close(); }
  });

  await test('A WRONG CREDENTIAL IS REFUSED BY THE PROVIDER AND NEVER RETRIED', async () => {
    const h = await harness({ token: 'the-wrong-key' });
    try {
      const answer = await askResolver(h.resolverUrl, REF_TORRENT);
      assert(answer.status === 403, `expected a terminal refusal, got ${answer.status}`);
      // NOT RETRIED. A rotated key gives the same answer however many times it is asked, and each ask spends
      // the operator's rate limit.
      assert(h.fixture.counters.badTokenRequests === 1,
        `the resolver retried an auth failure ${h.fixture.counters.badTokenRequests} times`);
    } finally { await h.close(); }
  });

  await test('THE GATE SECRET IS REQUIRED, AND A WRONG ONE REACHES NO PROVIDER', async () => {
    const h = await harness();
    try {
      for (const bearer of ['', 'wrong', `${GATE}x`, GATE.slice(0, -1)]) {
        const answer = await askResolver(h.resolverUrl, REF_TORRENT, bearer);
        assert(answer.status === 401, `a bad gate secret was accepted (${answer.status})`);
      }
      assert(h.fixture.counters.resolveRequests === 0,
        'a request that failed the gate must never reach the provider');
    } finally { await h.close(); }
  });

  await test('A MALFORMED REFERENCE IS REFUSED WITHOUT CONTACTING THE PROVIDER', async () => {
    const h = await harness();
    try {
      for (const ref of ['', 'torbox:torrent:1', 'not-a-ref', 'torbox:magnet:1:0']) {
        const answer = await askResolver(h.resolverUrl, ref);
        assert(answer.status === 400, `${JSON.stringify(ref)} was not refused (${answer.status})`);
      }
      assert(h.fixture.counters.resolveRequests === 0,
        'a malformed reference must cost the provider nothing');
    } finally { await h.close(); }
  });

  // -------------------------------------------------------------------------------------------------------
  // Every provider misbehaviour, injected into a real listener
  // -------------------------------------------------------------------------------------------------------

  const resolverFaults: [TorBoxFault, string][] = [
    ['resolver-not-json', 'a truncated body'],
    ['resolver-success-false', 'success false under HTTP 200'],
    ['resolver-no-data', 'success with no link'],
    ['resolver-data-not-url', 'a link that is not a URL'],
    ['resolver-401', 'an unauthorized status'],
    ['resolver-403', 'a forbidden status'],
    ['resolver-404', 'an unknown item'],
    ['resolver-redirect', 'a redirect'],
  ];

  for (const [fault, what] of resolverFaults) {
    await test(`THE RESOLVER FAILS CLOSED ON ${what.toUpperCase()}`, async () => {
      const h = await harness();
      try {
        h.fixture.setFault(fault, 5);
        const answer = await askResolver(h.resolverUrl, REF_TORRENT);
        assert(answer.status !== 200, `${what} produced a 200`);
        assert(answer.body.url === undefined, `${what} produced a URL`);
        const rendered = JSON.stringify(answer.body);
        assert(findSecretShapes(rendered, 'response').length === 0,
          `${what} leaked something into the response: ${rendered.slice(0, 80)}`);
      } finally { await h.close(); }
    });
  }

  await test('A PLAINTEXT LINK IS REFUSED WHEN THE FIXTURE EXEMPTION IS NOT ASKED FOR', async () => {
    // THE EXEMPTION IS THE MOST DANGEROUS LINE IN THIS ADAPTER. The fixture serves plaintext on loopback, so
    // an exemption has to exist; if it could be acquired by accident, a real deployment would accept a CDN
    // link that carries the operator's entitlement in the clear. So this runs a service configured EXACTLY
    // like a production one — by saying nothing about plaintext — and requires the refusal.
    const h = await harness({ allowPlaintextLink: false });
    try {
      h.fixture.setFault('resolver-data-plaintext', 5);
      const answer = await askResolver(h.resolverUrl, REF_TORRENT);
      assert(answer.status !== 200, `a plaintext link was accepted (${answer.status})`);
      assert(answer.body.url === undefined, 'and a URL was handed back');
    } finally { await h.close(); }
  });

  await test('THE MODULE ITSELF DEFAULTS TO REFUSING PLAINTEXT, WITH NO ARGUMENT AT ALL', () => {
    // Below the service, at the function every path funnels through: called with two arguments, the way a
    // caller who has never heard of the exemption calls it.
    let threw = false;
    try { parseResolveBody({ success: true, data: 'http://cdn.invalid/a' }, 0); } catch { threw = true; }
    assert(threw, 'parseResolveBody accepted a plaintext link by default');
    // Explicitly false must behave the same as omitted.
    threw = false;
    try { parseResolveBody({ success: true, data: 'http://cdn.invalid/a' }, 0, false); } catch { threw = true; }
    assert(threw, 'an explicit false did not refuse');
    // And the exemption must not widen to anything but http.
    for (const scheme of ['ftp', 'file', 'data', 'gopher']) {
      threw = false;
      try { parseResolveBody({ success: true, data: `${scheme}://x/a` }, 0, true); } catch { threw = true; }
      assert(threw, `the exemption admitted ${scheme}:`);
    }
    // https is accepted in both modes, because that is the real contract.
    assert(parseResolveBody({ success: true, data: 'https://cdn.invalid/a' }, 0).url === 'https://cdn.invalid/a',
      'https must be accepted with no exemption');
  });

  await test('THE EXEMPTION IS SET IN EXACTLY ONE PLACE IN SHIPPED CODE, AND IT IS OPT-IN', () => {
    const cli = repoFile('src/ops/torbox-resolver-cli.ts');
    const service = repoFile('src/ops/torbox-resolver-service.ts');
    // IT IS NOW STRICTER THAN A SINGLE FLAG: the relaxation requires --fixture-mode AS WELL, so a
    // deployment cannot acquire it without the word fixture appearing on its command line.
    assert(/allowPlaintextLink: fixtureMode && argv\.includes\('--fixture-plaintext-link'\)/.test(cli),
      'the CLI must require BOTH the fixture-mode switch and the explicit flag');
    assert(/--api-origin-file is FIXTURE-ONLY/.test(cli),
      'and the API origin override must fail closed outside fixture mode');
    assert(/config\.allowPlaintextLink === true/.test(service),
      'and the service must require an exact true rather than any truthy value');
    assert(!/allowPlaintextLink:\s*true/.test(cli) && !/allowPlaintextLink:\s*true/.test(service),
      'no shipped file may hard-code the exemption on');
  });

  await test('A RETRYABLE STATUS IS RETRIED, BOUNDED, AND THEN GIVES UP', async () => {
    // 429 is the one the backoff exists for: TorBox meters this endpoint, and an unbounded retry against a
    // rate limit is how a correctness gate becomes a denial of service on the operator's own account.
    const h = await harness();
    try {
      h.fixture.setFault('resolver-429', 99);
      const started = Date.now();
      const answer = await askResolver(h.resolverUrl, REF_TORRENT);
      assert(answer.status === 502, `expected a bounded give-up, got ${answer.status}`);
      assert(h.fixture.counters.resolveRequests === 3,
        `expected exactly 3 attempts, saw ${h.fixture.counters.resolveRequests}`);
      assert(Date.now() - started < 10_000, 'and the whole thing stayed inside a finite budget');
      assert(h.fixture.counters.status429 === 3, 'with every 429 recorded');
    } finally { await h.close(); }
  });

  await test('A RETRYABLE STATUS THAT CLEARS IS RECOVERED WITHIN THE BOUND', async () => {
    const h = await harness();
    try {
      h.fixture.setFault('resolver-429', 1);
      const answer = await askResolver(h.resolverUrl, REF_TORRENT);
      assert(answer.status === 200, `a transient 429 should have been ridden out, got ${answer.status}`);
      assert(h.fixture.counters.resolveRequests === 2, 'in exactly two attempts');
    } finally { await h.close(); }
  });

  await test('A HANGING PROVIDER HITS A FINITE DEADLINE RATHER THAN HANGING THE READER', async () => {
    const h = await harness();
    try {
      h.fixture.setFault('resolver-timeout', 99);
      const started = Date.now();
      const answer = await askResolver(h.resolverUrl, REF_TORRENT);
      assert(answer.status !== 200, 'a hanging provider must not produce a link');
      // Three attempts at a 2s timeout plus backoff; generous, but finite is the point.
      assert(Date.now() - started < 20_000, 'and the deadline must actually fire');
    } finally { await h.close(); }
  });

  await test('A LINK POINTING AT AN ORIGIN THE OPERATOR NEVER AUTHORISED IS NEVER DIALLED', async () => {
    // The resolver hands the URL back and the DAEMON checks it against the egress allowlist and re-checks
    // every address at dial time. What is proved here is the half this service owns: it does not itself
    // fetch the link, so a hostile origin is never contacted by this process.
    const h = await harness();
    try {
      h.fixture.setFault('resolver-wrong-origin', 1);
      const answer = await askResolver(h.resolverUrl, REF_TORRENT);
      // It may be handed back — the daemon is the authority on the allowlist — but nothing dialled it.
      assert(h.fixture.counters.disallowedOriginRequests === 0,
        'the resolver dialled the origin it was handed');
      if (answer.status === 200) {
        assert(!(answer.body.url ?? '').includes('api.torbox.app'),
          'and the link is the one the provider named, unmodified, for the daemon to judge');
      }
    } finally { await h.close(); }
  });

  // -------------------------------------------------------------------------------------------------------
  // CDN-side protocol discipline, observed through a real client
  // -------------------------------------------------------------------------------------------------------

  await test('THE FIXTURE CAN PRODUCE EVERY CDN PROTOCOL VIOLATION THE DATA PLANE MUST REFUSE', async () => {
    // The daemon's refusal of each of these is proved in Go (`source/http_test.go`). What is proved here is
    // that the fixture can actually MAKE each one happen, so those refusals are exercisable end to end
    // rather than only against a hand-built response.
    const h = await harness();
    try {
      const cases: [TorBoxFault, (r: Response, body: Buffer) => boolean, string][] = [
        ['cdn-full-body-on-range', (r) => r.status === 200, 'a 200 full body answering a ranged GET'],
        ['cdn-malformed-content-range',
          (r) => !/^bytes \d+-\d+\/\d+$/.test(r.headers.get('content-range') ?? ''), 'a malformed range'],
        ['cdn-mismatched-content-range',
          (r) => (r.headers.get('content-range') ?? '').startsWith('bytes 7-'), 'a mismatched range'],
        ['cdn-wrong-total',
          (r) => (r.headers.get('content-range') ?? '').endsWith(`/${SIZE + 1}`), 'a wrong total'],
        ['cdn-short-body', (_r, b) => b.length < 4096, 'a short body'],
        ['cdn-long-body', (_r, b) => b.length > 4096, 'a long body'],
        ['cdn-401', (r) => r.status === 401, 'an expired link'],
        ['cdn-429', (r) => r.status === 429, 'a rate limit'],
        ['cdn-redirect', (r) => r.status === 302 || r.redirected, 'a redirect'],
      ];
      for (const [fault, check, what] of cases) {
        const link = (await askResolver(h.resolverUrl, REF_TORRENT)).body.url as string;
        h.fixture.setFault(fault, 1);
        const response = await fetch(link, {
          headers: { Range: 'bytes=0-4095' }, redirect: 'manual',
        });
        const body = Buffer.from(await response.arrayBuffer());
        assert(check(response, body), `the fixture could not produce ${what}`);
      }
    } finally { await h.close(); }
  });

  await test('THE FIXTURE’S BYTES ARE DETERMINISTIC AND CONTENT-ADDRESSED', () => {
    // Two runs of the gate must compare the same digests, and two different objects must not collide.
    const a = objectBytes(REF_TORRENT, 0, 8192);
    const b = objectBytes(REF_TORRENT, 0, 8192);
    assert(a.equals(b), 'the same window must produce the same bytes');
    assert(!objectBytes(REF_WEBDL, 0, 8192).equals(a), 'two objects must not share bytes');
    assert(!objectBytes(REF_TORRENT, 8192, 8192).equals(a), 'two windows must not share bytes');
    // A window read whole and in two halves must agree, or every offset assertion is meaningless.
    const whole = objectBytes(REF_TORRENT, 100, 9000);
    const split = Buffer.concat([objectBytes(REF_TORRENT, 100, 4000), objectBytes(REF_TORRENT, 4100, 5000)]);
    assert(whole.equals(split), 'the byte function must be offset-consistent across block boundaries');
    assert(createHash('sha256').update(whole).digest('hex').length === 64, 'and digestible');
  });

  // -------------------------------------------------------------------------------------------------------
  // Redaction, which is what makes this adapter safe to run at all
  // -------------------------------------------------------------------------------------------------------

  await test('THE SCRUBBER RECOGNISES EVERY SHAPE THIS ADAPTER CAN LEAK', () => {
    for (const text of [
      'https://api.torbox.app/v1/api/torrents/requestdl?token=abc&torrent_id=1&file_id=0',
      'http://cdn.torbox.app/x',
      'token=deadbeef',
      'torbox:torrent:1234:0',
      'torbox:usenet:9:1',
      'Bearer abc123',
      'torrent_id=1234',
      'web_id=99',
      'usenet_id=7',
      'file_id=3',
    ]) {
      assert(findSecretShapes(text, 'x').length > 0, `the scrubber let through: ${text.slice(0, 40)}`);
    }
    // ...and it does not flag what a report legitimately says.
    for (const text of ['resolved a torrent reference in 1 attempt(s)', 'the provider answered 429',
      'object-1', 'torrent', '206', 'bytes 0-4095/4194304']) {
      assert(findSecretShapes(text, 'x').length === 0, `the scrubber flagged legitimate text: ${text}`);
    }
  });

  await test('A THROWN PROVIDER ERROR CARRYING A URL IS REPLACED WHOLESALE, NOT SCRUBBED IN PLACE', () => {
    // One unguarded `catch (e) { log(e.message) }` above this boundary would publish the operator's API key,
    // because a fetch failure's message routinely carries the URL it could not reach.
    const leaky = new Error('connect ECONNREFUSED https://api.torbox.app/v1/api/torrents/requestdl?token=SEC');
    const safe = redactError(leaky);
    assert(!safe.includes('token='), 'the redaction left the token in');
    assert(!safe.includes('api.torbox.app'), 'and the host');
    assert(findSecretShapes(safe, 'x').length === 0, 'and the result is clean');
    // A partial scrub of an unknown format is a guess, so the whole message goes.
    assert(/withheld/.test(safe), 'and it says the message was withheld rather than pretending to be one');
    assert(redactError(new Error('the provider answered 429')) === 'the provider answered 429',
      'while a clean message passes through unchanged');
  });

  await test('NOTHING THE SERVICE LOGS OR RETURNS CARRIES A REFERENCE, A TOKEN OR A REQUEST URL', async () => {
    const h = await harness();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      await askResolver(h.resolverUrl, REF_TORRENT);
      await askResolver(h.resolverUrl, 'torbox:torrent:1:1');
      await askResolver(h.resolverUrl, 'malformed', 'wrong');
      h.fixture.setFault('resolver-403', 2);
      await askResolver(h.resolverUrl, REF_WEBDL);
    } finally {
      console.log = originalLog;
      await h.close();
    }
    assert(lines.length > 0, 'the service logged nothing at all, so this proves nothing');
    for (const line of lines) {
      assert(findSecretShapes(line, 'log').length === 0, `a log line leaked: ${line.slice(0, 90)}`);
      assert(!line.includes(TOKEN), 'a log line carried the credential');
      assert(!line.includes('1234'), 'a log line carried a provider identifier');
    }
    // It must still say something useful, or "we log nothing" is a way to pass this test trivially.
    assert(lines.some((line) => /torrent|webdl|usenet/.test(line)),
      'the service must still record which kind of reference it handled');
  });

  await test('THE SHIPPED CODE NEVER PUTS A SECRET ON A COMMAND LINE', () => {
    for (const file of ['src/ops/torbox-resolver-cli.ts', 'src/ops/torbox-resolver-service.ts',
      'src/ops/torbox-fixture-cli.ts']) {
      const text = repoFile(file);
      assert(!/--token[= ]["$]?[A-Za-z0-9]/.test(text), `${file} passes a token on the command line`);
      assert(!/--api-key/.test(text), `${file} accepts an inline API key`);
    }
    assert(repoFile('src/ops/torbox-resolver-cli.ts').includes('findSecretShapes'),
      'the CLI checks its own argv before doing anything');
  });

  // -------------------------------------------------------------------------------------------------------
  // What this adapter must never become
  // -------------------------------------------------------------------------------------------------------

  await test('THE ADAPTER IS GET-ONLY AND TOUCHES NO MUTATING TORBOX ENDPOINT', () => {
    // COMMENTS ARE STRIPPED FIRST, AND THAT IS NOT A WEAKENING. An earlier version of this test failed on
    // the core module's own header, which QUOTES Phase 41 saying these endpoints "can expose CDN/permalink
    // URLs" — the exact sentence that should be there. What must be absent is a path the code CONSTRUCTS.
    const stripComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    const service = stripComments(repoFile('src/ops/torbox-resolver-service.ts'));
    const core = stripComments(repoFile('src/core/adapters/torbox-resolver.ts'));
    for (const [name, text] of [['the service', service], ['the core', core]] as const) {
      assert(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(text.replace(/method: 'GET'/g, '')),
        `${name} issues a mutating request to the provider`);
      // PATHS, NOT PROSE. An earlier version of this test grepped for the word "permalink" and failed on a
      // COMMENT saying the adapter never requests one -- which is exactly the sentence that should be there.
      // What must be absent is a URL PATH, so that is what is matched.
      for (const forbidden of ['/createtorrent', '/controltorrent', '/deletetorrent', '/createdownload',
        '/requestpermalink', '/permalink', 'usenet/create', 'webdl/create', '/user/data', '/torrents/create']) {
        assert(!text.toLowerCase().includes(forbidden),
          `${name} names a mutating or out-of-scope endpoint path: ${forbidden}`);
      }
    }
    // Only the three requestdl paths, and nothing else, are ever built.
    const paths = Object.values(TORBOX_REQUESTDL).map((entry) => entry.path);
    assert(paths.length === 3 && paths.every((path) => path.endsWith('/requestdl')),
      'the adapter reaches endpoints other than requestdl');
  });

  await test('THE PHASE 33 SMOKE CLIENT IS NOT UNGATED BY THIS PHASE', () => {
    // The tempting move was to widen TORBOX_REAL_CLIENT_ALLOWED_OPERATIONS so one gate covered everything.
    // That would relax a contract several hundred existing assertions depend on, to give the smoke client a
    // capability it has no use for. The resolver is its own surface instead, and this pins the boundary --
    // if a later change quietly ungates the smoke client, this fails.
    const gate = repoFile('src/core/adapters/torbox-real-client-gate.ts');
    const allowed = /TORBOX_REAL_CLIENT_ALLOWED_OPERATIONS = \[([\s\S]*?)\]/.exec(gate)?.[1] ?? '';
    assert(allowed !== '', 'the allowed-operation list must still exist');
    assert(!allowed.includes('request-download-link'),
      'request-download-link has been added to the smoke client allow list; this phase does not do that');
    const futureGated = /TORBOX_REAL_CLIENT_FUTURE_GATED_OPERATIONS = \[([\s\S]*?)\]/.exec(gate)?.[1] ?? '';
    assert(futureGated.includes('request-download-link'),
      'request-download-link must remain future-gated for the smoke client');
    // And the smoke transport still reaches only the cache/status surface.
    const transport = repoFile('src/ops/torbox-live-transport.ts');
    assert(!transport.includes('requestdl'), 'the Phase 42 smoke transport must not learn requestdl');
  });

  await test('THE DOCUMENTATION RECORDS THE OFFICIAL CONTRACT AND ITS SOURCES', () => {
    const doc = repoFile('docs/PHASE_50_TORBOX_RESOLVER.md');
    for (const needle of ['/v1/api/torrents/requestdl', '/v1/api/webdl/requestdl',
      '/v1/api/usenet/requestdl', 'torrent_id', 'web_id', 'usenet_id', 'file_id']) {
      assert(doc.includes(needle), `the phase document does not record ${needle}`);
    }
    assert(/github\.com\/TorBox-App/.test(doc), 'and it cites the official SDK it was taken from');
    // PHASE 41 FUTURE-GATED THIS FAMILY. The document that unblocks it must say so, or the two disagree.
    assert(/PHASE_41/.test(doc), 'and it names the phase that future-gated these endpoints');
  });

  // -------------------------------------------------------------------------------------------------------
  // The mount gate's own shape
  // -------------------------------------------------------------------------------------------------------

  await test('THE MOUNT GATE PROVES THE RESOLVER IS IN THE READ PATH, NOT MERELY THAT READS SUCCEEDED', () => {
    const gate = repoFile('deploy/projection-torbox-mount-gate.sh');
    // A gate that only checked bytes would pass against a daemon that never called the resolver -- if the
    // bytes came from anywhere else. The resolution COUNT is what makes the claim falsifiable.
    assert(/control\/counters/.test(gate), 'the gate must read the fixture own resolution counter');
    assert(/the resolver was not in the path/.test(gate),
      'and must fail with that reason when nothing resolved');
    assert(/control\/expire-links/.test(gate), 'and it must expire every link');
    assert(/reads did not recover after expiry/.test(gate), 'and require the reads to recover');
    assert(/AFTER_REFRESH" -gt "\$BEFORE_REFRESH/.test(gate),
      'and require the recovery to have cost a real re-resolution');
  });

  await test('THE MOUNT GATE READS BACKWARD AND PAST 90%, AND REQUIRES THE WINDOWS TO DIFFER', () => {
    const gate = repoFile('deploy/projection-torbox-mount-gate.sh');
    assert(/0\.91/.test(gate), 'a tail read past 90% of the object');
    assert(/backward/.test(gate), 'and a backward read');
    // Without this, a mount serving one buffer for every offset would satisfy both.
    assert(/distinct-windows/.test(gate), 'and the two windows must be required to differ');
  });

  await test('THE MOUNT GATE USES TWO DIFFERENT SECRETS AND PROVES THEY DIFFER', () => {
    const gate = repoFile('deploy/projection-torbox-mount-gate.sh');
    assert(/torbox-credential/.test(gate) && /gate-secret/.test(gate), 'two secret files');
    assert(/the two secrets are identical/.test(gate),
      'and the gate must fail if they are the same, which would defeat the split it exists to prove');
    assert(/chmod 600/.test(gate), 'both at mode 0600');
  });

  await test('THE MOUNT GATE KEEPS THE RESOLVER LOOPBACK-ONLY', () => {
    const gate = repoFile('deploy/projection-torbox-mount-gate.sh');
    assert(/--network "container:\$MOUNT_CONTAINER"/.test(gate),
      'the resolver must join the daemon network namespace rather than being published');
    assert(!/-p .*\$\{RESOLVER_PORT\}/.test(gate), 'and its port must never be published to the host');
  });

  await test('THE MOUNT GATE SEARCHES FOR BOTH SECRETS IN FILES AND IN CONTAINER LOGS', () => {
    const gate = repoFile('deploy/projection-torbox-mount-gate.sh');
    assert(/CRED_HITS/.test(gate) && /GATE_HITS/.test(gate), 'both secrets are searched for');
    assert(/docker logs "\$container"/.test(gate),
      'and container logs are searched too, because that is where a URL is most likely to surface');
    assert(/the resolver logged a stable reference/.test(gate), 'and a leaked reference fails the gate');
  });

  await test('THE MOUNT GATE IS OFFLINE AND SAYS SO, AND IS NOT THE REAL RUN', () => {
    const gate = repoFile('deploy/projection-torbox-mount-gate.sh');
    assert(/CLOSES NOTHING ABOUT ANY REAL PROVIDER/.test(gate),
      'the gate must refuse to be read as a real-provider pass');
    assert(/SKIPS with 77/.test(gate), 'and must point at the real run');
    assert(/GATE_SKIP_STATUS=77/.test(gate), 'and skip rather than pass where it cannot run');
    // THE FIXTURE EXEMPTIONS ARE HERE AND MUST BE NOWHERE ELSE.
    assert(/--fixture-plaintext-link/.test(gate), 'the plaintext exemption is opt-in, here');
    const realGate = repoFile('deploy/projection-real-provider-gate.sh');
    assert(!/fixture-plaintext-link/.test(realGate),
      'and the REAL gate must never set it');
  });

  // -------------------------------------------------------------------------------------------------------
  // The REAL gate: the topology, the narrow authority, and the fixture switches it must never set
  // -------------------------------------------------------------------------------------------------------

  await test('THE REAL GATE PUTS THE RESOLVER IN THE DAEMON NETWORK NAMESPACE, NOT ON A HOST PORT', () => {
    // THE DEFECT THIS CLOSES. The documented procedure started the resolver on the Unraid HOST at
    // 127.0.0.1:8140 and then started projectiond in a bridge network -- where 127.0.0.1 is the CONTAINER.
    // The daemon would have dialled its own loopback and found nothing. This test fails against that
    // arrangement and against any attempt to "fix" it by publishing the resolver to a host port.
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');
    assert(/--network \"container:\$MOUNT_CONTAINER\"/.test(gate),
      'the resolver must join the daemon network namespace');
    // NO `-p ...RESOLVER_PORT` ANYWHERE. Publishing it would make the resolver reachable from the network,
    // and anything that can reach it can mint CDN links for the operator's account.
    assert(!gate.split('\n').some((line) => /^\s*-p\s/.test(line) && line.includes('RESOLVER_PORT')),
      'the resolver port must never be published to the host: a reachable resolver is a credential oracle');
    // And the daemon must be confirmed running first, or the join fails with a message about a consequence.
    assert(gate.indexOf('daemon_up') < gate.indexOf('--network \"container:'),
      'the daemon must be confirmed running before anything joins its namespace');
    // The arrangement is asserted at run time, not merely configured.
    assert(/it must be loopback-only/.test(gate),
      'the gate must PROVE the resolver is unreachable from the gate network');
  });

  await test('THE REAL GATE USES THE NARROW LOOPBACK AUTHORITY AND NEVER THE BROAD PRIVATE-ADDRESS SWITCH', () => {
    // THE SECOND DEFECT. Reaching a loopback resolver used to require allowPrivateAddresses -- a switch its
    // own documentation calls test-only, which also authorises every RFC1918 destination and would widen
    // CDN egress across the operator's whole private network.
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');
    assert(/loopbackResolver: true/.test(gate), 'the narrow authority is what a real run sets');
    assert(/allowPrivateAddresses: false/.test(gate), 'and the broad one stays off');
    assert(/allowInsecureHttp: false/.test(gate), 'as does the plaintext switch');
  });

  await test('THE REAL GATE NEVER PASSES A FIXTURE FLAG, AND THE OFFLINE ONE ALWAYS DOES', () => {
    // COMMENTS STRIPPED FIRST: the real gate's own comment explains that it passes no fixture flag, and
    // that sentence is exactly the one that should be there. What must be absent is an ARGUMENT.
    const strip = (text: string): string =>
      text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    const real = strip(repoFile('deploy/projection-torbox-real-gate.sh'));
    const offline = repoFile('deploy/projection-torbox-mount-gate.sh');
    assert(!/--fixture-mode/.test(real), 'the real gate must never enter fixture mode');
    assert(!/--fixture-plaintext-link/.test(real), 'nor relax the plaintext rule');
    assert(!/--api-origin-file/.test(real),
      'nor override the API origin: a real resolver is pinned to the official TorBox origin');
    assert(/--fixture-mode --fixture-plaintext-link/.test(offline),
      'and the offline gate must ask for both together');
  });

  await test('THE REAL GATE SKIPS WITH 77 BEFORE ANY BUILD, DATABASE OR PACKET', () => {
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');
    const skip = gate.indexOf('exit "$GATE_SKIP_STATUS"');
    assert(skip !== -1, 'the gate skips');
    for (const [what, needle] of [
      ['an image build', 'docker build'],
      ['a database', 'docker compose -f "$COMPOSE_FILE" up'],
      ['a network', 'docker network create'],
    ] as const) {
      assert(gate.indexOf(needle) > skip, `the skip must come before ${what}`);
    }
    assert(/NOTHING WAS CONTACTED/.test(gate), 'and say so');
    assert(/It is not a pass and must not be reported as one/.test(gate),
      'and refuse to be read as a pass');
  });

  await test('THE REAL GATE GIVES THE DAEMON THE GATE SECRET AND NEVER THE TORBOX KEY', () => {
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');
    // A SEPARATE DIRECTORY, so the key is not merely unreferenced in the daemon container -- it is absent.
    assert(/daemon-inputs/.test(gate), 'the daemon gets its own inputs directory');
    assert(/install -m 600 "\$WORK\/inputs\/gate-secret" "\$WORK\/daemon-inputs\/gate-secret"/.test(gate),
      'containing only the gate secret');
    assert(/the TorBox credential is present inside the daemon container/.test(gate),
      'and the gate must FAIL if the key ever appears there');
    assert(/they must differ/.test(gate),
      'and the two secrets must be required to differ');
  });

  // -------------------------------------------------------------------------------------------------------
  // THE POPULATED-INPUT PATH, EXERCISED FOR REAL
  // -------------------------------------------------------------------------------------------------------
  //
  // WHY THESE TESTS EXIST AND WHY THEY ARE NOT STATIC. Every earlier test of the real gate read the shell
  // script and matched strings in it. That is why a P1 defect survived a whole review cycle: the gate handed
  // the operator's documented MINIMAL endpoint file straight to the generic preflight, which refuses an
  // endpoint naming neither a resolverUrl nor a directBaseUrl. The gate skips while inputs are absent and
  // the offline gate passes, so nothing ever ran the populated path — and the first real run would have died
  // before contacting anything.
  //
  // These build a synthetic but COMPLETE operator corpus in a temporary directory, at the real modes, and run
  // the actual CLIs the shell gate runs, in the same order, with the same arguments. Nothing is mocked and
  // nothing is inspected as text.

  interface Corpus {
    readonly dir: string;
    readonly credential: string;
    readonly gateSecret: string;
    readonly objects: string;
    readonly endpoint: string;
  }

  /** A complete operator corpus, exactly as `deploy/torbox-resolver.template.json` documents it. */
  function operatorCorpus(over: { endpoint?: unknown; objects?: unknown } = {}): Corpus {
    const dir = mkdtempSync(join(tmpdir(), 'tbop-'));
    const credential = join(dir, 'torbox-credential');
    const gateSecret = join(dir, 'credential');
    const objects = join(dir, 'objects.json');
    const endpoint = join(dir, 'endpoint.json');

    writeFileSync(credential, 'torbox-api-key-not-a-real-one-0001');
    writeFileSync(gateSecret, 'gate-secret-not-a-real-one-000002');
    writeFileSync(objects, JSON.stringify(over.objects ?? [{
      label: 'object-1',
      ref: REF_TORRENT,
      sizeBytes: 8 * 1024 * 1024,
      // A REAL-SHAPED DIGEST. 64 hex characters is exactly the shape the redaction scrubber calls "a long
      // opaque string that may be a credential", and masking it wrongly is the second defect these tests
      // caught: every correctly written manifest was refused by its own preflight.
      probeDigests: [{ offset: 1, length: 65_536, sha256: '9f2c4e1b7a3d0568cf91be24707d3a86e5b0c1d4f8a2937be6c05d17a4b39e82' }],
    }]), 'utf8');
    writeFileSync(endpoint, JSON.stringify(over.endpoint ?? {
      id: 'torbox',
      allowedOrigins: ['https://cdn.example.invalid'],
      allowInsecureHttp: false,
      allowPrivateAddresses: false,
    }), 'utf8');

    if (process.platform !== 'win32') {
      for (const file of [credential, gateSecret, objects, endpoint]) chmodSync(file, 0o600);
    }
    return { dir, credential, gateSecret, objects, endpoint };
  }

  const runCli = (script: string, args: readonly string[]): { code: number; out: string } => {
    const result = spawnSync('npx', ['tsx', join(HERE, '..', script), ...args],
      { encoding: 'utf8', shell: true });
    return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
  };

  const buildEffective = (corpus: Corpus, port = 8140): { code: number; out: string; path: string } => {
    const path = join(corpus.dir, 'effective.json');
    const result = runCli('src/ops/torbox-resolver-cli.ts',
      ['effective-endpoint', '--endpoint', corpus.endpoint, '--resolver-port', String(port), '--out', path]);
    return { ...result, path };
  };

  const genericPreflight = (corpus: Corpus, endpointPath: string): { code: number; out: string } =>
    runCli('src/ops/projection-real-provider-cli.ts',
      ['preflight', '--objects', corpus.objects, '--credential', corpus.gateSecret,
        '--endpoint', endpointPath]);

  await test('THE DOCUMENTED MINIMAL ENDPOINT SURVIVES THE WHOLE PRE-NETWORK PATH', async () => {
    // THE REGRESSION. A complete corpus written exactly as the template documents it must reach the
    // deliberate no-network boundary with everything green.
    const corpus = operatorCorpus();

    const secrets = runCli('src/ops/torbox-resolver-cli.ts',
      ['preflight', '--credential', corpus.credential, '--gate-secret', corpus.gateSecret]);
    assert(secrets.code === 0, `the secret preflight refused a valid corpus: ${secrets.out.slice(0, 200)}`);

    const effective = buildEffective(corpus);
    assert(effective.code === 0, `the effective endpoint could not be built: ${effective.out.slice(0, 300)}`);

    const built = JSON.parse(readFileSync(effective.path, 'utf8')) as Record<string, unknown>;
    assert(built.resolverUrl === 'http://127.0.0.1:8140/resolve', 'the resolver URL is a loopback literal');
    assert(built.loopbackResolver === true, 'the narrow authority is granted');
    assert(built.allowInsecureHttp === false && built.allowPrivateAddresses === false,
      'and neither fixture switch is set');
    const origins = built.allowedOrigins as string[];
    assert(origins[0] === 'http://127.0.0.1:8140',
      'the resolver origin is first: the daemon checks every url it dials against this list, its own '
      + 'resolver included, so omitting it makes the daemon refuse to start');
    assert(origins.includes('https://cdn.example.invalid'), 'and the operator CDN origin survives');

    const preflight = genericPreflight(corpus, effective.path);
    assert(preflight.code === 0,
      `the generic preflight refused a valid corpus: ${preflight.out.slice(0, 300)}`);
    assert(/nothing was contacted/i.test(preflight.out),
      'and it must say it contacted nothing, which is the boundary this test stops at');
  });

  await test('THE OLD DIRECT CALL — OPERATOR FILE STRAIGHT TO THE GENERIC PREFLIGHT — STILL FAILS', async () => {
    // THE DEFECT ITSELF, PINNED. If somebody reinstates the shortcut, this fails and names it.
    const corpus = operatorCorpus();
    const direct = genericPreflight(corpus, corpus.endpoint);
    assert(direct.code !== 0,
      'the operator MINIMAL endpoint was accepted by the generic preflight; the effective-endpoint step '
      + 'that exists to build a usable one has become optional, and a real run would depend on which '
      + 'path the gate happened to take');
    assert(/neither a resolverUrl nor a directBaseUrl/.test(direct.out),
      `and the refusal must be the one that broke the real run; got: ${direct.out.slice(0, 200)}`);
  });

  await test('A VALID sha256 DIGEST IS NOT MISTAKEN FOR A LEAKED CREDENTIAL', async () => {
    // THE SECOND DEFECT THIS PATH EXPOSED. 64 hex characters match the scrubber's "long opaque string"
    // rule, so every correctly written objects.json -- with the digests the gate REQUIRES -- was refused by
    // its own preflight. That broke the generic real-provider gate too, not only TorBox.
    const corpus = operatorCorpus();
    const effective = buildEffective(corpus);
    const preflight = genericPreflight(corpus, effective.path);
    assert(!/long opaque string/.test(preflight.out),
      `a required sha256 digest was read as a leaked credential: ${preflight.out.slice(0, 200)}`);
    assert(preflight.code === 0, 'and the manifest is accepted');

    // ...AND THE SCRUBBER STILL BITES ON A REAL LEAK. Masking the digest must not have blinded it.
    const leaky = operatorCorpus({
      objects: [{
        label: 'object-1', ref: REF_TORRENT, sizeBytes: 8 * 1024 * 1024,
        note: 'https://api.torbox.app/v1/api/torrents/requestdl?token=SECRETVALUE&torrent_id=1',
        probeDigests: [{ offset: 1, length: 65_536, sha256: 'a'.repeat(64) }],
      }],
    });
    const leakyEffective = buildEffective(leaky);
    const leakyPreflight = genericPreflight(leaky, leakyEffective.path);
    assert(leakyPreflight.code !== 0, 'a manifest carrying a signed URL was accepted');
  });

  await test('EVERY FIELD THE GATE OWNS IS REFUSED IN AN OPERATOR ENDPOINT FILE', async () => {
    // REFUSED, NOT IGNORED. A file carrying `loopbackResolver: true` is one where somebody believed they
    // were configuring the narrow authority. Silently dropping it would leave them believing it.
    const base = { id: 'torbox', allowedOrigins: ['https://cdn.example.invalid'] };
    for (const [field, value] of [
      ['resolverUrl', 'http://127.0.0.1:9999/resolve'],
      ['directBaseUrl', 'https://cdn.example.invalid/objects'],
      ['loopbackResolver', true],
      ['tokenFile', '/etc/passwd'],
      ['maxConnections', 999],
      ['resolutionDeadlineMs', 1],
      ['refreshCooldownMs', 1],
    ] as const) {
      const corpus = operatorCorpus({ endpoint: { ...base, [field]: value } });
      const built = buildEffective(corpus);
      assert(built.code !== 0, `an operator endpoint carrying "${field}" was accepted`);
      assert(built.out.includes(field), `and the refusal must name "${field}" so it teaches`);
    }
  });

  await test('AN UNKNOWN TRANSPORT FIELD IS REFUSED RATHER THAN SILENTLY DROPPED', async () => {
    const corpus = operatorCorpus({
      endpoint: { id: 'torbox', allowedOrigins: ['https://cdn.example.invalid'], proxyUrl: 'http://evil' },
    });
    const built = buildEffective(corpus);
    assert(built.code !== 0, 'an unknown transport field was silently ignored');
    assert(/proxyUrl/.test(built.out), 'and the refusal must name it');
  });

  await test('A FIXTURE SWITCH SET TRUE IN AN OPERATOR FILE IS REFUSED', async () => {
    for (const field of ['allowInsecureHttp', 'allowPrivateAddresses'] as const) {
      const corpus = operatorCorpus({
        endpoint: { id: 'torbox', allowedOrigins: ['https://cdn.example.invalid'], [field]: true },
      });
      const built = buildEffective(corpus);
      assert(built.code !== 0, `"${field}": true was accepted in a real corpus`);
    }
  });

  await test('EVERY BAD ORIGIN SHAPE IS REFUSED', async () => {
    for (const [what, origins] of [
      ['an empty list', []],
      ['a wildcard', ['*']],
      ['a partial wildcard', ['https://*.torbox.app']],
      ['plaintext', ['http://cdn.example.invalid']],
      ['an empty string', ['']],
      ['a path', ['https://cdn.example.invalid/objects']],
      ['a query', ['https://cdn.example.invalid?a=b']],
      ['userinfo', ['https://user:pass@cdn.example.invalid']],
      ['a loopback CDN', ['https://127.0.0.1']],
      ['localhost', ['https://localhost']],
      ['RFC1918', ['https://10.0.0.5']],
      ['the metadata address', ['https://169.254.169.254']],
      ['a non-string', [42]],
    ] as const) {
      const corpus = operatorCorpus({ endpoint: { id: 'torbox', allowedOrigins: origins } });
      const built = buildEffective(corpus);
      assert(built.code !== 0, `an allowlist containing ${what} was accepted`);
    }
  });

  await test('AN INVALID ENDPOINT ID IS REFUSED', async () => {
    for (const id of ['', 'Has Spaces', 'UPPER', 'https://x', '../etc', 'a'.repeat(40), 42]) {
      const corpus = operatorCorpus({ endpoint: { id, allowedOrigins: ['https://cdn.example.invalid'] } });
      const built = buildEffective(corpus);
      assert(built.code !== 0, `the endpoint id ${JSON.stringify(id)} was accepted`);
    }
  });

  await test('A MALFORMED ENDPOINT FILE FAILS CLOSED WITHOUT CONTACTING ANYTHING', async () => {
    for (const raw of ['not json', '[]', 'null', '"a string"', '123']) {
      const dir = mkdtempSync(join(tmpdir(), 'tbop-bad-'));
      const endpoint = join(dir, 'endpoint.json');
      writeFileSync(endpoint, raw, 'utf8');
      const built = runCli('src/ops/torbox-resolver-cli.ts',
        ['effective-endpoint', '--endpoint', endpoint, '--resolver-port', '8140',
          '--out', join(dir, 'out.json')]);
      assert(built.code !== 0, `the endpoint file ${JSON.stringify(raw)} was accepted`);
      assert(!/api\.torbox\.app/.test(built.out), 'and nothing was contacted');
    }
  });

  await test('THE EFFECTIVE ENDPOINT NEVER CARRIES A SECRET OR A REFERENCE INTO A REPORT', async () => {
    const corpus = operatorCorpus();
    const built = buildEffective(corpus);
    assert(built.code === 0, 'setup');
    assert(findSecretShapes(built.out, 'stdout').length === 0,
      `the effective-endpoint output leaked: ${built.out.slice(0, 150)}`);
    // The effective endpoint file legitimately carries the resolver URL, which is a loopback literal and no
    // secret at all -- but it must carry nothing else.
    const text = readFileSync(built.path, 'utf8');
    assert(!text.includes('torbox-api-key'), 'the effective endpoint carries the TorBox credential');
    assert(!text.includes('gate-secret-not'), 'or the gate secret');
    assert(!text.includes(REF_TORRENT), 'or a stable reference');
  });

  await test('THE GATE FEEDS THE EFFECTIVE ENDPOINT TO BOTH CONSUMERS, NOT THE OPERATOR FILE', () => {
    // The shell must not have kept a second path to the same decision. Two derivations of one thing is how
    // a gate validates a shape it does not run -- which is precisely the defect being repaired.
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');
    assert(/effective-endpoint/.test(gate), 'the gate builds an effective endpoint');
    assert(/--endpoint "\$EFFECTIVE_ENDPOINT"/.test(gate),
      'and the generic preflight is given it rather than the operator file');
    assert(/config\.cjs" "\$EFFECTIVE_ENDPOINT"/.test(gate),
      'and so is the daemon configuration');
    // THE OPERATOR FILE MAY REACH EXACTLY ONE PLACE: the validator that turns it into an effective
    // endpoint. Anywhere else is the defect coming back.
    const operatorFileUses = gate.split('\n')
      .filter((line) => line.includes('$ENDPOINT_FILE') && line.includes('--endpoint'));
    assert(operatorFileUses.length === 1,
      `the operator endpoint file is passed to ${operatorFileUses.length} commands; only `
      + 'effective-endpoint may receive it');
    assert(/effective-endpoint/.test(gate.slice(0, gate.indexOf(operatorFileUses[0] as string) + 200)),
      'and the one command that receives it must be effective-endpoint');
  });

  // -------------------------------------------------------------------------------------------------------
  // THE SCRIPTS THE GATES WRITE AT RUN TIME, LIFTED OUT AND EXECUTED
  // -------------------------------------------------------------------------------------------------------
  //
  // WHY THIS SECTION EXISTS. Everything these gates do to an operator's corpus before a container exists is
  // done by small `.cjs` programs embedded in the shell script as heredocs. Nothing had ever RUN one: the
  // tests above them matched strings in the surrounding shell, which is how a gate acquires a program that
  // is wrong in a way no assertion can see. Each test below extracts the shipped program and executes it.

  /** The exact program the gate writes at run time, lifted out of its heredoc. */
  function heredoc(gatePath: string, name: string): string {
    const text = repoFile(gatePath);
    const opener = `cat > "$WORK/${name}" <<'`;
    const start = text.indexOf(opener);
    assert(start !== -1, `${gatePath} does not write ${name}`);
    const delimiterEnd = text.indexOf("'", start + opener.length);
    const delimiter = text.slice(start + opener.length, delimiterEnd);
    const bodyStart = text.indexOf('\n', delimiterEnd) + 1;
    const bodyEnd = text.indexOf(`\n${delimiter}\n`, bodyStart);
    assert(bodyEnd !== -1, `${gatePath} never closes the heredoc for ${name}`);
    return text.slice(bodyStart, bodyEnd);
  }

  /** That program, on disk in a scratch directory, ready to run. */
  function extract(gatePath: string, name: string): { dir: string; script: string } {
    const dir = mkdtempSync(join(tmpdir(), 'tbgate-'));
    const script = join(dir, name);
    writeFileSync(script, `${heredoc(gatePath, name)}\n`, 'utf8');
    return { dir, script };
  }

  const runNode = (script: string, args: readonly string[]): { code: number; out: string } => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
  };

  await test('THE REGISTER PLAN PUTS NO STABLE REFERENCE IN ARGV, WHICH THE 0600 SHELL FILE NEVER DID', () => {
    // THE DEFECT, IN ITS OWN WORDS. All three gates wrote their register COMMANDS into a 0600 shell file and
    // then ran it, each carrying a comment saying that kept the reference "out of every process listing
    // taken while the gate runs". It did not, and could not: a mode protects the FILE. The commands built
    // from it still spent their whole lives in the process table carrying
    // `--source http-range:<id>:torbox:<kind>:<item>:<file>`, which `ps` shows to every user on the host —
    // and a TorBox reference identifies an item in the operator's account.
    //
    // `batch --file` takes the corpus as ONE PATH. The reference reaches a 0600 file and stops there.
    const gates = [
      ['deploy/projection-torbox-real-gate.sh', true],
      ['deploy/projection-torbox-mount-gate.sh', false],
      ['deploy/projection-real-provider-gate.sh', true],
    ] as const;

    for (const [gatePath, takesEndpoint] of gates) {
      const { dir, script } = extract(gatePath, 'register.cjs');
      const objectsPath = join(dir, 'objects.json');
      const endpointPath = join(dir, 'endpoint.json');
      writeFileSync(objectsPath, JSON.stringify([
        { label: 'object-1', ref: REF_TORRENT, sizeBytes: 8 * 1024 * 1024 },
        { label: 'object-2', ref: REF_WEBDL, sizeBytes: 4 * 1024 * 1024 },
      ]), 'utf8');
      writeFileSync(endpointPath, JSON.stringify({ id: 'torbox' }), 'utf8');

      const out = join(dir, 'register.json');
      const run = runNode(script, takesEndpoint ? [out, objectsPath, endpointPath] : [out, objectsPath]);
      assert(run.code === 0, `${gatePath}: register.cjs failed: ${run.out.slice(0, 300)}`);

      // NO SHELL SCRIPT IS PRODUCED ANY MORE, because running one is what put the reference in argv.
      assert(!existsSync(join(dir, 'register.sh')),
        `${gatePath}: a register.sh is still emitted, and running it is what leaked the reference`);

      const batchPath = join(dir, 'register-batch.json');
      assert(existsSync(batchPath), `${gatePath}: no 0600 batch file was written`);
      if (process.platform !== 'win32') {
        assert((statSync(batchPath).mode & 0o077) === 0,
          `${gatePath}: the batch file carrying the references is readable by group or other`);
      }

      // THE BATCH FILE IS THE ONE PLACE THE REFERENCE APPEARS, and it is in the shape `batch --file` reads.
      const batch = JSON.parse(readFileSync(batchPath, 'utf8')) as {
        versions: { key: string; size: number; mtime: string }[];
        entries: { item: string; versionKey: string; path: string; sources: string[] }[];
      };
      assert(batch.versions.length === 2 && batch.entries.length === 2,
        `${gatePath}: the batch file does not describe both objects`);
      assert(batch.entries[0]?.sources[0]?.endsWith(REF_TORRENT) === true,
        `${gatePath}: the first entry does not carry its stable reference`);
      assert(batch.entries.every((entry) => entry.versionKey === batch.versions[
        batch.entries.indexOf(entry)]?.key),
      `${gatePath}: an entry names a version the batch does not register`);

      // AND NOTHING ELSE register.cjs WROTE CARRIES IT. The summary the shell reads must be safe to echo.
      const summary = readFileSync(out, 'utf8');
      assert(!summary.includes(REF_TORRENT) && !summary.includes(REF_WEBDL),
        `${gatePath}: the register summary carries a stable reference`);
      assert(/"rootId"/.test(summary), `${gatePath}: the shell has no way to learn the root id`);

      // THE SHELL MUST INVOKE THE PATH FORM. This is the one part argv is built by, so it is checked where
      // it is written: nothing may run the generated script, and the batch must arrive as --file.
      const gate = repoFile(gatePath);
      assert(!/bash "\$WORK\/out\/register\.sh"/.test(gate),
        `${gatePath}: the gate still executes a generated register script`);
      assert(/batch --file "\$REL\/out\/register-batch\.json"/.test(gate),
        `${gatePath}: the gate does not register through the path form`);
      assert(!/register entry|register version|' entry --| version --key/.test(
        gate.split('REGISTER')[2] ?? ''),
      `${gatePath}: a per-row register invocation survives outside the batch file`);
    }
  });

  await test('THE REAL GATE MEASURES REACHABILITY AT THE TRANSPORT, SO A 404 CANNOT PASS FOR A REFUSAL', async () => {
    // THE FALSE-POSITIVE GATE. The real gate asserted that the resolver is unreachable from the gate network
    // with `wget -q -O /dev/null http://<daemon>:<port>/resolve`, and treated a non-zero exit as proof. But
    // wget exits non-zero for a refused connection AND for every HTTP error status — and this resolver
    // answers 404 to a GET. So a resolver that WAS reachable produced exactly the exit code the gate read as
    // "unreachable". The assertion could not fail, and it guards a credential oracle.
    const { script } = extract('deploy/projection-torbox-real-gate.sh', 'probe-reachable.cjs');

    // A listener that answers exactly as the resolver answers a stranger. THIS IS THE CASE THE OLD
    // INSTRUMENT COULD NOT SEE.
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as AddressInfo).port;

    const reachable = runNode(script, ['127.0.0.1', String(port)]);
    assert(reachable.code === 0,
      `a reachable listener answering 404 must be reported REACHABLE, got exit ${reachable.code}`);

    await new Promise<void>((resolve) => { server.close(() => resolve()); });

    // The same port with nothing behind it: a refusal, which is the only outcome that is proof.
    const refused = runNode(script, ['127.0.0.1', String(port)]);
    assert(refused.code === 1,
      `a closed port must be reported REFUSED, got exit ${refused.code}`);

    // AND A MEASUREMENT THAT DID NOT HAPPEN IS NOT A PASS. Folding an unresolvable name into "unreachable"
    // would restore the same unfalsifiable pass by another route.
    const unresolvable = runNode(script, ['no-such-host.invalid.', '9']);
    assert(unresolvable.code === 2,
      `a name that does not resolve must be INCONCLUSIVE, got exit ${unresolvable.code}`);

    // And the gate must act on all three, rather than on truthiness.
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');
    assert(!/wget[^\n]*RESOLVER_PORT/.test(gate),
      'the gate still tests reachability with an HTTP client whose exit code cannot tell 404 from refused');
    assert(/probe-reachable\.cjs/.test(gate), 'the gate must use the transport probe');
    assert(/could not be determined/.test(gate),
      'and must refuse to report the property as proven when it could not measure it');
  });

  await test('THE REAL GATE READS PAST 90% AND BACKWARDS AT EVERY OPERATOR OBJECT SIZE', () => {
    // THE DEFECT. The gate clamped a fixed 64 KiB window back inside the object, so for anything under about
    // 728 KiB the "past 90%" read silently happened well BELOW 90%, and for an object of 64 KiB or less it
    // happened at offset ZERO — where it became byte-for-byte identical to the backward read and the
    // distinct-windows check FAILED A CORRECT MOUNT. The operator supplies these sizes, so both cases are
    // reachable by anyone who ever populates this gate.
    const oldClamp = (offset: number, length: number, size: number): number =>
      Math.max(0, Math.min(offset, size - length));
    assert(oldClamp(Math.floor(65_536 * 0.91), 65_536, 65_536) === 0,
      'the old arithmetic must be shown to collapse the tail read onto offset zero');
    assert(oldClamp(Math.floor(100_000 * 0.91), 65_536, 100_000) < Math.floor(100_000 * 0.9),
      'and to pull it below the 90% line it is named for');

    const { script } = extract('deploy/projection-torbox-real-gate.sh', 'verify.cjs');
    for (const size of [4_096, 65_536, 65_537, 100_000, 800_000, 8 * 1024 * 1024]) {
      const dir = mkdtempSync(join(tmpdir(), 'tbverify-'));
      const mount = join(dir, 'mnt');
      mkdirSync(mount);
      // REAL BYTES, DISTINCT AT EVERY OFFSET, so a mount serving one buffer for every window would be caught
      // rather than accidentally satisfied.
      writeFileSync(join(mount, 'object-1.bin'), objectBytes(`size-${size}`, 0, size));
      const objectsPath = join(dir, 'objects.json');
      writeFileSync(objectsPath, JSON.stringify([
        { label: 'object-1', ref: REF_TORRENT, sizeBytes: size },
      ]), 'utf8');
      const out = join(dir, 'reads.json');

      const run = runNode(script, [objectsPath, mount, out]);
      assert(run.code === 0,
        `an object of ${size} bytes failed verification: ${run.out.slice(0, 300)}`);

      const record = JSON.parse(readFileSync(out, 'utf8')) as {
        problems: number;
        results: { kind: string; offset?: number; bytes: number; expected?: number;
          pastNinetyPercent?: boolean; match: boolean }[];
      };
      assert(record.problems === 0, `an object of ${size} bytes reported ${record.problems} problem(s)`);

      const tail = record.results.find((entry) => entry.kind === 'tail');
      const back = record.results.find((entry) => entry.kind === 'backward');
      assert(tail !== undefined && back !== undefined, `${size}: both windows must be recorded`);
      assert(tail.offset !== undefined && tail.offset >= Math.floor(size * 0.9),
        `${size}: the tail read started at ${tail.offset}, which is not past 90%`);
      assert(tail.pastNinetyPercent === true, `${size}: the record does not claim the property it has`);
      assert(tail.bytes === tail.expected && back.bytes === back.expected,
        `${size}: a window returned short`);
      assert((back.offset ?? -1) + (back.expected ?? 0) <= tail.offset,
        `${size}: the backward window overlaps the tail window, so distinctness proves nothing`);
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // The documents an operator would actually follow
  // -------------------------------------------------------------------------------------------------------

  await test('EVERY FILE PHASE 50 §8 TELLS AN OPERATOR TO PLACE IS ONE THE GATE ACTUALLY READS', () => {
    // THE DEFECT. §8 named the gate secret `gate-secret`; the gate has only ever read `credential`. A corpus
    // assembled from that table looks complete to its author and skips with 77 for ever, and the skip
    // message names a file they believe they placed.
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');
    const required = [...gate.matchAll(
      /^(?:TORBOX_CREDENTIAL|GATE_SECRET|OBJECTS_FILE|ENDPOINT_FILE)="\$INPUT_DIR\/([^"]+)"$/gm,
    )].map((match) => match[1] as string);
    assert(required.length === 4, `the gate requires ${required.length} inputs, not 4`);

    const doc = repoFile('docs/PHASE_50_TORBOX_RESOLVER.md');
    const section = doc.slice(doc.indexOf('## 8.'));
    assert(section.length > 0, 'PHASE_50 has no §8');
    for (const name of required) {
      assert(section.includes(`\`${name}\``), `§8 never names \`${name}\`, which the gate requires`);
    }
    assert(!/\|\s*`gate-secret`\s*\|/.test(section),
      'the §8 table still names `gate-secret`, a file the gate never reads');
  });

  await test('THE ENDPOINT FIELDS §8 PRESCRIBES ARE THE ONES THE VALIDATOR ACCEPTS', async () => {
    // THE SECOND DOC DEFECT. §8 told the operator to write a `resolverUrl` "pointing at the loopback
    // resolver". The validator refuses that field BY NAME, because the resolver's address depends on a
    // namespace the gate creates. So the documented corpus could not have got past step 2 of the gate's own
    // preflight — and the refusal names a field the document told them to write.
    //
    // THE AUTHORITY HERE IS THE EXECUTED VALIDATOR, not the prose: each field is refused by a real run
    // before the document is checked for mentioning it.
    const section = repoFile('docs/PHASE_50_TORBOX_RESOLVER.md');
    const eight = section.slice(section.indexOf('## 8.'));
    const endpointRow = eight.split('\n').find((line) => line.includes('`endpoint.json`')) ?? '';
    assert(endpointRow !== '', '§8 has no endpoint.json row');

    for (const [field, value] of [
      ['resolverUrl', 'http://127.0.0.1:8140/resolve'],
      ['directBaseUrl', 'https://cdn.example.invalid/objects'],
      ['loopbackResolver', true],
      ['tokenFile', '/dev/null'],
    ] as const) {
      const corpus = operatorCorpus({
        endpoint: { id: 'torbox', allowedOrigins: ['https://cdn.example.invalid'], [field]: value },
      });
      const built = buildEffective(corpus);
      assert(built.code !== 0, `the validator accepted "${field}"; this test's authority is gone`);
      assert(!endpointRow.includes(`\`${field}\``),
        `§8 tells an operator to write \`${field}\` in endpoint.json, and the validator refuses it by name`);
    }

    // AND THE SHAPE IT DOES PRESCRIBE MUST SURVIVE THE WHOLE PRE-NETWORK PATH.
    const good = operatorCorpus();
    const effective = buildEffective(good);
    assert(effective.code === 0, `the documented shape was refused: ${effective.out.slice(0, 200)}`);
    assert(genericPreflight(good, effective.path).code === 0,
      'and it must reach the deliberate no-network boundary green');
  });

  await test('THE TWO REAL GATES DO NOT SHARE AN APPROVED DIRECTORY, BECAUSE THEIR SCHEMAS EXCLUDE EACH OTHER',
    () => {
      // THE DEFECT. Both gates read `credential`, `objects.json` and `endpoint.json`, and both read them
      // from `…/secrets/real-provider`. Their endpoint schemas are mutually exclusive — the generic gate
      // refuses a file naming NEITHER `resolverUrl` nor `directBaseUrl`, and the TorBox gate refuses one
      // naming EITHER. So an operator who prepared for one turned the other's honest `SKIPPED (77)` into a
      // hard failure, and the two could never be prepared at the same time. `credential` did not even mean
      // the same thing in the two places.
      const torbox = /^INPUT_DIR="\$\{PROJECTION_TORBOX_INPUT_DIR:-([^}]*)\}"$/m
        .exec(repoFile('deploy/projection-torbox-real-gate.sh'));
      const generic = /^INPUT_DIR="\$\{PROJECTION_REAL_PROVIDER_INPUT_DIR:-([^}]*)\}"$/m
        .exec(repoFile('deploy/projection-real-provider-gate.sh'));
      assert(torbox !== null && generic !== null, 'both gates must declare an approved input directory');
      assert(torbox[1] !== generic[1],
        `both real gates still read ${String(torbox[1])}, and their endpoint schemas cannot both be met`);

      // THE REASON, EXECUTED IN BOTH DIRECTIONS.
      const torboxShaped = operatorCorpus();
      assert(genericPreflight(torboxShaped, torboxShaped.endpoint).code !== 0,
        'a TorBox-shaped endpoint must be refused by the generic preflight');
      const genericShaped = operatorCorpus({
        endpoint: {
          id: 'provider',
          directBaseUrl: 'https://cdn.example.invalid/objects',
          allowedOrigins: ['https://cdn.example.invalid'],
        },
      });
      assert(buildEffective(genericShaped).code !== 0,
        'and a generic-shaped endpoint must be refused by the TorBox validator');
    });

  await test('A WHOLE-OBJECT DIGEST IS STREAMED, SO AN OPERATOR MAY RECORD ONE FOR AN OBJECT OF ANY SIZE',
    () => {
      // THE DEFECT. Every window this gate reads is 64 KiB except one: the WHOLE-OBJECT read taken whenever
      // an operator records a `sha256`. It allocated the whole object in a single buffer. `probeDigests`
      // exist for the large-object case but nothing makes them compulsory, so a 40 GB film with a recorded
      // sha256 is a configuration the validator accepts — and the run would die on `Buffer.alloc(40e9)`,
      // with a message about a typed array length, after TorBox had already served the bytes.
      const { script } = extract('deploy/projection-torbox-real-gate.sh', 'verify.cjs');
      const dir = mkdtempSync(join(tmpdir(), 'tbwhole-'));
      const mount = join(dir, 'mnt');
      mkdirSync(mount);

      // LARGER THAN ONE CHUNK, so the loop that stitches chunks together is actually exercised: a digest
      // computed one 1 MiB chunk at a time must equal the digest of the whole file.
      const size = 5 * 1024 * 1024 + 12_345;
      const bytes = objectBytes('whole-object', 0, size);
      writeFileSync(join(mount, 'object-1.bin'), bytes);
      const whole = createHash('sha256').update(bytes).digest('hex');

      const objectsPath = join(dir, 'objects.json');
      writeFileSync(objectsPath, JSON.stringify([
        { label: 'object-1', ref: REF_TORRENT, sizeBytes: size, sha256: whole },
      ]), 'utf8');
      const out = join(dir, 'reads.json');
      const run = runNode(script, [objectsPath, mount, out]);
      assert(run.code === 0, `a streamed whole-object digest failed: ${run.out.slice(0, 300)}`);

      const record = JSON.parse(readFileSync(out, 'utf8')) as {
        problems: number; results: { kind: string; bytes: number; match: boolean }[];
      };
      const wholeRead = record.results.find((entry) => entry.kind === 'whole');
      assert(wholeRead !== undefined && wholeRead.match, 'the whole-object digest did not match');
      assert(wholeRead.bytes === size, `the whole object read ${wholeRead.bytes} of ${size} bytes`);
      assert(record.problems === 0, `${record.problems} problem(s) on a correct object`);

      // AND A WRONG DIGEST STILL FAILS. Streaming must not have turned the comparison into a formality.
      writeFileSync(objectsPath, JSON.stringify([
        { label: 'object-1', ref: REF_TORRENT, sizeBytes: size, sha256: 'b'.repeat(64) },
      ]), 'utf8');
      assert(runNode(script, [objectsPath, mount, join(dir, 'bad.json')]).code !== 0,
        'a wrong whole-object digest was accepted');

      // THE ALLOCATION IS BOUNDED BY THE CHUNK, which is the property the size independence rests on.
      const source = heredoc('deploy/projection-torbox-real-gate.sh', 'verify.cjs');
      assert(/Buffer\.allocUnsafe\(Math\.min\(length, READ_CHUNK\)\)/.test(source),
        'the read buffer is not bounded by the chunk size, so a large object still allocates whole');
      assert(!/Buffer\.alloc\(length\)/.test(source), 'a whole-window allocation survives');
    });

  await test('EACH THREE-RUN WRAPPER REPORTS ITS OWN GATE, NOT A VERBATIM COPY OF ANOTHER ONE\'S', () => {
    // THE DEFECT. Three wrappers — real-provider, torbox-mount and torbox-real — shipped the PATH LIFECYCLE
    // wrapper's header word for word, telling a reader that the sequence turns on three fresh media-server
    // config directories and on set differences between three real media servers' inventories. None of those
    // three gates has a media server anywhere in it.
    //
    // AND THE WORSE HALF, WHICH IS NOT A COMMENT. The REAL TorBox wrapper's CLOSING MESSAGE was the OFFLINE
    // gate's, word for word. Three successful runs against an operator's own TorBox account would have ended
    // by telling them the provider was a fixture, the credential was 32 random bytes the gate generated, and
    // no real TorBox account had ever been contacted — at the exact moment that stopped being true, about the
    // one run this whole tranche is waiting on. It is checked here by RUNNING the wrapper, through the seam
    // it documents for exactly this purpose.
    //
    // THIS IS THE ONE TEST HERE THAT DRIVES A SHIPPED SCRIPT END TO END, AND IT IS THE ONE THAT KEPT FAILING
    // ON WINDOWS FOR A REASON THAT HAD NOTHING TO DO WITH THE WRAPPER. It ran `spawnSync('bash', …)`, and on
    // a stock Windows box that is WSL, which cannot address this checkout at all. It is now given the shell
    // `posixShell` proved can execute a script here; where nothing can, it SKIPS BY NAME, because a suite
    // that could not run the wrapper has not checked the wrapper. Both paths still go through `shPath`: the
    // wrapper reads its stub path out of the environment, so that spelling has to be shell-readable too.
    const shell = posixShell();
    if (shell === null) { skipBlock(`${NO_SHELL} — the three-run wrappers were not executed`); return; }

    const drive = (script: string, commandVar: string, runsVar: string): string => {
      const dir = mkdtempSync(join(tmpdir(), 'tbwrap-'));
      const stub = join(dir, 'stub.sh');
      writeFileSync(stub, '#!/usr/bin/env bash\nexit 0\n');
      const result = spawnSync(shell, [shPath(join(HERE, '..', 'deploy', script))], {
        encoding: 'utf8',
        env: { ...process.env, [commandVar]: shPath(stub), [runsVar]: '1' },
      });
      assert(result.status === 0, `${script} did not complete: ${String(result.stderr).slice(0, 200)}`);
      return `${result.stdout}${result.stderr}`;
    };

    const offline = drive('projection-torbox-mount-gate-three.sh',
      'PROJECTION_TORBOX_GATE_COMMAND', 'PROJECTION_TORBOX_GATE_RUNS');
    assert(/IT CLOSES NOTHING ABOUT ANY REAL PROVIDER/.test(offline),
      'the OFFLINE wrapper must still refuse to be read as a real run');
    assert(/projection-torbox-real-gate\.sh/.test(offline),
      'and must point at the TorBox real gate rather than the generic one');

    const real = drive('projection-torbox-real-gate-three.sh',
      'PROJECTION_TORBOX_REAL_GATE_COMMAND', 'PROJECTION_TORBOX_REAL_GATE_RUNS');
    const flat = real.replace(/\s+/g, ' ');
    assert(!/the credential was 32 random bytes the gate generated/.test(flat),
      'the REAL wrapper still tells a successful real run that its credential was generated by the gate');
    assert(!/A real TorBox account has never been contacted\./.test(
      flat.slice(flat.indexOf('WHAT THIS DOES AND DOES NOT CLOSE'))),
    'the REAL wrapper still claims, on success, that no TorBox account was ever contacted');
    assert(/These runs CONTACTED TORBOX/.test(flat),
      'and it must say plainly that they did');
    assert(/does not close/i.test(flat) && /section 6\.1/.test(flat),
      'while still refusing to be read as Phase 1 closure');

    // AND NO WRAPPER MAY DESCRIBE MACHINERY ITS GATE DOES NOT HAVE.
    for (const script of ['projection-torbox-mount-gate-three.sh', 'projection-torbox-real-gate-three.sh',
      'projection-real-provider-gate-three.sh']) {
      const text = repoFile(`deploy/${script}`);
      const header = text.slice(0, text.indexOf('set -uo pipefail'));
      assert(!/THREE fresh media-server config directories/.test(header),
        `${script} still claims three fresh media-server config directories; it has no media server`);
      assert(!/PATH LIFECYCLE gate \(G27/.test(header),
        `${script} still titles itself as the path-lifecycle gate`);
    }
  });

  await test('NEITHER TORBOX GATE\'S LEAK SCAN CAN REPORT "NO LEAK" WITHOUT HAVING LOOKED', () => {
    // THE DEFECT, IN THE ONE MEASUREMENT THAT STANDS BEHIND "NEITHER SECRET REACHED DISK". Both gates search
    // everything the run wrote for the exact bytes of the TorBox credential and of the gate secret, and both
    // used the same program. It reported `0` — which the shell compares against 0 and passes — in three
    // situations where it had not searched at all:
    //
    //   a needle under 8 bytes skipped the walk outright;
    //   any file over 64 MiB was skipped, so a secret in a large log was invisible;
    //   a root that did not exist was walked in silence.
    //
    // In the REAL gate both needles are operator-supplied, so the first of those is reachable by anyone who
    // ever populates it. All three are executed below against each shipped copy.
    for (const gatePath of [
      'deploy/projection-torbox-real-gate.sh',
      'deploy/projection-torbox-mount-gate.sh',
    ]) {
      const { dir, script } = extract(gatePath, 'scan.cjs');
      const root = join(dir, 'out');
      mkdirSync(root);
      const secretFile = join(dir, 'secret');
      // STDOUT AND STDERR KEPT APART, because the whole point is that a refusal must not put a number on
      // stdout for `$(...)` to capture and `test -eq 0` to accept.
      const runScan = (args: readonly string[]): { code: number; out: string; err: string } => {
        const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
        return { code: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' };
      };

      // A REAL LEAK IS FOUND, and only a count reaches stdout.
      writeFileSync(secretFile, `${GATE}\n`);
      writeFileSync(join(root, 'resolver.log'), `POST /resolve authorization: Bearer ${GATE}\n`);
      const found = runScan([secretFile, root]);
      assert(found.code === 0 && found.out.trim() === '1',
        `${gatePath}: a planted gate-secret leak was not found: "${found.out.trim()}"`);
      assert(!found.out.includes(GATE) && !found.err.includes(GATE),
        `${gatePath}: the scan printed the secret it searched for`);
      assert(!found.out.includes('resolver.log') && !found.err.includes('resolver.log'),
        `${gatePath}: the scan named the file it found it in`);

      // AND A CLEAN RUN IS STILL A ZERO, so the refusals below are about decisiveness rather than noise.
      writeFileSync(join(root, 'resolver.log'), 'POST /resolve 401\n');
      assert(runScan([secretFile, root]).out.trim() === '0',
        `${gatePath}: a clean run did not report 0`);

      // 1. A SECRET TOO SHORT TO BE DECISIVE IS REFUSED RATHER THAN REPORTED AS ZERO.
      writeFileSync(secretFile, 'short12\n');
      writeFileSync(join(root, 'resolver.log'), 'authorization: Bearer short12\n');
      const short = runScan([secretFile, root]);
      assert(short.code !== 0,
        `${gatePath}: a 7-byte secret present verbatim reported "${short.out.trim()}" instead of failing`);
      assert(short.out.trim() === '',
        `${gatePath}: a refused scan still put "${short.out.trim()}" on stdout for the shell to capture`);

      // 2. A LARGE FILE IS SEARCHED. The same value at 64 MiB + 4 KiB used to be skipped entirely.
      writeFileSync(secretFile, `${GATE}\n`);
      const big = Buffer.alloc(64 * 1024 * 1024 + 4096, 0x2e);
      big.write(`authorization: Bearer ${GATE}`, 33 * 1024 * 1024);
      writeFileSync(join(root, 'resolver.log'), big);
      const large = runScan([secretFile, root]);
      assert(large.code === 0 && large.out.trim() === '1',
        `${gatePath}: a secret in a ${big.length}-byte file was not found`);

      // 3. A ROOT THAT DOES NOT EXIST IS A FAILURE, because its zero would prove nothing.
      const missing = runScan([secretFile, join(dir, 'no-such-directory')]);
      assert(missing.code !== 0 && missing.out.trim() === '',
        `${gatePath}: a root that does not exist reported "${missing.out.trim()}"`);
    }

    // AND BOTH GATES MUST ACT ON THE FAILURE RATHER THAN ON THE NUMBER. A `$(...)` capture of a failed
    // program yields the empty string, and `test "" -eq 0` is a shell error rather than a refusal — so the
    // call sites are checked where they are written.
    for (const gatePath of [
      'deploy/projection-torbox-real-gate.sh',
      'deploy/projection-torbox-mount-gate.sh',
      'deploy/projection-real-provider-gate.sh',
    ]) {
      const gate = repoFile(gatePath);
      for (const [, assignment] of gate.matchAll(/^([A-Z_]+="\$\(node "\$REL\/scan\.cjs"[^\n]*)$/gm)) {
        assert(/\\$/.test(assignment as string),
          `${gatePath}: a scan.cjs call site does not continue into a failure branch: ${assignment}`);
      }
      const sites = [...gate.matchAll(/node "\$REL\/scan\.cjs"/g)].length;
      const guarded = [...gate.matchAll(/could not be made decisive/g)].length;
      assert(sites > 0 && sites === guarded,
        `${gatePath}: ${sites} scan call site(s) but ${guarded} guarded against a non-decisive scan`);
    }
  });

  await test('THE RESOLVER PROBE IS BOUNDED, SO A RESOLVER THAT NEVER ANSWERS CANNOT HANG THE GATE', async () => {
    // THE DEFECT. `http.request` applies no default timeout in Node. Both TorBox gates probed the loopback
    // resolver with one and waited for a response for ever — so a resolver that accepted the connection and
    // then stalled left the gate hung rather than failed. A gate that hangs is worse than one that fails,
    // because nothing reports a hang: no assertion runs, no cleanup runs, and the operator sees a cursor.
    //
    // The TRANSPORT probe shipped beside this one already bounded itself at 3 s, which is how the omission
    // was visible at all. Proved below by running the shipped program against a listener that accepts and
    // never responds.
    // THE PROBE MUST BE RUN ASYNCHRONOUSLY. `spawnSync` blocks this process's event loop, so an in-process
    // listener could never answer the child and every case would look like the hung one — which would make
    // this test pass for the wrong reason and prove nothing about the deadline.
    const runProbe = (script: string, port: number): Promise<{ code: number | null; signal: string | null }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [script, String(port)], { stdio: 'ignore' });
        const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.on('exit', (code, signal) => { clearTimeout(killer); resolve({ code, signal }); });
      });

    const listening = async (handler: RequestListener): Promise<
    { port: number; close: () => Promise<void> }> => {
      const server = createServer(handler);
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
      return {
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
      };
    };

    for (const gatePath of [
      'deploy/projection-torbox-real-gate.sh',
      'deploy/projection-torbox-mount-gate.sh',
    ]) {
      const { script } = extract(gatePath, 'probe-resolver.cjs');

      // A 401 IS THE HEALTHY ANSWER: the probe presents no credential on purpose.
      const refusing = await listening((_req, res) => { res.writeHead(401); res.end(); });
      assert((await runProbe(script, refusing.port)).code === 0,
        `${gatePath}: a resolver answering 401 must be reported healthy`);
      await refusing.close();

      // ANYTHING ELSE IS NOT. A resolver that answered an unauthenticated POST is worth failing over.
      const permissive = await listening((_req, res) => { res.writeHead(200); res.end('{}'); });
      assert((await runProbe(script, permissive.port)).code !== 0,
        `${gatePath}: a resolver answering an unauthenticated POST 200 must fail the probe`);
      const closedPort = permissive.port;
      await permissive.close();

      // A CLOSED PORT FAILS RATHER THAN HANGS.
      assert((await runProbe(script, closedPort)).code !== 0,
        `${gatePath}: a closed port must fail the probe`);

      // THE CASE THE OLD PROBE COULD NOT SURVIVE: accepted, and never answered.
      const stalling = await listening(() => { /* deliberately never responds */ });
      const started = Date.now();
      const result = await runProbe(script, stalling.port);
      const elapsed = Date.now() - started;
      await stalling.close();
      assert(result.signal === null,
        `${gatePath}: the probe had to be killed after ${elapsed}ms; it applies no deadline of its own`);
      assert(result.code !== 0,
        `${gatePath}: a resolver that never answered was reported healthy`);
      assert(elapsed < 20_000,
        `${gatePath}: the probe took ${elapsed}ms to give up, which is not a bound worth having`);
    }
  });

  await test('THE MOUNT GATE REFUSES A CORPUS ON WHICH ITS "PAST 90%" READ WOULD NOT BE PAST 90%', () => {
    // THE DIVERGENCE. The REAL gate's `verify.cjs` was corrected to COMPUTE its windows, because an operator
    // chooses those sizes — see the test above. The MOUNT gate's copy still CLAMPS a fixed 64 KiB window back
    // inside the object, which is the arithmetic that correction replaced:
    //
    //   below 655,360 bytes the clamp pulls the "past 90%" read BELOW 90%;
    //   at 65,536 bytes or less it pulls it to offset ZERO, where it becomes byte-for-byte identical to the
    //   backward read and the distinct-windows check FAILS A CORRECT MOUNT.
    //
    // THIS GATE'S CORPUS IS ITS OWN AND IS 8 MiB, so the defect is LATENT here rather than live — which is
    // exactly why it survived the correction to its sibling. The cold pass depends on the shifted offsets
    // staying where they are, so the fix is a refusal rather than new arithmetic: the gate now declines a
    // corpus on which the window would not be what it is named, instead of reading below 90% in silence.
    const oldClamp = (offset: number, length: number, size: number): number =>
      Math.max(0, Math.min(offset, size - length));
    assert(oldClamp(Math.floor(65_536 * 0.91), 65_536, 65_536) === 0,
      'the old arithmetic must be shown to collapse the tail read onto offset zero');
    assert(oldClamp(Math.floor(100_000 * 0.91), 65_536, 100_000) < Math.floor(100_000 * 0.9),
      'and to pull it below the 90% line it is named for');

    const { script } = extract('deploy/projection-torbox-mount-gate.sh', 'verify.cjs');
    const SHIFT = 131_072;

    const runAt = (size: number): { code: number; out: string } => {
      const dir = mkdtempSync(join(tmpdir(), 'tbmountverify-'));
      const mount = join(dir, 'mnt');
      mkdirSync(mount);
      writeFileSync(join(mount, 'object-1.bin'), objectBytes(`size-${size}`, 0, size));
      const objectsPath = join(dir, 'objects.json');
      writeFileSync(objectsPath, JSON.stringify([{
        label: 'object-1', ref: REF_TORRENT, sizeBytes: size,
        probeDigests: [{ offset: 0, length: 65_536, sha256: '0'.repeat(64) }],
      }]), 'utf8');
      return runNode(script, [objectsPath, mount, join(dir, 'reads.json'), String(SHIFT)]);
    };

    // THE SIZES THE OLD ARITHMETIC READ BELOW 90% ON ARE NOW REFUSED BY NAME rather than measured wrongly.
    for (const size of [65_536, 100_000, 655_359]) {
      const run = runAt(size);
      assert(run.code !== 0,
        `an object of ${size} bytes was accepted, and its "past 90%" read would not have been past 90%`);
      assert(/past 90%|not past 90/.test(run.out),
        `${size}: the refusal must name the property it could not honour, got: ${run.out.slice(0, 200)}`);
    }

    // AND THE CORPUS THE GATE ACTUALLY SHIPS STILL PASSES, so the refusal is a floor and not a wall.
    const good = runAt(8 * 1024 * 1024);
    assert(good.code === 0, `the gate's own 8 MiB corpus was refused: ${good.out.slice(0, 300)}`);

    // THE SHIPPED CORPUS MUST STAY ABOVE THAT FLOOR, or the gate acquires the defect back by a corpus edit.
    const gate = repoFile('deploy/projection-torbox-mount-gate.sh');
    const declared = /^TB_SIZE=\$\(\((\d+) \* 1024 \* 1024\)\)$/m.exec(gate);
    assert(declared !== null, 'the mount gate must declare its corpus size in one readable place');
    assert(Number(declared[1]) * 1024 * 1024 >= 655_360,
      `the shipped corpus is ${String(declared[1])} MiB, below the floor its own verify step now enforces`);
  });

  // -------------------------------------------------------------------------------------------------------
  // THE REAL RUN — what the first genuine TorBox run exposed in the gate that was supposed to measure it
  // -------------------------------------------------------------------------------------------------------
  //
  // EVERY TEST BELOW PINS A DEFECT FOUND BY RUNNING THIS GATE AGAINST A REAL TORBOX ACCOUNT, and every one of
  // them fails against `6c900f4` and passes after. They share one shape: the gate made a claim in a step
  // heading or a comment, and the measurement underneath either could not fail, was never taken, or was taken
  // over the wrong scope. None of them moves a threshold.

  await test('THE REAL GATE STATS THE OBJECT, SO AN ORDINARY FILE IS PROVED AND NOT ASSUMED', () => {
    // THE DEFECT. This gate's whole claim is that a TorBox object becomes an ORDINARY FILE, and nothing had
    // ever looked at the inode: the only `stat`-shaped thing in the run was a shell `ls /mnt/*.bin` used to
    // decide the mount had appeared. So a namespace publishing entries at the wrong LENGTH — the drift G7
    // asserts against on every media-server gate — passed here as long as the windows still digested, and a
    // SYMLINK out of the mount passed outright, because `openSync` follows one.
    const { script } = extract('deploy/projection-torbox-real-gate.sh', 'verify.cjs');
    const SIZE_ON_DISK = 800_000;

    const stage = (build: (mount: string) => void, declaredSize: number): { code: number; out: string;
      record: { problems: number; results: { kind: string; match: boolean; size?: number }[] } | undefined } => {
      const dir = mkdtempSync(join(tmpdir(), 'tbstat-'));
      const mount = join(dir, 'mnt');
      mkdirSync(mount);
      build(mount);
      const objectsPath = join(dir, 'objects.json');
      writeFileSync(objectsPath, JSON.stringify([
        { label: 'object-1', ref: REF_TORRENT, sizeBytes: declaredSize },
      ]), 'utf8');
      const out = join(dir, 'reads.json');
      const run = runNode(script, [objectsPath, mount, out]);
      return { ...run, record: existsSync(out)
        ? JSON.parse(readFileSync(out, 'utf8')) as never : undefined };
    };

    // A CORRECT MOUNT STILL PASSES, and records the stat it took.
    const good = stage((mount) => {
      writeFileSync(join(mount, 'object-1.bin'), objectBytes('stat-ok', 0, SIZE_ON_DISK));
    }, SIZE_ON_DISK);
    assert(good.code === 0, `a correct object was refused: ${good.out.slice(0, 300)}`);
    assert(good.record?.results.some((entry) => entry.kind === 'stat' && entry.match) === true,
      'a passing run must record the stat it took, or the assertion is unreadable from the evidence');

    // A LENGTH THAT DISAGREES WITH THE MANIFEST FAILS. It is LARGER on disk than declared on purpose: a
    // shorter file already failed the byte counts, so only the larger case proves the stat is what caught it.
    const wrongSize = stage((mount) => {
      writeFileSync(join(mount, 'object-1.bin'), objectBytes('stat-big', 0, SIZE_ON_DISK + 4096));
    }, SIZE_ON_DISK);
    assert(wrongSize.code !== 0,
      'an object published at a length the manifest does not declare was accepted');
    assert(wrongSize.record?.results.some((entry) => entry.kind === 'stat' && !entry.match) === true,
      'and the failure was not attributed to the stat');

    // A SYMLINK IS NOT AN ORDINARY FILE, even when reading through it returns exactly the right bytes.
    if (process.platform !== 'win32') {
      const symlinked = stage((mount) => {
        const real = join(mount, 'elsewhere.dat');
        writeFileSync(real, objectBytes('stat-ok', 0, SIZE_ON_DISK));
        symlinkSync(real, join(mount, 'object-1.bin'));
      }, SIZE_ON_DISK);
      assert(symlinked.code !== 0,
        'a symlink whose target held exactly the right bytes was accepted as an ordinary file');
    }
  });

  await test('THE REAL GATE\'S READS ARE BOUNDED, SO A STALLED CDN FAILS IT RATHER THAN HANGING IT', () => {
    // THE DEFECT, AND IT IS THE ONE §6.11 RECORDED FOR THE RESOLVER PROBE, IN THE READ PATH INSTEAD. This
    // program is the only place in this gate where a real provider sits behind a system call, and it had no
    // deadline of any kind: it recorded `elapsedMs` on every window and asserted nothing against it. A CDN
    // that accepted the connection and then stalled left the gate waiting for ever — no assertion, no
    // cleanup, no report — and a gate that hangs is worse than one that fails, because nothing reports a hang.
    const { script } = extract('deploy/projection-torbox-real-gate.sh', 'verify.cjs');
    const dir = mkdtempSync(join(tmpdir(), 'tbdead-'));
    const mount = join(dir, 'mnt');
    mkdirSync(mount);
    writeFileSync(join(mount, 'object-1.bin'), objectBytes('deadline', 0, 800_000));
    const objectsPath = join(dir, 'objects.json');
    writeFileSync(objectsPath, JSON.stringify([
      { label: 'object-1', ref: REF_TORRENT, sizeBytes: 800_000 },
    ]), 'utf8');

    const runWith = (deadline: string | undefined): { code: number; out: string } => {
      const env = { ...process.env };
      if (deadline === undefined) delete env.PROJECTION_GATE_READ_DEADLINE_MS;
      else env.PROJECTION_GATE_READ_DEADLINE_MS = deadline;
      const result = spawnSync(process.execPath, [script, objectsPath, mount, join(dir, 'reads.json')],
        { encoding: 'utf8', env });
      return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
    };

    // WITH THE CEILING LOWERED BELOW ANY POSSIBLE READ, every window is over its deadline and the run fails.
    // This executes the SHIPPED bytes; it does not read the constant out of them. The value is negative so
    // that it bites deterministically: a local 64 KiB read can genuinely take 0 ms, and a 0 ms budget would
    // then be a race against the page cache rather than a test.
    const tight = runWith('-1');
    assert(tight.code !== 0,
      'with the deadline at zero the shipped verify program still reported no problems, so it asserts '
      + 'nothing against the elapsed times it records');
    const tightRecord = JSON.parse(readFileSync(join(dir, 'reads.json'), 'utf8')) as {
      results: { kind: string; budgetMs?: number }[] };
    assert(tightRecord.results.some((entry) => entry.kind === 'deadline'),
      'and the failure was not attributed to a deadline');

    // THE SEAM CAN ONLY TIGHTEN. A run that asks for an hour gets the built-in two minutes, so nothing in an
    // environment can widen the ceiling a real run is held to.
    const loosened = runWith(String(60 * 60 * 1000));
    assert(loosened.code === 0, 'an ordinary read failed under a loosened deadline, which should be capped');
    const loosenedRecord = JSON.parse(readFileSync(join(dir, 'reads.json'), 'utf8')) as {
      results: { kind: string; budgetMs?: number }[] };
    assert(!loosenedRecord.results.some((entry) => entry.kind === 'deadline'),
      'a loosened deadline must simply be ignored');
    for (const bad of ['not-a-number', '']) {
      assert(runWith(bad).code === 0, `an unparseable deadline (${bad}) must fall back, not crash`);
    }
    assert(runWith(undefined).code === 0, 'and the gate\'s own run, which sets nothing, must pass');

    // AND THE GATE ITSELF NEVER SETS IT, so the seam cannot be reached by running the gate.
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');
    assert(!/PROJECTION_GATE_READ_DEADLINE_MS=/.test(gate),
      'the gate sets the test seam itself, which would make the deadline configurable by a real run');

    // AND THE CEILING IS ONE VALUE, NOT THREE COPIES OF ONE. `verify.cjs` is a heredoc and cannot import, so
    // its ceiling is a re-typed literal; the shell derives the outer bound from a second copy of the same
    // number; and the contract itself lives in `real-provider.ts`. Nothing compared them, so they could
    // drift silently and the gate would go on citing the module's name for a number that was no longer its.
    const ceiling = /^const DEADLINE_CEILING_MS = (\d+);$/m.exec(heredoc(
      'deploy/projection-torbox-real-gate.sh', 'verify.cjs'));
    assert(ceiling !== null, 'verify.cjs no longer states its ceiling in one readable place');
    assert(Number(ceiling[1]) === MOUNT_READ_DEADLINE_MS,
      `verify.cjs bounds a window at ${String(ceiling[1])} ms while the contract in real-provider.ts says `
      + `${MOUNT_READ_DEADLINE_MS} ms`);
    const windowSeconds = /^READ_WINDOW_DEADLINE_S=(\d+)$/m.exec(gate);
    assert(windowSeconds !== null, 'the gate no longer states the per-window deadline it derives the bound from');
    assert(Number(windowSeconds[1]) * 1000 === MOUNT_READ_DEADLINE_MS,
      `the gate derives its outer bound from ${String(windowSeconds[1])}s per window while the contract is `
      + `${MOUNT_READ_DEADLINE_MS} ms`);
  });

  await test('A WINDOW THAT CANNOT BE READ IS RECORDED WITH ITS ERRNO, NOT THROWN AS A STACK TRACE', () => {
    // THIS DEFECT WAS FOUND BY A REAL RUN, AND IT IS THE ONE THE FAILURE-PATH EVIDENCE EXISTS FOR.
    //
    // TorBox rotates the CDN origin it hands back. When the operator's `allowedOrigins` went stale the
    // daemon refused the resolved URL — correctly, that is what the egress allowlist is — and the mount
    // answered EIO. `verify.cjs` let that escape as an uncaught exception and died at the FIRST window, so
    // no `reads.json` was ever written, the gate's failure-path preservation had nothing to preserve, and
    // the operator got a Node stack trace instead of a record naming the window and the errno. The single
    // case the evidence is for produced none.
    const { script } = extract('deploy/projection-torbox-real-gate.sh', 'verify.cjs');
    const size = 400_000;

    // AN UNREADABLE REGULAR FILE OF THE RIGHT LENGTH, so `lstat` passes and only the READ can fail — which
    // is the shape a wedged or refused mount presents. Mode 000 does that for any uid except root, so when
    // the suite runs as root (the tranche-closing host does) the child drops to 65534 first.
    if (process.platform === 'win32') {
      skipBlock('reading an unreadable window (Windows has no mode that refuses the owner)');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'tbeio-'));
    const mount = join(dir, 'mnt');
    mkdirSync(mount);
    const objectPath = join(mount, 'object-1.bin');
    writeFileSync(objectPath, objectBytes('eio', 0, size));
    const objectsPath = join(dir, 'objects.json');
    writeFileSync(objectsPath, JSON.stringify([
      { label: 'object-1', ref: REF_TORRENT, sizeBytes: size },
    ]), 'utf8');
    // The unprivileged child has to be able to reach everything EXCEPT the object's bytes, and to WRITE the
    // record — which is the point of the test, so its destination is the one directory it may write to.
    const outDir = join(dir, 'out');
    mkdirSync(outDir);
    const readsPath = join(outDir, 'reads.json');
    for (const path of [dir, mount]) chmodSync(path, 0o755);
    chmodSync(outDir, 0o777);
    chmodSync(objectsPath, 0o644);
    chmodSync(objectPath, 0o000);

    // THE SHIPPED PROGRAM IS COPIED SOMEWHERE THE DROPPED UID CAN READ IT. `extract` leaves it in its own
    // 0700 temp directory, which the child cannot traverse once it has given up root — so `require` would
    // fail for a reason that has nothing to do with what this test measures.
    const program = join(dir, 'verify.cjs');
    writeFileSync(program, readFileSync(script, 'utf8'), 'utf8');
    chmodSync(program, 0o644);

    const runner = join(dir, 'runner.cjs');
    writeFileSync(runner,
      '// Drop privileges where there are any to drop; where there are none, mode 000 already refuses us.\n'
      + 'try { process.setgid(65534); process.setuid(65534); } catch { /* not root: nothing to drop */ }\n'
      + `process.argv = [process.argv[0], ${JSON.stringify(shPath(program))}, `
      + `${JSON.stringify(shPath(objectsPath))}, ${JSON.stringify(shPath(mount))}, `
      + `${JSON.stringify(shPath(readsPath))}];\n`
      + `require(${JSON.stringify(shPath(program))});\n`);
    const result = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
    const out = `${result.stdout}${result.stderr}`;

    assert(result.status !== 0, 'an unreadable object was reported as a clean run');
    assert(!/at readSync|Error: EACCES|Error: EIO/.test(out),
      `the failure escaped as an uncaught exception instead of being recorded: ${out.slice(0, 300)}`);
    assert(existsSync(readsPath),
      'no reads.json was written, so a failing run has nothing for the gate to preserve — which is the '
      + 'exact case the failure-path copy exists for');
    const record = JSON.parse(readFileSync(readsPath, 'utf8')) as {
      problems: number; results: { kind: string; match: boolean; error?: string }[] };
    assert(record.problems > 0, 'the unreadable windows were not counted as problems');
    const failed = record.results.filter((entry) => entry.error !== undefined);
    assert(failed.length > 0, 'no window recorded the errno behind its failure, which is the whole diagnosis');
    assert(failed.every((entry) => entry.match === false),
      'a window that could not be read was recorded as matching');
    // EVERY WINDOW IS ATTEMPTED, so the record names all of them rather than stopping at the first.
    assert(record.results.filter((entry) => ['tail', 'backward'].includes(entry.kind)).length === 2,
      'the program stopped at the first failure instead of recording every window it was asked for');
    // AND THE INVENTED SECOND PROBLEM IS GONE: two unreadable windows both digest to nothing, which used to
    // compare equal and add a distinctness failure on top of the real one.
    const distinct = record.results.find((entry) => entry.kind === 'distinct-windows');
    assert(distinct !== undefined && distinct.match === true,
      'two unreadable windows were reported as a distinctness failure as well as an I/O one');

    chmodSync(objectPath, 0o644);
  });

  await test('THE OUTER READ BOUND BINDS A CHILD THAT IGNORES SIGTERM, AND HAS NO KNOB TO LOOSEN IT', async () => {
    // TWO DEFECTS, AND THE FIRST IS THAT THE BOUND DID NOT BOUND THE HANG IT WAS WRITTEN FOR.
    //
    // `timeout N cmd` sends SIGTERM and then WAITS for the child. A child SIGTERM cannot stop makes `timeout`
    // block for exactly as long as the child does and only then return 124 — so the elapsed time is the
    // child's, not the bound's. The scenario the step names is a read blocked in the kernel against a wedged
    // FUSE mount, where Linux waits with `wait_event_killable` and only a FATAL signal gets through: the
    // exact case the flag-less form claimed to have closed and did not. The old test could not see this,
    // because it matched the command line rather than running it.
    //
    // THE SECOND IS THAT THE STEP CARRIED AN UNVALIDATED ENVIRONMENT KNOB THAT COULD ONLY LOOSEN.
    // `PROJECTION_TORBOX_REAL_GATE_READ_TIMEOUT_S` raised the ceiling without limit, and GNU `timeout` reads
    // a duration of `0` as NO TIMEOUT AT ALL — so `…=0` removed the bound outright while the gate went on
    // reporting the property as proven. It is gone, and the bound is derived from the corpus instead.
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');

    assert(!/PROJECTION_TORBOX_REAL_GATE_READ_TIMEOUT_S/.test(gate.replace(/^#.*$/gm, '')),
      'the read bound is still reachable from the environment, where it can only be loosened');
    assert(/^READ_TIMEOUT_S=\$\(\( READ_WINDOWS \* READ_WINDOW_DEADLINE_S \* 2 \+ 60 \)\)$/m.test(gate),
      'the outer bound is not derived from the corpus, so it is a fixed number defended by an argument '
      + 'nothing enforces');
    assert(/READ_WINDOWS" -ge 1/.test(gate) && /''\|\*\[!0-9\]\*\) die/.test(gate),
      'a corpus that yields no window count, or a non-numeric one, must fail closed rather than produce an '
      + 'empty or nonsensical bound');

    if (process.platform === 'win32') {
      // NOT MERELY "needs a shell": Git Bash is present on this host and `posixShell` finds it. What this
      // block needs is POSIX SIGNAL DELIVERY — a child that installs `trap "" TERM` and a `timeout` whose
      // SIGTERM and SIGKILL reach it as signals rather than as emulated process termination. Naming the
      // shell as the missing thing would be wrong now that one is selected and verified.
      skipBlock('driving the shipped `bounded_read` against a SIGTERM-ignoring child '
        + '(needs POSIX signal delivery, which win32 does not provide even under a POSIX shell)');
      return;
    }
    if (posixShell() === null) { skipBlock(`${NO_SHELL} — \`bounded_read\` was not driven`); return; }

    // THE SHIPPED FUNCTION, EXECUTED. The harness supplies the grace the way the `mount_refuses` harness
    // supplies WORK and VERIFY_IMAGE — the gate's own constant is a literal assignment, not a knob, and is
    // asserted separately below.
    const start = gate.indexOf('bounded_read() {');
    assert(start !== -1, 'the gate no longer defines bounded_read');
    const body = gate.slice(start, gate.indexOf('\n}\n', start) + 3);

    const runHarness = (script: string): { code: number; elapsedMs: number } => {
      const dir = mkdtempSync(join(tmpdir(), 'tbbound-'));
      const harness = join(dir, 'harness.sh');
      writeFileSync(harness, script);
      const began = Date.now();
      const result = spawnSync(shellOrThrow(), [shPath(harness)], { encoding: 'utf8', timeout: 60_000 });
      const status = /STATUS=(\d+)/.exec(`${result.stdout}${result.stderr}`);
      return { code: status === null ? -1 : Number(status[1]), elapsedMs: Date.now() - began };
    };

    const drive = (command: string): { code: number; elapsedMs: number } => runHarness(
      'set -uo pipefail\n'
      + 'READ_KILL_GRACE_S=1\n'
      + `${body}\n`
      + `bounded_read 1 ${command}\n`
      + 'echo "STATUS=$?"\n');

    // THE CONTROL, AND IT IS WHY THIS TEST EXISTS RATHER THAN A REGEX. This is the form the gate shipped
    // before the correction — `timeout N cmd`, no `--kill-after` — driven against the same child, in the same
    // harness. It must be SEEN not to bind: `timeout` sends SIGTERM, the child ignores it, and `timeout`
    // then waits for the child and returns 124 only after the child's own 8 seconds have elapsed. A test
    // that matched the command line could not tell these two apart, because the only difference is a flag.
    const unbounded = runHarness(
      'set -uo pipefail\n'
      + `timeout 1 sh -c 'trap "" TERM; sleep 8'\n`
      + 'echo "STATUS=$?"\n');
    assert(unbounded.elapsedMs > 5_000,
      `the flag-less form was expected to overrun its own 1s bound and took only ${unbounded.elapsedMs} ms; `
      + 'this control has stopped measuring what it was written to measure');

    // A CHILD THAT IGNORES SIGTERM IS KILLED, and — the whole point — it does not outlive the bound plus the
    // grace. Against the flag-less form this child runs its full 20 s and `timeout` returns only after it.
    const stubborn = drive(`sh -c 'trap "" TERM; sleep 8'`);
    assert(stubborn.code === 137,
      `a SIGTERM-ignoring child must be KILLED (137); got ${stubborn.code}. Without --kill-after, timeout `
      + 'waits for it and the bound does not bind');
    assert(stubborn.elapsedMs < unbounded.elapsedMs,
      `the shipped form took ${stubborn.elapsedMs} ms against the flag-less form's ${unbounded.elapsedMs} ms `
      + 'on the same child, so the flag is not what is doing the bounding');
    assert(stubborn.elapsedMs < 5_000,
      `the child outlived the bound and its grace by ${stubborn.elapsedMs} ms, so the bound did not bind`);

    // AN ORDINARY OVERRUN IS STILL A PLAIN 124, so the two outcomes stay distinguishable in the case
    // statement that reports them.
    const ordinary = drive(`sh -c 'sleep 8'`);
    assert(ordinary.code === 124, `a terminable overrun must be 124; got ${ordinary.code}`);

    // AND A COMMAND THAT FINISHES INSIDE THE BOUND IS UNTOUCHED.
    const quick = drive(`sh -c 'exit 0'`);
    assert(quick.code === 0, `a command inside the bound must pass through its own status; got ${quick.code}`);

    // THE GRACE THE GATE SHIPS IS A BOUNDED POSITIVE LITERAL, not something an environment supplies.
    const grace = /^READ_KILL_GRACE_S=(\d+)$/m.exec(gate);
    assert(grace !== null, 'the gate no longer states its kill grace in one readable place');
    assert(Number(grace[1]) > 0 && Number(grace[1]) <= 300,
      `the kill grace is ${String(grace[1])}s, which is not a bounded positive period`);

    // EVERY `timeout` OUTCOME IS NAMED. 125/126/127 mean `timeout` ITSELF failed, so the read was never
    // bounded — reporting that as "reads through the mount failed" is the same conflation `mount_refuses`
    // was corrected for one step below.
    for (const [status, phrase] of [['124', 'did not finish'], ['137', 'ignored SIGTERM'],
      ['125|126|127', 'could not be bounded']] as const) {
      assert(new RegExp(`^  ${status}\\)`, 'm').test(gate),
        `the gate does not treat ${status} as its own outcome`);
      assert(gate.includes(phrase), `and does not say "${phrase}" for it`);
    }
  });

  await test('THE REAL GATE\'S READ-ONLY PROBE CANNOT REPORT A REFUSAL IT NEVER MEASURED', () => {
    // THE DEFECT, AND IT IS THE `wget` DEFECT AGAIN. The four read-only assertions ran
    // `docker run … && echo no || echo yes` and read EVERY non-zero exit as "the mount refused it". `docker
    // run` answers 125 when the daemon refuses the run, 126 when the entrypoint is not executable and 127
    // when it is not found — so a broken image, a missing device or a Docker outage produced exactly the exit
    // code the gate read as proof that the mount is read-only. All four could pass without the mount being
    // consulted once.
    //
    // AND A SECOND THING THE REWRITE DID NOT FIX AT FIRST: the probe ran as 65534 with every capability
    // dropped, so `rm`, `chmod` and an append would be refused by ordinary ownership and permission rules
    // against a perfectly WRITABLE filesystem. The measurement was real; the conclusion "the mount is
    // read-only" did not follow from it. The gate now probes a second time as uid 0 with the default
    // capability set — where `DAC_OVERRIDE` makes permission bits inapplicable — and then reads the errno
    // behind the refusal instead of inferring it.
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');

    // THE STRUCTURAL HALF RUNS EVERYWHERE. It is what makes this test bite on Windows, where the driven half
    // below cannot run at all — and the old unconditional `return` meant a Windows reader saw this line
    // green while nothing in it had been evaluated.
    assert(!/^refused\(\) \{/m.test(gate),
      'the two-valued refusal probe is still defined in this gate');
    assert(!/\$\(refused /.test(gate), 'and something still calls it');
    assert(/mount_refuses 65534:65534 .*--cap-drop ALL/.test(gate),
      'the probe does not name the uid it runs as, so there is only one of them — and a single unprivileged '
      + 'probe cannot attribute the refusal to the mount rather than to ownership and mode bits');
    assert(/mount_refuses 0:0 /.test(gate),
      'nothing probes as a uid permission rules cannot refuse, so a refusal here is not attributable to the '
      + 'mount being read-only');
    assert(/ROFS_REASON=/.test(gate) && /\[Rr\]ead-only/.test(gate),
      'the gate never reads the errno behind the refusal, so it reports a property it inferred');
    assert(/die "a privileged create through the mount was refused, but not because/.test(gate),
      'and a refusal for some other reason is not treated as the failure it is');

    // AND THE ERRNO PROBE CANNOT MISATTRIBUTE A BROKEN DOCKER, BECAUSE IT NEVER SEES ONE.
    //
    // `ROFS_REASON` captures whatever the privileged `touch` printed and fails unless it names a read-only
    // file system — so on a host where `docker run` itself failed, its message would be a daemon error and
    // the die text would blame the mount for something Docker did. That is unreachable only because
    // `mount_refuses 0:0` runs FIRST and already dies on 125/126/127, and "unreachable because of the order
    // two things happen in" is exactly the kind of property that stops being true when somebody moves one.
    // So the order is pinned here rather than left to be rediscovered.
    const privilegedCreate = gate.indexOf('mount_refuses 0:0 "a file creation"');
    const errnoProbe = gate.indexOf('ROFS_REASON=');
    assert(privilegedCreate !== -1 && errnoProbe !== -1,
      'the privileged create probe or the errno probe is gone');
    assert(privilegedCreate < errnoProbe,
      'the errno probe now runs BEFORE the privileged create that classifies a docker failure, so a broken '
      + '`docker run` would be reported as the mount being refused for the wrong reason');
    // The classification it depends on must still be the three-valued one.
    assert(/125\|126\|127\) die "the mount's refusal of \$_what as \$_who could not be measured/.test(gate),
      'the probe no longer classifies a docker failure as unmeasured, which is what keeps the errno probe '
      + 'from ever seeing one');

    if (process.platform === 'win32') {
      // The harness puts a stub `docker` first on PATH, which needs the POSIX `:` separator and an
      // executable bit; neither exists on win32, and a selected shell does not supply them.
      skipBlock('driving the shipped `mount_refuses` against a stub `docker` '
        + '(needs a PATH-injected executable, which win32 has no separator or exec bit for)');
      return;
    }
    if (posixShell() === null) { skipBlock(`${NO_SHELL} — \`mount_refuses\` was not driven`); return; }
    const start = gate.indexOf('mount_refuses() {');
    assert(start !== -1, 'the gate no longer defines mount_refuses');
    const body = gate.slice(start, gate.indexOf('\n}\n', start) + 3);

    // The shipped function, executed against a stub `docker` that exits with whatever it is told to.
    const drive = (dockerExit: number): { code: number; out: string } => {
      const dir = mkdtempSync(join(tmpdir(), 'tbrefuse-'));
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'docker'), `#!/bin/sh\nexit ${dockerExit}\n`);
      chmodSync(join(bin, 'docker'), 0o755);
      const harness = join(dir, 'harness.sh');
      writeFileSync(harness,
        'set -euo pipefail\n'
        + 'die() { echo "GATE FAILED: $*" >&2; exit 1; }\n'
        + 'WORK=/nonexistent\nVERIFY_IMAGE=stub\n'
        + `${body}\n`
        + 'mount_refuses 0:0 "a write" "echo x >> /mnt/object-1.bin"\n'
        + 'echo REFUSED-AND-CONTINUED\n');
      const result = spawnSync(shellOrThrow(), [shPath(harness)], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
    };

    // 0 — THE MOUNT ACCEPTED IT. The one outcome that must fail the gate as a data-plane defect.
    const accepted = drive(0);
    assert(accepted.code !== 0, 'a mount that ACCEPTED the write was not failed');
    assert(/accepted a write/.test(accepted.out), 'and the failure did not name what was accepted');

    // 125/126/127 — THE PROBE ITSELF FAILED. Unmeasured, and unmeasured is not a pass.
    for (const broken of [125, 126, 127]) {
      const unmeasured = drive(broken);
      assert(unmeasured.code !== 0,
        `docker exiting ${broken} was read as the mount refusing the write, which is the defect`);
      assert(/could not be measured/.test(unmeasured.out),
        `and exit ${broken} did not say the measurement never happened`);
    }

    // ANY OTHER NON-ZERO — the refusal the kernel actually returned, which is what the gate is looking for.
    const refused = drive(1);
    assert(refused.code === 0 && /REFUSED-AND-CONTINUED/.test(refused.out),
      'a genuine refusal (exit 1) did not let the gate continue');

    // AND THE OLD INSTRUMENT IS GONE, so the three-valued one cannot be bypassed by the shape beside it.
    // Matched on the SHAPES rather than on the prose: the comment above the replacement quotes the defect
    // it replaced, and a test that searched for that sentence would fail on the fix that removed it.
    assert(!/^refused\(\) \{/m.test(gate),
      'the two-valued refusal probe is still defined in this gate');
    assert(!/\$\(refused /.test(gate), 'and something still calls it');
  });

  await test('THE REAL GATE COUNTS THE RESOLUTIONS THE SHIPPED RESOLVER ACTUALLY LOGS', async () => {
    // TWO THINGS WERE ASSERTED BY NOTHING, AND THEY ARE OPPOSITE HALVES OF ONE MEASUREMENT.
    //
    // Nothing required a resolution to have HAPPENED: every ceiling in this gate is satisfied by a run that
    // contacted nothing, which is exactly why the generic gate asserts a positive byte count. And nothing
    // bounded how OFTEN the daemon resolved: a data plane that re-minted access material for every window
    // would read the same correct bytes, pass, and spend the operator's metered rate limit once per read.
    //
    // THE PATTERN IS PINNED TO THE SERVICE'S REAL OUTPUT RATHER THAN TO A STRING SOMEBODY BELIEVED IT EMITS.
    // A measurement that greps for a log line is only a measurement while that line exists; renaming it would
    // silently turn the count into a constant zero, and the gate would then fail closed on ">= 1" — but only
    // if the pattern is proved against what the shipped service really writes. So it is.
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');
    const declared = /grep -cE '([^']+)' \\\n\s+"\$WORK\/out\/log-\$RESOLVER_CONTAINER\.txt"/.exec(gate);
    assert(declared !== null, 'the gate no longer counts resolutions out of the resolver log');
    const pattern = new RegExp(declared[1] as string);

    const captured: string[] = [];
    const realLog = console.log;
    const live = await harness();
    try {
      console.log = (...args: unknown[]): void => { captured.push(args.map(String).join(' ')); };
      const resolved = await askResolver(live.resolverUrl, REF_TORRENT);
      console.log = realLog;
      assert(resolved.status === 200, 'the fixture resolution did not succeed');
    } finally { console.log = realLog; await live.close(); }

    const lines = captured.filter((line) => pattern.test(line));
    assert(lines.length === 1,
      `the gate's own pattern matched ${lines.length} of the shipped resolver's ${captured.length} log `
      + 'line(s) for one successful resolution; the count it computes is therefore not the count of '
      + 'resolutions');
    // AND IT MATCHES NOTHING ELSE THE SERVICE SAYS, or a refusal would inflate the count.
    assert(!captured.filter((line) => !lines.includes(line)).some((line) => pattern.test(line)),
      'the pattern also matches a line that is not a successful resolution');

    // AND THE TWO BOUNDS MEET, WHICH IS WHAT "EXACTLY ONE PER OBJECT" MEANS. The lower bound used to be
    // `-ge 1`: on the one-object corpus actually run it coincides with the sentence above it, and on the two-
    // and three-object corpora §2 allows it does not — a run that resolved ONE of three objects and served
    // the other two from somewhere else satisfied it. Together with the unchanged `-le`, `-ge $OBJECT_COUNT`
    // is an equality.
    assert(/RESOLUTIONS" -ge "\$OBJECT_COUNT"/.test(gate),
      'the lower bound is not one resolution PER OBJECT, so a multi-object corpus can pass with some object '
      + 'never resolved at all');
    assert(/RESOLUTIONS" -le "\$OBJECT_COUNT"/.test(gate),
      'the gate does not bound resolutions to one per object, so a resolution storm would pass');
    assert(!/RESOLUTIONS" -ge 1\b/.test(gate), 'the weaker lower bound survives somewhere in this gate');

    // AND THE COUNT IT IS COMPARED AGAINST IS THE CORPUS'S OWN, taken from the file `register.cjs` wrote
    // during preflight rather than from anything the run could influence later.
    assert(/OBJECT_COUNT="\$\(node "\$REL\/jq\.cjs" objects < "\$WORK\/out\/register\.json"\)"/.test(gate),
      'the object count no longer comes from the registered corpus');
  });

  await test('THE REGISTER PLAN COUNTS THE WINDOWS THE READ STEP WILL ACTUALLY OPEN', () => {
    // THE OUTER READ BOUND IS DERIVED FROM THIS NUMBER, so a wrong one is a bound that kills a legitimate
    // slow-but-bounded run and reports it as a hang — which is what the flat 3600 s it replaced could do,
    // because `probeDigests` has no cardinality cap and the comment defending 3600 assumed one.
    //
    // IT MUST MATCH WHAT `verify.cjs` ITERATES, so both shipped programs are run against the same corpus and
    // the count is compared to the reads that actually happened.
    const corpora = [
      { probes: 0, whole: false }, { probes: 1, whole: false },
      { probes: 4, whole: false }, { probes: 2, whole: true },
    ];
    for (const shape of corpora) {
      const dir = mkdtempSync(join(tmpdir(), 'tbwin-'));
      const size = 800_000;
      const mount = join(dir, 'mnt');
      mkdirSync(mount);
      const bytes = objectBytes('windows', 0, size);
      writeFileSync(join(mount, 'object-1.bin'), bytes);
      const probeDigests = Array.from({ length: shape.probes }, (_unused, index) => ({
        offset: index * 4096,
        length: 4096,
        sha256: createHash('sha256').update(bytes.subarray(index * 4096, index * 4096 + 4096)).digest('hex'),
      }));
      const object: Record<string, unknown> = {
        label: 'object-1', ref: REF_TORRENT, sizeBytes: size, probeDigests,
      };
      if (shape.whole) object.sha256 = createHash('sha256').update(bytes).digest('hex');
      const objectsPath = join(dir, 'objects.json');
      writeFileSync(objectsPath, JSON.stringify([object]), 'utf8');
      writeFileSync(join(dir, 'endpoint.json'), JSON.stringify({ id: 'torbox-real' }), 'utf8');

      const register = extract('deploy/projection-torbox-real-gate.sh', 'register.cjs');
      const summaryPath = join(dir, 'register.json');
      const planned = runNode(register.script, [summaryPath, objectsPath, join(dir, 'endpoint.json')]);
      assert(planned.code === 0, `register.cjs failed: ${planned.out.slice(0, 200)}`);
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as { readWindows?: number };
      assert(typeof summary.readWindows === 'number',
        'register.cjs writes no window count, so the read bound has nothing to be derived from');

      const verify = extract('deploy/projection-torbox-real-gate.sh', 'verify.cjs');
      const readsPath = join(dir, 'reads.json');
      const ran = runNode(verify.script, [objectsPath, mount, readsPath]);
      assert(ran.code === 0, `verify.cjs failed on a ${shape.probes}-probe corpus: ${ran.out.slice(0, 300)}`);
      const reads = JSON.parse(readFileSync(readsPath, 'utf8')) as {
        results: { kind: string }[] };
      // Everything that OPENS the object: the approved windows, the whole-object read where one was
      // recorded, and the two the gate adds. `stat` and `distinct-windows` open nothing.
      const opened = reads.results.filter((entry) =>
        ['probe', 'whole', 'tail', 'backward'].includes(entry.kind)).length;
      assert(summary.readWindows === opened,
        `register.cjs planned ${String(summary.readWindows)} window(s) for a corpus verify.cjs opened `
        + `${opened} on`);
    }
  });

  await test('THE REAL GATE FAILS CLOSED ON A LOG IT COULD NOT CAPTURE, AND CHECKS BOTH OF THEM', () => {
    // TWO DEFECTS IN ONE STEP, BOTH OF THE "A ZERO THAT MEANS DID NOT LOOK" KIND `scan.cjs` WAS CORRECTED FOR.
    //
    // The capture was `docker logs … || true`, so a capture that failed left an EMPTY file — and an empty
    // file holds no secret and no reference, so the leak scan and the reference grep both reported the
    // property proven over a file the run never managed to write.
    //
    // And the reference grep looked at exactly ONE file, the resolver's, under a step heading that says no
    // reference reached anything this run wrote. The DAEMON holds the same reference: it is the `objectRef`
    // it POSTs on every resolution and the source string it carries all run, and its log was never examined.
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');
    const step = gate.slice(gate.indexOf('NO SECRET AND NO REFERENCE REACHED ANYTHING THIS RUN WROTE'));

    // THE REFERENCE CHECK COVERS BOTH LOGS. Matched on the loop's subject rather than its formatting.
    assert(/for container in "\$MOUNT_CONTAINER" "\$RESOLVER_CONTAINER"; do[\s\S]{0,120}grep -qE 'torbox:/
      .test(step),
    'the stable-reference check still covers only one container log, while claiming to cover everything '
      + 'this run wrote');
    assert(/capture_container_logs "\$MOUNT_CONTAINER" "\$RESOLVER_CONTAINER"/.test(step),
      'and the capture no longer covers both containers');

    if (process.platform === 'win32') {
      // Same reason as `mount_refuses` above: a stub `docker` injected onto PATH.
      skipBlock('driving the shipped `capture_container_logs` against a failing `docker` '
        + '(needs a PATH-injected executable, which win32 has no separator or exec bit for)');
      return;
    }
    if (posixShell() === null) {
      skipBlock(`${NO_SHELL} — \`capture_container_logs\` was not driven`); return;
    }

    // THE SHIPPED CAPTURE, EXECUTED AGAINST A `docker` THAT FAILS. This half used to be a pair of regexes
    // asserting that a `|| true` was absent and a `die` string present — which bit the merge base, so it was
    // not a tautology, but it pinned formatting rather than behaviour and would have survived a semantic
    // regression that reworded the line.
    const start = gate.indexOf('capture_container_logs() {');
    assert(start !== -1, 'the gate no longer defines capture_container_logs');
    const body = gate.slice(start, gate.indexOf('\n}\n', start) + 3);

    const drive = (dockerExit: number): { code: number; out: string; wrote: string[] } => {
      const dir = mkdtempSync(join(tmpdir(), 'tblogs-'));
      const bin = join(dir, 'bin');
      const work = join(dir, 'work');
      mkdirSync(bin);
      mkdirSync(join(work, 'out'), { recursive: true });
      writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "a log line"\nexit ${dockerExit}\n`);
      chmodSync(join(bin, 'docker'), 0o755);
      const harness = join(dir, 'harness.sh');
      writeFileSync(harness,
        'set -euo pipefail\n'
        + 'die() { echo "GATE FAILED: $*" >&2; exit 1; }\n'
        + `WORK=${JSON.stringify(work)}\n`
        + `${body}\n`
        + 'capture_container_logs alpha beta\n'
        + 'echo CAPTURED-BOTH\n');
      const result = spawnSync(shellOrThrow(), [shPath(harness)], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      return {
        code: result.status ?? -1,
        out: `${result.stdout}${result.stderr}`,
        wrote: readdirSync(join(work, 'out')),
      };
    };

    // A CAPTURE THAT WORKS COVERS EVERY CONTAINER IT WAS GIVEN.
    const ok = drive(0);
    assert(ok.code === 0 && /CAPTURED-BOTH/.test(ok.out), `a good capture failed: ${ok.out.slice(0, 300)}`);
    assert(ok.wrote.includes('log-alpha.txt') && ok.wrote.includes('log-beta.txt'),
      `both logs must be written; got ${ok.wrote.join(',')}`);

    // A CAPTURE THAT FAILS ENDS THE RUN. Under `|| true` this left an EMPTY file — and an empty file holds
    // no secret and no reference, so the leak scan and the reference grep both reported the property proven
    // over a file the run never managed to write.
    const broken = drive(1);
    assert(broken.code !== 0,
      'a failed log capture was swallowed, so every check below it passes over a file that was never written');
    assert(/could not be captured/.test(broken.out),
      'and the failure does not say why a capture it could not take is a failure');
    assert(!/CAPTURED-BOTH/.test(broken.out), 'and the step continued past it');
  });

  await test('THE REAL GATE ASSERTS ITS OWN CLEANUP AND KEEPS THE EVIDENCE THAT JUSTIFIES IT', () => {
    // THE DEFECT §6.11 CLOSED FOR THE GENERIC GATE AND NOT FOR THIS ONE. The only statement this gate ever
    // made about its own leftovers came from `projection_gate_report_cleanliness` inside the EXIT trap, and
    // that function's own comment explains that it can only ever REPORT: a non-zero return there overwrites
    // the gate's exit status. So the gate Phase 1 closes on could print "1 mountpoint left behind" and exit
    // 0 — and §6.5 records four dangling mountpoints from exactly that, each of which is how the NEXT run
    // inherits a namespace and passes for the wrong reason.
    //
    // AND A PASSING RUN LEFT NOTHING BEHIND AT ALL. `reads.json` is the whole record of what was read through
    // the mount, it lives only in the run directory, and the run directory is deleted — so "three consecutive
    // runs" was a claim with no substrate.
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');

    assert(/^CLEANED=0$/m.test(gate) && /CLEANED=1/.test(gate),
      'the gate has no success-path cleanup state, so the trap is still the only thing that looks');
    assert(/if \[ "\$\{CLEANED:-0\}" = "1" \]; then/.test(gate),
      'and the trap would report a second, weaker statement over the assertion');
    assert(/projection-real-provider-cli\.ts cleanup \\\n\s+--mountpoints "\$OWN_MOUNTS_LEFT" --run-directory-present "\$OWN_DIR_PRESENT"/
      .test(gate),
    'the gate does not put its own leftovers through the same verdict every other gate uses');
    assert(/die "the run cleaned up after itself incompletely/.test(gate),
      'and an incomplete cleanup does not fail the run');

    // AND THE FAILING RUN KEEPS ITS EVIDENCE TOO, which is the half the first fix left behind. Every `die`
    // leaves through the EXIT trap, and the trap unconditionally `rm -rf`s the run directory — so
    // `copy_evidence`'s "refusing to destroy the only copy" was a refusal that destroyed it a moment later,
    // and a run that failed AT the read step, where `reads.json` is the diagnosis, kept nothing at all.
    assert(/^\s+preserve_failure_evidence$/m.test(gate.slice(gate.indexOf('cleanup() {'),
      gate.indexOf('trap cleanup EXIT'))),
    'the EXIT trap deletes the run directory without first preserving the failing run\'s evidence');
    assert(!/refusing to destroy the only copy/.test(gate),
      'a die string still claims to be saving evidence that the trap it leaves through removes anyway');
    assert(/chmod 700 "\$EVIDENCE_DIR"/.test(gate),
      'the one artifact this gate deliberately leaves on the host is not mode 0700');
    assert(/^EVIDENCE_SOURCE="out\/reads\.json"$/m.test(gate),
      'the file both paths may preserve is no longer named in one place, so they can disagree about it');

    // THE COPY IS A PRECONDITION OF THE DELETION, NOT A COURTESY BESIDE IT — the same three failure modes the
    // generic gate's own copy_evidence has, executed here against THIS gate's shipped copy.
    if (process.platform === 'win32') {
      // The failure modes turn on POSIX filesystem behaviour — an ENOTDIR under a regular file, and modes
      // root cannot bypass — rather than on the shell that exercises them.
      skipBlock('driving the shipped `copy_evidence` and `preserve_failure_evidence` through their failure '
        + 'modes (needs POSIX filesystem semantics: ENOTDIR under a regular file, and modes root obeys)');
      return;
    }
    if (posixShell() === null) { skipBlock(`${NO_SHELL} — the evidence helpers were not driven`); return; }
    const start = gate.indexOf('copy_evidence() {');
    assert(start !== -1, 'the gate no longer preserves its evidence');
    const body = gate.slice(start, gate.indexOf('\n}\n', start) + 3);
    assert(gate.indexOf('copy_evidence "$EVIDENCE_SOURCE"') > start,
      'the gate defines copy_evidence and never uses it on the one file that records what was read');

    const drive = (build: (work: string, evidence: string) => void): { code: number; out: string } => {
      const dir = mkdtempSync(join(tmpdir(), 'tbevid-'));
      const work = join(dir, 'work');
      const evidence = join(dir, 'evidence');
      mkdirSync(join(work, 'out'), { recursive: true });
      mkdirSync(evidence);
      build(work, evidence);
      const harness = join(dir, 'harness.sh');
      writeFileSync(harness,
        'set -euo pipefail\n'
        + 'die() { echo "GATE FAILED: $*" >&2; exit 1; }\n'
        + `WORK=${JSON.stringify(work)}\nEVIDENCE_DIR=${JSON.stringify(evidence)}\n`
        + `${body}\n`
        + 'copy_evidence "out/reads.json" "reads-1.json"\n'
        + 'echo EVIDENCE-KEPT\n');
      const result = spawnSync(shellOrThrow(), [shPath(harness)], { encoding: 'utf8' });
      return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
    };

    const ok = drive((work) => { writeFileSync(join(work, 'out', 'reads.json'), '{"problems":0}\n'); });
    assert(ok.code === 0 && /EVIDENCE-KEPT/.test(ok.out), `a good copy failed: ${ok.out.slice(0, 300)}`);

    const missing = drive(() => { /* nothing written */ });
    assert(missing.code !== 0 && /no out\/reads\.json/.test(missing.out),
      'a run that wrote no evidence was allowed to delete its run directory and report success');

    const empty = drive((work) => { writeFileSync(join(work, 'out', 'reads.json'), ''); });
    assert(empty.code !== 0, 'an EMPTY evidence file was preserved and reported as evidence');

    // A DESTINATION THAT DOES NOT EXIST, rather than one whose mode forbids writing: these gates run as root
    // on the tranche-closing host, and root ignores the mode — so a permission-based case would prove nothing
    // there and would pass for the wrong reason on the only platform that matters.
    const unwritable = drive((work, evidence) => {
      writeFileSync(join(work, 'out', 'reads.json'), '{"problems":0}\n');
      rmSync(evidence, { recursive: true });
    });
    assert(unwritable.code !== 0 && !/EVIDENCE-KEPT/.test(unwritable.out),
      'a copy that could not be written still announced that the evidence had been kept');

    // AND THE FAILURE PATH'S COPY, EXECUTED. It has the OPPOSITE obligation to the one above: it runs inside
    // the EXIT trap, where a non-zero return would overwrite the gate's exit status and turn a failing run
    // into a passing one — the same reason `projection_gate_report_cleanliness` can only report. So it must
    // preserve what it can, say what it did, and return 0 whatever happened.
    const preserveStart = gate.indexOf('preserve_failure_evidence() {');
    assert(preserveStart !== -1, 'the gate no longer preserves a failing run\'s evidence');
    const preserveBody = gate.slice(preserveStart, gate.indexOf('\n}\n', preserveStart) + 3);
    const readyStart = gate.indexOf('evidence_dir_ready() {');
    const readyBody = gate.slice(readyStart, gate.indexOf('\n}\n', readyStart) + 3);

    const drivePreserve = (build: (work: string) => void, evidenceParent: string | null): {
      code: number; out: string; kept: string[]; mode: number | undefined } => {
      const dir = mkdtempSync(join(tmpdir(), 'tbfail-'));
      const work = join(dir, 'work');
      const evidence = evidenceParent === null ? join(dir, 'evidence') : evidenceParent;
      mkdirSync(join(work, 'out'), { recursive: true });
      build(work);
      const harness = join(dir, 'harness.sh');
      writeFileSync(harness,
        'set -euo pipefail\n'
        + `WORK=${JSON.stringify(work)}\nEVIDENCE_DIR=${JSON.stringify(evidence)}\n`
        + 'EVIDENCE_SOURCE="out/reads.json"\nREL_GATE_ROOT=".projection-torbox-real-gate"\n'
        + `${readyBody}\n${preserveBody}\n`
        + 'preserve_failure_evidence\n'
        + 'echo "TRAP-CONTINUED=$?"\n');
      const result = spawnSync(shellOrThrow(), [shPath(harness)], { encoding: 'utf8' });
      let kept: string[] = [];
      let mode: number | undefined;
      try { kept = readdirSync(evidence); mode = statSync(evidence).mode & 0o777; } catch { kept = []; }
      return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}`, kept, mode };
    };

    // A FAILING RUN THAT GOT AS FAR AS READING KEEPS THE RECORD OF WHAT IT READ.
    const failedWithReads = drivePreserve(
      (work) => { writeFileSync(join(work, 'out', 'reads.json'), '{"problems":1}\n'); }, null);
    assert(failedWithReads.code === 0 && /TRAP-CONTINUED=0/.test(failedWithReads.out),
      'the trap\'s preservation returned non-zero, which would overwrite the gate\'s own exit status');
    assert(failedWithReads.kept.length === 1 && failedWithReads.kept[0]?.endsWith('-failed.json') === true,
      `the failing run's reads.json was not preserved; kept ${failedWithReads.kept.join(',') || 'nothing'}`);
    assert(failedWithReads.mode === 0o700,
      `the preserved evidence directory is mode ${(failedWithReads.mode ?? 0).toString(8)}, not 0700`);

    // A RUN THAT FAILED BEFORE THE READ STEP HAS NOTHING TO PRESERVE, and must still let the trap continue.
    const failedEarly = drivePreserve(() => { /* no reads.json */ }, null);
    assert(failedEarly.code === 0, 'a failing run with no evidence broke the trap');
    assert(failedEarly.kept.length === 0, 'something was preserved from a run that read nothing');

    // AND A PRESERVATION THAT CANNOT HAPPEN SAYS SO RATHER THAN BREAKING THE TRAP. The destination's parent
    // is a regular FILE, so `mkdir -p` fails with ENOTDIR — a case root cannot bypass, which the mode-based
    // one would be on the host these gates actually run on.
    const blockedRoot = mkdtempSync(join(tmpdir(), 'tbblock-'));
    writeFileSync(join(blockedRoot, 'not-a-dir'), 'x');
    const blocked = drivePreserve(
      (work) => { writeFileSync(join(work, 'out', 'reads.json'), '{"problems":1}\n'); },
      join(blockedRoot, 'not-a-dir', 'evidence'));
    assert(blocked.code === 0, 'a preservation that could not happen broke the trap');
    assert(/could NOT be preserved/.test(blocked.out),
      'a preservation that failed did not say so, so a reader would assume the record was kept');
    assert(blocked.kept.length === 0, 'a failed preservation left a partial copy behind');
  });

  await test('THE SHELL IS CHOSEN BY RUNNING IT, SO PATH ORDER CANNOT DECIDE WHETHER THIS SUITE CHECKS ANYTHING', () => {
    // THE DEFECT, WHICH WAS PUBLISHED AS A PASSING WINDOWS FIGURE TWICE. Four tests here drive a shipped
    // shell program, and they invoked whatever `bash` PATH resolved first. On a stock Windows box that is
    // `C:\WINDOWS\system32\bash.exe` — the WSL launcher — which cannot address a Windows drive path in ANY
    // spelling, so the wrapper test failed rather than ran, and the failure looked exactly like a regression
    // in the wrapper. It passed only when the suite happened to be launched from a shell that had already
    // put Git Bash's `bin` first, which is why the recorded figure did not reproduce from PowerShell.
    //
    // THE PREVIOUS FIX WAS SEPARATOR HYGIENE, AND SEPARATORS WERE NEVER THE DETERMINANT. Measured per
    // candidate: Git Bash runs a script at both spellings; WSL's `bash` runs it at neither. This test pins
    // the property that actually matters — that the suite picks a shell by MAKING IT DO THE JOB — and it
    // does so under a PATH deliberately poisoned to put a broken `bash` first, which is the exact shape of
    // the host the reviewer measured on.
    const dir = mkdtempSync(join(tmpdir(), 'tbpath-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // A stand-in for WSL's launcher: on PATH, executable, and unable to address the path it is handed.
    // `.cmd` on win32 because that is what `spawnSync` will resolve through PATHEXT; a bare name there
    // would simply not be found and would prove nothing.
    const refusal = 'cannot address a Windows path from here';
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'bash.cmd'), `@echo off\r\n>&2 echo ${refusal}\r\nexit /b 127\r\n`);
    } else {
      const poisoned = join(bin, 'bash');
      writeFileSync(poisoned, `#!/bin/sh\necho '${refusal}' >&2\nexit 127\n`);
      chmodSync(poisoned, 0o755);
    }

    const script = join(dir, 'probe.sh');
    writeFileSync(script, `#!/bin/sh\nprintf '%s' '${SHELL_SENTINEL}'\n`);
    try { chmodSync(script, 0o755); } catch { /* no executable bit on win32 */ }

    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${savedPath ?? ''}`;
    resetShellChoice();
    try {
      // THE CONTROL: the form this replaced, in the same process, under the same PATH. It must be seen to
      // pick the broken shell — otherwise this test is measuring nothing and would pass against the bug.
      const naive = spawnSync('bash', [shPath(script)], { encoding: 'utf8', timeout: 30_000 });
      assert(naive.status !== 0 || !String(naive.stdout ?? '').includes(SHELL_SENTINEL),
        'a `bash` first on PATH that cannot run a script was still able to run one, so this control is not '
        + 'reproducing the defect and nothing below is evidence');

      // THE SELECTION: it must not be fooled by PATH order.
      const chosen = posixShell();
      if (chosen === null) {
        // Honest on a host with no usable shell at all — but it must SAY so rather than fail, and the
        // wrapper test must reach the same conclusion rather than reporting a wrapper regression.
        skipBlock(`${NO_SHELL} — the selection regression could not find one behind the poisoned PATH`);
        return;
      }
      assert(!chosen.startsWith(bin) && chosen !== 'bash',
        `the selection returned ${chosen}, which is the poisoned candidate or the bare name that resolves `
        + 'to it — PATH order is still deciding');
      const viaChosen = spawnSync(chosen, [shPath(script)], { encoding: 'utf8', timeout: 30_000 });
      assert(viaChosen.status === 0 && String(viaChosen.stdout ?? '').includes(SHELL_SENTINEL),
        `the selected shell ${chosen} could not execute a script at the spelling this suite hands out`);

      // AND THE SELECTION IS BY EXECUTION, NOT BY NAME: a candidate that exists and is executable but
      // cannot do the job is rejected.
      assert(!shellCanRunAScript(process.platform === 'win32' ? join(bin, 'bash.cmd') : join(bin, 'bash')),
        'the verifier accepted a shell that cannot run a script, so it is checking existence rather than '
        + 'capability');
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
      resetShellChoice();
    }

    // AND NO CALL SITE MAY GO BACK TO THE BARE NAME. Matched on the CALL rather than on the prose, since the
    // comments quote the defective form on purpose — and counted rather than forbidden outright, because
    // exactly one such call must survive: the control a few lines above, which has to spawn the bare `bash`
    // in order to demonstrate that PATH order picks the broken one.
    const suite = repoFile('test/torbox-resolver.ts');
    const bareCalls = suite.match(/spawnSync\('bash',\s*\[/g) ?? [];
    assert(bareCalls.length === 1,
      `${bareCalls.length} call site(s) spawn the bare \`bash\`; exactly one may, and it is this test's own `
      + 'control. Any other lets PATH order decide whether the suite checks anything');
    assert(/const naive = spawnSync\('bash', \[shPath\(script\)\]/.test(suite),
      'the one surviving bare-`bash` call is not this test\'s control, so something else reintroduced it');
  });

  await test('this suite runs in the aggregate', () => {
    assert(AGGREGATE_SUITE_COMMAND.includes('tsx test/torbox-resolver.ts'),
      'a suite nobody runs is a suite that stops being true');
  });

  // THE SKIPS ARE PART OF THE RESULT, NOT A FOOTNOTE. Three of the tests here need a POSIX shell for part of
  // what they assert, and a test that returns early still prints `ok` — so a Windows reader saw a wholly
  // green suite with no way to know which halves never ran.
  console.log(`\n${passed} passed, ${failed} failed, ${skippedBlocks.length} block(s) skipped on `
    + `${process.platform}`);
  for (const what of skippedBlocks) console.log(`  skipped: ${what}`);
  console.log('');
  if (failed > 0) {
    for (const [name, error] of failures) console.error(`FAILED ${name}\n  ${String(error)}`);
    process.exit(1);
  }
}

void main();
