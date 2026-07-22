// The one exact UTC timestamp rule for the promotion record chain (Phases 232-239).
//
// Every phase in the chain records a moment a human acted -- decidedAtUtc, observedAtUtc, reviewedAtUtc,
// closedAtUtc, committedAtUtc, verifiedAtUtc, occurredAtUtc -- and each phase used to carry its own private
// copy of the check. All seven copies were byte-identical and all seven were wrong the same way, so this is
// the single shared rule they now import. One definition, no drift: the same reasoning as re-running each
// phase's own exported validator rather than restating its semantics elsewhere.
//
// THE DEFECT THIS EXISTS TO CLOSE. The old check was:
//
//     /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && Number.isFinite(Date.parse(value))
//
// For an ISO-SHAPED string V8 NORMALISES out-of-range components instead of rejecting them, so `Date.parse`
// returns a perfectly finite instant for a date that never existed -- and the timestamp silently means a
// different moment than the one written:
//
//     2026-02-30T12:00:00Z  ->  accepted, meant 2026-03-02
//     2026-02-29T12:00:00Z  ->  accepted, meant 2026-03-01   (2026 is not a leap year)
//     2026-04-31T12:00:00Z  ->  accepted, meant 2026-05-01
//     2026-01-01T24:00:00Z  ->  accepted, meant the NEXT DAY at 00:00:00
//
// A record that pins WHEN a human acted must refuse a moment that never happened rather than quietly relocate
// it. Phase 239 additionally ORDERS events by this value, so a silently-moved timestamp there also reorders a
// custody narrative.
//
// THE RULE. Match the exact shape, range-check every component, then ROUND-TRIP through Date.UTC: if the
// constructed instant does not report back the same six components, the input named a moment that does not
// exist. This catches impossible days per real calendar month, 29 February in non-leap years, hour 24 and
// day 00 -- with no leap-year table to get wrong -- while still accepting genuine leap days, which a naive
// month-length table would wrongly reject.
//
// Years 0000-0099 are rejected as a side effect: Date.UTC maps a two-digit year into the 1900s, so the round
// trip fails. That is correct fail-closed behaviour here -- no record in this chain legitimately names one.
// Leap seconds (:60) are rejected too; this format cannot express them.
export function isExactUtcTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value);
  if (m === null) return false;
  const [year, month, day, hour, minute, second] =
    m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
    && utc.getUTCHours() === hour && utc.getUTCMinutes() === minute && utc.getUTCSeconds() === second;
}
