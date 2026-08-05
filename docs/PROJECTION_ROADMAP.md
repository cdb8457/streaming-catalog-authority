# Projection roadmap — the reset

**Status of everything before this document:** the catalog authority is built. Phases 1–336 are history and
are not reopened. This is the roadmap for the projection appliance, and it is deliberately short.

## Where the product actually is

- The **control plane** works: catalog authority, operator UI, import/export, backup, restore, retention,
  custody, and a gated Jellyfin collection control plane.
- The **data plane exists, thinly, and more than one media server has now read it.** This line used to say
  "the data plane does not exist; no media server can open a file through this product", and that stopped
  being true when `deploy/projection-jellyfin-dataplane-gate.sh` started passing: a real, digest-pinned
  Jellyfin scans a ~50-entry projected corpus, direct-plays it for five minutes at the media's own rate,
  seeks ten times including backwards and past 90 % of duration, and consumes a forced transcode for five
  minutes — all through the production `projectiond` mount. Leaving the old sentence in place would have been
  the opposite of this repository's problem and just as bad: a document that disagrees with what runs.
- **"Plex and Emby are untouched" was this page's line, and it is now false twice over.** It became false for
  Plex when `deploy/projection-plex-dataplane-gate.sh` merged with a run record carrying a real count —
  **seven runs, three failing and four green**, the last three consecutive and each starting from nothing
  (`docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md` §7, which also says plainly that it is not a complete index).
  It became false for Emby when `deploy/projection-emby-dataplane-gate.sh` passed **four times, the last
  three consecutive and fresh, each 353 assertions with none failed and none skipped**
  (`docs/PROJECTION_PHASE_1_EMBY_DATA_PLANE.md` §7).
- **HISTORICAL — SUPERSEDED.** The sentence this bullet used to lead with, kept whole so the record of what
  was believed when survives:
  **ALL THREE MEDIA SERVERS NOW HAVE A GATE, AND THE TRANCHE IS NO CLOSER TO CLOSING.**
  When all three media-server gates first existed, every run of every one of
  them **had been** on **Windows / Docker Desktop**, which `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6
  says closes **none** of G7–G13. What changed then was that "one of the three is untouched" **stopped being**
  the reason Phase 1 was open; the reason **was** the platform. **That is no longer true** — see the Unraid
  bullet below — and this entry is kept only so the sequence of what was believed when is not lost.
- **A FOURTH GATE RUNS ALL THREE AT ONCE. IT IS G18, AND IT HAS SINCE RUN.**
  `deploy/projection-three-server-concurrency-gate.sh` puts a real, digest-pinned Plex, Jellyfin and Emby on
  **one** production mount, **one** admitted generation, **one** ~50-entry corpus and **one** fake endpoint,
  and observes all three scanning at the same instant rather than inferring it from three triggers landing
  together. It is not a wrapper around the other three gates: running those at once would stand up three
  daemons, three mounts and three corpora and would prove something about Docker Desktop.
  `docs/PROJECTION_PHASE_1_THREE_SERVER_CONCURRENCY.md` says what it asserts and what it refuses to claim.
  **HISTORICALLY** the §6.1 table recorded it as `NOT RUN`, because every run **had been** on Windows /
  Docker Desktop and `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6 says that closes none of G7–G13 or G18.
  **G18 HAS SINCE RUN — three consecutive fresh runs on a real Unraid host, 64 assertions each, none failed
  and none skipped**, and §6.1 records it as run. **Per-server provider attribution is impossible with one
  shared daemon and is still not claimed. No real provider endpoint has ever been contacted, and Phase 1
  remains open on that ground.**
