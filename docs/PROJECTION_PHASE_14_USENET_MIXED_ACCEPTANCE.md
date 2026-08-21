# Projection Phase 14 — Usenet and mixed-source three-server acceptance

## 1. Status and boundary

**PREFLIGHT ONLY. PHASE 14 IS NOT RUN AND NOT ENTERED.** Phase 13 is not GO, so the entry rule inherited
from Phase 12 §12.2 refuses a real or partial Phase 14 run. This tranche supplies the required
redaction-safe operator preflight. It contacts no worker, NNTP provider, indexer, media server, resolver or
provider; reads no credential, URL, NZB, path or media identity; and closes no claim.

The preflight accepts booleans only. A boolean records that the operator confirmed the *shape* exists; it
never carries the value itself. Unknown fields and non-boolean confirmations are refused.

## 2. Entry confirmations

| confirmation | required shape | purpose | claims unblocked |
|---|---|---|---|
| `phase13Go` | Phase 13 GO record from one frozen candidate | prerequisite, not inference | all Phase 14 claims |
| `phase13ZeroSkips` | that GO record has zero skips | a skipped provider run is not a prerequisite | all Phase 14 claims |
| `sabnzbdRunning` | operator-controlled SABnzbd worker is already running | real worker boundary | `P9-2`, `P9-3`, `P9-5`, `P11-R2` |
| `nntpConfiguredInWorker` | real NNTP provider already configured inside that worker | provider contact is operator-owned | `P9-2`, `P9-3`, `P9-5` |
| `dedicatedCategory` | one dedicated category | isolates admission and cleanup | `P9-2`, `P11-R2` |
| `incompleteDirectory` | category-specific incomplete directory | proves in-flight files do not publish | `P9-2`, `P11-R2` |
| `completeDirectory` | category-specific complete directory | admission boundary | `P9-3`, `P11-R1` |
| `entitledSource` | one operator-approved NZB or indexer reference | successful real sequence | `P9-3`, `P9-5`, `P11-R1` |
| `expectedFailureSource` | one entitled source expected to fail or remain incomplete | refusal/lifecycle evidence | `P9-2`, `P11-R2` |
| `completeDirectoryUnderMediaRoot` | completed output is already beneath the served media root | mixed published generation | `P11-R1` |
| `plexAttached` | real Plex bind attached before the appliance mount | first real reader | `P11-R1`, `P11-R4` |
| `jellyfinAttached` | real Jellyfin bind attached before the appliance mount | second real reader | `P11-R1`, `P11-R4` |
| `embyAttached` | real Emby bind attached before the appliance mount | third real reader | `P11-R1`, `P11-R4` |

If any row is false or absent, Phase 14 does not run. The preflight names the missing row, why it exists,
which claims it unblocks and how the operator can confirm the shape without disclosing its value.

## 3. Claims and windows

The only claims a later authorised Phase 14 run may close are `P9-2`, `P9-3`, `P9-5`, `P9-11`, `P11-R1`,
`P11-R2`, `P11-R4`, and conditionally `P11-R3`. `P11-R3` stays open unless a real outage happens or can be
waited for; this product never induces an outage on the operator's account.

The required windows are an operator window with the worker, both approved sources and all three media
servers available; a retention window for the entitled content; and, only for `P11-R3`, a naturally
occurring outage window.

## 4. Output contract

The report is deterministic and value-silent. It contains a closed-set status (`READY` or `BLOCKED`), the
missing confirmation identifiers, their fixed descriptions, all eight still-open claims, the fixed windows,
and explicit `contactsMade: 0`, `valuesEchoed: false`, `claimsClosed: []`, `phase14Entered: false` fields.
`READY` means only that the shapes required to ask for separate live-run authorization are present.

