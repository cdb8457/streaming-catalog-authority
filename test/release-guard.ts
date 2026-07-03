import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertReadOnlyGitArgs,
  formatReleaseGuardJson,
  formatReleaseGuardText,
  hasFailedGuardChecks,
  runReleaseGuard,
  type GitResult,
  type GitRunner,
  type ReleaseGuardReport,
} from '../src/ops/release-guard.js';

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

class FakeRunner implements GitRunner {
  readonly commands: (readonly string[])[] = [];
  constructor(private readonly responses: Record<string, GitResult>) {}
  runGit(args: readonly string[]): GitResult {
    assertReadOnlyGitArgs(args);
    this.commands.push([...args]);
    return this.responses[args.join('\0')] ?? { status: 0, stdout: '', stderr: '' };
  }
}

const okResponses: Record<string, GitResult> = {
  ['status\0--porcelain']: { status: 0, stdout: '', stderr: '' },
  ['merge-base\0--is-ancestor\0master\0HEAD']: { status: 0, stdout: '', stderr: '' },
  ['diff\0--check\0master...HEAD']: { status: 0, stdout: '', stderr: '' },
  ['show-ref\0--tags\0--verify\0refs/tags/phase-27']: { status: 1, stdout: '', stderr: '' },
  ['diff\0--name-only\0master...HEAD']: { status: 0, stdout: 'src/core/catalog.ts\n', stderr: '' },
  ['diff\0--unified=0\0master...HEAD']: { status: 0, stdout: '+small catalog change\n', stderr: '' },
};

console.log('Running Phase 27 release guard suite:\n');

test('pre-pr report passes clean local guard checks without mutating commands', () => {
  const runner = new FakeRunner(okResponses);
  const report = runReleaseGuard({ base: 'master', head: 'HEAD', tag: 'phase-27', phase: '27', mode: 'pre-pr' }, runner);
  assert(report.report === 'phase-27-release-guard', 'report name');
  assert(report.advisoryOnly === true, 'advisory-only');
  assert(!hasFailedGuardChecks(report), 'no failed checks');
  assert(report.checks.some((check) => check.id === 'mutation-boundary' && check.summary.includes('never approves')), 'mutation boundary visible');
  assert(runner.commands.every((cmd) => !['merge', 'tag', 'push', 'checkout', 'reset'].includes(cmd[0] ?? '')), 'no forbidden git subcommands');
});

test('failed worktree, ancestry, whitespace, and early tag checks return non-approval failures', () => {
  const runner = new FakeRunner({
    ...okResponses,
    ['status\0--porcelain']: { status: 0, stdout: ' M README.md\n', stderr: '' },
    ['merge-base\0--is-ancestor\0master\0HEAD']: { status: 1, stdout: '', stderr: 'no ancestor' },
    ['diff\0--check\0master...HEAD']: { status: 2, stdout: 'file.ts:1: trailing whitespace\n', stderr: '' },
    ['show-ref\0--tags\0--verify\0refs/tags/phase-27']: { status: 0, stdout: 'abc refs/tags/phase-27\n', stderr: '' },
    ['rev-parse\0master']: { status: 0, stdout: 'abc\n', stderr: '' },
    ['rev-parse\0origin/master']: { status: 0, stdout: 'def\n', stderr: '' },
  });
  const report = runReleaseGuard({ base: 'master', head: 'HEAD', tag: 'phase-27', phase: '27', mode: 'pre-merge' }, runner);
  assert(hasFailedGuardChecks(report), 'has failures');
  for (const id of ['clean-worktree', 'base-ancestor', 'diff-whitespace', 'expected-tag', 'master-origin-alignment']) {
    assert(report.checks.some((check) => check.id === id && check.status === 'fail'), `${id} failed`);
  }
  assert(formatReleaseGuardText(report).includes('No approval action was taken.'), 'text is advisory');
});

test('post-merge requires the expected tag to exist and master/origin to align', () => {
  const runner = new FakeRunner({
    ...okResponses,
    ['show-ref\0--tags\0--verify\0refs/tags/phase-27']: { status: 0, stdout: 'abc refs/tags/phase-27\n', stderr: '' },
    ['rev-parse\0master']: { status: 0, stdout: 'abc\n', stderr: '' },
    ['rev-parse\0origin/master']: { status: 0, stdout: 'abc\n', stderr: '' },
  });
  const report = runReleaseGuard({ base: 'master', head: 'HEAD', tag: 'phase-27', phase: '27', mode: 'post-merge' }, runner);
  assert(!hasFailedGuardChecks(report), 'post-merge checks pass');
  assert(report.checks.some((check) => check.id === 'expected-tag' && check.status === 'pass'), 'tag presence passes');
  assert(report.checks.some((check) => check.id === 'master-origin-alignment' && check.status === 'pass'), 'alignment passes');
});

