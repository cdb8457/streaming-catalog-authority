import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorUiStaticArtifact,
  describeOperatorUiStaticArtifact,
  OPERATOR_UI_STATIC_ARTIFACT_FILENAME,
} from '../src/ops/operator-ui-static-artifact.js';
import { inspectOperatorUiRenderedHtml } from '../src/ops/operator-ui-render-allowlist.js';
import { renderOperatorUiStaticPrototypeHtml } from '../src/ops/operator-ui-static-prototype.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const source = read('src/ops/operator-ui-static-artifact.ts');
const cliSource = read('src/ops/operator-ui-static-artifact-cli.ts');

console.log('Running Phase 65 static operator UI artifact suite:\n');

test('artifact build is deterministic and allowlist-backed', () => {
  const first = buildOperatorUiStaticArtifact();
  const second = buildOperatorUiStaticArtifact();
  assert(JSON.stringify(first) === JSON.stringify(second), 'stable artifact object');
  assert(first.ok, 'artifact accepted');
  assert(first.code === 'OPERATOR_UI_STATIC_ARTIFACT_READY', 'fixed ready code');
  assert(first.inspection.ok, 'inspection passed');
  assert(first.inspection.code === 'OPERATOR_UI_RENDER_ACCEPTED', 'Phase 64 accepted code');
  assert(source.includes('inspectOperatorUiRenderedHtml(html)'), 'helper calls Phase 64 inspection');
  assert(source.includes('throw new OperatorUiStaticArtifactError(inspection)'), 'helper fails closed');
});

test('HTML equals Phase 63 renderer output and passes Phase 64 inspection', () => {
  const artifact = buildOperatorUiStaticArtifact();
  const html = renderOperatorUiStaticPrototypeHtml();
  assert(artifact.html === html, 'artifact HTML is renderer output');
  assert(JSON.stringify(artifact.inspection) === JSON.stringify(inspectOperatorUiRenderedHtml(html)), 'inspection matches direct report');
  assert(artifact.artifactFilename === OPERATOR_UI_STATIC_ARTIFACT_FILENAME, 'filename constant');
  assert(artifact.artifactFilename === 'operator-ui-static-prototype.html', 'filename suggestion');
});

test('metadata includes stable byte count and digest but omits HTML body', () => {
  const artifact = buildOperatorUiStaticArtifact();
  const metadata = describeOperatorUiStaticArtifact(artifact);
  const json = JSON.stringify(metadata);
  const html = renderOperatorUiStaticPrototypeHtml();
  assert(metadata.byteCount === Buffer.byteLength(html, 'utf8'), 'byte count is over HTML');
  assert(metadata.sha256 === createHash('sha256').update(html, 'utf8').digest('hex'), 'sha256 is over HTML');
  assert(/^[a-f0-9]{64}$/.test(metadata.sha256), 'digest format');
  assert(!('html' in metadata), 'metadata omits HTML property');
  assert(!json.includes('<!doctype html>'), 'metadata does not include HTML body');
  for (const sentinel of [
    'SECRET_TOKEN_SENTINEL',
    'Private Movie Sentinel',
    'postgres://',
    'provider.example.invalid',
    'magnet:',
    'rawPayload',
  ]) assert(!json.includes(sentinel), `metadata omits ${sentinel}`);
});

test('--json CLI output is parseable and redaction-safe metadata only', () => {
  const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-static-artifact-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: 'SECRET_TOKEN_SENTINEL',
      PRIVATE_TITLE: 'Private Movie Sentinel',
      DATABASE_URL: 'postgres://user:pass@example.invalid/db',
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output) as ReturnType<typeof describeOperatorUiStaticArtifact>;
  assert(parsed.ok, 'json ok');
  assert(parsed.code === 'OPERATOR_UI_STATIC_ARTIFACT_READY', 'json code');
  assert(parsed.artifactFilename === 'operator-ui-static-prototype.html', 'json filename');
  assert(parsed.inspection.ok, 'json inspection ok');
  assert(!output.includes('<!doctype html>'), 'json omits HTML body');
  for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://', 'example.invalid']) {
    assert(!output.includes(sentinel), `json omits hostile env ${sentinel}`);
  }
});

