import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
// The phases' OWN validators, reused rather than reimplemented: re-running them is what makes the semantic
// path non-resealable, and reusing them means there is no second ruleset here to drift from theirs.
import { buildExecutionAuthorization, type ExecutionAuthorizationInput } from './promotion-execution-authorization.js';
import { buildExecutionAuthorizationRecord } from './promotion-execution-authorization-record.js';
import { buildPostRunObservationRecord } from './promotion-post-run-observation-record.js';
import { buildPostRunDispositionRecord } from './promotion-post-run-disposition-record.js';
import { buildOperationClosureRecord } from './promotion-operation-closure-record.js';

// Phase 236: local, non-live END-TO-END PROMOTION CHAIN REPLAY VERIFIER. It takes a bundle of the five chain
// reports -- Phase 231 gate, 232 authorization, 233 observation, 234 disposition, 235 closure -- and RE-DERIVES
// the whole chain in ONE pass instead of trusting any report's own word for it.
//
// It exists to remediate a real gap. Each phase only ever checks its IMMEDIATE parent, so nothing until now
// verified transitively that Phase 235 is closing out the SAME one operation Phase 231's template named. A
// SPLICED chain -- every report individually valid and self-verifying, every adjacent link binding correctly,
// but assembled from two different operations -- is precisely what no single phase can see and what this
// verifier catches.
//
// THE HEADLINE INVARIANT is therefore CROSS-PHASE OPERATION IDENTITY: the five operation digests
// (approvalId / item / source / destination / plan) must be IDENTICAL in every supplied report, anchored to
// Phase 231's template and re-derived downward. Identity is checked INDEPENDENTLY of linkage, so a forged
// report that keeps a correct parent link while carrying another operation's digests still fails closed.
//
// Absence is normal, not an error. The chain legitimately stops partway: the prepared P227-A operation stops at
// Phase 232 because no human ever approved it, so 233/234/235 cannot exist. That is CHAIN_REPLAY_VERIFIED_OPEN
// -- consistent as far as it goes -- never a defect. Only a chain that is internally inconsistent, has a
// skipped link, or drifts in operation identity is CHAIN_NOT_REPLAYABLE.
//
// STRUCTURE IS NOT ENOUGH, and this verifier says so out loud. Recomputation, linkage and identity are all
// RESEALABLE: a party holding the whole bundle can edit any report body and recompute its self-digest, then
// fix up the links and identity digests, and a purely structural replay waves it through. So a structural pass
// alone is reported as CHAIN_REPLAY_STRUCTURAL_ONLY and NEVER as VERIFIED_CLOSED or VERIFIED_OPEN.
//
// A VERIFIED_* verdict additionally requires the SEMANTIC path: for every supplied phase, the caller also
// supplies the SOURCE record that phase consumed, and this verifier RE-RUNS that phase's own exported
// validator over it and requires the result to reproduce the supplied report's self-digest exactly. That is
// not resealable -- the validators are deterministic functions of their inputs, so producing a doctored report
// would require source records that a fail-closed validator would have to have accepted in the first place
// (e.g. no source can make Phase 233 emit RECORDED over an unapproved Phase 232 authorization).
//
// KNOW WHAT THAT DOES NOT SAY. It proves a report is the honest output of its validator over SOME accepted
// record -- it does NOT pin WHICH record. The phase reports are deliberately redaction-minimal, so many source
// records collapse to a byte-identical report: the operator/observer/reviewer/closer digests, every timestamp,
// and Phase 233's observed-state digests (carried in the report only as PRESENT/PENDING) can ALL be swapped
// and the chain still verifies. VERIFIED_CLOSED therefore never means "these people did these things at these
// times over this observed state". See the locked non-uniqueness test in the suite.
//
// Reusing the phases' exported validators is deliberate: this file states NO phase semantics of its own, so
// there is no second ruleset here to drift from theirs. It reports the terminal state it finds; it does not
// decide it.
//
// It replays records and does nothing else: `performedByThisTool`, `capturedByThisTool` and `selfAuthorized`
// are the constants false. It never runs the promotion launcher, reads or writes the real Movies library,
// contacts Jellyfin, or reads the secret approval file.
//
// The emitted report is redaction-safe: chain digests, fixed codes, phase numbers and booleans only -- never a
// raw path, raw item id, raw approval id, or any operator / observer / reviewer / closer identity.

