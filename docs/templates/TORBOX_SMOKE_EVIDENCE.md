# TorBox Smoke Evidence Template

Use this template only for a future separately authorized, operator-run, read-only TorBox smoke.
Do not use it in CI. Do not attach private debug notes to this evidence artifact.

## Build

- Catalog Authority commit or build id:
- Smoke evidence document date:
- Operator environment label:

## Read-Only Confirmation

- Smoke mode confirmed read-only: yes / no
- Live transport came from a separately authorized phase: yes / no
- Execution was outside CI: yes / no
- No provider write, create, link, permalink, CDN, user, control, delete, export, download, or
  playback operation was attempted: yes / no

## Explicit Gates Checked

| Gate | Status | Notes |
|---|---|---|
| Separate live-smoke authorization exists | pass / fail / not-run | |
| Real transport was injected by the authorized phase | pass / fail / not-run | |
| Secret indirection used without recording secret values or paths | pass / fail / not-run | |
| Bounded timeout configured | pass / fail / not-run | |
| Fail-closed categories configured | pass / fail / not-run | |
| Redaction review completed before sharing | pass / fail / not-run | |

## Probe Summary

| Probe | Attempted count | Success count | Unknown count | Failure count | Status |
|---|---:|---:|---:|---:|---|
| Service status | | | | | pass / fail / not-run |
| Hoster metadata | | | | | pass / fail / not-run |
| Cache availability | | | | | pass / fail / not-run |

Cache availability was checked one scoped ref at a time: yes / no / not-run

## Failure Categories

Record fixed categories and counts only.

| Category | Count |
|---|---:|
| auth | |
| quota | |
| timeout | |
| transport | |
| parse | |
| unsupported-ref | |
| empty-ref | |
| ambiguous-response | |
| policy-block | |

## Redaction Review Checklist

- No tokens, API keys, bearer values, cookies, credentials, or secret-file paths are included.
- No credential-bearing URLs, raw endpoint URLs, CDN URLs, permalink URLs, or download-link URLs are
  included.
- No raw refs, infohashes, digests, link-derived inputs, NZB-derived inputs, or scoped-ref values
  are included.
- No raw response bodies, provider payloads, request payloads, headers, or SDK diagnostics are
  included.
- No catalog titles, years, metadata, external ids, item ids, or media-server identifiers are
  included.

## Operator / Reviewer Signoff

- Operator signoff:
- Reviewer signoff:
- Reviewer confirms O4 remains open/deferred: yes / no
- Reviewer confirms O5 remains open/deferred: yes / no
- Reviewer confirms FileCustodian remains a hardened reference harness, not production KMS: yes / no
