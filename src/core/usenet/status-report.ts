import {
  USENET_JOB_STATES,
  USENET_JOB_STATE_TITLES,
  USENET_REFUSAL_REASONS,
  isTransientRefusal,
  type UsenetJobState,
  type UsenetRefusalReason,
} from './sab-contract.js';
import { assertSealedSafe } from './sealed.js';
import { stateOf } from './admission.js';
import type { LedgerJob } from './job-ledger.js';

// Projection Phase 9 §3, LAST DELIVERABLE — the surface an operator reads.
//
// WHAT AN OPERATOR NEEDS FROM IT, AND WHAT THEY MUST NOT BE ABLE TO GET FROM IT.
//
// They need to answer four questions without opening a terminal on the worker: is anything moving, is
// anything stuck, is anything refused and why, and did the thing I submitted an hour ago land. All four are
// answerable from the ledger alone plus one reading of the worker, and all four are answerable in the closed
// vocabulary §3 fixes — downloading, repairing, unpacking, ready-to-admit, admitted, refused.
//
// THEY MUST NOT BE ABLE TO GET: the NZB URL, the indexer, the release name, the article ids, the completed
// path, the worker's job id or the API key. Not because a status document is likely to be published, but
// because every one of the tranches before this one preserved its evidence, and closure rule 9 says these
// appear in none of it. So a job is named by its submission key's first eleven characters and by its
// fingerprints, and `toStatusDocument` runs the sealed-value scanner over its own output before returning it.
// If a future edit interpolates something it should not, the function throws rather than returns.

export interface UsenetJobStatus {
  /** The submission key's first eleven characters. Stable, opaque, and enough to talk about one job. */
  readonly job: string;
  readonly state: UsenetJobState;
  readonly stateMeaning: string;
  /** The sealed source's fingerprint: same value, same fingerprint, across restarts and across hosts. */
  readonly source: string;
  /** Present once the worker has acknowledged the job. */
  readonly worker: string | null;
  readonly category: string;
  readonly since: string;
  readonly refusal: {
    readonly reason: UsenetRefusalReason;
    readonly transient: boolean;
    readonly meaning: string;
    readonly at: string;
  } | null;
  /** Present only once admitted. A projected path is namespace identity, not content identity. */
  readonly admitted: {
    readonly projectedPath: string;
    readonly projectedEntryId: string;
    readonly sizeBytes: number;
    /** The first sixteen characters of the whole-file digest. Enough to compare; not a re-derivable proof. */
    readonly digestPrefix: string;
    readonly at: string;
  } | null;
}

export interface UsenetStatusDocument {
  readonly phase: 9;
  readonly worker: 'SABnzbd';
  /** Counts by state, with every state present at zero rather than omitted. */
  readonly counts: Readonly<Record<UsenetJobState, number>>;
  readonly jobs: readonly UsenetJobStatus[];
  /** How many jobs are refused for a reason that looking again could resolve. */
  readonly retryable: number;
  /** How many jobs are refused for a reason that needs an operator. */
  readonly blocked: number;
}

/**
 * What each refusal MEANS to an operator, in one line.
 *
 * Every reason in the closed set has an entry, and `test/usenet-status-report.ts` asserts that — an operator
 * meeting a refusal with no explanation has been told a code, not a reason.
 */
export const USENET_REFUSAL_MEANINGS: Readonly<Record<UsenetRefusalReason, string>> = Object.freeze({
  'job-failed-at-worker': 'the worker could not complete this download; look at the worker\'s own history',
  'job-not-complete': 'the worker has not finished; nothing is wrong yet',
  'job-still-queued': 'the worker still has this job in its queue',
  'job-absent-from-worker': 'the worker knows nothing about this job; disappearance is never read as success',
  'worker-state-unrecognised': 'the worker reported a state this build does not define; upgrade or report it',
  'worker-unreachable': 'the worker did not answer; nothing has been assumed about the job',
  'worker-response-malformed': 'the worker answered with something that is not the document it should be',
  'worker-response-too-large': 'the worker answered with more than one reading is bounded to',
  'worker-rejected-credential': 'the worker rejected the API key; check the key file and its permissions',
  'output-root-unusable': 'the configured completed-download root is missing, is a link, or is not a directory',
  'output-path-escapes-root': 'the worker named an output outside the dedicated completed root',
  'output-path-not-normalized': 'the worker named an output whose path this contract will not interpret',
  'output-not-uniquely-identified': 'the completed job holds no publishable file, or more than one',
  'output-unpack-residue': 'an archive or repair artefact is still beside the output; the worker is not done',
  'output-component-is-symlink': 'a directory on the way to the output is a symbolic link, which is never followed',
  'output-is-symlink': 'the output is a symbolic link, which is never followed',
  'output-not-regular-file': 'the output is a directory, device, FIFO or socket rather than a file',
  'output-missing': 'the output named by the worker is not there',
  'output-empty': 'the output is smaller than anything this contract publishes',
  'output-too-large': 'the output is larger than this contract will digest',
  'output-multiply-linked': 'the output has a second name, so something else can still replace its bytes',
  'output-still-changing': 'the output moved between two observations; the worker may still be writing it',
  'output-mutated-during-digest': 'the output changed while it was being read; nothing was published',
  'output-name-not-projectable': 'the output cannot be named in the namespace without being rewritten; rename it',
  'already-admitted': 'this job was already published with the same proof; nothing was published twice',
  'admitted-digest-mismatch': 'this job is already published with different bytes; neither reading is trusted',
  'ledger-state-conflict': 'the ledger and the reading disagree; reconciliation will look again',
  'submission-not-reserved': 'an output was found for a submission this control plane has no record of making',
  'catalog-record-missing': 'the submission names no catalog record, so an admitted entry would have no logical media id',
  'credential-file-unreadable': 'the API key file is missing or could not be read',
  'credential-file-permissive': 'the API key file grants access beyond its owner, or is a link',
  'credential-file-malformed': 'the API key file does not hold a single opaque key',
  'nzb-source-not-approved': 'the submitted source is not an operator-approved sealed NZB source',
  'category-not-dedicated': 'the job is not in the dedicated category this phase owns',
});

