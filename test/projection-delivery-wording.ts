import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// THE ONE RULE ABOUT WHAT G18 AND G22 MAY SAY THEY MEASURED, shared by both offline suites.
//
// WHY IT EXISTS. Both gates count bytes twice: the COMMITTED payload length a response undertook to write,
// and the count the handler's `Write` call RETURNED. Neither is a delivery figure. `Write`'s return says the
// bytes were accepted by the HTTP stack — it is not proof of peer receipt, not a TCP acknowledgement, not the
// exact byte count on the wire, and not provider billing.
//
// WHY IT IS EXECUTABLE RATHER THAN A CONVENTION. This wording has now been corrected THREE times. A committed
// counter was reported as "served"; the correction then said "put on the socket" and "actually written"; a
// comparison of an observed column against another instrument's committed one was published as "delivered".
// Each round fixed the sentences somebody looked at and left the ones they did not. A prose rule that is not
// executed is a prose rule that comes back.
//
// WHAT IT DELIBERATELY PERMITS. History. This repository keeps its retractions, and a retraction has to be
// able to QUOTE the claim it withdraws. So a line that marks itself as historical, and a line where the
// phrase is NEGATED, both pass — and the suites prove that escape works rather than trusting it, by asserting
// that specific known-historical lines are exempt AND that a synthetic current-tense line is caught.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Read a repository file for scanning. Exported so a suite can point the rule at its own file list. */
export function readForWordingScan(relative: string): string {
  return readFileSync(join(repoRoot, relative), 'utf8');
}

/**
 * The claims neither gate may make in the present tense.
 *
 * Each entry is a phrase and the reason it is wrong, because a failure that only says "forbidden phrase"
 * sends the reader back here to work out why.
 */
export const DELIVERY_OVERSTATEMENTS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/actually wrote/i, 'says the endpoint wrote bytes; what it has is the count Write returned'],
  [/actually written/i, 'says bytes were written; what it has is the count Write returned'],
  [/put on the socket/i, 'claims bytes reached a socket, which Write\'s return does not establish'],
  [/onto the socket/i, 'claims bytes reached a socket, which Write\'s return does not establish'],
  [/wrote to the socket/i, 'claims bytes reached a socket, which Write\'s return does not establish'],
  [/left the endpoint's control/i, 'a committed payload length does not prove any byte left anything'],
  [/delivered traffic/i, 'calls the observed column delivery'],
  [/ends up receiving/i, 'claims the peer received bytes'],
  [/the client received/i, 'claims the peer received bytes'],
  [/what a provider would transfer/i, 'claims a provider transfer, which nothing here measures'],
  [/provider billing/i, 'billing is a commercial artefact, not a byte count'],
  [/peer receipt/i, 'nothing here observes peer receipt'],
  [/TCP acknowledgement/i, 'nothing here reads the transport\'s accounting'],
  [/exact wire bytes/i, 'framing, headers and any TLS overhead are outside every counter here'],
]);

/**
 * A line that declares itself historical may say anything, because a retraction has to quote what it retracts.
 *
 * THE MARKERS ARE DELIBERATELY EXPLICIT. "It used to say", "an earlier version", "RETRACTED" — each one is a
 * sentence the author had to write on purpose. Prose that describes what was once true and forgets to say so
 * fails this rule, and the fix is to say so rather than to delete the history.
 */
export const HISTORICAL_MARKERS: readonly RegExp[] = Object.freeze([
  /\bused to\b/i, /\ban earlier\b/i, /\bearlier version\b/i, /\bRETRACT/i, /\bwithdraw/i,
  /\bno longer\b/i, /\bpreviously\b/i, /\bonce let\b/i, /\bfor one release\b/i, /\bfirst said\b/i,
  /\bit read:/i, /\bhistorical\b/i, /\bwas not supported\b/i, /\bthis document no longer\b/i,
  /\bthe defect this\b/i, /\bwhich shipped\b/i, /\bhad the same shape\b/i, /\bwas and remains\b/i,
]);

/**
 * THE RULE READS SENTENCES, NOT RAW LINES, AND ITS FIRST VERSION DID NOT.
 *
 * Prose here is hard-wrapped at a hundred and ten columns and comments are wrapped by the same hand, so the
 * word that negates a phrase is very often on the line ABOVE it — "…not a TCP acknowledgement, not" / "exact
 * wire bytes, not billing". A per-line classifier called seven such nonclaims violations, including the very
 * sentences these gates are required to carry. So the negation window spans the wrap, and the historical
 * marker is looked for across the surrounding paragraph rather than the one line the claim landed on.
 */
