# Jellyfin Validation Evidence Report

Use this template for operator-run Jellyfin smoke validation. Keep it redaction-safe. Live Jellyfin
validation is manual/operator-run evidence and must not be required by CI or unattended automation.

Do not include raw media titles, provider ref values, Jellyfin item ids, collection ids, API keys,
tokens, correlation tokens, `[cat:<token>]` markers, secrets, credential file contents, screenshots
with media identity, or unredacted logs.

## Environment

- Date:
- Operator:
- Deployment type: Unraid / Docker Compose / other:
- Catalog Authority commit or build:
- Jellyfin version, if known:
- Validation mode: read-only / write-capable
- CI or automation used: no

## Command / Result Summary

- Command shape:
  - Read-only: `JELLYFIN_ENABLE_NETWORK=true npm run smoke:jellyfin -- <refType> <REDACTED>`
  - Write: `JELLYFIN_ENABLE_NETWORK=true JELLYFIN_ALLOW_LIVE_PUBLISH=true npm run smoke:jellyfin -- --write <refType> <REDACTED>`
- Ref type used:
- Ref value redacted: yes
- Secret values redacted: yes
- For write validation only:
  - `--write` intentionally used: yes / no / not applicable
  - `JELLYFIN_ALLOW_LIVE_PUBLISH=true` intentionally set: yes / no / not applicable
  - Mutating/destructive behavior acknowledged: yes / no / not applicable
- Exit code:
- Overall smoke result: OK / FAILED
- Redaction-safe smoke steps:
  - `find`:
  - `create`:
  - `find-by-token`:
  - `revoke`:
  - `verify-gone`:
- Counts or statuses reported by the smoke:

## Validation outcome

- Read-only outcome: passed / failed / not run
- Write-capable outcome: passed / failed / not run
- What this run proves without exposing identity:

## Cleanup outcome

- Cleanup status: not applicable / confirmed by `verify-gone` / manual cleanup confirmed / not confirmed
- Manual cleanup needed: yes / no
- Manual cleanup confirmation method, if any:

## Failures observed

- Pagination or incomplete traversal suspected: yes / no
- Token marker lookup failure suspected: yes / no
- Cleanup uncertainty after write validation: yes / no
- Revoke validation failure suspected: yes / no
- Redaction-safe notes:

## Review confirmation

- No raw titles included: yes / no
- No provider ref values included: yes / no
- No API keys, tokens, or secrets included: yes / no
- No Jellyfin item or collection ids included: yes / no
- No screenshots or logs with unredacted media identity included: yes / no
- Live Jellyfin validation was operator-run and not required by CI: yes / no
