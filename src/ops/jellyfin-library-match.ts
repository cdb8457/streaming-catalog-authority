import type { CatalogAuthority } from '../core/catalog/authority.js';
import type { PublishableField } from '../core/adapters/publisher.js';
import type { CollectionTarget } from '../core/publish/collection-outbox.js';
import type { CatalogReader } from './operator-ui-catalog-browse.js';
import { COLLECTION_PLAN_TARGET, canonical, digest } from './collection-plan.js';

// Phase 275 — the missing answer to "which of my records does my media server actually have?"
//
// WHAT WAS MISSING. Phase 266 could say how many libraries and collections a server has. Phase 269 could plan
// a collection and report a record as `blocked` when it had no reference. Neither could tell an operator the
// one thing they ask first: of the records I imported, which ones will be found over there, which will not,
// and which cannot be judged. Until now the only way to learn that was to plan a collection — which means
// naming one, and being one confirmation away from writing to somebody's media server just to ask a question.
//
// -----------------------------------------------------------------------------------------------------
// IT IS A READ, AND EVERY GATE THAT MAKES IT A READ IS STRUCTURAL.
// -----------------------------------------------------------------------------------------------------
//
// ONE SWITCH, NOT FOUR. It runs on `JELLYFIN_ENABLE_NETWORK` alone — the same single switch Phase 266's
// discovery and Phase 271's audit need — because requiring the write switches for a read would mean an
// operator has to turn WRITING ON to find out whether anything would be found. The other three switches are
// REPORTED, so a report says what state the installation was in when it was taken, and the suite asserts they
// were closed.
//
// THE TARGET IT IS GIVEN CANNOT WRITE. `createCollectionAuditRuntime` hands back a `CollectionTarget` whose
// `create`, `addMembers`, `removeMembers` and `remove` methods THROW. This function calls exactly one method
// on it — `resolve` — and holds no pool writer, no outbox, no ledger and no history store. "It wrote nothing"
// is a fact about what it was handed.
//
// PROVIDER IDENTITY GOES NOWHERE. Matching is LOCAL, exactly as it has been since Phase 11: the candidate
// listing is fetched with its `ProviderIds` and compared HERE. A reference value never becomes a query
// parameter, a path segment, a header or a search term. The suite asserts that against the request lines the
// fake server actually RECEIVED, because only those can show what was transmitted — a claim checked against
// the responses this product produced would prove nothing about the wire.
//
// EVERY RESOLUTION RUNS INSIDE `withPublishableIdentity`. A forgotten or shredded record resolves to nothing
// and is reported `unreadable`, never decrypted, and never counted as "not in your library".
//
// -----------------------------------------------------------------------------------------------------
// UNKNOWN IS A VERDICT, AND IT IS THE POINT.
// -----------------------------------------------------------------------------------------------------
//
// A record is only `unmatched` when the library scan was COMPLETE and the record's references matched nothing
// in it. A scan that threw, and a scan that hit its page bound, both mean this pass does not know what the
// library holds — so every record it would have judged becomes `unknown` instead. Reporting "your media
// server does not have these" from a listing that stopped early is exactly the shape of false proof this
// product refuses elsewhere (Phase 270's removals, Phase 271's audit), and a report is not exempt from it
// merely because it writes nothing: an operator acts on a report.
//
// -----------------------------------------------------------------------------------------------------
// WHAT IT WILL NOT PRINT.
// -----------------------------------------------------------------------------------------------------
//
// No title. No year. No provider reference value. No Jellyfin item id, not even a digest of one — a per-record
// count is enough to answer the question, and a stable fingerprint of a library id is a correlatable handle
// this report has no use for. No server address, no api key, no external handle, no correlation token, and
// nothing from an acquisition system, which this product does not hold in the first place. What it carries is
// the opaque catalog record id the operator already holds, a closed-set verdict, a bounded count, and the
// reference TYPES — which are a closed set of six words and identify nothing.

export const LIBRARY_MATCH_REPORT = 'phase-275-jellyfin-library-match';
export const LIBRARY_MATCH_VERSION = 1;

/** How many catalog records one report examines. A bound, and a truncated report says so. */
export const LIBRARY_MATCH_MAX_RECORDS = 1000;
/** How many records are read from the catalog in one page. */
export const LIBRARY_MATCH_PAGE = 200;

