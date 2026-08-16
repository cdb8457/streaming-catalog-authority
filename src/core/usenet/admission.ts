import {
  SAB_HISTORY_STATUS_LIFECYCLE,
  SAB_QUEUE_STATUS_LIFECYCLE,
  USENET_DEDICATED_CATEGORY,
  submissionMarkerFor,
  type UsenetJobState,
  type UsenetRefusalReason,
} from './sab-contract.js';
import type { SabClient, SabHistorySlot, SabQueueSlot } from './sab-client.js';
import type { SealedValue } from './sealed.js';
import { deriveSubmissionKey, type LedgerJob, type UsenetJobLedger } from './job-ledger.js';
import {
  findAdmissibleOutput,
  proveOutput,
  relativeSegmentsUnderRoot,
  type AdmissionClock,
  type OutputFileSystem,
} from './completed-output.js';
import { planLocalSource, torBoxDrift, type UsenetLocalSourcePlan } from './manifest-bridge.js';
import type { ProjectedEntry } from '../projection/manifest-v1.js';

// Projection Phase 9 — reconciliation and admission, which is where every other module in this directory is
// finally allowed to have an effect.
//
// THE ONE SENTENCE THAT DESCRIBES THIS FILE'S JOB: turn what the worker says into what the ledger records,
// and turn a ledger that says `ready-to-admit` into exactly one published local source.
//
// THE FOUR RULES IT IS BUILT AROUND.
//
//   A JOB IS FOUND, NEVER ASSUMED. `reconcileOne` looks for the job's own marker in the queue and in the
//   history. Absent from both is `job-absent-from-worker` — a NAMED refusal — and never "it finished". §4.
//
//   COMPLETION IS THE WORKER'S CLAIM AND THE CONTROL PLANE'S QUESTION. `Completed` in history moves the job
//   to `ready-to-admit`, which is the state in which the output checks RUN. Nothing about a history status
//   publishes anything.
//
//   PUBLISH-THEN-RECORD IS THE ONLY SAFE ORDER, AND THE LEDGER IS WHAT MAKES IT SAFE. Registration is
//   idempotent by derivation — the same path derives the same entry id and the same digest derives the same
//   version key — so a crash between publishing and recording leaves a re-run that publishes the identical
//   thing again and then records it. The reverse order would leave a ledger claiming an entry that does not
//   exist, which nothing later could detect.
//
//   AN ADMITTED ENTRY IS NEVER UNPUBLISHED HERE. There is no code path in this file that retires, degrades or
//   deletes anything. §1: a Usenet failure shall not empty, rename or make unavailable an already-admitted
//   entry, and the way that is guaranteed is that the failure path has no such verb available to it.

export interface AdmissionPublisher {
  /**
   * Register the version and the entry, and return the projected entry id.
   *
   * IT IS EXPECTED TO BE IDEMPOTENT, and the existing registration boundary already is: `registerVersion` and
   * `registerEntry` derive their ids from their inputs and upsert.
   */
  publish(plan: UsenetLocalSourcePlan, itemId: string): Promise<{ readonly projectedEntryId: string }>;
  /**
   * The namespace as it stands, when the publisher can present it.
   *
   * WHY IT IS OPTIONAL AND WHY IT IS HERE AT ALL. §4's sixth hard refusal is "let a Usenet outage alter the
   * TorBox namespace", and `torBoxDrift` is the check that proves it — but a check that only ever runs in a
   * rehearsal proves a property of the rehearsal. So the admission path runs it around every publish, for
   * every publisher that can answer this question. A publisher that cannot answer it does not get a weaker
   * guard silently: `admittedWithoutDriftCheck` on the outcome says so, and the operator surface carries it.
   */
  namespaceSnapshot?(): Promise<readonly ProjectedEntry[]>;
}

export interface AdmissionServiceConfig {
  readonly client: SabClient;
  readonly ledger: UsenetJobLedger;
  readonly fs: OutputFileSystem;
  readonly clock: AdmissionClock;
  readonly publisher: AdmissionPublisher;
  /** The worker's dedicated completed-download root, as an absolute POSIX path on the control plane's view. */
  readonly completedRoot: string;
  /** The local root id the appliance already serves the media directory as. */
  readonly rootId: string;
  /** Where the completed root sits under the media root, as segments. */
  readonly completedRootUnderMediaRoot: readonly string[];
  readonly category?: string;
  readonly pathPrefix?: string;
}

