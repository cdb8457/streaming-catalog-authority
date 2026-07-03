import { execFileSync } from 'node:child_process';

export type ReleaseGuardMode = 'pre-pr' | 'pre-merge' | 'post-merge';
export type ReleaseGuardStatus = 'pass' | 'warn' | 'fail';

export interface ReleaseGuardOptions {
  readonly base: string;
  readonly head: string;
  readonly tag?: string;
  readonly phase?: string;
  readonly mode: ReleaseGuardMode;
}

export interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRunner {
  readonly commands: readonly (readonly string[])[];
  runGit(args: readonly string[]): GitResult;
}

export interface ReleaseGuardCheck {
  readonly id: string;
  readonly status: ReleaseGuardStatus;
  readonly summary: string;
  readonly detail?: string;
}

export interface ReleaseGuardReport {
  readonly report: 'phase-27-release-guard';
  readonly version: 1;
  readonly advisoryOnly: true;
  readonly mode: ReleaseGuardMode;
  readonly phase?: string;
  readonly base: string;
  readonly head: string;
  readonly tag?: string;
  readonly decisionBoundary: string;
  readonly checks: readonly ReleaseGuardCheck[];
  readonly invokedGitCommands: readonly string[];
}

const MAX_OUTPUT_CHARS = 1600;

const REVIEWER_FILE_PATTERNS = [
  /(^|\/)docs\//,
  /(^|\/)README\.md$/,
  /(^|\/)package\.json$/,
  /(^|\/)test\/deploy\.ts$/,
  /(^|\/)src\/ops\/release-guard/i,
];

const REVIEWER_TEXT_PATTERNS = [
  /release gate|production readiness|operator evidence|coordinator/i,
  /privacy|redaction|backup|restore|custodian|KMS|KEK|FileCustodian/i,
  /\bO4\b|\bO5\b|live service|CI expectations|operator credentials/i,
];

export function createChildProcessGitRunner(cwd = process.cwd()): GitRunner {
  const commands: (readonly string[])[] = [];
  return {
    commands,
    runGit(args: readonly string[]): GitResult {
      assertReadOnlyGitArgs(args);
      commands.push([...args]);
      try {
        const stdout = execFileSync('git', [...args], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        });
        return { status: 0, stdout, stderr: '' };
      } catch (err) {
        const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
        return {
          status: typeof e.status === 'number' ? e.status : 1,
          stdout: outputToString(e.stdout),
          stderr: outputToString(e.stderr),
        };
      }
    },
  };
}

export function assertReadOnlyGitArgs(args: readonly string[]): void {
  if (isAllowedGitArgs(args)) return;
  throw new Error(`release guard refuses unsupported git command shape: git ${args.join(' ')}`);
}

export function runReleaseGuard(options: ReleaseGuardOptions, runner: GitRunner): ReleaseGuardReport {
  const checks: ReleaseGuardCheck[] = [];

  const status = runner.runGit(['status', '--porcelain']);
  checks.push(status.stdout.trim().length === 0 && status.status === 0
    ? pass('clean-worktree', 'Worktree is clean.')
    : fail('clean-worktree', 'Worktree has local changes.', boundOutput(`${status.stdout}\n${status.stderr}`)));

  const ancestor = runner.runGit(['merge-base', '--is-ancestor', options.base, options.head]);
  checks.push(ancestor.status === 0
    ? pass('base-ancestor', `Base ${options.base} is an ancestor of ${options.head}.`)
    : fail('base-ancestor', `Base ${options.base} is not proven to be an ancestor of ${options.head}.`, boundOutput(ancestor.stderr || ancestor.stdout)));

  const diffCheck = runner.runGit(['diff', '--check', `${options.base}...${options.head}`]);
  checks.push(diffCheck.status === 0
    ? pass('diff-whitespace', 'git diff --check passed.')
    : fail('diff-whitespace', 'git diff --check found whitespace/conflict-marker problems.', boundOutput(`${diffCheck.stdout}\n${diffCheck.stderr}`)));

  checks.push(checkExpectedTag(options, runner));
  checks.push(checkMasterOriginAlignment(options, runner));
  checks.push(checkReviewerRequired(options, runner));
  checks.push(pass(
    'mutation-boundary',
    'Advisory only: this command performs read-only local Git inspection and never approves, merges, tags, pushes, or deletes refs.',
    'Coordinator, Reviewer, and Clint still make GO/HOLD decisions. O4 and O5 remain open/deferred; FileCustodian remains a hardened reference harness, not production KMS.',
  ));

  return {
    report: 'phase-27-release-guard',
    version: 1,
    advisoryOnly: true,
    mode: options.mode,
    phase: options.phase,
    base: options.base,
    head: options.head,
    tag: options.tag,
    decisionBoundary: 'This report is advisory support only and is not approval to push, merge, tag, delete branches, or close readiness gates.',
    checks,
    invokedGitCommands: runner.commands.map((cmd) => `git ${cmd.join(' ')}`),
  };
}

export function hasFailedGuardChecks(report: ReleaseGuardReport): boolean {
  return report.checks.some((check) => check.status === 'fail');
}

export function formatReleaseGuardText(report: ReleaseGuardReport): string {
  const lines: string[] = [];
  lines.push(`Phase ${report.phase ?? '?'} release guard (${report.mode})`);
  lines.push(report.decisionBoundary);
  lines.push('');
  lines.push(`base: ${report.base}`);
  lines.push(`head: ${report.head}`);
  if (report.tag) lines.push(`expected tag: ${report.tag}`);
  lines.push('');
  lines.push('Checks:');
  for (const check of report.checks) {
    lines.push(`- ${check.status.toUpperCase()} ${check.id}: ${check.summary}`);
    if (check.detail) lines.push(`  ${check.detail.replace(/\n/g, '\n  ')}`);
  }
  lines.push('');
  lines.push('Read-only Git commands invoked:');
  for (const command of report.invokedGitCommands) lines.push(`- ${command}`);
  lines.push('');
  lines.push('No approval action was taken.');
  return `${lines.join('\n')}\n`;
}