export type MatchOutcome =
  /** The library holds at least one item carrying one of this record's references. */
  | 'matched'
  /** The scan was complete, the record has references, and none of them is in the library. */
  | 'unmatched'
  /** The record carries no provider reference, so there is nothing to match it BY. Not an absence. */
  | 'no-references'
  /** Forgotten, shredded, or otherwise not disclosable. Never decrypted, never judged. */
  | 'unreadable'
  /** This pass could not see enough to say. Never reported as an absence. */
  | 'unknown';

export type MatchReason =
  | 'FOUND_IN_LIBRARY'
  | 'NOT_IN_LIBRARY'
  | 'NO_PROVIDER_REFS'
  | 'RECORD_NOT_DISCLOSABLE'
  | 'SCAN_FAILED'
  | 'SCAN_TRUNCATED';

export interface LibraryMatchFinding {
  /** The opaque catalog record id. The only identifier in this report, and one the operator already holds. */
  readonly itemId: string;
  readonly outcome: MatchOutcome;
  readonly reason: MatchReason;
  /** How many library items this record's references matched. Null when nothing could be judged. */
  readonly matches: number | null;
  /** The closed-set reference TYPES this record carries. Never a value. */
  readonly refTypes: readonly string[];
}

export interface LibraryMatchCounts {
  readonly examined: number;
  readonly matched: number;
  readonly unmatched: number;
  readonly noReferences: number;
  readonly unreadable: number;
  readonly unknown: number;
}

export interface LibraryMatchGates {
  /** The one switch this report needs. Always true in a report that exists. */
  readonly networkEnabled: true;
  /** The three write switches, as they were. A report is expected to be taken with all of them closed. */
  readonly collectionWritesEnabled: boolean;
  readonly livePublishEnabled: boolean;
  readonly externalIdentityAllowed: boolean;
}

export interface LibraryMatchReport {
  readonly report: typeof LIBRARY_MATCH_REPORT;
  readonly version: typeof LIBRARY_MATCH_VERSION;
  readonly target: typeof COLLECTION_PLAN_TARGET;
  /** What this pass did to durable state and to the media server. Both are the same word, deliberately. */
  readonly wrote: 'nothing';
  readonly contacted: 'read-only library listing';
  /**
   * Whether the library was consulted AT ALL.
   *
   * It is false when every record examined had no provider reference — nothing was asked, so `libraryComplete`
   * below would be vacuously true and could be read as "your library was successfully listed". It was not.
   */
  readonly libraryRead: boolean;
  /** False when the library listing hit its page bound or failed. Never silently true. */
  readonly libraryComplete: boolean;
  /** True when the catalog holds more records than this report examined. */
  readonly truncated: boolean;
  readonly counts: LibraryMatchCounts;
  readonly findings: readonly LibraryMatchFinding[];
  readonly gates: LibraryMatchGates;
  /** A digest over the findings, so two reports of the same state are comparable without diffing content. */
  readonly reportDigest: string;
  readonly guidance: string;
}

export interface LibraryMatchDeps {
  readonly reader: CatalogReader;
  readonly authority: Pick<CatalogAuthority, 'withPublishableIdentity'>;
  /** The READ-ONLY target from `createCollectionAuditRuntime`. Only `resolve` is ever called on it. */
  readonly target: CollectionTarget;
  readonly requires: readonly PublishableField[];
  readonly gates: Omit<LibraryMatchGates, 'networkEnabled'>;
  /** How many records to examine. Clamped to {@link LIBRARY_MATCH_MAX_RECORDS}. */
  readonly limit?: number;
}

/**
 * Compare every readable catalog record with the media server's library, and write nothing.
 *
 * ONE LIBRARY SNAPSHOT FOR THE WHOLE PASS. `beginPass()` clears the target's cached candidate listing and the
 * first `resolve` takes a fresh one; every record is then judged against the SAME view. Without that, a
 * library scan finishing mid-report would make one record matched and the next one not, for no reason an
 * operator could see — and the report would not be reproducible from the same state.
 */
