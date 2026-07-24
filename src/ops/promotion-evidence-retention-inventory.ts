import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
// The one exact UTC timestamp rule for this chain -- shared, not restated, so it cannot drift per phase.
import { isExactUtcTimestamp } from './promotion-utc-timestamp.js';

// Phase 240: local, non-live EVIDENCE RETENTION AND ARCHIVAL INVENTORY validator, layered on the Phase 239
// custody ledger.
//
// WHY IT EXISTS. Phase 239 says who held the evidence and in what order custody moved, ending in a release.
// It says nothing about whether every artifact in the chain is still accounted for. This phase validates a
// separately supplied, DIGEST-ONLY inventory that must account for all NINE chain artifacts -- Phases 231
// through 239, one entry each -- and must claim only that they are RETAINED.
//
// IT ARCHIVES NOTHING AND DELETES NOTHING. `archivedByThisTool`, `deletedByThisTool`, `retrievedByThisTool`
// and `selfAuthorized` are the constants false. It moves no evidence, fetches no evidence, and destroys no
// evidence; it only checks a record a human produced out-of-band.
//
// THE HEADLINE INVARIANT -- AN INVENTORY MAY NEVER RECORD A DESTRUCTION. This is a record of what is KEPT.
// `retention` is a closed enum of retention-only values (RETAINED, PENDING) and nothing else, and the WHOLE
// supplied inventory is additionally scanned -- values AND keys, at any depth -- for purge/deletion
// vocabulary. An evidence inventory that can express deletion IS a deletion instrument: it turns the act of
// accounting for evidence into a place where destroying it can be recorded as routine. It mirrors the Phase
// 235 rule that `evidencePurged` may never be anything but PENDING, one layer up and across the whole chain.
//
// THE SECOND INVARIANT -- NO PATH, LOCATION OR NETWORK DATA. An inventory is the single highest-risk leak
// point in this entire stack: it is exactly where a human naturally writes where the evidence went. So the
// STRICT hand-written-record predicate applies (this is not a generated report), extended to reject anything
// shaped like a location or a network endpoint -- IPv4/IPv6 literals, host:port, UNC paths, drive letters,
// URL schemes, hostname.tld forms and bucket/URI forms. The offending value is NEVER echoed back.
//
// NOT_ELIGIBLE takes PRECEDENCE over everything: without a sound Phase 239 CUSTODY_LEDGER_INTACT whose
// custody has been RELEASED there is nothing to take an inventory OF, and no inventory can override that.
// An inventory of evidence still in open custody is premature -- the holder may still append events -- so a
// ledger that is intact but not released is deliberately not eligible either. That is what locks the actual
// prepared P227-A chain, whose Phase 239 result is itself NOT_ELIGIBLE because its Phase 238 verification
// never happened and its replay never closed.
//
// ELIGIBILITY IS CHECKED ON THE WHOLE BODY, NOT THE HEADLINE -- standing practice in this stack since the
// Phase 234/235 hardening. A self-digest is not a signature, so a forged ledger can carry a green `overall`
// over a body that failed Phase 239's own checks and still recompute cleanly.
//
// WHAT THIS DOES AND DOES NOT PROVE -- the honest limit, and it must not be softened. A COMPLETE inventory
// means a human accounted for every artifact in the chain, claimed each is retained, and (where the artifacts
// were supplied) each claimed digest matched the real one. It does NOT prove the artifacts exist, are
// readable, are stored anywhere in particular, or will continue to exist. An inventory is a claim about the
// world and no digest can confirm a claim about the world. In particular this validator CANNOT detect an
// artifact that was destroyed and then honestly re-listed as PENDING -- a missing artifact and an
// unfinished inventory look identical from here.
//
// The emitted report is redaction-safe: per-phase coverage and binding booleans, counts, fixed value-free
// codes, closed enum states and the already-public chain digests only -- never a supplied artifact digest
// that failed to bind, a custodian identity, a timestamp, a path, a location or a network identifier.

const LEDGER_REPORT_ID = 'phase-239-promotion-chain-custody-ledger';
const OPERATION = 'promote-observe-withdraw';
const LEDGER_INTACT = 'CUSTODY_LEDGER_INTACT';
const CUSTODY_RELEASED = 'CUSTODY_RELEASED';

export const RETENTION_INVENTORY_INPUT_ID = 'phase-240-promotion-evidence-retention-inventory-input';

const PLACEHOLDER = 'PENDING';

export type RetentionState = 'RETAINED' | 'PENDING';
export type InventoryFieldState = 'PENDING' | 'AFFIRMED' | 'REFUSED';
export type RecordedInventory = 'AFFIRMED' | 'REFUSED' | 'PENDING' | 'NONE';
export type EntryBinding = 'REPORT' | 'LEDGER' | 'UNBOUND';

// RETENTION-ONLY. There is deliberately no value here that can express destruction.
const RETENTION_STATES: readonly string[] = ['RETAINED', PLACEHOLDER];
const FIELD_STATES: readonly string[] = ['PENDING', 'AFFIRMED', 'REFUSED'];

// The nine chain artifacts this inventory must account for, one entry each.
const INVENTORY_PHASES: readonly number[] = [231, 232, 233, 234, 235, 236, 237, 238, 239];

// phase -> (report id, that report's own self-digest field). Authoritative: taken from each producer module.
interface ArtifactSpec { readonly reportId: string; readonly digestField: string; }
const ARTIFACT_SPECS: Readonly<Record<number, ArtifactSpec>> = {
  231: { reportId: 'phase-231-promotion-execution-authorization', digestField: 'authorizationDigest' },
  232: { reportId: 'phase-232-promotion-execution-authorization-record', digestField: 'recordDigest' },
  233: { reportId: 'phase-233-promotion-post-run-observation-record', digestField: 'observationDigest' },
  234: { reportId: 'phase-234-promotion-post-run-disposition-record', digestField: 'dispositionDigest' },
  235: { reportId: 'phase-235-promotion-operation-closure-record', digestField: 'closureDigest' },
  236: { reportId: 'phase-236-promotion-chain-replay-verification', digestField: 'replayDigest' },
  237: { reportId: 'phase-237-promotion-source-record-provenance-commitment', digestField: 'provenanceDigest' },
  238: { reportId: 'phase-238-promotion-supplied-source-record-verification', digestField: 'verificationDigest' },
  239: { reportId: LEDGER_REPORT_ID, digestField: 'ledgerDigest' },
};

