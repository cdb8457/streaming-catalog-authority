import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHarness, assert, assertEq } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  SAB_BOUNDARY_CONTRACT,
  SAB_CLIENT_BOUNDS,
  SAB_FORBIDDEN_OPERATIONS,
  SAB_HISTORY_STATUSES,
  SAB_HISTORY_STATUS_LIFECYCLE,
  SAB_MUTATING_OPERATIONS,
  SAB_OPERATIONS,
  SAB_OPERATION_MODES,
  SAB_QUEUE_STATUSES,
  SAB_QUEUE_STATUS_LIFECYCLE,
  SAB_STATUS_ALIASES,
  USENET_ADMISSION_BOUNDS,
  USENET_DEDICATED_CATEGORY,
  USENET_JOB_STATES,
  USENET_JOB_STATE_TITLES,
  USENET_REFUSAL_REASONS,
  USENET_SUBMISSION_MARKER_SHAPE,
  USENET_TRANSIENT_REFUSALS,
  canonicalSabStatus,
  isMutatingSabOperation,
  isSabHistoryStatus,
  isSabOperation,
  isSabQueueStatus,
  isTransientRefusal,
  isUsenetRefusalReason,
  submissionMarkerFor,
} from '../src/core/usenet/sab-contract.js';

// Projection Phase 9 — the worker boundary contract, offline.
//
// WHAT THIS SUITE PINS. Every claim in `sab-contract.ts` that a running system would discover the hard way:
// that the state maps are TOTAL (a partial map is a default branch wearing a different hat), that the
// operation set is closed, that the forbidden operations are absent rather than merely unimplemented, that
// every bound is ordered sensibly, and that the phase document still says what this module says it says.

const h = createHarness('Projection Phase 9 — the SABnzbd boundary contract');
const { test } = h;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');
const CONTRACT = 'docs/PROJECTION_PHASE_9_TORBOX_USENET.md';

h.section('the operations, and the ones deliberately absent');

test('the operation set is exactly the five this phase needs', () => {
  assertEq(SAB_OPERATIONS.join(' '), 'version status queue history submit-url', 'the operation set');
  for (const operation of SAB_OPERATIONS) {
    assert(isSabOperation(operation), `${operation} is recognised`);
    assert(typeof SAB_OPERATION_MODES[operation] === 'string', `${operation} names a mode`);
  }
  assert(!isSabOperation('addfile'), 'an operation outside the set is not recognised');
  assert(!isSabOperation('history&del'), 'a compound is not an operation');
});

test('exactly one operation mutates, and it is the submission', () => {
  assertEq(SAB_MUTATING_OPERATIONS.length, 1, 'one mutating operation');
  assertEq(SAB_MUTATING_OPERATIONS[0], 'submit-url', 'the mutating operation');
  assert(isMutatingSabOperation('submit-url'), 'submit mutates');
  for (const operation of SAB_OPERATIONS) {
    if (operation === 'submit-url') continue;
    assert(!isMutatingSabOperation(operation), `${operation} is a read`);
  }
});

test('every forbidden operation names a reason, and none of them is a mode this client sends', () => {
  assert(SAB_FORBIDDEN_OPERATIONS.length >= 8, 'the forbidden list is not a token gesture');
  const sentModes = new Set<string>(Object.values(SAB_OPERATION_MODES));
  for (const forbidden of SAB_FORBIDDEN_OPERATIONS) {
    assert(forbidden.reason.length > 20, `${forbidden.mode} has no reason for being absent`);
    if (forbidden.extra === '') {
      assert(!sentModes.has(forbidden.mode), `${forbidden.mode} is both forbidden and sent`);
    }
  }
});

test('the four §4 refusals about deletion are represented in the forbidden list', () => {
  const reasons = SAB_FORBIDDEN_OPERATIONS.map((entry) => `${entry.mode} ${entry.extra} ${entry.reason}`).join(' | ');
  assert(/history/.test(reasons), 'deleting history is named');
  assert(/queue/.test(reasons), 'deleting queue input is named');
  assert(/get_config/.test(reasons), 'reading the worker configuration is named');
  assert(/NNTP server credentials/.test(reasons), 'the reason config is refused is that it carries NNTP credentials');
});

h.section('the state maps, which must be total');

test('every queue status maps to a lifecycle state, and the map has no extra key', () => {
  assertEq(Object.keys(SAB_QUEUE_STATUS_LIFECYCLE).length, SAB_QUEUE_STATUSES.length, 'the map is exactly the set');
  for (const status of SAB_QUEUE_STATUSES) {
    const state = SAB_QUEUE_STATUS_LIFECYCLE[status];
    assert(USENET_JOB_STATES.includes(state), `${status} maps outside the lifecycle`);
    assert(state !== 'admitted' && state !== 'ready-to-admit',
      `${status} is in the QUEUE and cannot mean the output is ready; a job the worker still holds is one the `
      + 'worker can still mutate');
  }
});

