import { createHash } from 'node:crypto';
import {
  AUDIT_PHASES,
  AUDIT_PHASE_REPORT_IDS,
  buildAuditClosurePacket,
  containsRawPathMarker,
  type AuditClosurePacketReport,
} from './promotion-audit-closure-packet.js';
import { deepLocationOrLiveSurface } from './promotion-evidence-retention-inventory.js';

// Phase 242: the local, non-live OPERATOR CONSOLE over the completed Phase 231-241 chain.
//
// WHY IT EXISTS. Phases 231-241 are correct and they are unusable. Reaching a verdict today means knowing
// which of ten reports exist, naming each on its own flag, remembering which phase produces which artifact,
// and reading a machine report to find out what to do next. Every one of those is a place to get it wrong,
// and getting it wrong quietly is the failure mode that matters: a human who cannot tell "this chain is
// honestly unfinished" from "this chain is broken" will eventually treat one as the other.
//
// So this phase adds NO new evidence semantics whatsoever. It is a USABILITY layer: it collects the
// artifacts, hands them to the Phase 241 packet UNCHANGED, and turns the result into something a person can
// act on -- one outcome, the phase the chain actually reaches, the phase that is missing next, the fixed
// blockers with what each one means, and the exact safe next human steps.
//
// IT DECIDES NOTHING AND CREATES NOTHING. `approvalCreatedByThisTool`, `executionPerformedByThisTool`,
// `observationCapturedByThisTool`, `custodyHeldByThisTool`, `archivedByThisTool`, `judgmentFormedByThisTool`,
// `humanDecisionInferredByThisTool`, `promotionRunByThisTool` and `selfAuthorized` are the constants false.
// Every line of guidance it emits is a FIXED lookup from the outcome and the phase actually outstanding --
// never a recommendation about whether the promotion should proceed, and never an inference about what a
// human meant. "Outstanding" is not the same as "absent": a phase that is PRESENT but not yet terminal is the
// step still open, and it comes first.
//
// ABSENCE IS NORMAL, and this is the single most important thing the console has to communicate. The real
// P227-A operation stops at Phase 232 because no human approved it. That is AUDIT_OPEN with ZERO blockers,
// and the console says so in as many words rather than leaving a person to infer it from an empty list.
//
// THREE WAYS AN ARTIFACT CAN FAIL TO BE THERE, and they mean completely different things:
//   ABSENT     -- the phase has not happened yet. Normal. Never a blocker.
//   MALFORMED  -- something is in that slot that is not a chain report at all. A defect.
//   MISFILED   -- a genuine chain report, but for a different phase. A defect.
//   DUPLICATE  -- two artifacts claim the same phase. A defect: the console cannot know which is authoritative
//                 and will not guess.
// Collapsing these into "missing" is exactly the mistake that lets a broken chain read as an unfinished one.
//
// INTAKE IS ALLOWLISTED, NEVER PATH-DRIVEN. In directory mode the caller may only look for the FIXED
// filenames published here, joined to one directory, non-recursively. No filename, glob or path ever comes
// from the data being audited, so a hostile bundle cannot steer a read. Everything the console could not
// recognise as a chain artifact is screened through the Phase 240 location/live-surface predicate and
// rejected, so a foreign payload carrying a URL, a host, an IP or a filesystem location fails closed.
//
// IT NEVER ECHOES ITS INPUT. Not one string from the intake reaches the output: the report is built from
// fixed text, counts, phase numbers, and the Phase 241 packet -- which is itself redaction-safe. No path, no
// directory, no filename, no item id, no approval id or value, no identity, no timestamp, no secret.

export type ConsoleOutcome = 'AUDIT_CLOSED' | 'AUDIT_OPEN' | 'AUDIT_INVALID' | 'NOT_ELIGIBLE';
export type ArtifactStatus = 'PRESENT' | 'ABSENT' | 'MALFORMED' | 'MISFILED' | 'DUPLICATE';
export type IntakeMode = 'DIRECTORY' | 'BUNDLE' | 'NONE';

export const CONSOLE_PHASES: readonly number[] = AUDIT_PHASES;

// THE FILENAME ALLOWLIST. Two accepted names per phase: the canonical one, derived from the report id the
// Phase 241 packet requires so it can never drift from what is actually checked, and a short form for people
// typing by hand. Nothing else is ever read. Both present at once is a DUPLICATE, not a preference order:
// picking one would be guessing which artifact the operator meant.
export const CONSOLE_ARTIFACT_FILENAMES: Readonly<Record<number, readonly string[]>> = Object.freeze(
  Object.fromEntries(CONSOLE_PHASES.map((p) => [p, Object.freeze([`${AUDIT_PHASE_REPORT_IDS[p]!}.json`, `phase-${p}.json`])])),
);