// The SOURCE records each phase consumed. Supplying them unlocks the non-resealable semantic path; omitting
// any of them caps the verdict at STRUCTURAL_ONLY. These are inputs to the phases, not reports.
export interface ChainReplaySources {
  readonly gateEvidence?: unknown;          // the Phase 231 ExecutionAuthorizationInput bundle
  readonly authorizationDecision?: unknown; // the human decision record Phase 232 consumed
  readonly observation?: unknown;           // the human observation record Phase 233 consumed
  readonly disposition?: unknown;           // the human disposition record Phase 234 consumed
  readonly closure?: unknown;               // the human closure record Phase 235 consumed
}

export interface ChainReplayInput {
  readonly gate?: unknown;           // phase-231-promotion-execution-authorization
  readonly authorization?: unknown;  // phase-232-promotion-execution-authorization-record
  readonly observation?: unknown;    // phase-233-promotion-post-run-observation-record
  readonly disposition?: unknown;    // phase-234-promotion-post-run-disposition-record
  readonly closure?: unknown;        // phase-235-promotion-operation-closure-record
  readonly sources?: ChainReplaySources;
}

// The five operation digests, as they are named inside the Phase 231 template.
const OPERATION_DIGEST_FIELDS: readonly string[] = ['approvalIdDigest', 'itemDigest', 'sourceDigest', 'destinationDigest', 'planDigest'];
// ...and the boundDigests keys every downstream phase carries them under.
const OPERATION_BINDING_KEYS: Readonly<Record<string, string>> = {
  approvalIdDigest: 'operation-approval-id',
  itemDigest: 'operation-item',
  sourceDigest: 'operation-source',
  destinationDigest: 'operation-destination',
  planDigest: 'operation-plan',
};

interface PhaseSpec {
  readonly key: keyof ChainReplayInput;
  readonly phase: number;
  readonly reportId: string;
  readonly digestField: string;     // that report's own self-digest field
  readonly parentBinding?: string;  // the boundDigests key that must equal the parent's self-digest
}

// The chain, in order. Authoritative: taken from each producer module.
const CHAIN: readonly PhaseSpec[] = [
  { key: 'gate', phase: 231, reportId: 'phase-231-promotion-execution-authorization', digestField: 'authorizationDigest' },
  { key: 'authorization', phase: 232, reportId: 'phase-232-promotion-execution-authorization-record', digestField: 'recordDigest', parentBinding: 'gate-authorization' },
  { key: 'observation', phase: 233, reportId: 'phase-233-promotion-post-run-observation-record', digestField: 'observationDigest', parentBinding: 'authorization-record' },
  { key: 'disposition', phase: 234, reportId: 'phase-234-promotion-post-run-disposition-record', digestField: 'dispositionDigest', parentBinding: 'observation-record' },
  { key: 'closure', phase: 235, reportId: 'phase-235-promotion-operation-closure-record', digestField: 'closureDigest', parentBinding: 'disposition-record' },
];

const CLOSED_OVERALL = 'OPERATION_CLOSURE_CLOSED';

export const CHAIN_REPLAY_BOUNDARY =
  'No promotion launcher run, no withdrawal run, no remediation, no archival, no observed-state capture, no real Movies library read or write, no live Jellyfin call, no secret approval-file read, and no self-authorization: this verifier only replays supplied chain records.';

export const CHAIN_REPLAY_DISCLAIMERS: readonly string[] = [
  'This verifier replays records and does nothing else: it performs no run, captures no state, and closes, archives and authorizes nothing.',
  'CHAIN_REPLAY_VERIFIED_OPEN is a normal state, not a defect: the chain is consistent as far as it goes but the operation is not closed out.',
  'CHAIN_REPLAY_STRUCTURAL_ONLY means the bundle is self-consistent but UNVERIFIED: structural checks are resealable, so a complete-looking chain earns no VERIFIED verdict without its source records.',
  'A VERIFIED verdict requires re-running each phase own validator over a supplied source record and reproducing that report digest exactly -- structure alone never earns it.',
  'A VERIFIED verdict does NOT pin WHICH source record: the phase reports are redaction-minimal, so the identities, the timestamps and the observed-state digests can all differ between two source records that produce a byte-identical report. It never means "these people did these things at these times".',
  'CHAIN_REPLAY_VERIFIED_CLOSED means only that the supplied reports re-derive into one consistent chain over one operation that a human closed out -- it is not itself evidence that any of it happened.',
  'It re-runs the phases own exported validators rather than restating their semantics, so this verifier holds no ruleset of its own that could drift from theirs.',
  'Self-digests are not signatures. This raises the cost of forging a chain; it does not establish authorship of any record in it.',
];

