# Production Readiness Evidence Report

Use this template for operator-run production readiness review. Keep it redaction-safe. Live or
operator evidence is manually collected and must not be required by CI or unattended automation.

Do not include KEKs, DEKs, wrapping keys, master keys, completion secrets, HMAC secrets, API keys,
tokens, credentials, private keys, seed phrases, raw identity, provider refs, media titles, Jellyfin
ids, catalog item dumps, database URLs, secret file paths, backup artifact contents, screenshots with
media identity, full environment dumps, or unredacted logs.

## Environment / Build

- Date:
- Operator:
- Reviewer:
- Deployment type: Unraid / Docker Compose / other:
- Catalog Authority commit or build:
- Schema version:
- `APP_ENV` mode name:
- `CUSTODIAN_MODE` mode name:
- Evidence collected manually by operator: yes / no
- CI or unattended automation required live services: no

## Doctor Result

- Command shape: `npm run ops:doctor -- --json`
- Exit code:
- Overall `ok`: true / false
- Report version:
- PASS count:
- WARN count:
- FAIL count:
- FAIL checks observed:
- Redaction-safe WARN summary:
- `production-gate-o4-external-custodian` status: absent / warn / fail / pass
- `production-gate-o5-managed-kek` status: absent / warn / fail / pass
- O4 interpretation: open / closed by separate external-custodian evidence / formally accepted
- O5 interpretation: open / closed by separate managed-custody evidence / formally accepted

## Backup Verification

- Command shape: `npm run ops:verify-backup -- <artifact>`
- Artifact label or date, redacted:
- Offline verification used: yes / no
- Exit code:
- Result: passed / failed / not run
- Redaction-safe structural summary:

## Restore Rehearsal

- Command shape: `REHEARSAL_ADMIN_DATABASE_URL=<throwaway-db> npm run ops:rehearse-restore -- <artifact>`
- Throwaway database confirmed: yes / no
- Production database not targeted: yes / no
- Exit code:
- Result: passed / failed / not run
- Redaction-safe rehearsal summary:

## KEK Rewrap Plan

- Command shape: `npm run ops:rewrap-kek -- --plan --json`
- Non-mutating plan used: yes / no
- `mutates`: false / other
- Exit code:
- Result: passed / failed / not run
- `needsRewrap` count:
- `alreadyCurrent` count:
- `total` count:
- O5 remains open after this plan alone: yes / no

## Existing Release / Upgrade Checklist

- Pre-upgrade backup captured: yes / no / not applicable
- Backup verified offline: yes / no / not applicable
- Restore rehearsed in throwaway DB: yes / no / not applicable
- `ops:version` matched expected schema: yes / no / not applicable
- `ops:doctor --json` wired into scheduled healthcheck: yes / no / not applicable
- Keystore, KEK, completion secret, and DB backup stored on independent media: yes / no / not applicable

## Open Gate Status

- O4 managed/external custodian status:
- O4 evidence reviewed:
- O4 live adapter name/version/commit:
- O4 live acceptance command shape:
- O4 live acceptance result:
- O4 evidence confirms no CI dependency on live custodian/cloud/network: yes / no
- O5 managed age KEK custody/scheduling status:
- O5 evidence reviewed:
- Accepted production readiness exceptions:

## Failures Observed

- Doctor FAIL checks:
- Backup verification failures:
- Restore rehearsal failures:
- KEK rewrap plan failures:
- Redaction concerns:
- Follow-up actions:

## Operator / Reviewer Signoff

- Operator confirms no secret values or key material included: yes / no
- Operator confirms no raw identity, provider refs, media titles, or item dumps included: yes / no
- Operator confirms no secret file paths, database URLs, full env dumps, or unredacted logs included: yes / no
- Operator confirms live evidence was manually collected and not required by CI: yes / no
- Reviewer conclusion: approved / rejected / approved with exceptions
- Reviewer notes:
