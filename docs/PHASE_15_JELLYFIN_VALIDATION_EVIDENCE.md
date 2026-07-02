# Phase 15 - Jellyfin Validation Operations Evidence

Phase 15 makes real Jellyfin smoke validation repeatable and reviewable without adding product
behavior. Live Jellyfin validation remains an operator-run activity. It must not be required by CI,
release automation, unattended health checks, or any automated test path.

Use this document with:

- `docs/PHASE_13_JELLYFIN_VALIDATION.md` for the smoke path and endpoint mapping.
- `docs/PHASE_14_JELLYFIN_HARDENING.md` for pagination behavior and remaining real-server caveats.
- `docs/templates/JELLYFIN_VALIDATION_EVIDENCE.md` for the redaction-safe report format.

## Evidence rules

Evidence is safe to share only when it avoids direct content identity and credentials. Reports must
not include:

- Jellyfin API keys, tokens, session values, cookies, or credential file contents.
- Correlation tokens, `[cat:<token>]` markers, raw media titles, collection names, provider ref
  values, Jellyfin item ids, or collection ids.
- Screenshots or log excerpts that show unredacted user media identity.
- Full command environments, shell history, `.env` files, or secret mount paths that reveal secrets.

Expected successful evidence is limited to:

- Environment shape: deployment type, Jellyfin version if known, catalog build/commit, and whether the
  run was read-only or write-capable.
- Command shape: the command family and flags used, with ref values and secret locations redacted.
- Result summary: exit code plus redaction-safe `OK`/`FAIL` smoke steps, counts, and statuses.
- Cleanup outcome for write validation.
- Any failures observed, with triage notes and no raw identifiers.

## Read-only validation

Read-only validation checks live connectivity, authentication, base URL handling, and the Jellyfin
find mapping. It does not create, change, or delete Jellyfin data.

Operator command shape:

```bash
JELLYFIN_ENABLE_NETWORK=true npm run smoke:jellyfin -- <refType> <refValue>
```

Evidence to record:

- Mode: `read-only`.
- Exit code.
- Ref type only. Redact the ref value.
- Smoke lines for the `find` step.
- Matched count if reported.

A successful read-only run proves that the operator can reach the server and that the find mapping
can traverse the library for that reference. It does not prove live publishing, create, token lookup,
revoke, or cleanup behavior.

## Write-capable validation

Write-capable validation is destructive or mutating unless the smoke can clean up everything it
created. It creates a token-tagged Jellyfin collection, looks it up, deletes it, and verifies that it
is gone. Run it only against a server where the operator accepts that a cleanup failure may require
manual removal in Jellyfin.

Write validation must remain intentionally gated by both:

- An explicit operator action: the `--write` CLI flag.
- The live publish environment gate: `JELLYFIN_ALLOW_LIVE_PUBLISH=true`.

The real-network gate is also required:

```bash
JELLYFIN_ENABLE_NETWORK=true JELLYFIN_ALLOW_LIVE_PUBLISH=true \
  npm run smoke:jellyfin -- --write <refType> <refValue>
```

Evidence to record:

- Mode: `write`.
- Confirmation that both `--write` and `JELLYFIN_ALLOW_LIVE_PUBLISH=true` were intentionally used.
- Exit code.
- Ref type only. Redact the ref value.
- Redaction-safe smoke lines for `find`, `create`, `find-by-token`, `revoke`, and `verify-gone`.
- Cleanup outcome. For success, `verify-gone` must be `OK`.

A successful write run is the evidence that this Jellyfin server supports the current provisional
mapping for find, create, token lookup, revoke, cleanup, and duplicate avoidance. If cleanup cannot
be confirmed, treat the run as failed until an operator confirms and documents manual cleanup.

## Triage guidance

### Pagination or incomplete traversal

Symptoms:

- Read-only `find` returns zero or fewer matches than expected.
- A known collection or item exists in Jellyfin but the smoke cannot find it.
- Results differ between small and large libraries.

Actions:

- Confirm the run used the current Phase 14+ build that walks paginated `/Items` responses with
  `StartIndex` and `Limit`.
- Re-run read-only validation with a reference for a known library item and record only the ref type
  and matched count.
- Check for server-side permission or library-scope limits on the API key; do not paste item titles
  or raw ids into the report.
- If the failure persists, report it as a mapping/traversal failure with the smoke step, status, and
  redacted count evidence.

### Token marker lookup failure

Symptoms:

- `create` succeeds but `find-by-token` fails.
- `find-by-token` returns nothing.
- `find-by-token` returns a different opaque handle.

Actions:

- Treat the write run as failed even if later cleanup succeeds.
- Confirm the collection name marker was expected to be preserved by Jellyfin, but do not paste the
  collection name, correlation token, or marker token into the evidence report.
- Record whether `revoke` and `verify-gone` succeeded after the lookup failure.
- If cleanup is confirmed, no manual Jellyfin action is required. If cleanup is not confirmed, follow
  the cleanup uncertainty path below.

### Cleanup uncertainty after write validation

Symptoms:

- `verify-gone` fails.
- The report says `CLEANUP NOT CONFIRMED`.
- The create call failed ambiguously and token-based cleanup could not prove that no collection
  remains.

Actions:

- Treat the write run as failed.
- Do not re-run write validation repeatedly until the possible leftover collection is resolved.
- Inspect Jellyfin manually using operator access and remove only the collection created by the smoke.
  Do not record raw collection names, ids, or user media titles in the evidence.
- In the report, mark cleanup outcome as `manual cleanup required` or `manual cleanup confirmed`, and
  record the confirmation method without identifiers.

### Revoke validation failure

Symptoms:

- The `revoke` step fails.
- Delete returns an unexpected failure or permission error.
- `verify-gone` cannot run because deletion failed.

Actions:

- Treat the write run as failed and assume the collection may still exist until proven otherwise.
- Check that the Jellyfin API key used for write validation has deletion permission for the created
  collection.
- Complete manual cleanup in Jellyfin before any follow-up write run.
- Record the failure as a revoke/delete permission or endpoint failure using only the smoke step,
  HTTP status if shown by the smoke, and cleanup outcome.

## Review checklist

Before sharing evidence, confirm:

- The report uses `docs/templates/JELLYFIN_VALIDATION_EVIDENCE.md`.
- Ref values, raw titles, provider refs, API keys, tokens, collection ids, item ids, and screenshots
  with media identity are absent.
- Read-only and write-capable results are clearly separated.
- Write validation states whether `--write` and `JELLYFIN_ALLOW_LIVE_PUBLISH=true` were used.
- Cleanup is explicitly marked as confirmed, not applicable, or not confirmed.
- Live Jellyfin validation was run manually by an operator and was not added to CI.

## Out of scope

No product behavior changes, provider integrations, Real-Debrid, TorBox, Plex, playback, scraping,
downloading, metadata-provider behavior, web UI, mobile UI, live-network CI, secret storage changes,
encryption changes, key-management changes, or crypto-shredding changes.