export interface SubmitOutcome {
  readonly key: string;
  readonly marker: string;
  readonly sourceFingerprint: string;
  readonly outcome: 'submitted' | 'already-known' | 'refused';
  readonly state: UsenetJobState;
  readonly reason?: UsenetRefusalReason;
  readonly detail?: string;
}

export interface ReconcileOutcome {
  readonly key: string;
  readonly marker: string;
  readonly state: UsenetJobState;
  readonly changed: boolean;
  readonly reason?: UsenetRefusalReason;
  readonly detail?: string;
  /** Present only on the reconciliation that admitted. Never a path. */
  readonly admitted?: {
    readonly projectedPath: string;
    readonly projectedEntryId: string;
    readonly versionKey: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  };
  /**
   * True when this admission was published by a publisher that cannot present the namespace, so the TorBox
   * drift comparison could not be made. It is reported rather than assumed either way.
   */
  readonly admittedWithoutDriftCheck?: boolean;
}

export class UsenetAdmissionService {
  private readonly config: AdmissionServiceConfig;

  constructor(config: AdmissionServiceConfig) {
    this.config = config;
  }

  /**
   * Submit one operator-approved source, exactly once, ever.
   *
   * THE ORDER IS THE WHOLE GUARANTEE: reserve durably, then call. A caller that finds the key already
   * reserved is told so and nothing is sent — recovering an ambiguous earlier attempt is `reconcile`'s job,
   * because recovering it means LOOKING, and looking is not something a submit path should be doing.
   */
  async submit(sealedSource: SealedValue, itemId: string): Promise<SubmitOutcome> {
    const category = this.config.category ?? USENET_DEDICATED_CATEGORY;
    if (sealedSource.kind !== 'nzb-source') {
      return {
        key: '', marker: '', sourceFingerprint: '', outcome: 'refused', state: 'refused',
        reason: 'nzb-source-not-approved', detail: 'a submission takes a sealed NZB source',
      };
    }
    const key = deriveSubmissionKey(sealedSource, category);
    const reservation = this.config.ledger.reserve({ sealedSource, category, itemId });
    const marker = submissionMarkerFor(key);

    // A RESERVATION MAY BE SUBMITTED EXACTLY WHEN NOTHING HAS EVER BEEN SENT UNDER IT.
    //
    // That is true in two situations and only two: the reservation was just created, or a reconciliation
    // read the queue and the history, found no job carrying this marker, and recorded `submission-lost` —
    // which resets the job to "as if never attempted". Every other shape, including a reservation whose
    // submission timed out and might have landed, is `already-known`, and reconciliation is what advances it.
    const neverSent = reservation.job.phase === 'reserved'
      && reservation.job.jobFingerprint === null
      && reservation.job.lastObservedState === null
      && reservation.job.refusal === null;

    if (!reservation.created && !neverSent) {
      return {
        key,
        marker,
        sourceFingerprint: sealedSource.fingerprint(),
        outcome: 'already-known',
        state: stateOf(reservation.job),
        detail: 'this source is already recorded; reconciliation, not a second submission, is what advances it',
      };
    }

    const submitted = await this.config.client.submitUrl(sealedSource, marker);
    if (!submitted.ok) {
      // THE TWO KINDS OF SUBMISSION FAILURE ARE RECORDED DIFFERENTLY, and getting this wrong wedges a
      // submission forever in one direction or downloads it twice in the other.
      //
      //   AMBIGUOUS — a timeout or a refused connection. The worker MAY have accepted it. An observation is
      //   recorded so that a second `submit` is refused as already-known; reconciliation resolves it by
      //   LOOKING for the marker, and only reconciliation may declare it lost.
      //
      //   DEFINITIVE — the worker answered and declined: a rejected credential, a malformed answer, a
      //   declined NZB. Nothing was created, so the reservation is recorded as lost rather than refused. A
      //   permanent refusal here would mean an operator who fixed their API key could never submit that
      //   source again, because the submission key is derived from the source.
      const ambiguous = submitted.reason === 'worker-unreachable';
      if (ambiguous) this.config.ledger.recordObserved(key, 'downloading');
      else this.config.ledger.recordSubmissionLost(key);
      return {
        key, marker, sourceFingerprint: sealedSource.fingerprint(), outcome: 'refused',
        state: ambiguous ? 'downloading' : 'refused', reason: submitted.reason, detail: submitted.detail,
      };
    }

    this.config.ledger.confirmSubmitted(key, submitted.value.jobRef);
    return {
      key, marker, sourceFingerprint: sealedSource.fingerprint(), outcome: 'submitted', state: 'downloading',
    };
  }