const OPERATION_DIGEST_FIELDS: readonly string[] = ['approvalIdDigest', 'itemDigest', 'sourceDigest', 'destinationDigest', 'planDigest'];
// The phases each upstream report names explicitly, used to pin one exact chain instance.
// Phases 237 and 238 both publish `phase-232`..`phase-235`; Phase 236 publishes `phase-231`..`phase-235`.
const SOURCE_RECORD_PHASES: readonly number[] = [232, 233, 234, 235];
const REPLAY_CHAIN_PHASES: readonly number[] = [231, 232, 233, 234, 235];
// Every binding the Phase 239 report must itself carry before an inventory over it can mean anything.
const LEDGER_BINDING_KEYS: readonly string[] = ['verification-report', 'head-event', ...OPERATION_DIGEST_FIELDS];

// `inventoryAffirmed` carries the decision itself. One source of truth, so an inventory can never state a
// verdict that contradicts its own fields.
const DECISION_FIELD = 'inventoryAffirmed';
// What a custodian must actually have done before affirming an inventory.
const AFFIRMATION_FIELDS: readonly string[] = [
  'artifactsIndependentlyLocated', 'artifactsIndependentlyDigested', 'artifactsRetainedInFull',
];
const INVENTORY_FIELDS: readonly string[] = [DECISION_FIELD, ...AFFIRMATION_FIELDS];

// Strict top-level allowlist: anything else is smuggled content and fails closed.
const INVENTORY_KEYS: readonly string[] = [
  'record', 'version', 'operation', 'sourceCustodyLedger', 'ledgerDigest', 'headEventDigest',
  ...OPERATION_DIGEST_FIELDS, 'entries', 'fields', 'custodianDigest', 'inventoriedAtUtc',
];
const ENTRY_KEYS: readonly string[] = ['phase', 'artifactDigest', 'retention'];

export interface RetentionInventoryInput {
  readonly ledger?: unknown;     // phase-239-promotion-chain-custody-ledger report
  readonly inventory?: unknown;  // the separately supplied human digest-only inventory
  // OPTIONAL: the actual chain reports, keyed by phase. When supplied, each entry's artifact digest is BOUND
  // by recomputing that report's own self-digest. When absent, entries the ledger cannot reach stay UNBOUND
  // and the verdict is capped at STRUCTURAL_ONLY -- this module never pretends to bind what it cannot reach.
  readonly reports?: unknown;
}

// One inventory entry, as a human writes it. Digest-only: no path, no location, no filename.
export interface RetentionInventoryEntry {
  readonly phase: number;
  readonly artifactDigest: string;
  readonly retention: RetentionState;
}

// The blank inventory a human completes. It accounts for nothing until they do.
export interface RetentionInventorySkeleton {
  readonly record: typeof RETENTION_INVENTORY_INPUT_ID;
  readonly version: 1;
  readonly operation: typeof OPERATION;
  readonly sourceCustodyLedger: typeof LEDGER_REPORT_ID;
  readonly ledgerDigest: string;
  readonly headEventDigest: string;
  readonly approvalIdDigest: string;
  readonly itemDigest: string;
  readonly sourceDigest: string;
  readonly destinationDigest: string;
  readonly planDigest: string;
  readonly entries: readonly RetentionInventoryEntry[];
  readonly fields: Readonly<Record<string, InventoryFieldState>>;
  readonly custodianDigest: string;
  readonly inventoriedAtUtc: string;
}

export interface InventoryEntryState {
  readonly phase: number;
  readonly covered: boolean;
  readonly artifactDigestPresent: boolean;
  readonly boundVia: EntryBinding;
  readonly retention: RetentionState | 'NONE';
}

export const RETENTION_INVENTORY_REMAINING_HUMAN_STEPS: readonly string[] = [
  'Actually holding the evidence: this validator retrieves nothing and confirms the existence of nothing.',
  'Periodic re-inventory, because retention is a continuing claim and this record only ever describes one moment.',
  'Any archival, migration or disposal decision, governed out-of-band -- never by this record, which can only ever say the evidence is retained.',
  'Independent confirmation that each retained artifact still re-verifies against these exact chain digests.',
];

export const RETENTION_INVENTORY_BOUNDARY =
  'No promotion launcher run, no withdrawal run, no remediation, no archival, no deletion, no evidence retrieval, no observed-state capture, no real Movies library read or write, no live Jellyfin call, no secret approval-file read, and no self-authorization: this validator only checks a separately supplied digest-only inventory against the Phase 239 custody ledger.';

export const RETENTION_INVENTORY_DISCLAIMERS: readonly string[] = [
  'This validator archives nothing and deletes nothing. It retrieves no artifact and confirms the existence of none.',
  'An inventory may never record a destruction: `retention` is a retention-only enum and any purge or deletion vocabulary anywhere in the supplied record fails closed. An evidence inventory that can express deletion is a deletion instrument.',
  'INVENTORY_COMPLETE means a human accounted for all nine chain artifacts, claimed each is retained, and every claimed digest matched the real artifact supplied alongside it.',
  'It does NOT prove the artifacts exist, are readable, are stored anywhere in particular, or will continue to exist. An inventory is a claim about the world, and no digest can confirm a claim about the world.',
  'It CANNOT detect an artifact that was destroyed and then honestly re-listed as PENDING: a missing artifact and an unfinished inventory are indistinguishable from here.',
  'INVENTORY_STRUCTURAL_ONLY means the inventory is well-formed and bound but the artifacts were not supplied, so the claimed digests could not be checked against anything.',
];