const NEGATION_WINDOW = 90;
const NEGATOR = /\b(not|never|neither|nor|no|without|refus\w*|deny|denies|cannot|isn't)\b/i;
/** Words that repudiate a phrase AFTER it, which is how a retraction names the thing it is withdrawing. */
const REPUDIATION_WINDOW = 90;
const REPUDIATION = /\b(are all wrong|is wrong|are wrong|withdraw\w*|retract\w*|both halves)\b/i;
/** How many lines either side of a claim count as its paragraph, for the historical marker only. */
const PARAGRAPH_RADIUS = 3;

const collapse = (text: string): string => text.replace(/\s+/g, ' ');

/**
 * Every current-tense delivery overstatement in one file, as human-readable findings.
 *
 * IT RETURNS FINDINGS RATHER THAN A BOOLEAN so a failure names the file, the line and the reason. A rule that
 * printed `false` would cost a reader the whole file to interpret.
 */
export function deliveryOverstatements(source: string, label: string): string[] {
  const findings: string[] = [];
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    // THE HISTORICAL ESCAPE IS PARAGRAPH-SCOPED. A retraction's marker is its heading or its opening
    // sentence; the claim it quotes lands a line or two later. Scoping the marker to the claim's own line
    // would forbid a retraction from naming what it retracts.
    const paragraph = collapse(lines
      .slice(Math.max(0, index - PARAGRAPH_RADIUS), index + PARAGRAPH_RADIUS + 1).join(' '));
    if (HISTORICAL_MARKERS.some((marker) => marker.test(paragraph))) return;

    // The negation and repudiation windows are SENTENCE-scoped: the wrapped line before, this line, and the
    // wrapped line after, so a negator split across a wrap still reads as one clause.
    const previous = collapse(lines[index - 1] ?? '');
    const next = collapse(lines[index + 1] ?? '');
    for (const [pattern, why] of DELIVERY_OVERSTATEMENTS) {
      const match = pattern.exec(line);
      if (match === null) continue;
      // A NEGATED PHRASE IS THE OPPOSITE CLAIM AND IS ALWAYS ALLOWED. "not peer receipt" is the nonclaim
      // these gates are required to carry; flagging it would forbid the very sentence that fixes the problem.
      const before = `${previous} ${collapse(line.slice(0, match.index))}`;
      if (NEGATOR.test(before.slice(-NEGATION_WINDOW))) continue;
      const after = `${collapse(line.slice(match.index + match[0].length))} ${next}`;
      if (REPUDIATION.test(after.slice(0, REPUDIATION_WINDOW))) continue;
      findings.push(`${label}:${index + 1}: "${match[0]}" — ${why}\n      ${line.trim().slice(0, 150)}`);
    }
  });
  return findings;
}

// THE TWO SUITES THEMSELVES ARE DELIBERATELY NOT IN EITHER LIST, and this is the one exclusion worth stating
// rather than leaving to be rediscovered. A test that proves the rule FIRES has to contain the forbidden
// phrases as fixtures — "the endpoint actually wrote 12 bytes to the socket" is the input, not a claim — so a
// rule that scanned its own prover would forbid the proof. Everything those suites assert ABOUT the product
// surfaces is covered, because the surfaces are.

/** The G18 surfaces this rule covers: the product endpoint, its telemetry, its driver, its gate, its doc. */
export const G18_WORDING_FILES: readonly string[] = Object.freeze([
  'projectiond/internal/fakeprovider/fakeprovider.go',
  'src/core/projection/three-server-concurrency.ts',
  'src/ops/projection-three-server-concurrency.ts',
  'src/ops/projection-three-server-concurrency-cli.ts',
  'deploy/projection-three-server-concurrency-gate.sh',
  'deploy/projection-three-server-concurrency-gate-three.sh',
  'deploy/projection-three-server-concurrency-gate-optional.sh',
  'docs/PROJECTION_PHASE_1_THREE_SERVER_CONCURRENCY.md',
]);

/** The G22 surfaces: the comparison endpoint, its gate tool, its rules, its driver, its gate, its doc. */
export const G22_WORDING_FILES: readonly string[] = Object.freeze([
  'projectiond/internal/fakewebdav/fakewebdav.go',
  'projectiond/cmd/fakewebdav/main.go',
  'src/core/projection/rclone-comparison.ts',
  'src/ops/projection-rclone-comparison.ts',
  'src/ops/projection-rclone-comparison-cli.ts',
  'deploy/projection-rclone-comparison-gate.sh',
  'deploy/projection-rclone-comparison-gate-three.sh',
  'deploy/projection-rclone-comparison-gate-optional.sh',
  'docs/PROJECTION_PHASE_1_RCLONE_COMPARISON.md',
]);
