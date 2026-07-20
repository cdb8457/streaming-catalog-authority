# Phase 230: Final No-Live Authorization Guard (local, non-live)

Report id: `phase-230-promotion-no-live-authorization-guard`

Status: `PHASE_230_PROMOTION_NO_LIVE_AUTHORIZATION_GUARD_READY`

The final backstop against a smuggled live authorization. Given a set of artifacts, any that **claims** a live
authorization fails closed — unless it is explicitly a PENDING human gate doc.

## What it flags

A **claim** is any of: an `authorization` / `status` / `overall` equal to `APPROVED`, `EXECUTE`, `LIVE_READY`,
`PHASE_231_AUTHORIZED`, or `GRANTED`; a truthy `approved` / `execute` / `liveReady` / `phase231Authorized` /
`liveAuthorized` flag; or one of those tokens appearing anywhere in the artifact body.

### Hard claim vs textual claim

- A **hard claim** — a forbidden token carried in the *subtree* of a claim field (`authorization`/`status`/
  `overall`) whether as a bare string, or wrapped in an array/object (e.g. `overall: ['LIVE_READY']`,
  `overall: { v: 'PHASE_231_AUTHORIZED' }`); a truthy claim flag; or an **object key** that reduces to a
  forbidden token with a truthy value — is detected **recursively at any nesting depth** and **never** exempt.
- A **textual claim** — a forbidden token appearing merely as a prose string elsewhere in the body — is the
  only thing a PENDING human gate may LIST as a pending step.

### Token matching (normalization-aware, false-positive-safe)

Each string (value **or object key**) is reduced to a **word-boundary** form — camelCase / digit boundaries
split (`LiveReady` → `live_ready`, `phase231Authorized` → `phase_231_authorized`), lower-cased,
non-alphanumerics collapsed to single `_`, trimmed — and to a **compact** form (all non-alphanumerics
stripped). So `APPROVED`, `approved`, `live_ready`, `live-ready`, `LIVE READY`, `LiveReady`, `LIVEREADY`,
`phase_231_authorized` and `phase-231-authorized` all reduce onto the canonical tokens.

- A token matches when the whole boundary form equals it, the whole compact form equals its compact form
  (catches separator-free camelCase), or — for **identifier-like strings** (no interior whitespace: enum
  values, flags, **object keys**, standalone list tokens) — the token appears at a `_`-delimited **word
  boundary**, so affixed variants like `APPROVED_FOR_LIVE` also fail closed. The `_`-delimited boundary means
  `unapproved` and `local_review_authorized` do **not** match `approved`.
- **Prose strings** (any interior whitespace — sentences) only ever match on the two **whole-string** forms;
  the word-boundary affix rule is identifier-only. This is a deliberate **exact-token policy for prose**: it
  keeps `LOCAL_REVIEW_AUTHORIZED` and negative prose such as "Phase 231 authorization is NOT granted" from
  false-positiving (a sentence never equals a token, and `granted` inside "NOT granted" is not matched as a
  word). The bare word `AUTHORIZED` is deliberately **not** a token — only `PHASE_231_AUTHORIZED` as a whole
  token.
- **Object keys**: a key that reduces to a forbidden token with a *truthy* value is a hard claim
  (`{ live_ready: true }`, `{ approved_for_live: {...} }`, `{ LiveReady: 1 }`). A forbidden-token key set to a
  *falsy* value (e.g. `approved: false`) is not a claim. Scoped by the same word-boundary rule, so unrelated
  review fields (`reviewAuthorization`, `localReviewAuthorized`, `unapproved`) are not flagged.

An artifact that makes a claim is a `LIVE_AUTHORIZATION_CLAIMED` violation **unless** it is an explicit PENDING
human gate doc — `humanGate: true`, `status: 'PENDING'`, `authorization` in `NONE`/`PENDING` — which may LIST
those tokens (including variants) as pending future steps. A hard claim inside such a doc still fails closed.
`NO_ARTIFACTS` guards an empty set. `overall` is `NO_LIVE_AUTHORIZATION_CLEAN` only when no artifact claims a
live authorization.

It reads parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts
Jellyfin, and echoes only report short-names and booleans — never the offending value. A CLEAN result is not
an approval and does not authorize Phase 231.

## Files

- `src/ops/promotion-no-live-authorization-guard.ts` — `buildNoLiveAuthorizationGuard(input)`.
- `src/ops/promotion-no-live-authorization-guard-cli.ts` — CLI wrapper.
- `test/promotion-no-live-authorization-guard.ts` — clean; violated on
  APPROVED/EXECUTE/LIVE_READY/PHASE_231_AUTHORIZED claims; a PENDING gate doc listing the tokens is exempt
  (but an actual authorization claim is not); hard claims (top-level and nested) cannot be smuggled inside a
  human gate; a **case/separator/affix variant corpus** (`approved_for_live`, `phase-231-authorized`,
  `live-ready`, `Live Ready`, `ExEcUtE`, …) fails closed; **false-positive corpus** (`LOCAL_REVIEW_AUTHORIZED`,
  "Phase 231 authorization is NOT granted", "…not been approved…") stays clean; no artifacts; and a spawned
  CLI run. Negative-evidence-corpus samples also exercise the guard. The variant/false-positive corpus is the
  trace the coordinator can run during final review via
  `npm run test:promotion-no-live-authorization-guard`.

## Usage

```
npm run ops:promotion-no-live-authorization-guard -- --artifacts artifacts.json [--out report.json]
```

Exit `0` = `NO_LIVE_AUTHORIZATION_CLEAN`, `1` = `NO_LIVE_AUTHORIZATION_VIOLATED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
