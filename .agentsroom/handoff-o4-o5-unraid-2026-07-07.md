# Handoff - O4/O5 Hardening and Unraid Foundation

## Current Task

Clint asked to continue from the completed catalog-only Unraid validation, then start the next phase for O4/O5 hardening. The latest work also added the Unraid Management Agent MCP endpoint to the local `.mcp.json` config so a future restarted agent session can try to inspect Unraid directly.

## Current Repo State

- Branch: `phase-o4-o5-hardening-plan`
- Base commit: `057405ac5e96bbbe123361626ab8f77a4a195e6a`
- Tracked changes:
  - `README.md` modified with a Phase 95 pointer.
  - `docs/PHASE_95_O4_O5_HARDENING_PLAN.md` added.
- Local/ignored config:
  - `.mcp.json` now includes:
    - `Unraid`
    - `url: http://192.168.1.31:8043/mcp`
  - `.mcp.json` is ignored by git, so it does not appear in normal status.
- Local evidence artifacts:
  - Many untracked `.agentsroom/*.redacted.md` evidence/checkpoint files exist and should remain local/uncommitted unless Clint explicitly asks otherwise.

## Completed Work

- Validated local Docker Desktop deployment path.
- Validated Unraid Compose deployment path.
- Validated final explicit Unraid bind-mounted layout.
- Proved `ops:init`, `ops:doctor`, and JSON doctor on Unraid.
- Proved backup dump, offline verify, and isolated restore rehearsal.
- Added and proved encrypted backup script path on Unraid using OpenSSL AES-256-CBC with PBKDF2.
- Removed old plaintext validation backups and temp decrypted restore rehearsal files from Unraid.
- Installed and confirmed Unraid User Scripts:
  - `catalog-doctor`: hourly.
  - `catalog-backup-verify`: daily.
  - `catalog-kek-rewrap-plan`: monthly.
- Confirmed hourly doctor evidence files were being generated.
- Wired `catalog-doctor` failure path to Unraid `notify`.
- Recorded passphrase custody evidence without exposing the passphrase.
- Removed the suspect `catalog-restore-rehearsal` script that was partially created during a web-terminal crash.
- Created final checkpoint/readiness evidence under `.agentsroom`.
- Created planning-only O4/O5 phase document:
  - `docs/PHASE_95_O4_O5_HARDENING_PLAN.md`
- Added README pointer for Phase 95.
- Ran `npm run test:deploy`: 99 passed, 0 failed.

## Key Decisions

- O4/O5 hardening should precede provider-boundary design.
- Phase 95 is planning-only.
- No provider adapters, Real-Debrid, TorBox, Plex, Jellyfin, scraping, downloading, playback, UI, HTTP service, cloud SDK, vendor SDK, or runtime integration was opened.
- O4 remains open/deferred.
- O5 remains open/deferred.
- FileCustodian remains a hardened reference harness, not production KMS.
- Unraid backup encryption is now proven for script-produced artifacts, but backup passphrase custody remains operator responsibility.
- Restore rehearsal remains manual; no restore rehearsal User Script is currently installed.

## Verification

- `npm run test:deploy`
  - Result: 99 passed, 0 failed.

## Important Local Evidence Files

- `.agentsroom/final-readiness-summary-2026-07-07.redacted.md`
- `.agentsroom/catalog-only-unraid-foundation-checkpoint-2026-07-07.redacted.md`
- `.agentsroom/o4-o5-deferred-risk-acceptance-2026-07-07.redacted.md`
- `.agentsroom/unraid-backup-encryption-evidence-2026-07-07.redacted.md`
- `.agentsroom/backup-passphrase-custody-evidence-2026-07-07.redacted.md`
- `.agentsroom/unraid-plaintext-backup-cleanup-evidence-2026-07-07.redacted.md`
- `.agentsroom/unraid-doctor-schedule-alerting-evidence-2026-07-07.redacted.md`

## Gotchas

- Do not call `run_qa_test` unless Clint explicitly asks for QA delegation.
- `.agentsroom` evidence files are local evidence, not repo product docs.
- `.mcp.json` is ignored and local; the Unraid MCP entry may require restarting/reloading AgentsRoom/Codex before tools appear.
- The Unraid MCP endpoint returning `Bad Request: GET requires an Mcp-Session-Id header` is expected for browser GET; it needs an MCP client session.
- Unraid Management Agent should stay read-only initially and bound to `192.168.1.31 (br0)`.
- The web terminal is fragile with very long pasted scripts; prefer short commands or MCP once available.
- Do not expose or request backup encryption passphrase, KEKs, DEKs, DB URLs, secret file contents, raw logs, or backup artifact contents.
- O4/O5 must not be described as closed without separate reviewed operator evidence.

## Remaining Work

Immediate next steps:

1. Restart/reload AgentsRoom/Codex so the local `.mcp.json` Unraid MCP server is loaded.
2. After restart, check tool discovery for Unraid MCP tools.
3. If Unraid MCP is available, inspect read-only Unraid state:
   - containers;
   - user scripts/schedules;
   - evidence directory labels;
   - backup artifact labels;
   - share status.
4. Commit or review the Phase 95 planning docs if Clint asks:
   - `README.md`
   - `docs/PHASE_95_O4_O5_HARDENING_PLAN.md`
5. If implementation is authorized later, start with O4/O5 descriptor consolidation or external custodian adapter design, not runtime code.

Do not start provider-boundary design until Clint explicitly pivots from O4/O5 hardening.