export interface RetentionInventoryReport {
  readonly report: 'phase-240-promotion-evidence-retention-inventory';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly archivedByThisTool: false;
  readonly deletedByThisTool: false;
  readonly retrievedByThisTool: false;
  readonly selfAuthorized: false;
  readonly overall:
    | 'INVENTORY_COMPLETE'
    | 'INVENTORY_STRUCTURAL_ONLY'
    | 'INVENTORY_PENDING'
    | 'INVENTORY_INVALID'
    | 'NOT_ELIGIBLE';
  readonly recordedInventory: RecordedInventory;
  readonly inventoryComplete: boolean;
  readonly ledgerEligible: boolean;
  readonly inventoryWellFormed: boolean;
  readonly inventoryRedactionSafe: boolean;
  readonly inventoryBound: boolean;
  readonly inventoryCoherent: boolean;
  readonly coverageComplete: boolean;
  // Value-free continuity status for the top-down expectation walk: NOT_SUPPLIED when no artifacts were
  // handed over at all, ANCHORED when every supplied artifact had an expected digest to be pinned to, BROKEN
  // when at least one did not because the report naming it was missing.
  readonly chainContinuity: 'ANCHORED' | 'BROKEN' | 'NOT_SUPPLIED';
  readonly allEntriesBound: boolean;
  readonly allEntriesRetained: boolean;
  readonly destructionClaimed: false;
  readonly entryCount: number;
  readonly entries: readonly InventoryEntryState[];
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly fieldStates: Readonly<Record<string, InventoryFieldState>>;
  readonly remainingHumanSteps: readonly string[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly inventoryDigest: string;
}

export function buildRetentionInventory(input: RetentionInventoryInput): RetentionInventoryReport {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};

  // (1) The Phase 239 ledger: genuine, INTACT, and CLOSED -- custody released. Anything wrong here means there
  //     is nothing to inventory, which is NOT_ELIGIBLE, never INVALID.
  const led = validateLedgerReport(input.ledger, blockers);
  const ledgerEligible = led.ok;
  if (ledgerEligible) {
    boundDigests['custody-ledger'] = led.ledgerDigest!;
    boundDigests['head-event'] = led.bindings['head-event']!;
    boundDigests['verification-report'] = led.bindings['verification-report']!;
    for (const f of OPERATION_DIGEST_FIELDS) boundDigests[f] = led.bindings[f]!;
  }

  // (2) The human inventory: present, single, strictly allowlisted, closed enums, nine well-formed entries.
  const inv = validateInventoryShape(input.inventory, blockers);
  const inventoryWellFormed = inv.ok;

  // (3) THE TWO REDACTION INVARIANTS, scanned over the WHOLE supplied value rather than the allowlisted keys.
  //     A destruction claim and a disclosed location are each their own finding; neither value is ever echoed.
  let inventoryRedactionSafe = false;
  if (input.inventory !== undefined) {
    const destruction = deepDestructionVocabulary(input.inventory);
    const location = deepLocationOrLiveSurface(input.inventory);
    if (destruction) blockers.push('INVENTORY_DESTRUCTION_CLAIMED');
    if (location) blockers.push('INVENTORY_LOCATION_DISCLOSED');
    inventoryRedactionSafe = !destruction && !location;
  }

  // (4) The binding: this inventory must be OF this ledger -- its own digest, its head event, and the one
  //     operation. Same transplantation defence as every phase below it.
  let inventoryBound = false;
  if (ledgerEligible && inventoryWellFormed) {
    const bindsLedger = inv.obj.ledgerDigest === led.ledgerDigest;
    if (!bindsLedger) blockers.push('INVENTORY_NOT_BOUND_TO_LEDGER');
    const bindsHead = inv.obj.headEventDigest === led.bindings['head-event'];
    if (!bindsHead) blockers.push('INVENTORY_HEAD_EVENT_MISMATCH');
    let digestsMatch = true;
    for (const f of OPERATION_DIGEST_FIELDS) {
      if (asSha256(inv.obj[f]) !== undefined && inv.obj[f] === led.bindings[f]) continue;
      digestsMatch = false;
      blockers.push(`INVENTORY_${screamingSnake(f)}_MISMATCH`);
    }
    inventoryBound = bindsLedger && bindsHead && digestsMatch;
  }