// Every report id this chain can legitimately carry, for telling a MISFILED artifact from a MALFORMED one.
const KNOWN_CHAIN_REPORT_IDS: ReadonlySet<string> = new Set(CONSOLE_PHASES.map((p) => AUDIT_PHASE_REPORT_IDS[p]!));

export const CONSOLE_BOUNDARY =
  'No promotion launcher run, no withdrawal run, no remediation, no archival, no deletion, no observed-state capture, no record retrieval, no identity verification, no custody, no real Movies library read or write, no live Jellyfin call, no secret approval-file read, no network access, no merge, tag or push, and no self-authorization: this console only collects supplied chain reports, hands them to the Phase 241 audit unchanged, and restates the result.';

export const CONSOLE_DISCLAIMERS: readonly string[] = [
  'This console adds no evidence semantics. Every verdict it reports is the Phase 241 packet\'s, unchanged; it only makes that verdict, and what to do about it, legible.',
  'AUDIT_OPEN with zero blockers is the normal state of an unfinished chain, not a defect. It means the chain is consistent as far as it goes and simply has not reached a closed terminal state.',
  'AUDIT_CLOSED means the ten records are mutually consistent and each is sound by its own criteria. It does NOT mean the promotion happened, was correct, or was authorized by anyone in particular.',
  'Self-digests are not signatures. A party controlling every artifact can fabricate a bundle that audits as CLOSED; the proof-limit matrix inside the embedded Phase 241 report states each phase\'s honest limit.',
  'The next steps are a FIXED lookup from the outcome and the phase actually outstanding -- a phase that is present but not yet terminal comes before the first absent one. They are not advice about whether the promotion should proceed, and no human decision is read, inferred or supplied here.',
  'The console never echoes its input: no path, directory, filename, item id, approval id or value, identity, timestamp or secret appears in this report.',
];

export interface ConsoleBlocker {
  readonly code: string;
  readonly phase: number | null;
  readonly meaning: string;
  readonly humanAction: string;
}

export interface ArtifactState {
  readonly phase: number;
  readonly status: ArtifactStatus;
  readonly usable: boolean;                        // handed on to the Phase 241 audit
  readonly acceptedFilenames: readonly string[];
}

export interface OperatorConsoleReport {
  readonly report: 'phase-242-promotion-operator-console';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly approvalCreatedByThisTool: false;
  readonly executionPerformedByThisTool: false;
  readonly observationCapturedByThisTool: false;
  readonly custodyHeldByThisTool: false;
  readonly archivedByThisTool: false;
  readonly judgmentFormedByThisTool: false;
  readonly humanDecisionInferredByThisTool: false;
  readonly promotionRunByThisTool: false;
  readonly selfAuthorized: false;
  readonly overall: ConsoleOutcome;
  readonly auditOutcome: ConsoleOutcome;
  readonly outcomeMatchesAudit: boolean;
  readonly intakeMode: IntakeMode;
  readonly intakeSound: boolean;
  readonly terminalPhase: number | null;
  readonly nextRequiredPhase: number | null;
  readonly missingPhases: readonly number[];
  readonly nonTerminalPhases: readonly number[];
  readonly artifacts: readonly ArtifactState[];
  readonly presentCount: number;
  readonly absentCount: number;
  readonly malformedCount: number;
  readonly misfiledCount: number;
  readonly duplicateCount: number;
  readonly unknownKeyCount: number;
  readonly unknownFilesIgnored: number;
  readonly summary: readonly string[];
  readonly blockers: readonly ConsoleBlocker[];
  readonly blockerCodes: readonly string[];
  readonly nextSteps: readonly string[];
  readonly audit: AuditClosurePacketReport;
  readonly boundary: string;
  readonly disclaimers: readonly string[];
  readonly consoleDigest: string;
}

// What a caller that walked a directory found for one phase. `status` carries the filesystem facts this
// module cannot see for itself; a claimed PRESENT is ALWAYS re-validated here against the report body, so a
// caller can only ever make the console MORE suspicious of an artifact, never less.
export interface ConsoleArtifactIntake {
  readonly status?: unknown;
  readonly report?: unknown;
}

export interface OperatorConsoleInput {
  readonly mode?: unknown;                 // 'DIRECTORY' | 'BUNDLE'
  readonly artifacts?: unknown;            // DIRECTORY mode: phase -> ConsoleArtifactIntake
  readonly bundle?: unknown;               // BUNDLE mode: phase -> report, or [report, report] for a duplicate
  readonly unknownFilesIgnored?: unknown;  // DIRECTORY mode: count of non-allowlisted entries, never their names
}