  /**
   * Reconcile every non-terminal job against one reading of the worker.
   *
   * TWO KINDS OF JOB ARE SKIPPED, AND FOR OPPOSITE REASONS. An ADMITTED job is skipped because §1 says a
   * Usenet failure shall not touch one, and the cheapest way to keep that promise is for the failure path
   * never to run over it. A PERMANENTLY REFUSED job is skipped because looking again would produce the same
   * answer: a symlinked output will still be a symlinked output in ten minutes, and a timer that re-derived
   * that refusal every cycle would append a ledger record per cycle and tell nobody anything new. A job
   * refused for a TRANSIENT reason is NOT skipped — that is the whole difference between the two words.
   */
  async reconcileAll(): Promise<readonly ReconcileOutcome[]> {
    const all = this.config.ledger.all();
    const jobs = all.filter((job) => job.phase !== 'admitted'
      && !(job.refusal !== null && !job.refusal.transient));
    if (jobs.length === 0) return [];

    const queue = await this.config.client.queue();
    if (!queue.ok) {
      return jobs.map((job) => ({
        key: job.key, marker: job.marker, state: stateOf(job), changed: false,
        reason: queue.reason, detail: queue.detail,
      }));
    }
    const history = await this.config.client.history();
    if (!history.ok) {
      return jobs.map((job) => ({
        key: job.key, marker: job.marker, state: stateOf(job), changed: false,
        reason: history.reason, detail: history.detail,
      }));
    }

    const outcomes: ReconcileOutcome[] = [];
    for (const job of jobs) {
      outcomes.push(await this.reconcileOne(job, queue.value, history.value));
    }
    return outcomes;
  }

  private async reconcileOne(
    job: LedgerJob,
    queue: readonly SabQueueSlot[],
    history: readonly SabHistorySlot[],
  ): Promise<ReconcileOutcome> {
    const inQueue = queue.find((slot) => matches(job, slot));
    const inHistory = history.find((slot) => matches(job, slot));

    if (inQueue !== undefined) {
      // A JOB PRESENT IN BOTH IS TREATED AS PRESENT IN THE QUEUE. SABnzbd can briefly show both while it
      // moves a job across, and the safe reading of "it might still be running" is that it is.
      const state = SAB_QUEUE_STATUS_LIFECYCLE[inQueue.status];
      if (job.phase === 'reserved') this.config.ledger.confirmSubmitted(job.key, inQueue.jobRef);
      this.config.ledger.recordObserved(job.key, state, inQueue.jobRef);
      return { key: job.key, marker: job.marker, state, changed: job.lastObservedState !== state };
    }

    if (inHistory === undefined) {
      if (job.phase === 'reserved') {
        // THE ONE CASE THIS WHOLE MARKER MECHANISM EXISTS FOR. A reservation whose marker is in neither list
        // was never accepted by the worker, and saying so durably is what lets an operator submit it again
        // without wondering whether they are about to download it twice.
        this.config.ledger.recordSubmissionLost(job.key);
        return {
          key: job.key, marker: job.marker, state: 'refused', changed: true,
          reason: 'job-absent-from-worker',
          detail: 'the worker never accepted this submission; it may be submitted again',
        };
      }
      // A CONFIRMED JOB THAT HAS LEFT BOTH LISTS IS A REFUSAL, NOT A COMPLETION. §4.
      this.config.ledger.recordRefused(job.key, 'job-absent-from-worker', false);
      return {
        key: job.key, marker: job.marker, state: 'refused', changed: true,
        reason: 'job-absent-from-worker',
        detail: 'the job is in neither the queue nor the history; disappearance is never read as success',
      };
    }

    if (inHistory.status !== 'Completed') {
      const state = SAB_HISTORY_STATUS_LIFECYCLE[inHistory.status];
      if (state === 'refused') {
        this.config.ledger.recordRefused(job.key, 'job-failed-at-worker', false);
        return {
          key: job.key, marker: job.marker, state: 'refused', changed: true,
          reason: 'job-failed-at-worker', detail: 'the worker recorded this job as failed',
        };
      }
      this.config.ledger.recordObserved(job.key, state, inHistory.jobRef);
      return { key: job.key, marker: job.marker, state, changed: job.lastObservedState !== state };
    }

    if (inHistory.failed) {
      this.config.ledger.recordRefused(job.key, 'job-failed-at-worker', false);
      return {
        key: job.key, marker: job.marker, state: 'refused', changed: true,
        reason: 'job-failed-at-worker', detail: 'the worker recorded a failure against this completed job',
      };
    }

    if (job.phase === 'reserved') this.config.ledger.confirmSubmitted(job.key, inHistory.jobRef);
    this.config.ledger.recordObserved(job.key, 'ready-to-admit', inHistory.jobRef);
    return this.admit(this.config.ledger.get(job.key) as LedgerJob, inHistory);
  }

