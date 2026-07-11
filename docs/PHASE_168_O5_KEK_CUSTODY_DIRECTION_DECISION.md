# Phase 168 - O5 KEK Custody Direction Decision

Report id: `phase-168-o5-kek-custody-direction-decision`

Phase 168 records the next recommended direction for O5 without closing O5. The selected direction is
to keep manual operator KEK custody as the current accepted-risk posture while designing sidecar-owned
KEK custody alongside the O4 external sidecar custodian path.

## Decision

Recommended next path: `manual-operator-custody-now-sidecar-owned-kek-next`.

Manual operator custody remains the current operating posture because it is already explicit,
inspectable, and compatible with the validated Unraid runtime. The next build should move toward
sidecar-owned KEK custody once the O4 sidecar boundary is implemented, so O4 and O5 can share one
operator-evidence story instead of creating two unrelated custody systems.

## Options Considered

| Option | Status | Reason |
|---|---|---|
| Manual operator KEK custody | current accepted risk | Simple and visible, but not enough to close O5 as managed custody. |
| Age-encrypted KEK workflow | deferred | Useful for operator backup handling, but still depends on external private-key custody and runbook discipline. |
| External custodian-owned KEK | recommended next design | Aligns with the O4 sidecar direction and gives one custody boundary for DEK wrapping and KEK handling. |

## Required Evidence Before Closure

O5 closure still requires:

- redaction-safe output from `ops:kek-evidence-preflight`;
- a reviewed `ops:rewrap-kek -- --plan --json` artifact;
- managed KEK custody documentation;
- rotation scheduling or operator-approved rotation cadence;
- alert/triage runbook evidence;
- independent secret-media handling evidence;
- explicit O5 closure authorization after review.

## Scope Guard

O5 remains open. This phase does not close O5. It also does not close O4.

Still forbidden: no provider contact, no scraping, no downloading, no playback, no Real-Debrid live
mode, no TorBox live provider mode, no Plex/Jellyfin mutation, and no media-server library writes.

This phase does not run mutating KEK rotation, does not print secret material, does not install a
scheduler, does not change Docker Compose, and does not change runtime service behavior.