export function buildOperatorConsole(input: OperatorConsoleInput): OperatorConsoleReport {
  const mode: IntakeMode = input.mode === 'DIRECTORY' ? 'DIRECTORY' : input.mode === 'BUNDLE' ? 'BUNDLE' : 'NONE';
  const codes: string[] = [];
  if (mode === 'NONE') codes.push('CONSOLE_NO_INPUT');

  // (1) INTAKE. Normalise both modes to one per-phase status, and set aside every value that will NOT reach
  //     the Phase 241 audit so it can be screened here instead of going unexamined.
  const statuses: ArtifactStatus[] = [];
  const usable: Array<Record<string, unknown> | undefined> = [];
  const foreignValues: unknown[] = [];        // not a chain report at all
  const unauditedChainValues: unknown[] = []; // chain-shaped, but not handed to the audit
  const setAside = (v: unknown): void => classify(v, unauditedChainValues, foreignValues);
  let unknownKeyCount = 0;

  const bundle = asObject(input.bundle);
  const artifacts = asObject(input.artifacts);
  if (mode === 'BUNDLE') {
    for (const key of Object.keys(bundle)) {
      if (!CONSOLE_PHASES.some((p) => String(p) === key)) { unknownKeyCount++; setAside(bundle[key]); }
    }
  }

  for (const phase of CONSOLE_PHASES) {
    const key = String(phase);
    const intake = asObject(artifacts[key]);
    const raw = mode === 'BUNDLE' ? bundle[key] : intake.report;
    const declared = mode === 'BUNDLE' ? bundle[key] !== undefined : artifacts[key] !== undefined;
    if (!declared) { statuses.push('ABSENT'); usable.push(undefined); continue; }

    // A caller-declared non-PRESENT status is taken at face value: only the caller can see the filesystem, and
    // it can only ever make the console MORE suspicious of an artifact, never less. A status it declares that
    // is not one this module knows is MALFORMED -- fail closed, never ignored.
    if (mode === 'DIRECTORY' && intake.status !== 'PRESENT') {
      const status: ArtifactStatus = intake.status === 'ABSENT' ? 'ABSENT'
        : intake.status === 'DUPLICATE' ? 'DUPLICATE' : 'MALFORMED';
      statuses.push(status); usable.push(undefined);
      if (status !== 'ABSENT' && raw !== undefined) setAside(raw);
      continue;
    }

    // A duplicate encoded in a bundle: two artifacts filed under one phase. The console will not pick one.
    if (Array.isArray(raw)) {
      statuses.push(raw.length >= 2 ? 'DUPLICATE' : 'MALFORMED'); usable.push(undefined); setAside(raw); continue;
    }
    if (raw === null || typeof raw !== 'object') { statuses.push('MALFORMED'); usable.push(undefined); setAside(raw); continue; }

    const obj = raw as Record<string, unknown>;
    if (obj.report === AUDIT_PHASE_REPORT_IDS[phase]) { statuses.push('PRESENT'); usable.push(obj); continue; }
    // A genuine chain report id in the wrong slot is MISFILED -- a recoverable filing mistake, distinct from
    // an object that is not a chain report at all.
    const misfiled = typeof obj.report === 'string' && KNOWN_CHAIN_REPORT_IDS.has(obj.report);
    statuses.push(misfiled ? 'MISFILED' : 'MALFORMED');
    usable.push(undefined);
    setAside(obj);
  }

  // (2) SCREEN WHAT THE AUDIT WILL NEVER SEE. Anything not shaped like a chain report is not one, so the
  //     strict Phase 240 predicate applies to it in full: URL schemes, hosts, IP literals, UNC and
  //     drive-letter paths, buckets and live Jellyfin surfaces all fail closed. That predicate is
  //     deliberately NOT applied to chain-shaped reports, because their own boundary prose legitimately names
  //     the live surfaces they avoid; those get the Phase 241 raw-path scanner instead -- the same split
  //     Phases 236 and 241 already make, for the same reason. Artifacts that DO reach the audit are screened
  //     by the audit itself, so nothing is scanned twice and no defect is reported under two codes.
  if (foreignValues.length > 0 && deepLocationOrLiveSurface(foreignValues)) codes.push('CONSOLE_LIVE_DATA_PRESENT');
  if (unauditedChainValues.length > 0 && containsRawPathMarker(unauditedChainValues)) codes.push('CONSOLE_RAW_PATH_PRESENT');

  CONSOLE_PHASES.forEach((phase, i) => {
    const status = statuses[i]!;
    if (status === 'MALFORMED') codes.push(`CONSOLE_PHASE_${phase}_ARTIFACT_MALFORMED`);
    if (status === 'MISFILED') codes.push(`CONSOLE_PHASE_${phase}_ARTIFACT_MISFILED`);
    if (status === 'DUPLICATE') codes.push(`CONSOLE_PHASE_${phase}_ARTIFACT_DUPLICATE`);
  });
  if (unknownKeyCount > 0) codes.push('CONSOLE_UNKNOWN_ARTIFACT_KEY');

  // (3) THE AUDIT ITSELF, unchanged. Only the artifacts that survived intake are handed over; the Phase 241
  //     packet is the sole authority on what the chain proves, and this console never second-guesses it.
  const reports: Record<string, unknown> = {};
  CONSOLE_PHASES.forEach((phase, i) => { if (usable[i] !== undefined) reports[String(phase)] = usable[i]; });
  const audit = buildAuditClosurePacket(Object.keys(reports).length > 0 ? { reports } : {});
  const auditOutcome = audit.overall;

  const intakeSound = codes.length === 0;
  // NOT_ELIGIBLE keeps the precedence it has in Phase 241: without a genuine Phase 231 anchor there is no
  // operation identity to audit anything against, and no intake defect changes that. Otherwise an intake
  // defect is decisive on its own -- a bundle the console could not even assemble cannot be reported as
  // merely unfinished.
  const overall: ConsoleOutcome = auditOutcome === 'NOT_ELIGIBLE' ? 'NOT_ELIGIBLE'
    : intakeSound ? auditOutcome : 'AUDIT_INVALID';

  const missingPhases = CONSOLE_PHASES.filter((_, i) => statuses[i] === 'ABSENT');
  const nonTerminalPhases = audit.phases.filter((p) => p.present && !p.terminal).map((p) => p.phase);
  const terminalPhase = audit.terminalPhase;
  // WHAT IS ACTUALLY NEEDED NEXT. A phase that is PRESENT but not yet in its terminal state takes precedence
  // over the first absent one, and getting this the wrong way round would be the console's own worst failure
  // mode: the real P227-A chain holds at an UNDECIDED Phase 232, and pointing an operator at Phase 233
  // instead would tell them to record an observation of a run nobody has authorized. An unfinished phase is
  // finished on its own terms first; only then does the next artifact become the next thing.
  const nextRequiredPhase: number | null =
    overall === 'NOT_ELIGIBLE' ? CONSOLE_PHASES[0]!
      : overall === 'AUDIT_CLOSED' || overall === 'AUDIT_INVALID' ? null
        : nonTerminalPhases.length > 0 ? nonTerminalPhases[0]!
          : missingPhases.length > 0 ? missingPhases[0]!
            : null;

  const blockers = [...new Set(codes.concat(audit.blockers))].map(describeBlocker);
  const blockerCodes = blockers.map((b) => b.code);
  const nextIsUnfinished = nextRequiredPhase !== null && nonTerminalPhases.includes(nextRequiredPhase);
  const nextSteps = buildNextSteps(overall, nextRequiredPhase, nextIsUnfinished, blockers);
  const summary = buildSummary({
    overall, auditOutcome, mode, terminalPhase, nextRequiredPhase, nextIsUnfinished, missingPhases,
    statuses, audit, blockers, unknownKeyCount, unknownFilesIgnored: count(input.unknownFilesIgnored),
  });

  const withoutDigest: Omit<OperatorConsoleReport, 'consoleDigest'> = {
    report: 'phase-242-promotion-operator-console',
    version: 1,
    redactionSafe: true,
    approvalCreatedByThisTool: false,
    executionPerformedByThisTool: false,
    observationCapturedByThisTool: false,
    custodyHeldByThisTool: false,
    archivedByThisTool: false,
    judgmentFormedByThisTool: false,
    humanDecisionInferredByThisTool: false,
    promotionRunByThisTool: false,
    selfAuthorized: false,
    overall,
    auditOutcome,
    outcomeMatchesAudit: overall === auditOutcome,
    intakeMode: mode,
    intakeSound,
    terminalPhase,
    nextRequiredPhase,
    missingPhases,
    nonTerminalPhases,
    artifacts: CONSOLE_PHASES.map((phase, i) => ({
      phase,
      status: statuses[i]!,
      usable: usable[i] !== undefined,
      acceptedFilenames: CONSOLE_ARTIFACT_FILENAMES[phase]!,
    })),
    presentCount: statuses.filter((s) => s === 'PRESENT').length,
    absentCount: statuses.filter((s) => s === 'ABSENT').length,
    malformedCount: statuses.filter((s) => s === 'MALFORMED').length,
    misfiledCount: statuses.filter((s) => s === 'MISFILED').length,
    duplicateCount: statuses.filter((s) => s === 'DUPLICATE').length,
    unknownKeyCount,
    unknownFilesIgnored: count(input.unknownFilesIgnored),
    summary,
    blockers,
    blockerCodes,
    nextSteps,
    audit,
    boundary: CONSOLE_BOUNDARY,
    disclaimers: CONSOLE_DISCLAIMERS,
  };
  return { ...withoutDigest, consoleDigest: digest('phase-242-operator-console', JSON.stringify(withoutDigest)) };
}