export interface ChainPhaseState {
  readonly phase: number;
  readonly present: boolean;
  readonly reportIdOk: boolean;
  readonly verified: boolean;
  readonly linkedToParent: boolean | null;   // null for Phase 231: it is the anchor and has no parent
  readonly identityMatched: boolean | null;  // null when identity could not be anchored at all
  // null when no source record was supplied for this phase: unproven is not the same as disproven.
  readonly rederivedFromSource: boolean | null;
}

export interface ChainReplayReport {
  readonly report: 'phase-236-promotion-chain-replay-verification';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly replayedByThisTool: true;
  readonly performedByThisTool: false;
  readonly capturedByThisTool: false;
  readonly selfAuthorized: false;
  readonly overall:
    | 'CHAIN_REPLAY_VERIFIED_CLOSED'
    | 'CHAIN_REPLAY_VERIFIED_OPEN'
    | 'CHAIN_REPLAY_STRUCTURAL_ONLY'
    | 'CHAIN_NOT_REPLAYABLE'
    | 'CHAIN_REPLAY_NO_INPUT';
  readonly terminalPhase: number | null;
  readonly chainComplete: boolean;
  readonly operationClosed: boolean;
  // True only when EVERY supplied phase was re-derived by re-running its own validator over its source record.
  readonly semanticallyRederived: boolean;
  readonly identityAnchored: boolean;
  readonly suppliedCount: number;
  readonly phases: readonly ChainPhaseState[];
  readonly operationDigests: Readonly<Record<string, string>>;
  readonly chainDigests: Readonly<Record<string, string>>;
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly replayDigest: string;
}