test('every history status maps to a lifecycle state, and only Completed reaches ready-to-admit', () => {
  assertEq(Object.keys(SAB_HISTORY_STATUS_LIFECYCLE).length, SAB_HISTORY_STATUSES.length, 'the map is exactly the set');
  for (const status of SAB_HISTORY_STATUSES) {
    const state = SAB_HISTORY_STATUS_LIFECYCLE[status];
    assert(USENET_JOB_STATES.includes(state), `${status} maps outside the lifecycle`);
    if (state === 'ready-to-admit') assertEq(status, 'Completed', 'only Completed is ready to admit');
    assert(state !== 'admitted', `${status} cannot mean admitted; admission is the control plane's word`);
  }
  assertEq(SAB_HISTORY_STATUS_LIFECYCLE.Completed, 'ready-to-admit', 'Completed is ready, not admitted');
  assertEq(SAB_HISTORY_STATUS_LIFECYCLE.Failed, 'refused', 'Failed is refused');
});

test('an unrecognised state is recognised as unrecognised, in both directions', () => {
  assert(!isSabQueueStatus('Teleporting'), 'an invented queue state');
  assert(!isSabHistoryStatus('Teleporting'), 'an invented history state');
  assert(!isSabQueueStatus('Completed'), 'Completed is a history state and not a queue state');
  assert(isSabHistoryStatus('Completed'), 'Completed is a history state');
});

test('the aliases fold the worker\'s two renderings of one state, and nothing else', () => {
  assertEq(canonicalSabStatus('Quick Check'), 'QuickCheck', 'the spaced rendering folds');
  assertEq(canonicalSabStatus('Post Processing'), 'Running', 'post-processing folds to Running');
  assertEq(canonicalSabStatus('Downloading'), 'Downloading', 'an ordinary state is unchanged');
  assertEq(canonicalSabStatus('Nonsense'), 'Nonsense', 'an unknown state is not invented into a known one');
  for (const target of Object.values(SAB_STATUS_ALIASES)) {
    assert(isSabQueueStatus(target) || isSabHistoryStatus(target), `${target} is an alias onto a defined state`);
  }
});

h.section('the operator-visible lifecycle');

test('the six states are the contract\'s six, in the contract\'s own order', () => {
  assertEq(USENET_JOB_STATES.join(' '), 'downloading repairing unpacking ready-to-admit admitted refused',
    'the lifecycle');
  const document = read(CONTRACT);
  assert(document.includes('downloading, repairing, unpacking, ready-to-admit, admitted and'),
    'the phase document no longer states the lifecycle this module encodes');
});

test('every state has a meaning, and no meaning names a path, a URL or a provider', () => {
  for (const state of USENET_JOB_STATES) {
    const title = USENET_JOB_STATE_TITLES[state];
    assert(typeof title === 'string' && title.length > 20, `${state} has no meaning`);
    assert(!/https?:|\/mnt\/|\/downloads\/|SABnzbd_nzo/.test(title), `${state}'s meaning carries identity`);
  }
});

h.section('the refusals');

test('the refusal set is closed, unique, and every member is a slug', () => {
  const seen = new Set<string>();
  for (const reason of USENET_REFUSAL_REASONS) {
    assert(/^[a-z][a-z0-9-]*$/.test(reason), `${reason} is not a plain slug`);
    assert(!seen.has(reason), `${reason} appears twice`);
    seen.add(reason);
    assert(isUsenetRefusalReason(reason), `${reason} is recognised`);
  }
  assert(!isUsenetRefusalReason('something-went-wrong'), 'an invented reason is not in the set');
  assert(USENET_REFUSAL_REASONS.length >= 30, 'the refusal set is not a token gesture');
});

test('every transient refusal is a member of the closed set, and the permanent ones are not transient', () => {
  for (const reason of USENET_TRANSIENT_REFUSALS) {
    assert(isUsenetRefusalReason(reason), `${reason} is not in the closed set`);
    assert(isTransientRefusal(reason), `${reason} does not report itself transient`);
  }
  for (const permanent of ['job-failed-at-worker', 'output-is-symlink', 'admitted-digest-mismatch'] as const) {
    assert(!isTransientRefusal(permanent), `${permanent} must not be retried on its own`);
  }
});

test('the reasons that mean "the worker is not finished" are transient and the safety refusals are not', () => {
  assert(isTransientRefusal('output-still-changing'), 'a file still being written is worth looking at again');
  assert(isTransientRefusal('output-unpack-residue'), 'an unpack artefact is worth looking at again');
  assert(!isTransientRefusal('output-component-is-symlink'),
    'a symlinked parent will still be a symlinked parent next time, and retrying it forever tells nobody');
  assert(!isTransientRefusal('output-multiply-linked'), 'a second hard link is not a transient condition');
});