export function formatReleaseGuardJson(report: ReleaseGuardReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function checkExpectedTag(options: ReleaseGuardOptions, runner: GitRunner): ReleaseGuardCheck {
  if (!options.tag) return warn('expected-tag', 'No expected tag was provided; skipping tag presence/absence check.');
  const tag = runner.runGit(['show-ref', '--tags', '--verify', `refs/tags/${options.tag}`]);
  const exists = tag.status === 0;
  if (options.mode === 'post-merge') {
    return exists
      ? pass('expected-tag', `Expected tag ${options.tag} exists.`)
      : fail('expected-tag', `Expected tag ${options.tag} is absent after merge/tag phase.`, boundOutput(tag.stderr || tag.stdout));
  }
  return exists
    ? fail('expected-tag', `Expected release tag ${options.tag} already exists before merge/tag cleanup.`)
    : pass('expected-tag', `Expected release tag ${options.tag} is absent before merge/tag cleanup.`);
}

function checkMasterOriginAlignment(options: ReleaseGuardOptions, runner: GitRunner): ReleaseGuardCheck {
  if (options.mode === 'pre-pr') {
    return warn('master-origin-alignment', 'Skipped for pre-pr mode; run pre-merge/post-merge when master/origin alignment matters.');
  }
  const master = runner.runGit(['rev-parse', 'master']);
  const origin = runner.runGit(['rev-parse', 'origin/master']);
  if (master.status !== 0 || origin.status !== 0) {
    return fail('master-origin-alignment', 'Could not resolve master and origin/master.', boundOutput(`${master.stderr}\n${origin.stderr}`));
  }
  const local = master.stdout.trim();
  const remote = origin.stdout.trim();
  return local === remote
    ? pass('master-origin-alignment', `master and origin/master both resolve to ${local}.`)
    : fail('master-origin-alignment', `master (${local}) differs from origin/master (${remote}).`);
}

function checkReviewerRequired(options: ReleaseGuardOptions, runner: GitRunner): ReleaseGuardCheck {
  const names = runner.runGit(['diff', '--name-only', `${options.base}...${options.head}`]);
  const diff = runner.runGit(['diff', '--unified=0', `${options.base}...${options.head}`]);
  const changedFiles = names.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fileTriggers = changedFiles.filter((file) => REVIEWER_FILE_PATTERNS.some((pattern) => pattern.test(file.replace(/\\/g, '/'))));
  const textTriggers = REVIEWER_TEXT_PATTERNS.filter((pattern) => pattern.test(diff.stdout)).map((pattern) => pattern.source);
  if (fileTriggers.length === 0 && textTriggers.length === 0) {
    return pass('reviewer-required-triggers', 'No reviewer-required trigger was detected from changed file names or bounded diff text.');
  }
  const detail = [
    fileTriggers.length > 0 ? `files: ${fileTriggers.slice(0, 20).join(', ')}` : '',
    textTriggers.length > 0 ? `text patterns: ${textTriggers.slice(0, 8).join('; ')}` : '',
  ].filter(Boolean).join('\n');
  return warn('reviewer-required-triggers', 'Independent Reviewer is required by Phase 24 trigger rules.', boundOutput(detail));
}

function pass(id: string, summary: string, detail?: string): ReleaseGuardCheck {
  return { id, status: 'pass', summary, detail };
}

function warn(id: string, summary: string, detail?: string): ReleaseGuardCheck {
  return { id, status: 'warn', summary, detail };
}

function fail(id: string, summary: string, detail?: string): ReleaseGuardCheck {
  return { id, status: 'fail', summary, detail };
}

function outputToString(value: Buffer | string | undefined): string {
  if (typeof value === 'string') return value;
  if (value) return value.toString('utf8');
  return '';
}

function isAllowedGitArgs(args: readonly string[]): boolean {
  if (sameArgs(args, ['status', '--porcelain'])) return true;
  if (args.length === 4 && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
    return isSafeRef(args[2]) && isSafeRef(args[3]);
  }
  if (args.length === 3 && args[0] === 'diff' && args[1] === '--check') {
    return isSafeRange(args[2]);
  }
  if (args.length === 4 && args[0] === 'show-ref' && args[1] === '--tags' && args[2] === '--verify') {
    return isSafeTagRef(args[3]);
  }
  if (args.length === 2 && args[0] === 'rev-parse') {
    return args[1] === 'master' || args[1] === 'origin/master';
  }
  if (args.length === 3 && args[0] === 'diff' && args[1] === '--name-only') {
    return isSafeRange(args[2]);
  }
  if (args.length === 3 && args[0] === 'diff' && args[1] === '--unified=0') {
    return isSafeRange(args[2]);
  }
  return false;
}

function sameArgs(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((arg, idx) => actual[idx] === arg);
}

function isSafeRange(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split('...');
  return parts.length === 2 && parts.every(isSafeRef);
}

function isSafeTagRef(value: string | undefined): boolean {
  if (!value || !value.startsWith('refs/tags/')) return false;
  return isSafeRef(value.slice('refs/tags/'.length));
}

function isSafeRef(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-') && !/[\u0000\r\n]/.test(value);
}

function boundOutput(output: string): string {
  const redacted = output
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '<redacted-db-url>')
    .replace(/(token|secret|password|key|kek|credential)=\S+/gi, '$1=<redacted>');
  const trimmed = redacted.trim();
  if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n...<truncated>`;
}