export async function matchCatalogToLibrary(deps: LibraryMatchDeps): Promise<LibraryMatchReport> {
  deps.target.beginPass?.();
  const limit = clamp(deps.limit ?? LIBRARY_MATCH_MAX_RECORDS, 1, LIBRARY_MATCH_MAX_RECORDS);

  const ids: string[] = [];
  let truncated = false;
  for (let offset = 0; offset < limit; offset += LIBRARY_MATCH_PAGE) {
    const page = await deps.reader.listActiveIds(Math.min(LIBRARY_MATCH_PAGE, limit - offset), offset);
    ids.push(...page);
    if (page.length < Math.min(LIBRARY_MATCH_PAGE, limit - offset)) break;
  }
  if (ids.length >= limit) {
    // One more than the bound would have been read: if there IS one, the catalog is bigger than this report.
    const probe = await deps.reader.listActiveIds(1, limit);
    truncated = probe.length > 0;
  }

  const findings: LibraryMatchFinding[] = [];
  let libraryComplete = true;
  let libraryRead = false;
  for (const itemId of ids) {
    findings.push(await matchOne(deps, itemId, (attempted, complete) => {
      if (attempted) libraryRead = true;
      if (!complete) libraryComplete = false;
    }));
  }
  // A TOTAL order that does not depend on what the catalog happened to return first, so two reports over the
  // same state are the same document with the same digest.
  findings.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

  const counts: LibraryMatchCounts = {
    examined: findings.length,
    matched: findings.filter((f) => f.outcome === 'matched').length,
    unmatched: findings.filter((f) => f.outcome === 'unmatched').length,
    noReferences: findings.filter((f) => f.outcome === 'no-references').length,
    unreadable: findings.filter((f) => f.outcome === 'unreadable').length,
    unknown: findings.filter((f) => f.outcome === 'unknown').length,
  };

  const gates: LibraryMatchGates = { networkEnabled: true, ...deps.gates };
  return {
    report: LIBRARY_MATCH_REPORT,
    version: LIBRARY_MATCH_VERSION,
    target: COLLECTION_PLAN_TARGET,
    wrote: 'nothing',
    contacted: 'read-only library listing',
    libraryRead,
    libraryComplete,
    truncated,
    counts,
    findings,
    gates,
    reportDigest: digest('library-match', canonical({
      version: LIBRARY_MATCH_VERSION,
      target: COLLECTION_PLAN_TARGET,
      libraryRead,
      libraryComplete,
      truncated,
      findings: findings.map((f) => canonical({
        itemId: f.itemId, outcome: f.outcome, reason: f.reason, matches: f.matches, refTypes: [...f.refTypes],
      })),
    })),
    guidance: matchGuidance(counts, libraryRead, libraryComplete, truncated, gates),
  };
}

/**
 * One record.
 *
 * THE ORDER OF THE ANSWERS IS THE ORDER OF THEIR CERTAINTY. Not disclosable comes first, because a forgotten
 * record must never be decrypted or judged. No references comes next, because a record with nothing to match
 * by is not a record the library is missing. Only then is the library consulted, and a scan that could not be
 * vouched for ends the record as `unknown` rather than as an absence.
 */
async function matchOne(
  deps: LibraryMatchDeps,
  itemId: string,
  /** `attempted` — the library was consulted for this record; `complete` — and the answer can be trusted. */
  note: (attempted: boolean, complete: boolean) => void,
): Promise<LibraryMatchFinding> {
  let outcome: MatchOutcome = 'unknown';
  let reason: MatchReason = 'SCAN_FAILED';
  let matches: number | null = null;
  let refTypes: string[] = [];

  let resolved: { readonly outcome: MatchOutcome; readonly reason: MatchReason; readonly matches: number | null; readonly refTypes: string[] } | null;
  try {
    resolved = await deps.authority.withPublishableIdentity(itemId, deps.requires, async (identity) => {
      const refs = identity.providerRefs ?? [];
      // The TYPES are captured here, inside the disclosure scope, and the VALUES are not retained past the
      // `resolve` call below. Nothing outside this closure ever holds a reference value.
      const types = [...new Set(refs.map((ref) => ref.type))].sort();
      if (refs.length === 0) {
        return { outcome: 'no-references' as const, reason: 'NO_PROVIDER_REFS' as const, matches: null, refTypes: types };
      }
      note(true, true); // the library IS being consulted for this record, whatever the answer turns out to be
      const found = await deps.target.resolve(refs);
      if (found.truncated) {
        // The scan did not see the whole library. "Not found" is therefore not a statement about the library,
        // and this record is not judged at all.
        return { outcome: 'unknown' as const, reason: 'SCAN_TRUNCATED' as const, matches: null, refTypes: types };
      }
      return found.ids.length > 0
        ? { outcome: 'matched' as const, reason: 'FOUND_IN_LIBRARY' as const, matches: found.ids.length, refTypes: types }
        : { outcome: 'unmatched' as const, reason: 'NOT_IN_LIBRARY' as const, matches: 0, refTypes: types };
    });
  } catch {
    // The listing failed. Reported as unknown for this record, and the whole report says the library was not
    // completely read. `attempted` is true: a read that FAILED is still a read that happened, and reporting
    // otherwise would let "the server was down" look like "nothing needed asking".
    note(true, false);
    return { itemId, outcome: 'unknown', reason: 'SCAN_FAILED', matches: null, refTypes: [] };
  }

  if (resolved === null) {
    // FAIL-CLOSED DISCLOSURE. The record is forgotten, shredded, or its key lineage is not active. It is not
    // "missing from your library" — it is a record this product will not describe at all.
    return { itemId, outcome: 'unreadable', reason: 'RECORD_NOT_DISCLOSABLE', matches: null, refTypes: [] };
  }
  ({ outcome, reason, matches, refTypes } = resolved);
  if (reason === 'SCAN_TRUNCATED') note(true, false);
  return { itemId, outcome, reason, matches, refTypes };
}