interface BlockerText { readonly meaning: string; readonly humanAction: string }

// THE BLOCKER TAXONOMY. Fixed, value-free text for every code the Phase 241 packet and this console can emit,
// keyed by the code's phase-independent suffix so one entry serves all ten phases. A code carries WHAT WENT
// WRONG; the human action says what to do about it and, just as importantly, what not to do -- re-sealing an
// artifact to clear a blocker is always available and never helps, because the next auditor re-derives the
// chain from the same inputs.
const PHASE_BLOCKER_TEXT: Readonly<Record<string, BlockerText>> = {
  REPORT_INVALID: {
    meaning: 'The artifact filed for this phase is not that phase\'s report.',
    humanAction: 'Refile the correct artifact for this phase. Do not rename another phase\'s report to fit the slot.',
  },
  DIGEST_MISMATCH: {
    meaning: 'The artifact does not reproduce its own self-digest, so its body has been altered since it was written.',
    humanAction: 'Retrieve the artifact as it was originally written. Re-sealing the altered copy makes it recompute again but changes nothing an auditor re-deriving the chain would see.',
  },
  PREDECESSOR_MISSING: {
    meaning: 'This phase is present while the phase it builds on is absent -- a hole, not an unfinished chain.',
    humanAction: 'Supply the missing predecessor artifact, or withdraw this one. A chain with a hole cannot be audited as one chain.',
  },
  CONSTANT_INVALID: {
    meaning: 'A constant this phase must always publish is missing or wrong in the artifact body.',
    humanAction: 'Regenerate the artifact from its own producer over the evidence you hold, rather than editing the body.',
  },
  ACTION_CLAIMED: {
    meaning: 'The artifact claims a tool performed an action -- an execution, capture, archival, retrieval or authorization -- that no validator in this chain is allowed to perform.',
    humanAction: 'Treat this artifact as untrustworthy and establish where it came from. No genuine report in this chain can carry that claim.',
  },
  FINDINGS_PRESENT: {
    meaning: 'The artifact carries its own unresolved findings, so the phase that produced it did not pass its own checks.',
    humanAction: 'Read that phase\'s own report, resolve what it lists, and regenerate it. Do not audit over the top of it.',
  },
  STATE_CONTRADICTS_HEADLINE: {
    meaning: 'The artifact\'s headline and its own success booleans disagree. Every producer in this chain computes the headline FROM those booleans, so this cannot happen in a genuine report.',
    humanAction: 'Treat this artifact as forged and establish where it came from. This is not an unfinished report; it is a report whose body denies its own headline.',
  },
  LINK_NOT_REDERIVED: {
    meaning: 'The artifact does not bind to its parent\'s recomputed digest, so it belongs to a different chain instance.',
    humanAction: 'Supply the artifact that was actually generated over this parent. A report and its parent are bound by digest and cannot be paired after the fact.',
  },
  OPERATION_IDENTITY_MISMATCH: {
    meaning: 'The artifact describes a different operation from the one the Phase 231 gate anchors.',
    humanAction: 'Remove the foreign artifact. Reports from two operations are not one chain, however complete they look together.',
  },
  OPERATION_IDENTITY_UNAVAILABLE: {
    meaning: 'The Phase 231 gate does not publish a usable operation identity, so nothing can be checked against it.',
    humanAction: 'Regenerate the Phase 231 gate from the approval and preflight evidence you hold.',
  },
  ARTIFACT_MALFORMED: {
    meaning: 'What was supplied for this phase is not a chain report: unreadable, not JSON, not an object, or carrying an unrecognised report id.',
    humanAction: 'Supply the phase artifact itself. This is a defect, not an unfinished phase -- an unfinished phase has nothing in its slot at all.',
  },
  ARTIFACT_MISFILED: {
    meaning: 'A genuine chain report is filed under the wrong phase.',
    humanAction: 'Refile it under its own phase using one of that phase\'s accepted filenames.',
  },
  ARTIFACT_DUPLICATE: {
    meaning: 'Two artifacts claim this phase. The console cannot know which is authoritative and will not guess.',
    humanAction: 'Leave exactly one artifact for this phase and remove or move the other out of the intake.',
  },
};