- **A FIFTH GATE MEASURES WHAT THE NAIVE PATH COSTS, AND IT IS A CONTROL RATHER THAN A CANDIDATE.**
  `deploy/projection-rclone-comparison-gate.sh` is G22: the **same** ~50-entry corpus behind a digest-pinned
  rclone mount of a deterministic WebDAV endpoint, read by the **same** three real, digest-pinned media
  servers, observed by G18's **own** observer and floors. `docs/ADR_002_PROJECTION_APPLIANCE.md` §2 rejected
  rclone over WebDAV as production architecture and kept it as a test control, in those words; **nothing
  measured here reopens that, a cheap number would not, and an expensive one is not what closed it.** G22 has
  **no pass threshold**, so every cost figure is recorded and compared against nothing — what fails closed is
  the instrumentation. `docs/PROJECTION_PHASE_1_RCLONE_COMPARISON.md` says what it measures and refuses to
  claim. **HISTORICALLY** the §6.1 table recorded **G22 as `NOT RUN`**, because every run **had been** on
  Windows / Docker Desktop; **it has since run three consecutive fresh times on a real Unraid host, 70
  assertions each.** G22 still has no pass threshold, so that is reproducibility of the instrument and not a
  verdict on the naive path.
- **DOCKER DESKTOP IS NOT UNRAID, AND EVERY GATE THAT HAS AN EXECUTABLE FORM HAS NOW RUN THERE.** Three
  consecutive fresh runs each, on a real Unraid host, none failed and none skipped: **Jellyfin** (366
  assertions per run), **Emby** (395/394/394), **Plex** (414/412/414), **G18** (64), **G22** (70),
  **G24–G26** (29) and **G27** (85) — **seven gate groups, seven 3/3 sequences.** The host preflight
  returned an authoritative verdict rather than `undetermined`, and every run left the host clean — zero
  mountpoints, where the same gate once left four behind.

- **GETTING THERE COST FIVE GATE DEFECTS AND NO PRODUCT DEFECTS, WHICH IS ITSELF THE RESULT.** A byte
  budget measured against bytes that were never written; a byte budget that was arithmetically unreachable
  on the only object it bound; a cleanup whose lazy unmount ran in a mount namespace that did not
  propagate; a scan window that was never cold because Plex had already scanned it before the window
  opened; and an encoder-liveness floor that counted throttle bursts and therefore scored LOWER on faster
  hardware. Every one was invisible on Docker Desktop.

- **AND G24-G26 HAVE NOW RUN TOO** — three consecutive fresh Unraid runs, 29 assertions each, none
  failed and none skipped: a lease lapsed under an in-flight read and was re-resolved EXACTLY once with all
  seven identity fields unchanged; twenty concurrent opens cost EXACTLY one resolution; the open inside the
  cooldown cost none and failed in 340, 345 and 377 ms against a 10,000 ms ceiling; all four malformed
  refreshed responses were refused with zero bytes accepted; and the disallowed origin was never contacted.
  No product code changed: the daemon already did all of it.

- **AND G27 HAS NOW RUN TOO** — three consecutive fresh Unraid runs, **85 assertions each**, none failed and
  none skipped. A successor moving a carried entry's path was forged into a real artifact under a real
  pointer and **refused** by the daemon with `PATH_CHANGED_FOR_CARRIED_ENTRY`, with all three servers showing
  no change; the retire → grace → delete → add sequence then ran end to end, and all three observed **exactly**
  the removal and **exactly** the addition. Whether a server preserves watch state across that pair is
  **recorded, not asserted** — none of the three did, and that fails nothing. Four defects were found and all
  four were in the gate: **no product code changed.**