  // (5) Coverage and per-entry binding. Coverage is structural -- exactly one entry per phase 231..239.
  //     Binding is separate: an entry is BOUND when its claimed digest equals the real artifact's, either from
  //     a supplied report or from what the ledger itself already carries (it reaches 238 and 239).
  const entries: InventoryEntryState[] = [];
  let coverageComplete = false;
  let allEntriesBound = false;
  let allEntriesRetained = false;
  // Continuity is reported as a value-free status alongside the blocker: a custodian who omits the report that
  // names the ones below it breaks the bridge, and every artifact under the break is unanchored.
  let continuityBroken = false;
  let anySupplied = false;
  if (inventoryWellFormed) {
    const supplied = asObject(input.reports);
    const byPhase = new Map<number, RetentionInventoryEntry>();
    for (const e of inv.entries) if (!byPhase.has(e.phase)) byPhase.set(e.phase, e);
    coverageComplete = inv.entriesOk && INVENTORY_PHASES.every((p) => byPhase.has(p));

    // Pin ONE chain instance before validating any artifact. Operation identity alone cannot distinguish two
    // genuine chains for the same operation, so each supplied artifact is additionally required to be the
    // exact instance the chain above it names.
    const chainExpected = resolveExpectedDigests(led, supplied);
    if (chainExpected.inconsistent) blockers.push('INVENTORY_SUPPLIED_REPORT_CHAIN_MISMATCH');

    let bound = 0;
    let retained = 0;
    for (const phase of INVENTORY_PHASES) {
      const entry = byPhase.get(phase);
      if (entry === undefined) {
        entries.push({ phase, covered: false, artifactDigestPresent: false, boundVia: 'UNBOUND', retention: 'NONE' });
        continue;
      }
      const claimed = asSha256(entry.artifactDigest);
      // What the ledger itself already establishes, with no artifact supplied: its own digest, and the Phase
      // 238 verification report it was built over.
      const fromLedger = ledgerEligible
        ? (phase === 239 ? led.ledgerDigest : phase === 238 ? led.bindings['verification-report'] : undefined)
        : undefined;
      // A supplied artifact is validated on its own terms -- right report, recomputes, THIS operation, and
      // THIS chain instance (the exact digest the chain above it names).
      const artifact = validateSuppliedArtifact(phase, supplied[String(phase)], led.bindings, chainExpected.expected[phase] ?? fromLedger);
      if (artifact.status === 'INVALID') blockers.push('INVENTORY_SUPPLIED_REPORT_INVALID');
      if (artifact.status === 'FOREIGN_OPERATION') blockers.push('INVENTORY_SUPPLIED_REPORT_FOREIGN_OPERATION');
      if (artifact.status === 'CHAIN_MISMATCH') blockers.push('INVENTORY_SUPPLIED_REPORT_CHAIN_MISMATCH');
      if (artifact.status === 'UNANCHORED') { blockers.push('INVENTORY_SUPPLIED_REPORT_CHAIN_UNANCHORED'); continuityBroken = true; }
      if (artifact.status !== 'ABSENT') anySupplied = true;
      const fromReport = artifact.digest;

      let boundVia: EntryBinding = 'UNBOUND';
      if (claimed !== undefined && fromReport !== undefined) {
        if (claimed === fromReport) boundVia = 'REPORT';
        else blockers.push('INVENTORY_ENTRY_DIGEST_MISMATCH');
      } else if (claimed !== undefined && fromLedger !== undefined && artifact.status === 'ABSENT') {
        // Ledger-derived binding is only a fallback for an artifact that was NOT supplied. A supplied artifact
        // that failed validation must never be rescued by what the ledger happens to know.
        if (claimed === fromLedger) boundVia = 'LEDGER';
        else blockers.push('INVENTORY_ENTRY_DIGEST_MISMATCH');
      }
      if (boundVia !== 'UNBOUND') bound++;
      if (entry.retention === 'RETAINED') retained++;
      entries.push({
        phase, covered: true, artifactDigestPresent: claimed !== undefined,
        boundVia, retention: entry.retention,
      });
    }
    allEntriesBound = coverageComplete && bound === INVENTORY_PHASES.length;
    allEntriesRetained = coverageComplete && retained === INVENTORY_PHASES.length;
  }

  // (6) Coherence between the decision, the affirmations, and what the inventory actually accounts for.
  let inventoryCoherent = false;
  let decision: RecordedInventory = 'NONE';
  const fieldStates: Record<string, InventoryFieldState> = {};
  if (inventoryWellFormed) {
    const fields = asObject(inv.obj.fields);
    for (const f of INVENTORY_FIELDS) fieldStates[f] = fields[f] as InventoryFieldState;

    const affirmed = fieldStates[DECISION_FIELD];
    decision = affirmed === 'AFFIRMED' ? 'AFFIRMED' : affirmed === 'REFUSED' ? 'REFUSED' : 'PENDING';

    // Affirming an inventory means the custodian actually did the work, that every artifact is accounted for,
    // and that every one of them is claimed RETAINED. An affirmation over a partial inventory is a false one.
    let decisionBacked = true;
    if (decision === 'AFFIRMED') {
      if (!AFFIRMATION_FIELDS.every((f) => fieldStates[f] === 'AFFIRMED')) {
        blockers.push('INVENTORY_AFFIRMED_WITHOUT_FULL_AFFIRMATION'); decisionBacked = false;
      }
      if (!coverageComplete) { blockers.push('INVENTORY_AFFIRMED_WITHOUT_FULL_COVERAGE'); decisionBacked = false; }
      if (!allEntriesRetained) { blockers.push('INVENTORY_AFFIRMED_WITHOUT_FULL_RETENTION'); decisionBacked = false; }
    }

    // A decided inventory names WHO took it and WHEN; an undecided or refused one claims neither, because
    // nothing has been inventoried in either case.
    const decided = decision === 'AFFIRMED';
    const custodianOk = decided ? asSha256(inv.obj.custodianDigest) !== undefined : inv.obj.custodianDigest === PLACEHOLDER;
    if (!custodianOk) blockers.push(decided ? 'INVENTORY_CUSTODIAN_DIGEST_REQUIRED' : 'INVENTORY_CUSTODIAN_DIGEST_NOT_PENDING');
    const takenAtOk = decided ? isExactUtcTimestamp(inv.obj.inventoriedAtUtc) : inv.obj.inventoriedAtUtc === PLACEHOLDER;
    if (!takenAtOk) blockers.push(decided ? 'INVENTORY_INVENTORIED_AT_REQUIRED' : 'INVENTORY_INVENTORIED_AT_NOT_PENDING');

    inventoryCoherent = decisionBacked && custodianOk && takenAtOk;
  }

  const uniqueBlockers = [...new Set(blockers)];
  const inventorySound = uniqueBlockers.length === 0
    && inventoryWellFormed && inventoryRedactionSafe && inventoryBound && inventoryCoherent;

  // NOT_ELIGIBLE takes precedence over everything: nothing to inventory cannot be inventoried.
  // A COMPLETE verdict additionally requires every entry BOUND against a real artifact -- without the reports
  // the claimed digests were checked against nothing, and STRUCTURAL_ONLY says exactly that.
  const overall: RetentionInventoryReport['overall'] =
    !ledgerEligible ? 'NOT_ELIGIBLE'
      : !inventorySound ? 'INVENTORY_INVALID'
        : decision !== 'AFFIRMED' ? 'INVENTORY_PENDING'
          : allEntriesBound ? 'INVENTORY_COMPLETE'
            : 'INVENTORY_STRUCTURAL_ONLY';
  const settled = overall === 'INVENTORY_COMPLETE' || overall === 'INVENTORY_STRUCTURAL_ONLY'
    || overall === 'INVENTORY_PENDING';