const GLOBAL_BLOCKER_TEXT: Readonly<Record<string, BlockerText>> = {
  AUDIT_NO_REPORTS_SUPPLIED: {
    meaning: 'No chain artifacts were supplied at all, so there is nothing to audit.',
    humanAction: 'Point the console at the directory holding the artifacts, or supply a bundle.',
  },
  AUDIT_ANCHOR_MISSING: {
    meaning: 'The Phase 231 gate is missing or not genuine. It is the anchor that names the one operation everything else must be about, and no later report can supply that identity.',
    humanAction: 'Supply the genuine Phase 231 artifact. Until it is present, no verdict about the rest of the chain is meaningful.',
  },
  AUDIT_REDACTION_UNSAFE: {
    meaning: 'A supplied report does not declare itself redaction-safe, or carries a raw filesystem path.',
    humanAction: 'Do not circulate this bundle. Establish where the report came from; every genuine artifact in this chain is digest-only by construction.',
  },
  CONSOLE_NO_INPUT: {
    meaning: 'No intake was given: neither a directory to discover artifacts in nor a bundle.',
    humanAction: 'Run the console with a directory or a bundle. It reads nothing by default and never guesses a location.',
  },
  CONSOLE_UNKNOWN_ARTIFACT_KEY: {
    meaning: 'The supplied bundle carries keys that are not chain phases. The console will not read data it cannot name.',
    humanAction: 'Supply a bundle keyed only by phase number, 231 through 240. The unexpected keys are neither read nor echoed.',
  },
  CONSOLE_LIVE_DATA_PRESENT: {
    meaning: 'Something in the intake that is not a chain artifact carries a live or network shape -- a URL, host, IP address, share or filesystem location.',
    humanAction: 'Remove it from the intake. This console is offline by construction: it holds no credentials, opens no connection, and will not audit around live data.',
  },
  CONSOLE_RAW_PATH_PRESENT: {
    meaning: 'A recognised chain report carries a raw filesystem path, which no genuine artifact in this chain does.',
    humanAction: 'Do not circulate this bundle. Establish where that report came from.',
  },
};

