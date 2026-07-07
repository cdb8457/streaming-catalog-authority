import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSidecarUnraidReviewHandoff,
  formatSidecarUnraidReviewHandoffJson,
  formatSidecarUnraidReviewHandoffText,
  type SidecarUnraidReviewHandoff,
} from '../src/ops/sidecar-unraid-review-handoff.js';

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

function assertShape(handoff: SidecarUnraidReviewHandoff): void {
  assert(handoff.report === 'phase-111-sidecar-unraid-review-handoff', 'report');
  assert(handoff.code === 'SIDECAR_UNRAID_REVIEW_HANDOFF', 'code');
  assert(handoff.status === 'awaiting-independent-review', 'status');
  assert(handoff.launchApproved === false, 'no launch approval');
  assert(handoff.productionReady === false, 'not production ready');
  assert(handoff.serviceInstallApproved === false, 'no install approval');
  assert(handoff.providerModeEnabled === false, 'provider disabled');
  assert(handoff.closesO4 === false && handoff.closesO5 === false, 'no closure');
  assert(handoff.sourceReviewSummary === 'phase-109-sidecar-unraid-review-summary', 'source summary');
  assert(handoff.sourceAcceptancePreflight === 'phase-110-sidecar-unraid-acceptance-preflight', 'source acceptance');
  assert(handoff.handoffSections.length === 4, 'four sections');
  assert(handoff.explicitNonGoals.includes('No network calls or live service contact.'), 'no live contact');
}

function assertNoSentinels(output: string): void {
  for (const sentinel of ['SECRET_VALUE_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'postgres://', 'Authorization', 'Bearer ', 'http://localhost']) {
    assert(!output.includes(sentinel), `output excludes ${sentinel}`);
  }
}

console.log('Running Phase 111 sidecar Unraid review handoff suite:\n');

test('handoff is static, label-only, and approval-free', () => {
  const handoff = buildSidecarUnraidReviewHandoff();
  assertShape(handoff);
  const labels = handoff.handoffSections.flatMap((section) => [...section.sourceLabels, ...section.reviewerQuestionLabels, ...section.holdTriggerLabels]);
  for (const label of ['phase-108-sidecar-unraid-review-gate', 'phase-109-sidecar-unraid-review-summary', 'phase-110-sidecar-unraid-acceptance-preflight', 'o4-open-deferred-label', 'o5-open-deferred-label', 'tcp-http-lan-exposure-claim']) {
    assert(labels.includes(label), `label ${label}`);
  }
});

test('formatters and CLIs emit deterministic redaction-safe output', () => {
  const handoff = buildSidecarUnraidReviewHandoff();
  const json = formatSidecarUnraidReviewHandoffJson(handoff);
  const text = formatSidecarUnraidReviewHandoffText(handoff);
  assertShape(JSON.parse(json) as SidecarUnraidReviewHandoff);
  assert(text.includes('Phase 111 sidecar Unraid review handoff'), 'text title');
  assert(text.includes('productionReady: false'), 'text production false');
  assert(text.includes('closesO4: false'), 'text O4 false');
  assertNoSentinels(json);
  assertNoSentinels(text);
  const env = { ...process.env, SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL', PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL' };
  const direct = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/sidecar-unraid-review-handoff-cli.ts', '--json'], { cwd: root, env, encoding: 'utf8' });
  assertShape(JSON.parse(direct) as SidecarUnraidReviewHandoff);
  assertNoSentinels(direct);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:sidecar-unraid-review-handoff -- -- --json', { cwd: root, encoding: 'utf8' });
  assertShape(JSON.parse(output) as SidecarUnraidReviewHandoff);
});

test('source and docs preserve handoff-only boundary', () => {
  const source = `${read('src/ops/sidecar-unraid-review-handoff.ts')}\n${read('src/ops/sidecar-unraid-review-handoff-cli.ts')}`;
  const docs = `${read('docs/PHASE_111_SIDECAR_UNRAID_REVIEW_HANDOFF.md')}\n${read('README.md')}\n${read('package.json')}`;
  assert((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['ops:sidecar-unraid-review-handoff'] === 'tsx src/ops/sidecar-unraid-review-handoff-cli.ts', 'ops script');
  for (const forbidden of ['node:fs', 'node:http', 'node:https', 'node:net', 'process.env', 'globalThis.fetch', 'fetch(', 'execSync', 'spawnSync', 'ProviderAdapter', 'TorBoxReadOnlyClient', 'JellyfinHttpClient']) {
    assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  }
  for (const required of ['Phase 111', 'SIDECAR_UNRAID_REVIEW_HANDOFF', 'awaiting-independent-review', 'productionReady: false', 'serviceInstallApproved: false', 'closesO4: false', 'closesO5: false', 'O4/O5 remain open/deferred']) {
    assert(docs.includes(required), `docs include ${required}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