/** Build the document. It refuses to return one that carries unsealed identity. */
export function toStatusDocument(jobs: readonly LedgerJob[]): UsenetStatusDocument {
  const counts: Record<UsenetJobState, number> = {
    downloading: 0, repairing: 0, unpacking: 0, 'ready-to-admit': 0, admitted: 0, refused: 0,
  };
  let retryable = 0;
  let blocked = 0;

  const rows: UsenetJobStatus[] = jobs.map((job) => {
    const state = stateOf(job);
    counts[state] += 1;
    if (job.refusal !== null) {
      if (isTransientRefusal(job.refusal.reason)) retryable += 1;
      else blocked += 1;
    }
    return {
      job: job.key.slice(0, 11),
      state,
      stateMeaning: USENET_JOB_STATE_TITLES[state],
      source: job.sourceFingerprint,
      worker: job.jobFingerprint,
      category: job.category,
      since: job.updatedAt,
      refusal: job.refusal === null ? null : {
        reason: job.refusal.reason,
        transient: job.refusal.transient,
        meaning: USENET_REFUSAL_MEANINGS[job.refusal.reason],
        at: job.refusal.at,
      },
      admitted: job.admitted === null ? null : {
        projectedPath: job.admitted.projectedPath,
        projectedEntryId: job.admitted.projectedEntryId,
        sizeBytes: job.admitted.sizeBytes,
        digestPrefix: job.admitted.sha256.slice(0, 16),
        at: job.admitted.at,
      },
    };
  });

  const document: UsenetStatusDocument = {
    phase: 9,
    worker: 'SABnzbd',
    counts: Object.freeze(counts),
    jobs: rows,
    retryable,
    blocked,
  };
  // THE LAST GATE BEFORE ANYTHING IS PRINTED. It scans for the shapes a leak would have — a URL, an absolute
  // download path, an article id, an `apikey=` parameter, a worker job id — and throws rather than returning
  // a document carrying one.
  assertSealedSafe(document, 'status');
  return document;
}

/** Render the document as lines. Same content, for an operator who is not piping it into `jq`. */
export function renderStatusLines(document: UsenetStatusDocument): readonly string[] {
  const lines: string[] = [];
  lines.push('projection phase 9 — usenet jobs');
  lines.push(USENET_JOB_STATES.map((state) => `${state}=${document.counts[state]}`).join('  '));
  if (document.jobs.length === 0) lines.push('  (no submissions recorded)');
  for (const job of document.jobs) {
    lines.push(`  ${job.job}  ${job.state.padEnd(14)} source=${job.source} since=${job.since}`);
    if (job.refusal !== null) {
      lines.push(`      refused: ${job.refusal.reason} (${job.refusal.transient ? 'retryable' : 'needs an operator'})`);
      lines.push(`      ${job.refusal.meaning}`);
    }
    if (job.admitted !== null) {
      lines.push(`      admitted: ${job.admitted.projectedPath} (${job.admitted.sizeBytes} bytes, `
        + `sha256:${job.admitted.digestPrefix}…)`);
    }
  }
  lines.push(`retryable=${document.retryable}  blocked=${document.blocked}`);
  return lines;
}

/** Exported so a suite can prove the meanings table covers the closed set exactly, with no extra key. */
export const USENET_REFUSAL_MEANING_KEYS: readonly string[] = Object.freeze(Object.keys(USENET_REFUSAL_MEANINGS));
export const USENET_REFUSAL_REASON_KEYS: readonly string[] = USENET_REFUSAL_REASONS;