const UNKNOWN_BLOCKER: BlockerText = {
  meaning: 'The Phase 241 audit reported a check this console has no fixed text for.',
  humanAction: 'Read the embedded Phase 241 report for the detail. The verdict above already accounts for it; only the explanation is missing.',
};

function describeBlocker(code: string): ConsoleBlocker {
  const m = /^(?:AUDIT|CONSOLE)_PHASE_(\d{3})_(.+)$/.exec(code);
  if (m) {
    const text = PHASE_BLOCKER_TEXT[m[2]!] ?? UNKNOWN_BLOCKER;
    return { code, phase: Number(m[1]), meaning: text.meaning, humanAction: text.humanAction };
  }
  const text = GLOBAL_BLOCKER_TEXT[code] ?? UNKNOWN_BLOCKER;
  return { code, phase: null, meaning: text.meaning, humanAction: text.humanAction };
}

// WHAT EACH PHASE NEEDS FROM A HUMAN. Fixed text, one entry per phase, describing what the missing artifact
// records and who has to produce it. Phrased so that no entry can be read as a recommendation to run,
// approve or accept anything: the phases that need a human decision say so and stop there.
const PHASE_NEXT_STEP: Readonly<Record<number, string>> = {
  231: 'Phase 231 prepares the execution-authorization TEMPLATE from approval and preflight evidence you already hold. Run `npm run ops:promotion-execution-authorization` over that evidence. It authorizes nothing: every template field stays PENDING and authorization stays NONE.',
  232: 'Phase 232 records a human APPROVE or DECLINE decision on the prepared operation. A person fills in the Phase 232 skeleton and validates it with `npm run ops:promotion-execution-authorization-record`. This console does not make, infer or recommend that decision, and DECLINE is a complete and valid outcome that ends the chain honestly.',
  233: 'Phase 233 records what a human OBSERVED after an authorized run. Only the person who watched the run can write it, and they write what they saw. Nothing here performs, schedules, recommends or authorizes a run.',
  234: 'Phase 234 records a human REVIEW that accepts or rejects the observed outcome. A reviewer fills in the Phase 234 skeleton and validates it with `npm run ops:promotion-post-run-disposition-record`. Rejecting the outcome is a valid result.',
  235: 'Phase 235 records a human CLOSING the operation out, having affirmed the evidence was archived and no remediation is outstanding. Closure is archival, never erasure: no valid record here can express destruction.',
  236: 'Phase 236 replays the whole chain from the source records. Run `npm run ops:promotion-chain-replay` with the reports and the source records you already hold; it re-derives, and creates nothing.',
  237: 'Phase 237 records a human COMMITTING to the exact content digests of the four source records. Run `npm run ops:promotion-source-record-provenance`. It never recomputes those digests against real records -- it only makes a later substitution detectable.',
  238: 'Phase 238 verifies supplied source-record bytes against that commitment. Retrieve the records yourself, then run `npm run ops:promotion-supplied-source-record-verification`. The tool retrieves nothing on your behalf.',
  239: 'Phase 239 records the hash-linked custody narrative and must reach CUSTODY_RELEASED before an inventory can be taken over it. Run `npm run ops:promotion-chain-custody-ledger` over the custody events you hold.',
  240: 'Phase 240 accounts for all nine chain artifacts as retained. Run `npm run ops:promotion-evidence-retention-inventory` and supply the artifacts themselves; without them the claimed digests are checked against nothing and the inventory can only reach STRUCTURAL_ONLY.',
};

