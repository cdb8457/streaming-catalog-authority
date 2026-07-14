import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

console.log('Running Phase 222 Jellyfin integration decision suite:\n');

test('Phase 222 records the full Jellyfin ladder and final dispositions', () => {
  const doc = read('docs/PHASE_222_JELLYFIN_INTEGRATION_DECISION.md');
  for (const required of [
    'phase-222-jellyfin-integration-decision',
    'JELLYFIN_READ_ONLY_INTEGRATION_PROVEN',
    'JELLYFIN_READ_ONLY_LAUNCH_ELIGIBLE_CURRENT_SCOPE',
    'JELLYFIN_WRITE_CAPABLE_NOT_LAUNCH_READY',
    'JELLYFIN_COLLECTION_WRITE_MEMBERSHIP_NOT_MATERIALIZING',
    'JELLYFIN_INTEGRATION_DECISION_READ_ONLY_PROVEN_WRITE_BLOCKED',
    'phase-218',
    'cd3dd6b2b10725f5115376a56400a7c42e33bc59784cf8701f73da8353cebde9',
    '24641bd15aeb533b31611f2787df46d21bbbbc943b825a4c89fae1f9ab518101',
    'phase-219',
    '46f3945e995651a916fb7fab820ebc69ef8d61bc2a1700cbe0b3a7407bed4c75',
    '5aee02f0cd123c67d71008994c3f200a6460e058b4bfb31341e1c871f6d3c7ba',
    '0abd899',
    '7b8cb31e703f20b87a7f262cc376f956c26ed14827ec3c2349db22d183ea3055',
    'ac423af0f96afcb2fff905c228cdc3dd43e29ee866340b3b96c89f9a8e3e9b71',
    'mapped `1`, unmatched `1`',
    'a468bb4',
    'phase-221',
    'fc2a1841107a8b5f807ffcfed0aeed67a25331e2ba4db465f3c8b0bd97ed0cc6',
    'f7a5ca903900da963baa4c927caf1484bf027c68e5a45eec1772befba5637bcd',
    'JELLYFIN_WRITE_PROOF_FAILED_SAFE',
    '0 collection-items reference(s) confirmed after 61 poll(s)',
    'members_lower=0',
    't+60s',
    'manual probe residue returned to `0`',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(doc.includes(required), `Phase 222 doc includes ${required}`);
});

test('Phase 222 propagates launch posture to readiness records and README', () => {
  const combined = [
    read('README.md'),
    read('docs/PHASE_200_LAUNCH_READINESS_PASS.md'),
    read('docs/RELEASE_CHECKLIST.md'),
  ].join('\n');
  for (const required of [
    'Phase 222 adds `docs/PHASE_222_JELLYFIN_INTEGRATION_DECISION.md`',
    'JELLYFIN_READ_ONLY_INTEGRATION_PROVEN',
    'JELLYFIN_WRITE_CAPABLE_NOT_LAUNCH_READY',
    'JELLYFIN_COLLECTION_WRITE_MEMBERSHIP_NOT_MATERIALIZING',
    'JELLYFIN_INTEGRATION_DECISION_READ_ONLY_PROVEN_WRITE_BLOCKED',
    'read-only Jellyfin',
    'write-capable Jellyfin',
    'new operator authorization gate',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
  ]) assert(combined.includes(required), `launch records include ${required}`);
});

test('Phase 222 guards keep Jellyfin writes out of shipped configuration', () => {
  const doc = read('docs/PHASE_222_JELLYFIN_INTEGRATION_DECISION.md');
  const realFactory = read('src/core/adapters/jellyfin/real-factory.ts');
  const writeProofCli = read('src/ops/jellyfin-write-proof-cli.ts');
  const composeFiles = readdirSync(root).filter((name) => /^docker-compose.*\.ya?ml$/.test(name));
  const compose = composeFiles.map((name) => read(name)).join('\n');

  assert(realFactory.includes('JELLYFIN_ALLOW_LIVE_PUBLISH'), 'real Jellyfin publish gate exists');
  assert(writeProofCli.includes('--confirm-disposable-write'), 'write proof requires explicit confirmation');
  assert(!compose.includes('JELLYFIN_ALLOW_LIVE_PUBLISH=true'), 'Compose defaults do not enable Jellyfin live publish');
  assert(!compose.includes('ops:jellyfin-write-proof'), 'Compose does not run write proof as a service');
  assert(doc.includes('Default Compose/runtime configuration must not enable `JELLYFIN_ALLOW_LIVE_PUBLISH=true`'), 'doc records shipped config guard');
  assert(doc.includes('silent reattempt of rung 3 without a new operator authorization gate'), 'doc requires future authorization');
});

test('Phase 222 record is redaction-safe and artifact-only', () => {
  const doc = read('docs/PHASE_222_JELLYFIN_INTEGRATION_DECISION.md');
  for (const required of [
    'makes no Jellyfin calls',
    'no runtime changes',
    'no Docker Compose changes',
    'no media-server state changes',
  ]) assert(doc.includes(required), `artifact-only doc includes ${required}`);
  for (const forbidden of [
    '192.168.',
    '/mnt/user/appdata',
    'postgres://',
    'postgresql://',
    'Jellyfin API key',
    'O5_CLOSED',
    'JELLYFIN_WRITE_CAPABLE_LAUNCH_ELIGIBLE',
    'provider live mode enabled',
    'playback enabled',
    'download enabled',
  ]) assert(!doc.includes(forbidden), `Phase 222 doc excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