  const withoutDigest: Omit<RetentionInventoryReport, 'inventoryDigest'> = {
    report: 'phase-240-promotion-evidence-retention-inventory',
    version: 1,
    redactionSafe: true,
    archivedByThisTool: false,
    deletedByThisTool: false,
    retrievedByThisTool: false,
    selfAuthorized: false,
    overall,
    recordedInventory: settled ? decision : 'NONE',
    inventoryComplete: overall === 'INVENTORY_COMPLETE',
    ledgerEligible,
    inventoryWellFormed,
    inventoryRedactionSafe,
    inventoryBound,
    inventoryCoherent,
    coverageComplete,
    chainContinuity: !anySupplied ? 'NOT_SUPPLIED' : continuityBroken ? 'BROKEN' : 'ANCHORED',
    allEntriesBound,
    allEntriesRetained,
    // Constant: no valid inventory can express a destruction, and this validator performs none.
    destructionClaimed: false,
    entryCount: inv.entries.length,
    entries,
    boundDigests,
    fieldStates,
    remainingHumanSteps: RETENTION_INVENTORY_REMAINING_HUMAN_STEPS,
    boundary: RETENTION_INVENTORY_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: RETENTION_INVENTORY_DISCLAIMERS,
  };
  return { ...withoutDigest, inventoryDigest: digest('phase-240-evidence-retention-inventory', JSON.stringify(withoutDigest)) };
}

// Emit the blank inventory a human completes: nine entries, every artifact digest and every retention state
// PENDING, every field PENDING. Only derived bindings are pre-filled. It NEVER creates or infers a completed
// inventory, and it never invents an artifact digest. Returns null when the ledger is not eligible.
export function buildRetentionInventorySkeleton(ledgerValue: unknown): RetentionInventorySkeleton | null {
  const led = validateLedgerReport(ledgerValue, []);
  if (!led.ok) return null;
  const fields: Record<string, InventoryFieldState> = {};
  for (const f of INVENTORY_FIELDS) fields[f] = 'PENDING';
  return {
    record: RETENTION_INVENTORY_INPUT_ID,
    version: 1,
    operation: OPERATION,
    sourceCustodyLedger: LEDGER_REPORT_ID,
    ledgerDigest: led.ledgerDigest!,
    headEventDigest: led.bindings['head-event']!,
    approvalIdDigest: led.bindings.approvalIdDigest!,
    itemDigest: led.bindings.itemDigest!,
    sourceDigest: led.bindings.sourceDigest!,
    destinationDigest: led.bindings.destinationDigest!,
    planDigest: led.bindings.planDigest!,
    entries: INVENTORY_PHASES.map((phase) => ({ phase, artifactDigest: PLACEHOLDER, retention: PLACEHOLDER })),
    fields,
    custodianDigest: PLACEHOLDER,
    inventoriedAtUtc: PLACEHOLDER,
  };
}

interface ValidatedLedger {
  readonly ok: boolean;
  readonly ledgerDigest: string | undefined;
  readonly bindings: Readonly<Record<string, string | undefined>>;
}

// The ledger must be the genuine Phase 239 report: it recomputes, it is INTACT, its custody has been RELEASED,
// it still claims to have held and created nothing, it carries no blockers, and it has all its bindings.
// EVERY failure here is a NOT_ELIGIBLE chain, never an INVALID inventory.
//
// These semantic checks are NOT redundant behind the digest check: a self-digest is not a signature, so a
// forger who rebuilds it reaches them, and they are the only thing that stops a fabricated closed ledger.
function validateLedgerReport(value: unknown, blockers: string[]): ValidatedLedger {
  const none: ValidatedLedger = { ok: false, ledgerDigest: undefined, bindings: {} };
  if (value === undefined) { blockers.push('LEDGER_RECORD_MISSING'); return none; }
  const obj = asObject(value);
  if (obj.report !== LEDGER_REPORT_ID) { blockers.push('LEDGER_RECORD_INVALID'); return none; }

  const stated = asSha256(obj.ledgerDigest);
  if (stated === undefined || verifySelfDigests([obj]).results[0]?.verified !== true) {
    blockers.push('LEDGER_RECORD_DIGEST_MISMATCH'); return none;
  }
  let ok = true;
  if (obj.overall !== LEDGER_INTACT) { blockers.push('LEDGER_RECORD_NOT_INTACT'); ok = false; }
  if (obj.ledgerIntact !== true) { blockers.push('LEDGER_RECORD_NOT_MARKED_INTACT'); ok = false; }
  // An inventory of evidence still in open custody is premature: the holder may still append events.
  if (obj.terminalTransition !== CUSTODY_RELEASED) { blockers.push('LEDGER_RECORD_CUSTODY_NOT_RELEASED'); ok = false; }
  // The ledger's OWN success booleans -- the Phase 234/235 hardening, applied one layer up.
  if (obj.redactionSafe !== true) { blockers.push('LEDGER_RECORD_NOT_REDACTION_SAFE'); ok = false; }
  if (obj.verificationEligible !== true) { blockers.push('LEDGER_RECORD_VERIFICATION_NOT_ELIGIBLE'); ok = false; }
  if (obj.eventsWellFormed !== true) { blockers.push('LEDGER_RECORD_EVENTS_NOT_WELL_FORMED'); ok = false; }
  if (obj.eventsRedactionSafe !== true) { blockers.push('LEDGER_RECORD_EVENTS_NOT_REDACTION_SAFE'); ok = false; }
  if (obj.chainLinked !== true) { blockers.push('LEDGER_RECORD_CHAIN_NOT_LINKED'); ok = false; }
  if (obj.transitionsValid !== true) { blockers.push('LEDGER_RECORD_TRANSITIONS_NOT_VALID'); ok = false; }
  // The ledger must itself still be a record only -- it may never claim to have acted.
  if (obj.custodyHeldByThisTool !== false) { blockers.push('LEDGER_RECORD_CUSTODY_HELD_CLAIMED'); ok = false; }
  if (obj.eventsCreatedByThisTool !== false) { blockers.push('LEDGER_RECORD_EVENTS_CREATED_CLAIMED'); ok = false; }
  if (obj.selfAuthorized !== false) { blockers.push('LEDGER_RECORD_SELF_AUTHORIZED'); ok = false; }
  if (!Array.isArray(obj.blockers) || obj.blockers.length !== 0) { blockers.push('LEDGER_RECORD_BLOCKERS_PRESENT'); ok = false; }
  if (asSha256(obj.headEventDigest) === undefined) { blockers.push('LEDGER_RECORD_HEAD_EVENT_MISSING'); ok = false; }

  const bound = asObject(obj.boundDigests);
  const bindings: Record<string, string | undefined> = {};
  for (const k of LEDGER_BINDING_KEYS) {
    bindings[k] = asSha256(bound[k]);
    if (bindings[k] === undefined) { blockers.push('LEDGER_RECORD_BINDINGS_INCOMPLETE'); ok = false; }
  }
  // The head the ledger publishes and the head it bound must be the same head.
  if (ok && bindings['head-event'] !== asSha256(obj.headEventDigest)) {
    blockers.push('LEDGER_RECORD_HEAD_EVENT_INCONSISTENT'); ok = false;
  }

  return ok ? { ok: true, ledgerDigest: stated, bindings } : none;
}

