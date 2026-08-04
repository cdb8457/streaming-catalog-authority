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
- **ALL THREE MEDIA SERVERS NOW HAVE A GATE, AND THE TRANCHE IS NO CLOSER TO CLOSING.** Every run of every one
  of them has been on **Windows / Docker Desktop**, which `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6 says
  closes **none** of G7–G13. What changed is that "one of the three is untouched" is no longer the reason
  Phase 1 is open. The reason is the platform, and it always was.
- **A FOURTH GATE NOW RUNS ALL THREE AT ONCE, AND G18 IS STILL NOT RUN.**
  `deploy/projection-three-server-concurrency-gate.sh` puts a real, digest-pinned Plex, Jellyfin and Emby on
  **one** production mount, **one** admitted generation, **one** ~50-entry corpus and **one** fake endpoint,
  and observes all three scanning at the same instant rather than inferring it from three triggers landing
  together. It is not a wrapper around the other three gates: running those at once would stand up three
  daemons, three mounts and three corpora and would prove something about Docker Desktop.
  `docs/PROJECTION_PHASE_1_THREE_SERVER_CONCURRENCY.md` says what it asserts and what it refuses to claim; the
  §6.1 table records it as **NOT RUN**, because every run has been on Windows / Docker Desktop and
  `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6 says that closes none of G7–G13 or G18. **Per-server
  provider attribution is impossible with one shared daemon and is not claimed. G27's three-server
  half is not run. No real provider endpoint has ever been contacted, and Phase 1 remains open.**
- **A FIFTH GATE MEASURES WHAT THE NAIVE PATH COSTS, AND IT IS A CONTROL RATHER THAN A CANDIDATE.**
  `deploy/projection-rclone-comparison-gate.sh` is G22: the **same** ~50-entry corpus behind a digest-pinned
  rclone mount of a deterministic WebDAV endpoint, read by the **same** three real, digest-pinned media
  servers, observed by G18's **own** observer and floors. `docs/ADR_002_PROJECTION_APPLIANCE.md` §2 rejected
  rclone over WebDAV as production architecture and kept it as a test control, in those words; **nothing
  measured here reopens that, a cheap number would not, and an expensive one is not what closed it.** G22 has
  **no pass threshold**, so every cost figure is recorded and compared against nothing — what fails closed is
  the instrumentation. `docs/PROJECTION_PHASE_1_RCLONE_COMPARISON.md` says what it measures and refuses to
  claim; the §6.1 table records **G22 as NOT RUN**, because every run has been on Windows / Docker Desktop.
- **DOCKER DESKTOP IS NOT UNRAID, AND EVERY GATE THAT HAS AN EXECUTABLE FORM HAS NOW RUN THERE.** Three
  consecutive fresh runs each, on a real Unraid host, none failed and none skipped: **Jellyfin** (366
  assertions per run), **Emby** (395/394/394), **Plex** (414/412/414), **G18** (64) and **G22** (70). The
  host preflight returned an authoritative verdict rather than `undetermined`, and every run left the host
  clean — zero mountpoints, where the same gate once left four behind.

- **GETTING THERE COST FIVE GATE DEFECTS AND NO PRODUCT DEFECTS, WHICH IS ITSELF THE RESULT.** A byte
  budget measured against bytes that were never written; a byte budget that was arithmetically unreachable
  on the only object it bound; a cleanup whose lazy unmount ran in a mount namespace that did not
  propagate; a scan window that was never cold because Plex had already scanned it before the window
  opened; and an encoder-liveness floor that counted throttle bursts and therefore scored LOWER on faster
  hardware. Every one was invisible on Docker Desktop.

- **AND PHASE 1 STILL DOES NOT CLOSE.** **G24–G26 and G27’s three-server half have no executable gate at
  all** — nothing has been run for them, which is not the same as something run and fallen short — and
  **no real provider endpoint has ever been contacted**. What has changed is that the reason the tranche
  is open is no longer the platform. What has been run, against which server, is
  `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6.1 — and that table, not this page, is the authority on it.
- Therefore the product now does the thing it is for, **on all three media servers, on a developer's machine**
  — and Phase 1 remains open.

## The only tranche

| | |
|---|---|
| **Projection Phase 0** | The executable product contract. `docs/ADR_002_PROJECTION_APPLIANCE.md`, `docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md`, `docs/schemas/projection-manifest-v1.schema.json`, `src/core/projection/*`, `test/projection-manifest-v1.ts`. **Done.** |
| **Projection Phase 1** | The **vertical slice**: manifest producer → published artifact → `projectiond` → FUSE mount → Plex, Jellyfin and Emby scanning and playing it. Local passthrough and HTTP Range adapters, in the same tranche. Gates in `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md`. **Open.** The daemon, the manifest producer (`docs/PROJECTION_PHASE_1_MANIFEST_PUBLISHER.md`), the publisher-to-mount gate and **all three media-server data-plane gates** are built and run — **on Windows / Docker Desktop only, which closes none of G7–G13**. **The Unraid half is not**, and the tranche does not close until every gate passes on a real Linux or Unraid host, on all three media servers, three times. Whether any given gate has ever passed is §6.1 of the acceptance plan and each gate's own run record, because **a gate existing is not a gate passing**. |

There is no Phase 2 in this document. Writing one now would be a guess, and a guess in a roadmap is how a
product acquires thirty phases of scaffolding around a thing that has never run.

## The anti-detour rule

**No later phase, and no new evidence, ceremony, review-gate, packaging, disposition or acceptance-record
phase, may be started before the Phase 1 vertical slice passes its hard gates on three consecutive runs on a
real Linux or Unraid host.**

**This rule has not been satisfied.** Three consecutive green runs on Windows and Docker Desktop are three
green runs on Windows and Docker Desktop.

**AND THE UNRAID RUNS DO NOT SATISFY IT EITHER, WHICH IS THE WHOLE POINT OF STATING THEM PRECISELY.** The
rule names **the Phase 1 vertical slice**, and the slice is not only the media-server gates. G24–G26 and
G27’s three-server half have **no executable gate at all**, and **no real provider endpoint has ever been
contacted** — the acceptance plan names a real-provider corpus and places it on exactly this environment.
Five gates passing three times each is five gates passing three times each.

**What has changed is which sentence is doing the work.** For the whole life of this document the reason
Phase 1 was open was the platform. It is not any more. The reason now is that parts of the slice have
never been executed, and a partial truth recorded exactly is what this page is for.
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