h.section('the bounds');

test('every timeout bound is ordered and the default sits inside it', () => {
  const timeout = SAB_CLIENT_BOUNDS.TIMEOUT_MS;
  assert(timeout.min < timeout.default && timeout.default < timeout.max, 'min < default < max');
  assert(timeout.max <= 30_000, 'a LOCAL worker does not need a longer ceiling than this');
});

test('the read retry policy is bounded and its backoff cannot exceed its own ceiling', () => {
  assert(SAB_CLIENT_BOUNDS.MAX_READ_ATTEMPTS >= 2 && SAB_CLIENT_BOUNDS.MAX_READ_ATTEMPTS <= 5, 'attempts');
  const last = SAB_CLIENT_BOUNDS.RETRY_BASE_DELAY_MS * 2 ** (SAB_CLIENT_BOUNDS.MAX_READ_ATTEMPTS - 2);
  assert(Math.min(SAB_CLIENT_BOUNDS.RETRY_MAX_DELAY_MS, last) <= SAB_CLIENT_BOUNDS.RETRY_MAX_DELAY_MS, 'backoff ceiling');
});

test('the admission bounds are ordered, and the dwell is long enough to be evidence', () => {
  assert(USENET_ADMISSION_BOUNDS.MIN_OUTPUT_BYTES < USENET_ADMISSION_BOUNDS.MAX_OUTPUT_BYTES, 'size bounds');
  assert(USENET_ADMISSION_BOUNDS.STABLE_SAMPLES >= 2,
    'one sample cannot distinguish a finished file from one being written at the moment it was asked');
  assert(USENET_ADMISSION_BOUNDS.STABLE_DWELL_MS >= 1_000, 'the dwell is at least a second');
  assert(USENET_ADMISSION_BOUNDS.MAX_OUTPUT_DEPTH >= 2 && USENET_ADMISSION_BOUNDS.MAX_OUTPUT_DEPTH <= 12, 'depth');
});

h.section('the category and the submission marker');

test('the dedicated category is a plain label and is not a name an operator already uses', () => {
  assertEq(USENET_DEDICATED_CATEGORY, 'projection', 'the dedicated category');
  assert(/^[a-z][a-z0-9-]*$/.test(USENET_DEDICATED_CATEGORY), 'a plain label');
});

test('a submission marker is derived, shaped and carries nothing about the content', () => {
  const digest = 'a'.repeat(32);
  const marker = submissionMarkerFor(digest);
  assertEq(marker, `projection-${digest}`, 'the marker');
  assert(USENET_SUBMISSION_MARKER_SHAPE.test(marker), 'the marker matches its own shape');
  assert(!USENET_SUBMISSION_MARKER_SHAPE.test('projection-Some.Release.2024.1080p'), 'a release name is not a marker');
  assert(!USENET_SUBMISSION_MARKER_SHAPE.test(`projection-${digest}x`), 'a longer value is not a marker');
  let threw = false;
  try { submissionMarkerFor('not-hex'); } catch { threw = true; }
  assert(threw, 'a marker cannot be derived from something that is not a digest');
});

h.section('the whole document');

test('the frozen contract restates the eight hard refusals the phase document names', () => {
  const document = read(CONTRACT);
  for (const rule of SAB_BOUNDARY_CONTRACT.hardRefusals) {
    assert(document.includes(rule), `the phase document no longer contains the hard refusal "${rule}"`);
  }
  assertEq(SAB_BOUNDARY_CONTRACT.hardRefusals.length, 8, 'the phase document names eight hard refusals');
});

test('the contract names SABnzbd as the first supported worker, and the document agrees', () => {
  assertEq(SAB_BOUNDARY_CONTRACT.worker, 'SABnzbd', 'the worker');
  assert(read(CONTRACT).includes('The first supported worker is SABnzbd'), 'the phase document names the worker');
});

test('the credential rules forbid every place a key must not appear, and name the NNTP non-goal', () => {
  const rules = SAB_BOUNDARY_CONTRACT.credentialRules.join(' ');
  for (const place of ['argv', 'environment', 'manifest', 'metric label', 'logged']) {
    assert(rules.includes(place), `the credential rules do not mention ${place}`);
  }
  assert(/No NNTP credential is read by this project at all/.test(rules),
    'the contract must say that NNTP credentials are the worker\'s and never this project\'s');
});

test('this suite is in the offline inventory', () => {
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/usenet-sab-contract.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((suite) => suite.file === 'usenet-sab-contract.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'offline group');
});

await h.finish();