interface ValidatedInventory {
  readonly ok: boolean;
  readonly obj: Record<string, unknown>;
  readonly entries: readonly RetentionInventoryEntry[];
  readonly entriesOk: boolean;
}

// Strict shape: one object, only allowlisted keys, fixed literals correct, closed enums, and an entry LIST of
// exactly nine well-formed entries in ascending phase order with no duplicates. The list is an array on
// purpose: omission, duplication and reordering are three distinct, separately-reported failures.
function validateInventoryShape(value: unknown, blockers: string[]): ValidatedInventory {
  const none: ValidatedInventory = { ok: false, obj: {}, entries: [], entriesOk: false };
  if (value === undefined) { blockers.push('INVENTORY_MISSING'); return none; }
  if (Array.isArray(value)) { blockers.push('INVENTORY_NOT_SINGLE'); return none; }
  if (!value || typeof value !== 'object') { blockers.push('INVENTORY_INVALID'); return none; }
  const obj = value as Record<string, unknown>;

  let ok = true;
  for (const k of Object.keys(obj)) {
    if (!INVENTORY_KEYS.includes(k)) { blockers.push('INVENTORY_UNKNOWN_FIELD'); ok = false; break; }
  }
  if (obj.record !== RETENTION_INVENTORY_INPUT_ID) { blockers.push('INVENTORY_INVALID'); return none; }
  if (obj.version !== 1) { blockers.push('INVENTORY_VERSION_UNSUPPORTED'); ok = false; }
  if (obj.operation !== OPERATION) { blockers.push('INVENTORY_OPERATION_MISMATCH'); ok = false; }
  if (obj.sourceCustodyLedger !== LEDGER_REPORT_ID) { blockers.push('INVENTORY_SOURCE_LEDGER_MISMATCH'); ok = false; }
  if (asSha256(obj.ledgerDigest) === undefined) { blockers.push('INVENTORY_LEDGER_DIGEST_INVALID'); ok = false; }
  if (asSha256(obj.headEventDigest) === undefined) { blockers.push('INVENTORY_HEAD_EVENT_DIGEST_INVALID'); ok = false; }
  if (typeof obj.custodianDigest !== 'string') { blockers.push('INVENTORY_CUSTODIAN_DIGEST_INVALID'); ok = false; }
  if (typeof obj.inventoriedAtUtc !== 'string') { blockers.push('INVENTORY_INVENTORIED_AT_INVALID'); ok = false; }

  const fields = asObject(obj.fields);
  const fieldKeys = Object.keys(fields);
  if (fieldKeys.length !== INVENTORY_FIELDS.length || !INVENTORY_FIELDS.every((f) => fieldKeys.includes(f))) {
    blockers.push('INVENTORY_FIELDS_INVALID'); return none;
  }
  for (const f of INVENTORY_FIELDS) {
    if (typeof fields[f] === 'string' && FIELD_STATES.includes(fields[f] as string)) continue;
    blockers.push('INVENTORY_FIELD_STATE_INVALID'); ok = false;
  }

  const raw = obj.entries;
  if (!Array.isArray(raw)) { blockers.push('INVENTORY_ENTRIES_INVALID'); return { ok: false, obj, entries: [], entriesOk: false }; }
  let entriesOk = true;
  if (raw.length !== INVENTORY_PHASES.length) { blockers.push('INVENTORY_ENTRY_COUNT_INVALID'); entriesOk = false; ok = false; }

  const entries: RetentionInventoryEntry[] = [];
  for (const item of raw) {
    const e = asObject(item);
    const keysOk = item !== null && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(e).every((k) => ENTRY_KEYS.includes(k))
      && ENTRY_KEYS.every((k) => k in e);
    const phaseOk = typeof e.phase === 'number' && Number.isInteger(e.phase);
    if (!keysOk || !phaseOk) { blockers.push('INVENTORY_ENTRY_INVALID'); entriesOk = false; ok = false; continue; }
    const digestOk = asSha256(e.artifactDigest) !== undefined || e.artifactDigest === PLACEHOLDER;
    if (!digestOk) { blockers.push('INVENTORY_ENTRY_ARTIFACT_DIGEST_INVALID'); entriesOk = false; ok = false; continue; }
    // RETENTION-ONLY. A value outside this closed set is refused here before anything else can look at it.
    if (typeof e.retention !== 'string' || !RETENTION_STATES.includes(e.retention)) {
      blockers.push('INVENTORY_RETENTION_INVALID'); entriesOk = false; ok = false; continue;
    }
    entries.push({ phase: e.phase as number, artifactDigest: e.artifactDigest as string, retention: e.retention as RetentionState });
  }

  // Duplication, ordering and phase-set membership are separate, separately-reported failures.
  const seen = new Set<number>();
  let duplicated = false;
  for (const e of entries) { if (seen.has(e.phase)) duplicated = true; seen.add(e.phase); }
  if (duplicated) { blockers.push('INVENTORY_ENTRY_DUPLICATED'); entriesOk = false; ok = false; }

  let ascending = true;
  for (let i = 1; i < entries.length; i++) if (entries[i]!.phase <= entries[i - 1]!.phase) ascending = false;
  if (!ascending && !duplicated) { blockers.push('INVENTORY_ENTRY_OUT_OF_ORDER'); entriesOk = false; ok = false; }

  if (!INVENTORY_PHASES.every((p) => seen.has(p)) || ![...seen].every((p) => INVENTORY_PHASES.includes(p))) {
    blockers.push('INVENTORY_ENTRY_PHASE_INVALID'); entriesOk = false; ok = false;
  }

  return { ok, obj, entries, entriesOk };
}