export function verifyPromotionChainReplay(input: ChainReplayInput): ChainReplayReport {
  const blockers: string[] = [];
  const chainDigests: Record<string, string> = {};

  // (1) Recompute every supplied report independently. A report that does not reproduce its own digest is not
  //     evidence of anything, so nothing downstream of it may be trusted either.
  const supplied = CHAIN.map((spec) => input[spec.key]);
  const reportIdOk: boolean[] = [];
  const verified: boolean[] = [];
  const selfDigests: Array<string | undefined> = [];
  CHAIN.forEach((spec, i) => {
    const value = supplied[i];
    if (value === undefined) { reportIdOk.push(false); verified.push(false); selfDigests.push(undefined); return; }
    const obj = asObject(value);
    const idOk = obj.report === spec.reportId;
    if (!idOk) blockers.push(`CHAIN_PHASE_${spec.phase}_REPORT_INVALID`);
    const stated = asSha256(obj[spec.digestField]);
    const recomputes = idOk && stated !== undefined && verifySelfDigests([obj]).results[0]?.verified === true;
    if (idOk && !recomputes) blockers.push(`CHAIN_PHASE_${spec.phase}_DIGEST_MISMATCH`);
    reportIdOk.push(idOk);
    verified.push(recomputes);
    selfDigests.push(recomputes ? stated : undefined);
    if (recomputes) chainDigests[`phase-${spec.phase}`] = stated!;
  });

  const suppliedCount = supplied.filter((v) => v !== undefined).length;

  // (2) Contiguity. The supplied set must be a PREFIX of the chain: a report whose parent is absent is a
  //     skipped link, and a chain with a hole in it cannot be replayed at all.
  CHAIN.forEach((spec, i) => {
    if (i === 0 || supplied[i] === undefined) return;
    if (supplied[i - 1] === undefined) blockers.push(`CHAIN_PHASE_${spec.phase}_PARENT_MISSING`);
  });
  // The terminal phase is the end of the contiguous prefix that actually starts at Phase 231.
  let prefix = 0;
  while (prefix < CHAIN.length && supplied[prefix] !== undefined) prefix++;
  const terminalPhase = prefix === 0 ? null : CHAIN[prefix - 1]!.phase;

  // (3) The identity ANCHOR: Phase 231's template names the one operation the whole chain must be about. A gate
  //     with no usable template (never READY, so never emitted one) anchors nothing and the chain cannot be
  //     replayed against it.
  const gateTemplate = asObject(asObject(supplied[0]).template);
  const anchor: Record<string, string> = {};
  let identityAnchored = false;
  if (supplied[0] !== undefined && verified[0]) {
    const digests = OPERATION_DIGEST_FIELDS.map((f) => asSha256(gateTemplate[f]));
    if (digests.every((d) => d !== undefined)) {
      OPERATION_DIGEST_FIELDS.forEach((f, i) => { anchor[f] = digests[i]!; });
      identityAnchored = true;
    } else {
      blockers.push('CHAIN_PHASE_231_OPERATION_IDENTITY_UNAVAILABLE');
    }
  }

  // (4) Re-derive each inter-phase link, and (5) check operation identity, INDEPENDENTLY of each other -- so a
  //     forged report that keeps a valid parent link but carries another operation's digests still fails.
  const linked: Array<boolean | null> = [];
  const identityMatched: Array<boolean | null> = [];
  CHAIN.forEach((spec, i) => {
    const value = supplied[i];
    // An absent phase is neither linked nor unlinked -- null, never false, so absence never reads as a defect.
    if (value === undefined) { linked.push(null); identityMatched.push(null); return; }
    const bound = asObject(asObject(value).boundDigests);

    // (4) The link: this report's recorded parent digest must equal the parent's OWN recomputed self-digest.
    let link: boolean | null = null;
    if (i > 0) {
      const parentDigest = selfDigests[i - 1];
      link = parentDigest !== undefined && asSha256(bound[spec.parentBinding!]) === parentDigest;
      if (!link && verified[i] && verified[i - 1]) blockers.push(`CHAIN_PHASE_${spec.phase}_LINK_NOT_REDERIVED`);
    }
    linked.push(link);

    // (5) Operation identity against the Phase 231 anchor. The gate IS the anchor; everything below it carries
    //     the same five digests under its boundDigests keys.
    // Unanchored, or a report that never recomputed: identity is unknown, not matched and not mismatched.
    if (!identityAnchored || !verified[i]) { identityMatched.push(null); return; }
    if (i === 0) { identityMatched.push(true); return; }
    const matches = OPERATION_DIGEST_FIELDS.every((f) => asSha256(bound[OPERATION_BINDING_KEYS[f]!]) === anchor[f]);
    if (!matches) blockers.push(`CHAIN_PHASE_${spec.phase}_OPERATION_IDENTITY_MISMATCH`);
    identityMatched.push(matches);
  });

  // (6) THE NON-RESEALABLE PATH. Everything above is resealable: a party holding the bundle can edit a report,
  //     recompute its digest and fix up the links and identity digests. So for each supplied phase whose SOURCE
  //     record was also supplied, re-run that phase's OWN exported validator over that source and require the
  //     result to reproduce the supplied report's self-digest exactly. Reusing the phases' validators means no
  //     phase semantics are restated here, so nothing can drift from them.
  const sources = input.sources ?? {};
  const sourceValues: readonly unknown[] = [
    sources.gateEvidence, sources.authorizationDecision, sources.observation, sources.disposition, sources.closure,
  ];
  const rederived: Array<boolean | null> = [];
  CHAIN.forEach((spec, i) => {
    // No report, or no source for it: unproven, which is NOT disproven -- null, never false.
    if (supplied[i] === undefined || sourceValues[i] === undefined) { rederived.push(null); return; }
    let produced: string | undefined;
    try { produced = rederiveSelfDigest(i, sourceValues[i], supplied); } catch { produced = undefined; }
    const ok = produced !== undefined && selfDigests[i] !== undefined && produced === selfDigests[i];
    if (!ok) blockers.push(`CHAIN_PHASE_${spec.phase}_NOT_REDERIVED_FROM_SOURCE`);
    rederived.push(ok);
  });
  // Every supplied phase must have been re-derived; a single unproven phase caps the whole verdict.
  const semanticallyRederived = suppliedCount > 0
    && CHAIN.every((_spec, i) => supplied[i] === undefined || rederived[i] === true);

  // (7) Redaction, defence in depth: every supplied report must declare itself redaction-safe and no raw path
  //     may appear anywhere in the bundle.
  const present = supplied.filter((v) => v !== undefined);
  if (present.length > 0) {
    const declared = present.every((v) => asObject(v).redactionSafe === true);
    if (!declared || deepRawPath(present)) blockers.push('CHAIN_REDACTION_UNSAFE');
  }

  const uniqueBlockers = [...new Set(blockers)];
  const phases: ChainPhaseState[] = CHAIN.map((spec, i) => ({
    phase: spec.phase,
    present: supplied[i] !== undefined,
    reportIdOk: reportIdOk[i]!,
    verified: verified[i]!,
    linkedToParent: linked[i]!,
    identityMatched: identityMatched[i]!,
    rederivedFromSource: rederived[i]!,
  }));

  const chainComplete = uniqueBlockers.length === 0
    && prefix === CHAIN.length
    && verified.every((v) => v)
    && identityAnchored
    && phases.every((p) => p.linkedToParent !== false && p.identityMatched !== false);
  const operationClosed = chainComplete && asObject(supplied[CHAIN.length - 1]).overall === CLOSED_OVERALL;

  // Conservative by construction: a VERIFIED_* verdict is refused unless the non-resealable semantic path
  // succeeded for every supplied phase. Structure alone earns STRUCTURAL_ONLY and nothing more, however
  // complete and self-consistent the bundle looks.
  const overall: ChainReplayReport['overall'] =
    suppliedCount === 0 ? 'CHAIN_REPLAY_NO_INPUT'
      : uniqueBlockers.length > 0 ? 'CHAIN_NOT_REPLAYABLE'
        : !semanticallyRederived ? 'CHAIN_REPLAY_STRUCTURAL_ONLY'
          : operationClosed ? 'CHAIN_REPLAY_VERIFIED_CLOSED'
            : 'CHAIN_REPLAY_VERIFIED_OPEN';

  const withoutDigest: Omit<ChainReplayReport, 'replayDigest'> = {
    report: 'phase-236-promotion-chain-replay-verification',
    version: 1,
    redactionSafe: true,
    replayedByThisTool: true,
    performedByThisTool: false,
    capturedByThisTool: false,
    selfAuthorized: false,
    overall,
    terminalPhase: overall === 'CHAIN_REPLAY_NO_INPUT' ? null : terminalPhase,
    chainComplete,
    operationClosed,
    semanticallyRederived,
    identityAnchored,
    suppliedCount,
    phases,
    // Only published once identity actually holds across everything supplied -- never a partial or drifting set.
    operationDigests: uniqueBlockers.length === 0 && identityAnchored ? anchor : {},
    chainDigests,
    boundary: CHAIN_REPLAY_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: CHAIN_REPLAY_DISCLAIMERS,
  };
  return { ...withoutDigest, replayDigest: digest('phase-236-chain-replay', JSON.stringify(withoutDigest)) };
}