function matchGuidance(
  counts: LibraryMatchCounts,
  libraryRead: boolean,
  libraryComplete: boolean,
  truncated: boolean,
  gates: LibraryMatchGates,
): string {
  const parts: string[] = [];
  if (counts.examined === 0) {
    parts.push('This installation holds no readable catalog records, so there is nothing to compare with your library.');
  } else {
    parts.push(`${counts.examined} record(s) compared with your media server's library: ${counts.matched} would `
      + `be found, ${counts.unmatched} would not, ${counts.noReferences} carry no provider reference to match `
      + `by, ${counts.unreadable} are not disclosable, and ${counts.unknown} could not be judged. Nothing was `
      + 'changed: this is a read.');
  }
  if (!libraryComplete) {
    parts.push('The library listing did not complete, so no record was reported as absent on the strength of it. '
      + '"I could not see it" is not "it is not there".');
  } else if (!libraryRead && counts.examined > 0) {
    // Said out loud, because a report whose every record had nothing to match by consulted the media server
    // ZERO times — and "the library read completed" would otherwise be a true sentence that reads as proof
    // the server was reachable.
    parts.push('Your media server was not consulted at all: no record examined carries a provider reference, '
      + 'so there was nothing to look one up by. This report says nothing about whether your server is reachable.');
  }
  if (counts.noReferences > 0) {
    parts.push('A record with no provider reference cannot be matched to a library item at all — that is a '
      + 'property of the record, not a statement about your library.');
  }
  if (truncated) {
    parts.push(`Only the first ${LIBRARY_MATCH_MAX_RECORDS} catalog records were examined.`);
  }
  if (!gates.collectionWritesEnabled && !gates.livePublishEnabled && !gates.externalIdentityAllowed) {
    parts.push('Every collection write switch was closed while this ran, and this command has no write path in it '
      + 'whatever they say.');
  }
  return parts.join(' ');
}

/**
 * The human summary.
 *
 * OPAQUE RECORD IDS, CLOSED-SET WORDS AND COUNTS. This goes to scrollback, to a CI log and to a support
 * bundle somebody pastes into an issue, so it is held to the command line's stricter standard exactly as the
 * collection CLI is: no title, no year, no reference value, no Jellyfin id, no address.
 */
export function renderLibraryMatch(report: LibraryMatchReport): string {
  const lines: string[] = [];
  lines.push(`library match: ${report.target}   (read-only — nothing was changed, on either side)`);
  lines.push(`  ${Object.entries(report.counts).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  lines.push(`  library consulted       ${report.libraryRead}`);
  lines.push(`  library read complete   ${report.libraryComplete}`);
  lines.push(`  catalog truncated       ${report.truncated}`);
  lines.push(`  write switches          collectionWrites=${report.gates.collectionWritesEnabled} `
    + `livePublish=${report.gates.livePublishEnabled} externalIdentity=${report.gates.externalIdentityAllowed}`);
  lines.push(`  report digest           ${report.reportDigest}`);
  lines.push('');
  lines.push('  records (opaque ids only — no title, reference value or media-server id is ever printed):');
  for (const finding of report.findings) {
    lines.push(`    ${finding.itemId}  ${finding.outcome.padEnd(13)} ${finding.reason.padEnd(22)} `
      + `matches=${finding.matches ?? '?'} refTypes=${finding.refTypes.length === 0 ? '-' : finding.refTypes.join(',')}`);
  }
  lines.push('');
  lines.push(`  ${report.guidance}`);
  return lines.join('\n');
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return max;
  return Math.max(min, Math.min(max, value));
}