// Where each phase publishes the five operation digests. THREE different shapes exist across the chain, so
// this must be a per-phase extractor: Phase 231 carries them inside its emitted template, Phases 232-235 under
// kebab-case `operation-*` keys in boundDigests, Phase 236 in its own `operationDigests` map, and Phases
// 237-239 under the plain field names in boundDigests. Getting this wrong would silently return undefined for
// every field and make the identity check below vacuous, so each shape is taken from its producer module.
const OPERATION_BINDING_KEYS: Readonly<Record<string, string>> = {
  approvalIdDigest: 'operation-approval-id',
  itemDigest: 'operation-item',
  sourceDigest: 'operation-source',
  destinationDigest: 'operation-destination',
  planDigest: 'operation-plan',
};
function suppliedOperationDigests(phase: number, obj: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (phase === 231) {
    const template = asObject(obj.template);
    for (const f of OPERATION_DIGEST_FIELDS) out[f] = asSha256(template[f]);
    return out;
  }
  if (phase >= 232 && phase <= 235) {
    const bound = asObject(obj.boundDigests);
    for (const f of OPERATION_DIGEST_FIELDS) out[f] = asSha256(bound[OPERATION_BINDING_KEYS[f]!]);
    return out;
  }
  if (phase === 236) {
    const ops = asObject(obj.operationDigests);
    for (const f of OPERATION_DIGEST_FIELDS) out[f] = asSha256(ops[f]);
    return out;
  }
  const bound = asObject(obj.boundDigests);
  for (const f of OPERATION_DIGEST_FIELDS) out[f] = asSha256(bound[f]);
  return out;
}

// THE EXACT-INSTANCE MAP. Same-operation is not enough. Two GENUINE chains for the SAME operation -- a re-run
// with a different operator, or different decision times -- carry identical operation digests throughout, so
// an artifact lifted from an alternate run passes the operation-identity check and would still bind.
//
// What pins one chain is that each report names the exact instance beneath it. Walking downward from the
// ledger: the ledger names its Phase 238 verification; Phase 238 names its Phase 237 commitment and the
// phase-232..235 reports it verified; Phase 237 names its Phase 236 replay and its own phase-232..235; Phase
// 236 names phase-231..235 in chainDigests. That yields an exact expected digest for every phase 231-239.
//
// A report is only trusted to contribute expectations once it has itself matched the expectation above it, so
// the walk cannot be bootstrapped from an alternate chain. Where two levels both name a phase, they must
// AGREE -- a disagreement means the supplied set was assembled from more than one chain.
interface ExpectedDigests {
  readonly expected: Readonly<Record<number, string | undefined>>;
  readonly inconsistent: boolean;
}
function resolveExpectedDigests(led: ValidatedLedger, supplied: Record<string, unknown>): ExpectedDigests {
  const expected: Record<number, string | undefined> = {};
  let inconsistent = false;
  expected[239] = led.ledgerDigest;
  expected[238] = led.bindings['verification-report'];

  // Read a supplied report ONLY if it is the right report id, recomputes, and IS the exact instance expected.
  const trusted = (phase: number): Record<string, unknown> | undefined => {
    const want = expected[phase];
    const value = supplied[String(phase)];
    if (value === undefined || want === undefined) return undefined;
    const spec = ARTIFACT_SPECS[phase];
    if (spec === undefined) return undefined;
    const obj = asObject(value);
    if (obj.report !== spec.reportId || asSha256(obj[spec.digestField]) !== want) return undefined;
    return verifySelfDigests([obj]).results[0]?.verified === true ? obj : undefined;
  };
  const adopt = (phase: number, digest: string | undefined): void => {
    if (digest === undefined) return;
    if (expected[phase] !== undefined && expected[phase] !== digest) { inconsistent = true; return; }
    expected[phase] = digest;
  };

  const r238 = trusted(238);
  if (r238 !== undefined) {
    const bound = asObject(r238.boundDigests);
    adopt(237, asSha256(bound['commitment-report']));
    for (const p of SOURCE_RECORD_PHASES) adopt(p, asSha256(bound[`phase-${p}`]));
  }
  const r237 = trusted(237);
  if (r237 !== undefined) {
    const bound = asObject(r237.boundDigests);
    adopt(236, asSha256(bound['replay-report']));
    for (const p of SOURCE_RECORD_PHASES) adopt(p, asSha256(bound[`phase-${p}`]));
  }
  const r236 = trusted(236);
  if (r236 !== undefined) {
    const chain = asObject(r236.chainDigests);
    for (const p of REPLAY_CHAIN_PHASES) adopt(p, asSha256(chain[`phase-${p}`]));
  }
  return { expected, inconsistent };
}

export type SuppliedArtifactStatus =
  | 'ABSENT' | 'INVALID' | 'FOREIGN_OPERATION' | 'UNANCHORED' | 'CHAIN_MISMATCH' | 'OK';
interface SuppliedArtifact { readonly status: SuppliedArtifactStatus; readonly digest: string | undefined; }