  /**
   * Prove the output and publish it, exactly once.
   *
   * NOTHING HERE TRUSTS THE HISTORY SLOT except for the path it names, and the path is treated as a claim: it
   * has to be under the configured completed root, reachable without following a link, and hold exactly one
   * publishable file, or none of the rest of this runs.
   */
  private async admit(job: LedgerJob, slot: SabHistorySlot): Promise<ReconcileOutcome> {
    const base = { key: job.key, marker: job.marker } as const;

    if (slot.category !== (this.config.category ?? USENET_DEDICATED_CATEGORY)) {
      this.config.ledger.recordRefused(job.key, 'category-not-dedicated', false);
      return {
        ...base, state: 'refused', changed: true, reason: 'category-not-dedicated',
        detail: 'the completed job is not in the dedicated category this phase owns',
      };
    }
    if (job.itemId === null) {
      // A PUBLISHED ENTRY NEEDS A CATALOG RECORD. `logicalMediaId` is a required manifest field and it is the
      // control plane's own identity for the thing being projected; there is nothing to invent one from.
      this.config.ledger.recordRefused(job.key, 'catalog-record-missing', false);
      return {
        ...base, state: 'refused', changed: true, reason: 'catalog-record-missing',
        detail: 'this submission named no catalog record, so an admitted entry would have no logical media id',
      };
    }
    if (slot.storagePath === null) {
      this.config.ledger.recordRefused(job.key, 'output-missing', true);
      return {
        ...base, state: 'refused', changed: true, reason: 'output-missing',
        detail: 'the worker reported the job complete without naming an output',
      };
    }

    const relative = relativeSegmentsUnderRoot(this.config.completedRoot, slot.storagePath.reveal());
    if (!relative.ok) {
      this.config.ledger.recordRefused(job.key, relative.reason, relative.transient);
      return { ...base, state: 'refused', changed: true, reason: relative.reason, detail: relative.detail };
    }

    const found = await findAdmissibleOutput(this.config.fs, this.config.completedRoot, relative.value);
    if (!found.ok) {
      this.config.ledger.recordRefused(job.key, found.reason, found.transient);
      return { ...base, state: 'refused', changed: true, reason: found.reason, detail: found.detail };
    }

    const proven = await proveOutput(this.config.fs, this.config.clock, this.config.completedRoot, found.value.segments);
    if (!proven.ok) {
      this.config.ledger.recordRefused(job.key, proven.reason, proven.transient);
      return { ...base, state: 'refused', changed: true, reason: proven.reason, detail: proven.detail };
    }

    const plan = planLocalSource({
      output: proven.value,
      rootId: this.config.rootId,
      completedRootUnderMediaRoot: this.config.completedRootUnderMediaRoot,
      ...(this.config.pathPrefix === undefined ? {} : { pathPrefix: this.config.pathPrefix }),
    });
    if (!plan.ok) {
      this.config.ledger.recordRefused(job.key, plan.reason, false);
      return { ...base, state: 'refused', changed: true, reason: plan.reason, detail: plan.detail };
    }

    // THE TORBOX HALF, READ BEFORE THE PUBLISH. A snapshot taken here and compared after is the mechanism
    // §4's sixth hard refusal is kept by; taking it inside the `try` would mean a publisher that threw left
    // no `before` to compare against.
    let before: readonly ProjectedEntry[] | null = null;
    if (this.config.publisher.namespaceSnapshot !== undefined) {
      try {
        before = await this.config.publisher.namespaceSnapshot();
      } catch {
        before = null;
      }
    }

    let published: { readonly projectedEntryId: string };
    try {
      published = await this.config.publisher.publish(plan.value, job.itemId);
    } catch {
      // A PUBLISH THAT FAILED IS TRANSIENT AND IS NOT RECORDED AS AN ADMISSION. The next reconciliation
      // re-proves and re-publishes; both are idempotent, so repeating them costs a digest and nothing else.
      this.config.ledger.recordRefused(job.key, 'ledger-state-conflict', true);
      return {
        ...base, state: 'refused', changed: true, reason: 'ledger-state-conflict',
        detail: 'the registration boundary refused the admitted entry; reconciliation will try again',
      };
    }

    // AND READ AGAIN, BEFORE THE ADMISSION IS RECORDED. A publish that moved a provider-backed entry is not
    // an admission this control plane will write down: recording it would leave a ledger asserting that a
    // Usenet file was published cleanly while a TorBox entry it had no business touching had moved. The
    // refusal is PERMANENT, so reconciliation stops rather than re-publishing the same drift every cycle.
    if (before !== null && this.config.publisher.namespaceSnapshot !== undefined) {
      let drift: readonly { readonly code: string }[];
      try {
        drift = torBoxDrift(before, await this.config.publisher.namespaceSnapshot());
      } catch {
        drift = [{ code: 'TORBOX_SNAPSHOT_UNREADABLE' }];
      }
      if (drift.length > 0) {
        this.config.ledger.recordRefused(job.key, 'torbox-namespace-drifted', false);
        return {
          ...base, state: 'refused', changed: true, reason: 'torbox-namespace-drifted',
          detail: `publishing this entry moved the TorBox half of the namespace (${drift.map((problem) => problem.code).join(', ')}); `
            + 'the admission was not recorded',
        };
      }
    }

    const recorded = this.config.ledger.recordAdmitted(job.key, {
      sha256: plan.value.sha256,
      sizeBytes: plan.value.sizeBytes,
      projectedPath: plan.value.projectedPath,
      versionKey: plan.value.versionKey,
      projectedEntryId: published.projectedEntryId,
    });

    if (!recorded.admitted) {
      // EACH REASON GETS ITS OWN SENTENCE. A two-branch ternary here printed "already admitted with a
      // different proof" over `submission-not-reserved`, which is a different fact about a different
      // problem — and a refusal diagnostic that describes the wrong cause sends an operator to the wrong
      // place. §3's last deliverable is a surface that distinguishes; that starts here.
      const detail = recorded.reason === 'already-admitted'
        ? 'this job was already admitted with the same proof; nothing was published twice'
        : recorded.reason === 'admitted-digest-mismatch'
          ? 'this job is already admitted with a different proof, so neither reading is trusted'
          : recorded.reason === 'submission-not-reserved'
            ? 'an output was proved for a submission this control plane has no confirmed record of making'
            : 'the ledger refused to record this admission';
      return {
        ...base, state: recorded.reason === 'already-admitted' ? 'admitted' : 'refused', changed: false,
        ...(recorded.reason === undefined ? {} : { reason: recorded.reason }),
        detail,
      };
    }

    return {
      ...base,
      state: 'admitted',
      changed: true,
      ...(before === null ? { admittedWithoutDriftCheck: true } : {}),
      admitted: {
        projectedPath: plan.value.projectedPath,
        projectedEntryId: published.projectedEntryId,
        versionKey: plan.value.versionKey,
        sizeBytes: plan.value.sizeBytes,
        sha256: plan.value.sha256,
      },
    };
  }
}

/**
 * Whether a worker slot is this ledger job.
 *
 * TWO WAYS, BOTH CONTENT-FREE. The marker is the primary one — it is what the submission set and what a
 * restart looks for. The job fingerprint is the fallback, for a worker that did not echo the name back the way
 * this contract expects. Neither of them is a release name, so neither of them can carry content identity into
 * a comparison.
 */
function matches(job: LedgerJob, slot: { readonly marker: string | null; readonly jobRef: SealedValue }): boolean {
  if (slot.marker !== null && slot.marker === job.marker) return true;
  return job.jobFingerprint !== null && slot.jobRef.fingerprint() === job.jobFingerprint;
}

/** The operator-visible state of a ledger job, with no worker reading involved. */
export function stateOf(job: LedgerJob): UsenetJobState {
  if (job.phase === 'admitted') return 'admitted';
  if (job.phase === 'refused') return 'refused';
  const observed = job.lastObservedState;
  if (observed === 'downloading' || observed === 'repairing' || observed === 'unpacking'
    || observed === 'ready-to-admit') {
    return observed;
  }
  return 'downloading';
}
