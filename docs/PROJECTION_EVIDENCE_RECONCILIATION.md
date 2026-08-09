# Projection — evidence reconciliation ledger

**What this file is.** A register of places where this repository makes two claims that cannot both be true
about whether something has ever run. Each entry records the investigation, what the evidence does and does
not establish, and a status. `test/projection-evidence-consistency.ts` reads this file: a contradiction that
is **not** registered here fails that suite. A new one therefore cannot be introduced quietly, and an old one
cannot be resolved by deleting the sentence that makes it visible.

**Why a ledger rather than an edit.** The obvious way to make two files agree is to change one of them. That
is exactly the move this repository has spent four dispatches undoing, because the file that gets changed is
whichever one is easier to reach, not whichever one is wrong. A contradiction between an evidence claim and a
nonclaim is a question about **what happened**, and it is answered from artifacts or not at all. Where the
artifacts run out, the uncertainty is recorded rather than resolved.

---

## RCLONE-G22-LINUX-RUN-EXISTENCE

**STATUS: UNRESOLVED — the two sides are not symmetric, and neither is fully supported.**

### The two claims

| Where | Claim |
|---|---|
| `src/core/projection/rclone-comparison.ts` (`RCLONE_COMPARISON_NONCLAIMS`) and `deploy/projection-rclone-comparison-gate.sh` (header) | **"no run of this gate has ever happened on a real Linux or Unraid host"** |
| `docs/PROJECTION_PHASE_1_RCLONE_COMPARISON.md` §7.7 and its run-record table | **runs 18–20: three consecutive fresh runs on a real Unraid host**, 70 assertions each, with per-run figures |

### How it arose

`99a6828` ("feat: run G22 rclone comparison on real Linux/Unraid host") changed **three** files together: the
gate header, the nonclaims list, and the run-record document. `373df01` ("revert: restore Phase 1 files to
origin/master — builder's unauthorized modifications reverted") restored **two** of the three and left the
document. The repository has asserted both ever since. No test caught it, because nothing cross-checked the
document against the nonclaims list — which is what this ledger and its suite now do.

### What the artifacts establish

Investigated 2026-08-09 against the real Unraid host (`tower`, 192.168.1.31) and against git history.

**Established:**

- **The gate ran on that host, in that tree, in that window.** `/mnt/user/appdata/catalog-phase1-heredoc-audit-2/.projection-rclone-gate`
  exists and is **empty**, mtime `2026-08-07 18:50:14 -0500`. That directory is created by
  `deploy/projection-rclone-comparison-gate.sh` and by nothing else, and it exists in **exactly one** of the
  four `catalog*` trees on the host. Its parent's mtime is `18:39:58`, which bounds the gate root's creation.
  Empty-but-present is the signature of the cleanup trap completing.
- **The commit the document names is real and matches the identity it claims.** `69f93e0`
  (2026-08-07 16:18:03, tip of `cdb8457/projection-phase1-heredoc-audit-2`) has **exactly 1593 tracked
  files**, the figure §7.7 states. It is not an ancestor of this branch, which is consistent with it being a
  sibling line rather than an error.
- **The host matches the environment §7.7 describes**, field for field: Unraid 7.2.3, kernel
  `6.12.54-Unraid`, Node v22.18.0, Compose 2.40.3, Docker 27.5.1.
- **The timeline is internally coherent.** Commit 16:18 → gate root created 18:39:58 → last run directory
  removed 18:50:14 → commit 99a6828 at 19:08:35. The gate-root lifetime is **10 min 16 s**; all media-server,
  rclone and Postgres images were already warm on the host, so ~3 min 25 s per run for three runs is
  plausible, if brisk.

**NOT established:**

- **The run count.** The rclone gate retains **no per-run artifact** — its cleanup removes the run directory
  and leaves an empty root — so nothing distinguishes one completed run from three. The contrast is exact and
  instructive: the TorBox real-provider gate *does* retain evidence, and
  `/mnt/user/appdata/catalog-phase1-torbox-real/…/.projection-real-provider-gate/evidence/` still holds
  **three** `results-*.jsonl` and three `results-summary-*.json` under **three distinct PIDs**
  (2186733 / 2200346 / 2213799). §6.15's 3/3 claim is corroborated by artifact; §7.7's is not, because the
  gate was never built to leave one.
- **The per-run figures.** The ranged-GET counts, byte totals and scan seconds in §7.7 cannot be re-derived
  from anything retained on the host. They are reproducible only by running the gate again.
- **1593 as a fingerprint.** It is shared by `69f93e0`, `5841aba`, `373df01` and `99a6828`. It distinguishes
  that family from neighbours (1591, 1592, 1599) but does not single out `69f93e0`.

### What follows

**The absolute nonclaim is refuted by artifact.** "No run of this gate has ever happened on a real Linux or
Unraid host" cannot be reconciled with a gate root that only that gate creates, on that host, timestamped.
**At least one run happened.**

**The document's specific claim is unverified, not refuted.** Three consecutive runs with those figures is
consistent with every artifact found and proven by none of them.

**So neither side is edited here.** Restoring `99a6828`'s text would adopt figures no retained artifact
supports; leaving the nonclaims as the only correction would keep asserting something an artifact refutes.
Both remain, registered, until one of two things happens:

1. Someone re-runs `npm run go:rclone-comparison-gate:three` on the host and records first-party evidence — at
   which point §7.7 is replaced by that run's figures and the nonclaims are corrected to match; or
2. The rclone gate is given the evidence-retention the real-provider gate has, so the question cannot recur in
   this form.

**This was not resolved by the Phase 2 closure work**, which is scoped to the mount-hardening gates and the
multi-frontend harness. G22 remains the **comparison control**; nothing here changes that.