test('reviewer-required triggers are warnings, not GO approval', () => {
  const runner = new FakeRunner({
    ...okResponses,
    ['diff\0--name-only\0master...HEAD']: { status: 0, stdout: 'docs/PHASE_27_RELEASE_GUARD.md\ntest/deploy.ts\n', stderr: '' },
    ['diff\0--unified=0\0master...HEAD']: { status: 0, stdout: '+O4 remains open/deferred\n+FileCustodian is not production KMS\n', stderr: '' },
  });
  const report = runReleaseGuard({ base: 'master', head: 'HEAD', phase: '27', mode: 'pre-pr' }, runner);
  const trigger = report.checks.find((check) => check.id === 'reviewer-required-triggers');
  if (!trigger) throw new Error('reviewer trigger check exists');
  assert(trigger.status === 'warn', 'reviewer trigger warns');
  assert(trigger.summary.includes('Independent Reviewer is required'), 'reviewer required text');
});

test('redaction bounds surprising git diff output', () => {
  const runner = new FakeRunner({
    ...okResponses,
    ['diff\0--check\0master...HEAD']: {
      status: 2,
      stdout: `DATABASE_URL=postgresql://user:secret@example.invalid/db\nCUSTODIAN_KEK=abc\n${'x'.repeat(3000)}`,
      stderr: '',
    },
  });
  const report = runReleaseGuard({ base: 'master', head: 'HEAD', phase: '27', mode: 'pre-pr' }, runner);
  const json = formatReleaseGuardJson(report);
  assert(!json.includes('user:secret@example.invalid'), 'db url redacted');
  assert(!json.includes('CUSTODIAN_KEK=abc'), 'kek redacted');
  assert(json.includes('<truncated>'), 'long output truncated');
});

test('read-only git guard rejects mutating subcommands', () => {
  for (const cmd of [
    ['merge', 'feature'],
    ['tag', 'phase-27'],
    ['push', 'origin', 'HEAD'],
    ['branch', '-d', 'old'],
    ['worktree', 'remove', 'x'],
    ['checkout', 'master'],
    ['reset', '--hard'],
    ['pull', '--ff-only'],
    ['fetch', 'origin'],
  ]) {
    let threw = false;
    try { assertReadOnlyGitArgs(cmd); }
    catch { threw = true; }
    assert(threw, `rejects git ${cmd.join(' ')}`);
  }
});

test('read-only git guard permits only the exact command shapes release guard uses', () => {
  for (const cmd of [
    ['status', '--porcelain'],
    ['merge-base', '--is-ancestor', 'master', 'HEAD'],
    ['diff', '--check', 'master...HEAD'],
    ['show-ref', '--tags', '--verify', 'refs/tags/phase-27'],
    ['rev-parse', 'master'],
    ['rev-parse', 'origin/master'],
    ['diff', '--name-only', 'master...HEAD'],
    ['diff', '--unified=0', 'master...HEAD'],
  ]) {
    assertReadOnlyGitArgs(cmd);
  }
});

test('read-only git guard rejects alias, config, and global-option bypass attempts', () => {
  for (const cmd of [
    ['-c', 'alias.safe=!git tag phase-27', 'safe'],
    ['--config-env', 'alias.safe=GIT_ALIAS_SAFE', 'safe'],
    ['--exec-path=.', 'status', '--porcelain'],
    ['--paginate', 'status', '--porcelain'],
    ['-C', '..', 'status', '--porcelain'],
    ['diff', '-c', 'alias.safe=!git tag phase-27', '--check', 'master...HEAD'],
    ['diff', '--check', '--output=owned', 'master...HEAD'],
    ['diff', '--check', '--evil...HEAD'],
    ['merge-base', '--is-ancestor', '--evil', 'HEAD'],
    ['show-ref', '--tags', '--verify', '--refs/tags/phase-27'],
    ['rev-parse', '--verify', 'master'],
  ]) {
    let threw = false;
    try { assertReadOnlyGitArgs(cmd); }
    catch { threw = true; }
    assert(threw, `rejects git ${cmd.join(' ')}`);
  }
});

test('CLI emits parseable JSON and unsupported args fail closed', () => {
  const ok = spawnSync('npm', ['run', 'ops:release-guard', '--', '--', '--base', 'HEAD', '--head', 'HEAD', '--json'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const out = `${ok.stdout}`;
  const marker = '{\n  "report": "phase-27-release-guard"';
  const jsonStart = out.indexOf(marker);
  assert(jsonStart >= 0, 'npm output contains JSON report');
  const parsed = JSON.parse(out.slice(jsonStart)) as ReleaseGuardReport;
  assert(parsed.report === 'phase-27-release-guard', 'parsed report name');
  assert(parsed.advisoryOnly === true, 'parsed advisory-only flag');

  const bad = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/release-guard-cli.ts', '--base', 'HEAD', '--push'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
  });
  assert(bad.status === 2 && bad.stderr.includes('unsupported argument'), 'unsupported args return usage error');
});

test('source has no live-service imports, env reads, or mutating git command strings', () => {
  const src = `${read('src/ops/release-guard.ts')}\n${read('src/ops/release-guard-cli.ts')}`;
  for (const forbidden of [
    "from 'pg'",
    'from "pg"',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'docker compose',
    'process.env.',
    'readFileSync',
  ]) assert(!src.includes(forbidden), `no ${forbidden}`);
  for (const mutating of ['git merge', 'git tag', 'git push', 'git checkout', 'git reset', 'branch -d', 'worktree remove']) {
    assert(!src.includes(mutating), `no ${mutating}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
