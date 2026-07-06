import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorUiStaticArtifact,
  describeOperatorUiStaticArtifact,
} from '../src/ops/operator-ui-static-artifact.js';
import {
  extractOperatorUiRenderedTextSegments,
  inspectOperatorUiRenderedHtml,
  OPERATOR_UI_RENDER_ALLOWED_TEXT,
} from '../src/ops/operator-ui-render-allowlist.js';
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

console.log('Running Phase 66 static operator UI layout refinement suite:\n');

test('refined appliance layout landmarks are present', () => {
  const html = renderOperatorUiStaticPrototypeHtml();
  for (const token of [
    'class="shell"',
    'class="sidebar"',
    'class="top-strip"',
    'class="overview-band"',
    'class="summary-grid"',
    'class="status-rail"',
    'class="metric-row"',
    'class="screen-panel"',
    'class="panel-state-stack"',
    'class="table-frame"',
    'aria-label="Overview status"',
    'aria-label="Sanitized Activity"',
    'Static Surface',
    'Allowlist Gate',
    'Artifact Gate',
    'Render Boundary',
    'Fixture Screens',
    'Packet Rows',
    'Static Layout',
    'Artifact Digest',
  ]) assert(html.includes(token), `layout includes ${token}`);
});

test('layout keeps bordered panels flat without card nesting', () => {
  const html = renderOperatorUiStaticPrototypeHtml();
  assert(!/<article class="summary-card">(?:(?!<\/article>).)*<article class="summary-card">/s.test(html), 'summary cards are not nested');
  assert(!/<section class="screen-panel"[^>]*>(?:(?!<\/section>).)*<article class="summary-card">/s.test(html), 'screen panels do not contain summary cards');
  assert(!/<section class="activity-panel"[^>]*>(?:(?!<\/section>).)*<article class="summary-card">/s.test(html), 'activity panel does not contain cards');
  assert(!/<aside class="status-rail">(?:(?!<\/aside>).)*<section class="screen-panel"/s.test(html), 'status rail does not contain screen panels');
});

test('responsive CSS remains static and within Phase 60 visual direction', () => {
  const html = renderOperatorUiStaticPrototypeHtml();
  for (const token of [
    '@media (max-width:980px)',
    '@media (max-width:900px)',
    '@media (max-width:560px)',
    'grid-template-columns:240px minmax(0,1fr)',
    'grid-template-columns:minmax(0,1.5fr) minmax(240px,.5fr)',
    'overflow:auto',
    '#111214',
    '#1A1B1E',
    '#232428',
    '#303238',
    '#D18A3A',
    'border-radius:8px',
    'border-radius:6px',
    'border-radius:4px',
  ]) assert(html.includes(token), `CSS includes ${token}`);

  for (const forbidden of ['linear-gradient', 'radial-gradient', 'box-shadow', 'backdrop-filter', 'filter:blur', 'url(', '@import']) {
    assert(!html.includes(forbidden), `CSS omits ${forbidden}`);
  }
});

test('new visible chrome is fixed allowlisted text only', () => {
  const html = renderOperatorUiStaticPrototypeHtml();
  const allowed = new Set<string>(OPERATOR_UI_RENDER_ALLOWED_TEXT);
  for (const segment of extractOperatorUiRenderedTextSegments(html)) {
    assert(allowed.has(segment), `visible segment is allowlisted: ${segment}`);
  }
  assert(inspectOperatorUiRenderedHtml(html).ok, 'Phase 64 allowlist accepts refined render');
});

test('Phase 81 local control is fixed and external references/storage remain absent', () => {
  const html = renderOperatorUiStaticPrototypeHtml();
  for (const required of [
    '<script>',
    'id="operator-secret-input"',
    'id="packet-auth-control"',
    '/operator-ui/packets.json',
    'X-Operator-UI-Secret',
  ]) assert(html.includes(required), `html includes ${required}`);

  for (const forbidden of [
    '<link',
    '<img',
    '<iframe',
    '<form',
    ' href="http',
    " href='http",
    ' src=',
    'javascript:',
    'localStorage',
    'sessionStorage',
    'window.',
  ]) assert(!html.includes(forbidden), `html omits ${forbidden}`);
});

test('artifact metadata and digest update deterministically through allowlist gate', () => {
  const first = buildOperatorUiStaticArtifact();
  const second = buildOperatorUiStaticArtifact();
  const metadata = describeOperatorUiStaticArtifact(first);
  const html = renderOperatorUiStaticPrototypeHtml();
  assert(JSON.stringify(first) === JSON.stringify(second), 'artifact is deterministic');
  assert(first.inspection.ok, 'artifact inspection is accepted');
  assert(first.html === html, 'artifact HTML uses refined renderer output');
  assert(metadata.byteCount === Buffer.byteLength(html, 'utf8'), 'metadata byte count follows HTML');
  assert(metadata.sha256 === createHash('sha256').update(html, 'utf8').digest('hex'), 'metadata digest follows HTML');
  assert(!('html' in metadata), 'metadata remains HTML-body free');
});

test('Phase 66 docs and package chain are wired after artifact packaging', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const chain = pkg.scripts.test ?? '';
  assert(pkg.scripts['test:operator-ui-static-layout'] === 'tsx test/operator-ui-static-layout.ts', 'test script');
  assert(
    chain.includes('test/operator-ui-static-artifact.ts && tsx test/operator-ui-static-layout.ts'),
    'layout suite follows Phase 65 artifact suite',
  );

  const combined = `${read('docs/PHASE_66_STATIC_UI_LAYOUT_REFINEMENT.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
  for (const kw of [
    'Phase 66',
    'static UI layout refinement',
    'fixture-only',
    'Phase 64 allowlist gate',
    'Phase 65 artifact packaging',
    'Graphite + Muted Orange',
    'future decision gate',
    'Provider availability remains advisory/count-only',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `docs/deploy include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
