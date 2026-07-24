import { readFileSync } from 'node:fs';
import { decideRelease, type ReleaseEventContext } from './release-ref.js';
import type { GateStatus, RehearsalOutcome } from './release-rehearsal.js';
import {
  REHEARSAL_GATE_UNREADABLE_EXIT,
  interpretRehearsalGate,
  type RehearsalReportView,
} from './release-rehearsal-gate.js';

// Phase 252 — `ops:release-rehearsal-gate`, the event-aware interpreter that decides whether a rehearsal
// report is a CI pass for THIS event.
//
//   npm run ops:release-rehearsal-gate -- --report dist/handoff.json
//
// It reads the handoff packet ops:release-rehearsal wrote and the GitHub event context (from the environment,
// exactly as the publish release-ref gate does), and exits 0 when the rehearsal should pass for this event or
// non-zero when it must fail. On a publish-reaching event only HANDOFF_READY passes; on a non-publishing
// validation event a NOT_RUN caused solely by the intentionally absent release tag also passes. A missing or
// unreadable packet fails closed. It publishes nothing and holds no permission.

const VALID_OUTCOMES: readonly RehearsalOutcome[] = ['HANDOFF_READY', 'BLOCKED', 'INVALID', 'NOT_RUN'];
const VALID_STATUSES: readonly GateStatus[] = ['PASS', 'BLOCK', 'INVALID', 'NOT_RUN'];

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

/** Build the release event context from flags/env, identical in spirit to ops:release-ref, so the two agree. */
function contextFromEnv(args: readonly string[]): ReleaseEventContext {
  const repository = valueAfter(args, '--repository') ?? process.env.GITHUB_REPOSITORY ?? '';
  const owner = valueAfter(args, '--owner') ?? process.env.GITHUB_REPOSITORY_OWNER ?? repository.split('/')[0] ?? '';
  const releaseTag = valueAfter(args, '--release-tag') ?? process.env.RELEASE_TAG_NAME;
  const publishInput = valueAfter(args, '--publish-input') ?? process.env.RELEASE_PUBLISH_INPUT;
  const ref = valueAfter(args, '--ref') ?? process.env.GITHUB_REF;
  const draft = args.includes('--draft') ? true : process.env.RELEASE_DRAFT === 'true';
  return {
    eventName: valueAfter(args, '--event') ?? process.env.GITHUB_EVENT_NAME ?? 'unknown',
    ...(ref === undefined || ref === '' ? {} : { ref }),
    ...(releaseTag === undefined || releaseTag === '' ? {} : { releaseTagName: releaseTag }),
    releaseDraft: draft,
    ...(publishInput === undefined ? {} : { publishInput }),
    repository,
    repositoryOwner: owner,
  };
}

/** Read and validate the rehearsal report to the minimal view the gate needs. Throws on any malformity. */
function readReport(path: string): RehearsalReportView {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object') throw new Error('the handoff packet is not an object');
  const record = parsed as Record<string, unknown>;
  const outcome = record.outcome;
  if (typeof outcome !== 'string' || !VALID_OUTCOMES.includes(outcome as RehearsalOutcome)) {
    throw new Error('the handoff packet has no recognised outcome');
  }
  if (!Array.isArray(record.gates)) throw new Error('the handoff packet has no gates array');
  const gates = record.gates.map((gate) => {
    if (gate === null || typeof gate !== 'object') throw new Error('a gate entry is not an object');
    const id = (gate as Record<string, unknown>).id;
    const status = (gate as Record<string, unknown>).status;
    if (typeof id !== 'string') throw new Error('a gate entry has no id');
    if (typeof status !== 'string' || !VALID_STATUSES.includes(status as GateStatus)) throw new Error('a gate entry has no recognised status');
    return { id, status: status as GateStatus };
  });
  const candidate = record.candidate;
  const candidateCommit = candidate !== null && typeof candidate === 'object'
    ? (candidate as Record<string, unknown>).candidateCommit
    : undefined;
  if (candidateCommit !== null && typeof candidateCommit !== 'string') {
    throw new Error('the handoff packet has no candidate.candidateCommit');
  }
  return { outcome: outcome as RehearsalOutcome, gates, candidate: { candidateCommit: candidateCommit ?? null } };
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('usage: ops:release-rehearsal-gate --report <handoff.json> [--event <name>] [--ref <refs/...>]');
    console.log('                                 [--release-tag <tag>] [--draft] [--publish-input <bool>]');
    console.log('                                 [--repository <owner/name>] [--owner <owner>]');
    console.log('');
    console.log('Reads a rehearsal handoff packet and the event context and decides whether the rehearsal passes');
    console.log('CI for this event. Publish-reaching events require HANDOFF_READY; a non-publishing validation');
    console.log('event also accepts a NOT_RUN caused solely by the intentionally absent release tag. Fails closed.');
    return 0;
  }

  const reportPath = valueAfter(args, '--report');
  if (reportPath === undefined || reportPath.trim() === '') {
    console.error('FAIL: --report <handoff.json> is required.');
    return 2;
  }

  const context = contextFromEnv(args);
  const publishReaching = decideRelease(context).publish;

  let report: RehearsalReportView;
  try {
    report = readReport(reportPath);
  } catch (err) {
    // Fail closed: a rehearsal whose packet cannot be read is never a pass, on any event.
    console.error(`FAIL: the rehearsal handoff packet at ${reportPath} could not be read: ${(err as Error).message}`);
    console.error(`event is ${publishReaching ? 'publish-reaching' : 'a non-publishing validation event'}; refusing to pass on an unreadable rehearsal.`);
    return REHEARSAL_GATE_UNREADABLE_EXIT;
  }

  const decision = interpretRehearsalGate(report, { publishReaching });
  const kind = publishReaching ? 'publish-reaching' : 'validation';
  if (decision.pass) {
    console.log(`rehearsal gate PASS (${kind} event, outcome ${report.outcome}): ${decision.reason}`);
    return 0;
  }
  console.error(`rehearsal gate FAIL (${kind} event, outcome ${report.outcome}): ${decision.reason}`);
  return decision.code;
}

process.exit(main());