const OUTCOME_STEP: Readonly<Record<ConsoleOutcome, string>> = {
  AUDIT_CLOSED: 'The ten records are present, genuine, mutually consistent and each in its own terminal state. Keep this report with the artifacts: the proof-limit matrix travels inside it, and AUDIT_CLOSED does NOT mean the promotion happened, was correct, or was authorized by anyone in particular.',
  AUDIT_OPEN: 'Nothing is wrong. The chain is consistent as far as it goes and has simply not reached a closed terminal state. An unfinished chain is the expected state of an operation nobody has carried further.',
  AUDIT_INVALID: 'Stop and resolve every blocker below before adding anything to this chain. Do not re-seal, regenerate or edit an artifact to make a blocker disappear: a re-sealed artifact recomputes cleanly and hides nothing from the next person who re-derives the chain.',
  NOT_ELIGIBLE: 'There is no genuine Phase 231 gate in this intake, so there is no operation identity to audit anything against. Nothing can be concluded about the rest of the artifacts until it is supplied.',
};

const SHELL_NOTE =
  'When running any of these tools with flags, invoke them directly -- `npx tsx src/ops/<tool>-cli.ts <flags>` -- which behaves the same on PowerShell, cmd and bash. `npm run <script> -- <flags>` is not portable: PowerShell consumes the first `--`, npm takes the flags as its own, and the tool runs with none of them.';

const STANDING_STEPS: readonly string[] = [
  'Nothing in this console authorizes, schedules, performs or recommends a promotion run. It never reads the real Movies library, contacts Jellyfin, reads the secret approval file, or touches the network.',
  'Every step above is a fixed lookup from the outcome and the phase actually outstanding -- a phase that is present but not yet in its terminal state is the step still open, and comes before the first absent one. None of it is advice about whether the promotion should proceed, and no human decision is read or inferred here.',
  'Never delete or archive an artifact to clear a blocker. No valid record in this chain can express destruction, and a missing artifact is a worse position than a failing one.',
];

function buildNextSteps(
  overall: ConsoleOutcome,
  nextRequiredPhase: number | null,
  nextIsUnfinished: boolean,
  blockers: readonly ConsoleBlocker[],
): readonly string[] {
  const steps: string[] = [OUTCOME_STEP[overall]];
  for (const action of [...new Set(blockers.map((b) => b.humanAction))]) steps.push(action);
  if (nextRequiredPhase !== null) {
    steps.push(nextIsUnfinished
      // Present and genuine, but not finished. Saying "the next artifact is Phase n+1" here would send a
      // person past the step that is actually outstanding.
      ? `Phase ${nextRequiredPhase} is present and genuine but NOT in its terminal state, which is what holds this chain open. That is not a defect -- it is the step that is actually outstanding, and it is finished on its own terms before any later phase can exist. ${PHASE_NEXT_STEP[nextRequiredPhase]!}`
      : `The next artifact this chain needs is Phase ${nextRequiredPhase}. ${PHASE_NEXT_STEP[nextRequiredPhase]!}`);
    // Only worth saying when a step above actually asks someone to run something. Passing flags through
    // `npm run <script> -- <flags>` is not portable -- PowerShell eats the first `--`, npm takes the flags as
    // its own, and the tool runs with none of them -- which reads as the tool ignoring the operator.
    steps.push(SHELL_NOTE);
  }
  steps.push(...STANDING_STEPS);
  return steps;
}

interface SummaryInput {
  readonly overall: ConsoleOutcome;
  readonly auditOutcome: ConsoleOutcome;
  readonly mode: IntakeMode;
  readonly terminalPhase: number | null;
  readonly nextRequiredPhase: number | null;
  readonly nextIsUnfinished: boolean;
  readonly missingPhases: readonly number[];
  readonly statuses: readonly ArtifactStatus[];
  readonly audit: AuditClosurePacketReport;
  readonly blockers: readonly ConsoleBlocker[];
  readonly unknownKeyCount: number;
  readonly unknownFilesIgnored: number;
}