- **AND PHASE 1 STILL DOES NOT CLOSE, FOR ONE REASON AND NO LONGER FOR ANY OF THE OLD ONES.** **No real
  provider endpoint has ever been contacted.** That is the whole of what is left. For most of this document's
  life the reason was the platform; then it was the absence of a lease gate; then it was G27's missing
  lifecycle gate. **None of those is true any more.** What has been run, against which server, is
  `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6.1 — and that table, not this page, is the authority on it.
- Therefore the product now does the thing it is for, **on all three media servers, on a real Unraid host**
  — and Phase 1 remains open.

## The only tranche

| | |
|---|---|
| **Projection Phase 0** | The executable product contract. `docs/ADR_002_PROJECTION_APPLIANCE.md`, `docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md`, `docs/schemas/projection-manifest-v1.schema.json`, `src/core/projection/*`, `test/projection-manifest-v1.ts`. **Done.** |
| **Projection Phase 1** | The **vertical slice**: manifest producer → published artifact → `projectiond` → FUSE mount → Plex, Jellyfin and Emby scanning and playing it. Local passthrough and HTTP Range adapters, in the same tranche. Gates in `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md`. **Open.** The daemon, the manifest producer (`docs/PROJECTION_PHASE_1_MANIFEST_PUBLISHER.md`), the publisher-to-mount gate, **all three media-server data-plane gates**, the three-server concurrency gate, the rclone comparison control and the access-lease gate are built and have each **run three consecutive fresh times on a real Unraid host**. G27's three-server path-lifecycle gate is built and has run three consecutive fresh times too, so **every Phase 1 gate now has an executable form and a 3/3 Unraid sequence — seven of them**. **The platform is no longer why this row says Open, and neither is a missing gate.** It stays open for exactly one reason: **no real provider endpoint has ever been contacted**. Whether any given gate has ever passed is §6.1 of the acceptance plan and each gate's own run record, because **a gate existing is not a gate passing**. |

There is no Phase 2 in this document. Writing one now would be a guess, and a guess in a roadmap is how a
product acquires thirty phases of scaffolding around a thing that has never run.

## The anti-detour rule

**No later phase, and no new evidence, ceremony, review-gate, packaging, disposition or acceptance-record
phase, may be started before the Phase 1 vertical slice passes its hard gates on three consecutive runs on a
real Linux or Unraid host.**

**This rule has not been satisfied, and the reason it has not has changed.** **HISTORICALLY** it was unsatisfied
because three consecutive green runs on Windows and Docker Desktop are three green runs on Windows and
Docker Desktop. **That reason is spent:** the gates have since run on a real Unraid host. The rule is
unsatisfied now for the reason below, and for no other.

**AND THE UNRAID RUNS DO NOT SATISFY IT EITHER, WHICH IS THE WHOLE POINT OF STATING THEM PRECISELY.** The
rule names **the Phase 1 vertical slice**, and the slice is not only the gates that have run. Every planned
Phase 1 gate now has an executable form and a 3/3 fresh Unraid sequence — **seven of them** — and **no real
provider endpoint has ever been contacted**, while the acceptance plan names a real-provider corpus and
places it on exactly this environment. **Seven gate groups passing three times each is seven gate groups
passing three times each**, and the slice is not the gates.

**What has changed is which sentence is doing the work, and it has changed twice.** For most of this
document's life the reason Phase 1 was open was the platform; that stopped being true when the gates ran on
Unraid. It was then the absence of a lease gate; that stopped being true when G24–G26 were written and ran.
It was then G27's lifecycle half; that stopped being true when G27 was written and ran. **What is left is
the real-provider run, alone**, and a partial truth recorded exactly is what this page is for.
This is a rule with teeth because this repository has the failure mode it prevents. There are 336 phases
behind it, a large fraction of which are evidence packets, review gates, closure gates, authorization
records, dispositions and acceptance seals for work whose end-to-end behaviour was never demonstrated. Each
one was individually defensible. Together they are the reason a product with a complete backup lifecycle
cannot play a file.

What the rule permits while Phase 1 is open:

- fixing a defect the slice exposes, in any layer, including the control plane;
- amending the Phase 0 contract when the slice proves a decision wrong — with the amendment written into
  `docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md` and its test, not into a new document;
- anything the existing suites require to stay green.

What it does not permit, however well argued:

- a phase that produces a document about work not yet done;
- a review, gate, seal, attestation, disposition or record whose subject is the slice itself before the slice
  runs;
- a second frontend, a third source adapter, an operator UI surface, a packaging step, an Unraid template or
  a release, before the gates pass.

## How this changes the READMEs and pointers

`README.md` gains one short section stating that the product's purpose is a projection appliance, that the
existing application is its control plane, and that the data plane is Projection Phase 1. Nothing else in the
README is rewritten: everything it describes is still true and still shipped.