// Re-run phase `i`'s OWN exported validator over its source record and return the self-digest it produces.
// Each downstream phase is fed the SUPPLIED parent report, exactly as it was fed in the first place -- so a
// doctored parent cannot be laundered by re-deriving the child against a clean one.
function rederiveSelfDigest(i: number, source: unknown, supplied: readonly unknown[]): string | undefined {
  switch (i) {
    case 0: return buildExecutionAuthorization(source as ExecutionAuthorizationInput).authorizationDigest;
    case 1: return buildExecutionAuthorizationRecord({ gate: supplied[0], record: source }).recordDigest;
    case 2: return buildPostRunObservationRecord({ authorizationRecord: supplied[1], observation: source }).observationDigest;
    case 3: return buildPostRunDispositionRecord({ observationRecord: supplied[2], disposition: source }).dispositionDigest;
    case 4: return buildOperationClosureRecord({ dispositionRecord: supplied[3], closure: source }).closureDigest;
    default: return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
// Raw-path fragments that must never leak into a redaction-safe artifact tree. Authoritative: the same marker
// set the Phase 230 final-bundle replay verifier uses.
//
// NOTE the deliberate difference from the per-phase validators. Those scan a HUMAN-SUPPLIED record for any
// live-surface WORD ("jellyfin", a url scheme, a media extension), because a human writing a record has no
// business naming those at all. Here the inputs are GENERATED reports whose boundary and disclaimer prose
// names the live surfaces it promises to avoid -- "no live Jellyfin call", "no real Movies library read". A
// word scan would flag every honest boundary statement in the chain. What must never appear is a RAW PATH, so
// that is exactly what is scanned for.
const RAW_PATH_MARKERS: readonly string[] = ['/mnt/', '\\mnt\\', '/media/Movies', 'user/media', 'catalog-authority-test-library'];

function hasRawPathMarker(value: string): boolean {
  return RAW_PATH_MARKERS.some((m) => value.includes(m));
}
// Flag any string ANYWHERE in the supplied bundle -- keys included -- that carries a raw-path marker.
// Traverses ITERATIVELY (explicit stack) with a visited set, so it terminates on any input: a pathologically
// deep bundle cannot overflow the stack and a cyclic/shared-reference bundle cannot loop forever. Skipping an
// already-visited node is safe (its subtree was fully evaluated on first visit); the result is deterministic
// and a raw path buried at any depth still fails closed.
function deepRawPath(root: unknown): boolean {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') { if (hasRawPathMarker(value)) return true; continue; }
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { for (const v of value) stack.push(v); continue; }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (hasRawPathMarker(k)) return true;
      stack.push(v);
    }
  }
  return false;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