// A supplied chain artifact only binds an entry when it is the right report id for that phase, genuinely
// recomputes its own self-digest, AND DESCRIBES THIS OPERATION.
//
// The last clause is the point. Checking report id plus self-digest alone was a transplantation hole: a
// perfectly genuine, self-consistent report belonging to a DIFFERENT promotion satisfies both, so it could
// bind an inventory entry and count toward INVENTORY_COMPLETE while the inventory itself stayed bound to THIS
// ledger. An inventory would then account for nine artifacts that were never part of the operation it claims
// to inventory. Every supplied report must therefore carry the same five operation digests the ledger does.
//
// Where the ledger already establishes an artifact's digest independently (Phase 239 is the ledger itself,
// Phase 238 is the verification report it was built over), the supplied report must also BE that artifact --
// a genuine report of the right operation but the wrong instance is still not the artifact being inventoried.
//
// A supplied artifact that fails any of these binds NOTHING and never falls back to a ledger-derived binding:
// once a custodian hands over an artifact, it is validated on its own terms or it is rejected.
function validateSuppliedArtifact(
  phase: number,
  value: unknown,
  ledgerOperationDigests: Readonly<Record<string, string | undefined>>,
  ledgerKnownDigest: string | undefined,
): SuppliedArtifact {
  if (value === undefined) return { status: 'ABSENT', digest: undefined };
  const spec = ARTIFACT_SPECS[phase];
  if (spec === undefined) return { status: 'INVALID', digest: undefined };
  const obj = asObject(value);
  if (obj.report !== spec.reportId) return { status: 'INVALID', digest: undefined };
  const stated = asSha256(obj[spec.digestField]);
  if (stated === undefined) return { status: 'INVALID', digest: undefined };
  if (verifySelfDigests([obj]).results[0]?.verified !== true) return { status: 'INVALID', digest: undefined };

  const ops = suppliedOperationDigests(phase, obj);
  const sameOperation = OPERATION_DIGEST_FIELDS.every((f) => {
    const supplied = ops[f];
    return supplied !== undefined && supplied === ledgerOperationDigests[f];
  });
  if (!sameOperation) return { status: 'FOREIGN_OPERATION', digest: undefined };

  // CONTINUITY, AND NO FALLBACK LAUNDERING. Same-operation is never sufficient on its own. If the top-down
  // walk produced no expected digest for this phase -- because the report that names it, Phase 238 or Phase
  // 237, was not supplied -- then the bridge is broken and there is nothing to pin this artifact to. Binding
  // on same-operation alone here would hand back exactly the alternate-chain hole the expectation walk exists
  // to close, and would let a custodian unlock it simply by OMITTING a report. So it fails closed: no
  // expectation, no REPORT binding, and never COMPLETE.
  if (ledgerKnownDigest === undefined) return { status: 'UNANCHORED', digest: undefined };
  if (stated !== ledgerKnownDigest) return { status: 'CHAIN_MISMATCH', digest: undefined };
  return { status: 'OK', digest: stated };
}

function screamingSnake(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

// THE DESTRUCTION VOCABULARY. An inventory records what is KEPT; any word that describes evidence being
// destroyed has no legitimate place in one, in a value or in a key, at any depth.
const DESTRUCTION_WORDS: readonly string[] = [
  'purge', 'purged', 'delete', 'deleted', 'destroy', 'destroyed', 'shred', 'shredded',
  'erase', 'erased', 'wipe', 'wiped', 'remove', 'removed', 'discard', 'discarded',
];
function hasDestructionWord(value: string): boolean {
  const lower = value.toLowerCase();
  return DESTRUCTION_WORDS.some((w) => lower.includes(w));
}

// LOCATION AND NETWORK SHAPES. Structural rather than a word list, so it catches what a human would actually
// write. The host:port and hostname forms deliberately require a dotted name so a UTC timestamp -- which
// contains colons -- can never be mistaken for an endpoint.
function isLocationOrEndpoint(value: string): boolean {
  return /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(value)                       // IPv4 literal
    || /(?:[0-9a-f]{1,4}:){4,}[0-9a-f]{0,4}/i.test(value)                // IPv6 literal (4+ groups; a timestamp has 2 colons)
    || /::[0-9a-f]{0,4}/i.test(value)                                    // compressed IPv6
    || /\b[a-z][a-z0-9+.-]*:\/\//i.test(value)                           // any URL scheme, s3:// smb:// nfs:// included
    || /\\\\[^\\]+\\/.test(value)                                        // UNC path
    || /[A-Za-z]:[\\/]/.test(value)                                      // drive letter
    || /\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+:\d{2,5}\b/i.test(value)       // dotted host:port
    || /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i.test(value) // hostname.tld
    || /\bbucket\b/i.test(value);                                        // bucket/object-store naming
}
function isLiveSurface(value: string): boolean {
  return /jellyfin|https?:\/\/|wss?:\/\/|x-emby|library\/refresh|\/mnt\//i.test(value);
}
function pathBearing(value: string): boolean {
  return /^\//.test(value) || /[A-Za-z]:[\\/]/.test(value) || /\/mnt\//.test(value) || /\\mnt\\/.test(value)
    || value.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(value);
}

// Both scans traverse ITERATIVELY with a visited set, over VALUES AND KEYS, so they terminate on any input: a
// pathologically deep inventory cannot overflow the stack and a cyclic one cannot loop forever.
function deepScan(root: unknown, hit: (s: string) => boolean): boolean {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') { if (value.length > 0 && hit(value)) return true; continue; }
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { for (const v of value) stack.push(v); continue; }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (hit(k)) return true;
      stack.push(v);
    }
  }
  return false;
}
function deepDestructionVocabulary(root: unknown): boolean {
  return deepScan(root, hasDestructionWord);
}
// Published for callers that must reject a foreign, live or network-bearing payload before it reaches a
// validator -- Phase 242 screens everything it could not recognise as a chain artifact through this exact
// predicate rather than restating it.
export function deepLocationOrLiveSurface(root: unknown): boolean {
  return deepScan(root, (s) => isLiveSurface(s) || pathBearing(s) || isLocationOrEndpoint(s));
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