// THE HUMAN SUMMARY. Built from fixed text, counts and phase numbers only -- there is nothing here that could
// carry a value out of the intake. The headline says in words what the outcome means, because the whole point
// of the phase is that a person should not have to interpret a status code to know whether to worry.
function buildSummary(s: SummaryInput): readonly string[] {
  const lines: string[] = [
    'PROMOTION RECORD CHAIN -- OPERATOR CONSOLE (Phase 242, local, non-live)',
    '',
    `  outcome:              ${s.overall}`,
    `  means:                ${OUTCOME_HEADLINE[s.overall]}`,
    `  audit verdict:        ${s.auditOutcome}${s.overall === s.auditOutcome ? '' : '  (the intake itself is defective; see blockers)'}`,
    `  intake:               ${s.mode}`,
    `  chain reaches:        ${s.terminalPhase === null ? 'nothing -- no usable Phase 231 anchor' : `Phase ${s.terminalPhase}`}`,
    `  next required phase:  ${s.nextRequiredPhase === null ? 'none' : `${s.nextRequiredPhase}${s.nextIsUnfinished ? '  (present, but not finished)' : ''}`}`,
    `  artifacts:            ${count2(s.statuses, 'PRESENT')} present, ${count2(s.statuses, 'ABSENT')} absent, ${count2(s.statuses, 'MALFORMED')} malformed, ${count2(s.statuses, 'MISFILED')} misfiled, ${count2(s.statuses, 'DUPLICATE')} duplicate`,
    `  blockers:             ${s.blockers.length === 0 ? 'none' : String(s.blockers.length)}`,
    '',
    'phases:',
  ];
  CONSOLE_PHASES.forEach((phase, i) => {
    const status = s.statuses[i]!;
    const a = s.audit.phases.find((p) => p.phase === phase);
    const flags = status !== 'PRESENT' || a === undefined ? ''
      : [
          a.verified ? 'verified' : 'NOT-VERIFIED',
          a.semanticallySound ? 'sound' : 'NOT-SOUND',
          a.terminal ? 'terminal' : 'not-terminal',
          a.linkedToParent === false ? 'LINK-BROKEN' : '',
          a.identityMatched === false ? 'FOREIGN-OPERATION' : '',
        ].filter((f) => f !== '').join('  ');
    lines.push(`  ${phase}  ${status.padEnd(9)} ${flags}`.trimEnd());
  });
  if (s.missingPhases.length > 0) {
    lines.push('', `absent (not a defect): ${s.missingPhases.join(', ')}`);
  }
  if (s.unknownKeyCount > 0 || s.unknownFilesIgnored > 0) {
    lines.push('', `ignored, unread and never echoed: ${s.unknownFilesIgnored} non-allowlisted entries, ${s.unknownKeyCount} unknown bundle keys`);
  }
  if (s.blockers.length > 0) {
    lines.push('', 'blockers:');
    for (const b of s.blockers) {
      lines.push(`  ${b.code}`);
      lines.push(`      ${b.meaning}`);
    }
  }
  lines.push('', 'next steps:');
  buildNextSteps(s.overall, s.nextRequiredPhase, s.nextIsUnfinished, s.blockers)
    .forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
  lines.push('', 'This console creates nothing, decides nothing, and infers no human decision.');
  return lines;
}

const OUTCOME_HEADLINE: Readonly<Record<ConsoleOutcome, string>> = {
  AUDIT_CLOSED: 'the records are mutually consistent -- NOT that the promotion happened or was authorized',
  AUDIT_OPEN: 'consistent as far as it goes, and honestly unfinished. This is normal, not a defect',
  AUDIT_INVALID: 'something does not hang together. Do not proceed until it is resolved',
  NOT_ELIGIBLE: 'no genuine Phase 231 anchor, so nothing can be audited against anything',
};

// Split one intake value into "shaped like a chain report" and "not", so each gets the screen that fits it.
// Iterative with a visited set over arrays, so a pathologically nested or cyclic intake cannot overflow the
// stack or loop forever; anything that is not an array is classified where it stands.
function classify(root: unknown, chainShaped: unknown[], foreign: unknown[]): void {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      if (seen.has(value)) continue;
      seen.add(value);
      for (const v of value) stack.push(v);
      continue;
    }
    const id = asObject(value).report;
    if (typeof id === 'string' && KNOWN_CHAIN_REPORT_IDS.has(id)) chainShaped.push(value);
    else foreign.push(value);
  }
}

function count2(statuses: readonly ArtifactStatus[], status: ArtifactStatus): number {
  return statuses.filter((s) => s === status).length;
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