test('HTML CLI output omits unsafe terms and includes static prototype basics', () => {
  const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-static-artifact-cli.ts'], {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: 'SECRET_TOKEN_SENTINEL',
      PRIVATE_TITLE: 'Private Movie Sentinel',
      DATABASE_URL: 'postgres://user:pass@example.invalid/db',
    },
    encoding: 'utf8',
  });
  assert(output === renderOperatorUiStaticPrototypeHtml(), 'default CLI prints HTML only');
  for (const expected of [
    '<!doctype html>',
    'Operator UI Static Prototype',
    'Catalog Authority',
    'Fixture Only',
    'Read Only',
    'Sanitized Activity',
    'Provider Count',
    'O4 O5 Deferred',
  ]) assert(output.includes(expected), `html includes ${expected}`);
  for (const forbidden of [
    'SECRET_TOKEN_SENTINEL',
    'Private Movie Sentinel',
    'postgres://',
    'example.invalid',
    'Real-Debrid',
    'TorBox logo',
    'magnet:',
    'providerRef',
    'rawPayload',
    'playback',
    'download',
    'stream provider control',
  ]) assert(!output.includes(forbidden), `html omits ${forbidden}`);
});

test('helper and CLI source has no frontend/API/runtime/DB/provider/network/env/file-read scope creep', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react', 'cheerio', 'jsdom']) {
    assert(!allDeps.includes(dep), `no render/API dependency ${dep}`);
  }
  assert(pkg.scripts['test:operator-ui-static-artifact'] === 'tsx test/operator-ui-static-artifact.ts', 'test script');
  assert(pkg.scripts['ops:operator-ui-static-artifact'] === 'tsx src/ops/operator-ui-static-artifact-cli.ts', 'ops script');
  assert((pkg.scripts.test ?? '').includes('test/operator-ui-render-allowlist.ts && tsx test/operator-ui-static-artifact.ts'), 'suite follows Phase 64');

  const combined = `${source}\n${cliSource}`;
  for (const forbidden of [
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
    'from "pg"',
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
  ]) assert(!combined.includes(forbidden), `source excludes ${forbidden}`);
});

test('source performs no filesystem writes and docs use stdout redirection only', () => {
  for (const forbidden of [
    'writeFile',
    'writeFileSync',
    'appendFile',
    'appendFileSync',
    'mkdir',
    'mkdirSync',
    'createWriteStream',
    'openSync',
    'rmSync',
    'unlinkSync',
  ]) assert(!`${source}\n${cliSource}`.includes(forbidden), `source excludes ${forbidden}`);

  const doc = read('docs/PHASE_65_STATIC_UI_ARTIFACT_PACKAGING.md');
  assert(doc.includes('npm run --silent ops:operator-ui-static-artifact > operator-ui-static-prototype.html'), 'doc shows stdout redirect');
  assert(doc.includes('The helper and CLI do not write files'), 'doc states no source writes');
});

test('docs and deploy guard mention Phase 65 artifact boundaries', () => {
  const combined = `${read('docs/PHASE_65_STATIC_UI_ARTIFACT_PACKAGING.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
  for (const kw of [
    'Phase 65',
    'static operator UI artifact packaging',
    'buildOperatorUiStaticArtifact',
    'ops:operator-ui-static-artifact',
    'test:operator-ui-static-artifact',
    'operator-ui-static-prototype.html',
    'Phase 64 allowlist gate',
    'fixture-only',
    'no React, Vite, Next, Express, frontend framework, bundler, HTTP route, API route, database read, provider adapter, network call, env read, file read, browser JavaScript, browser storage, external asset, remote font, provider control, playback, download, or streaming behavior',
    'Provider availability remains advisory/count-only',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
    'Phase 66',
  ]) assert(combined.includes(kw), `Phase 65 docs/deploy include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
