# Phase 224: Working Foundation Redefinition + First End-to-End Workflow Plan

Report id: `phase-224-working-foundation-redefinition`

Decision date: `2026-07-14`

Phase type: definition, plan, and guard tests only. This phase makes no runtime, Docker Compose,
custody-mode, provider, downloader, scraper, playback, Jellyfin write, or media-server mutation
changes.

## Honest Redefinition

Prior `launch-ready` claims in Phase 200 and Phase 223 describe infrastructure readiness, not product
readiness.

Those records remain historically accurate for their scoped claim: the self-hosted Catalog Authority
runtime, sidecar custody, operator UI health surface, packaging, and release path are running and
verified. They do not prove a working media process. Phase 224 is the addendum that names that gap
plainly.

New definition:

`WORKING_FOUNDATION = one complete, boring, repeatable media workflow from input to visible result`.

The required user-visible workflow is:

`operator input -> catalog item stored -> media file imported -> Jellyfin can see it -> UI reports the lifecycle status`.

Until that workflow is proven on Unraid with evidence, the project should not describe itself as
product-ready or as having a working streaming/media automation foundation.

## Current Capability Matrix

| Capability | Current state | Basis |
| --- | --- | --- |
| Runtime stack | Working for infrastructure scope | App, Postgres, sidecar healthy in Phase 223 |
| Custody path | Working for current sidecar scope | O4 `O4_CLOSED`; runtime `CUSTODIAN_MODE=sidecar` |
| Operator UI/API | Working for health/status scope | UI live check `ok:true`; read-only/operator status surface |
| Release packaging | Working for current scope | `v1.0.0`, clean-clone smoke, Unraid release image digest |
| Jellyfin read-only integration | Partial, read-only only | Auth, server info, library lookup, and mapping proven through Phase 220/222 |
| Jellyfin write integration | Not working / blocked | `JELLYFIN_COLLECTION_WRITE_MEMBERSHIP_NOT_MATERIALIZING` |
| Local media import | Missing | No system path yet validates, names, and places a supplied file |
| Provider integrations | Missing / out of scope | No Real-Debrid, TorBox, Usenet, scraper, or provider live mode |
| Download/acquisition | Missing / out of scope | No download orchestration or downloader handoff |
| Playback orchestration | Missing / out of scope | No playback, stream selection, or player control |
| End-to-end visible media workflow | Missing | No proven `input -> Jellyfin-visible result` process |

## First Workflow: Local-Media Pipeline

The first working-foundation workflow deliberately avoids providers. Providers later become one way
to supply the file at Step 3; they are not part of this proof.

### Step 1: Operator Input

The operator submits or selects one catalog item through an existing controlled path:

- preferred: `ops:catalog-ingest-item` if present and capable of creating the item with encrypted
  provider references;
- acceptable for the first implementation phase: the existing admin/ops ingestion path already used
  to produce Phase 220 data-positive mapping evidence;
- future UI: a read-only/operator form may wrap the same command after the CLI path is proven.

Evidence source: command report containing item digest, stable catalog item ID, and lifecycle
transition `REQUESTED`. No raw provider ref, secret, or media filename is required in the public
record.

### Step 2: Stored Under Sidecar Custody

The item must be persisted under sidecar custody with encrypted provider-reference handling. Phase
220 proved that real catalog items can carry encrypted provider refs and map one item to Jellyfin
read-only evidence.

Lifecycle transition:

`REQUESTED -> STORED`

Evidence source:

- catalog lookup by item ID;
- custody-path assertion from the app side;
- encrypted-provider-ref presence asserted by count/digest only.

### Step 3: Import Operator-Supplied Local Media File

The operator supplies a real local media file already present on Unraid. The system's job is to
validate it, name it, organize it according to Jellyfin conventions, and place it into a designated
test library folder.

Designated folder:

`/mnt/user/media/catalog-authority-test-library`

Initial media layout:

`/mnt/user/media/catalog-authority-test-library/Movies/<Title> (<Year>)/<Title> (<Year>).<ext>`

Naming rules:

- title comes from the catalog item display title after filesystem-safe normalization;
- year is used when known; unknown year uses `Unknown Year`;
- extension must be preserved from the source file and must be in an allowlist such as `.mkv`,
  `.mp4`, `.m4v`, `.avi`, `.mov`, or `.webm`;
- destination is deterministic and collision-safe: an existing different checksum refuses unless an
  explicit overwrite/reimport mode is later designed.

Import mode for the first proof:

`copy`

Rationale: copy is safest for a first Unraid proof because it does not mutate or remove the
operator's source file. The implementation should copy to a temporary file in the target directory,
fsync/close where practical, verify size and SHA-256, then atomically rename into place.

Hardlink and move remain out of scope for the first proof. They can be added later only after copy
semantics are accepted.

Lifecycle transition:

`STORED -> IMPORTED`

Observed-state evidence:

- source file is readable, regular, non-empty, and allowed by extension;
- destination file exists at the expected path;
- destination size and SHA-256 match the source;
- source remains unchanged;
- import report records only digests and normalized path category, not private source paths.

### Step 4: Jellyfin Scan and Read-Only Visibility Confirmation

The system triggers or awaits a Jellyfin library scan only through an explicitly approved mechanism
for the test library. If scan triggering is not approved in Phase 226, the operator may trigger scan
manually and the system must await observed state.

Verification is never "Jellyfin accepted a request." Verification means the item is queryable through
the proven read-only path after scan/indexing.

Lifecycle transition:

`IMPORTED -> VISIBLE_IN_JELLYFIN`

Observed-state evidence:

- destination file still exists at the expected path;
- Jellyfin read-only library lookup sees a media item matching the imported title/year/path digest;
- Catalog Authority to Jellyfin mapping reports the item as mapped;
- evidence records Jellyfin item digest, catalog item digest, match basis, and no raw private paths.

### Step 5: UI Lifecycle Status

The operator UI must show the item lifecycle:

`REQUESTED -> STORED -> IMPORTED -> VISIBLE_IN_JELLYFIN`

Failure state:

`FAILED`

The UI must expose the current state, last successful transition, last failure code, and a log/evidence
reference that can be retrieved without exposing secrets or private raw paths.

## State Machine

Allowed states:

- `REQUESTED`;
- `STORED`;
- `IMPORT_VALIDATING`;
- `IMPORTING`;
- `IMPORTED`;
- `JELLYFIN_SCAN_WAITING`;
- `VISIBLE_IN_JELLYFIN`;
- `FAILED`.

Allowed transitions:

| From | To | Evidence required |
| --- | --- | --- |
| `REQUESTED` | `STORED` | Catalog item persisted under sidecar custody |
| `STORED` | `IMPORT_VALIDATING` | Import command accepted with explicit item and source-file reference |
| `IMPORT_VALIDATING` | `IMPORTING` | Source file readable, regular, non-empty, allowed extension |
| `IMPORTING` | `IMPORTED` | Destination file observed with matching size and SHA-256 |
| `IMPORTED` | `JELLYFIN_SCAN_WAITING` | Target library folder remains present and scan/await started |
| `JELLYFIN_SCAN_WAITING` | `VISIBLE_IN_JELLYFIN` | Jellyfin read-only query returns mapped item |
| Any non-terminal state | `FAILED` | Failure code, retry classification, and log/evidence reference recorded |

Terminal success:

`VISIBLE_IN_JELLYFIN`

Terminal failure:

`FAILED`, unless a retry creates a new attempt record.

## Failure Semantics

Every failure must be visible in the UI and evidence. The 195/221 lesson is binding: verification
means observed state, not accepted commands or HTTP status codes alone.

| Step | Failure code | UI behavior | Retry semantics |
| --- | --- | --- | --- |
| Input | `CATALOG_INPUT_REJECTED` | Show validation error and no import controls | Safe after correcting input |
| Store | `CATALOG_STORE_FAILED` | Show stored state absent and custody check failed | Safe; retry must be idempotent by item key |
| Import validation | `IMPORT_SOURCE_INVALID` | Show source-file validation failure | Safe after selecting a valid file |
| Import validation | `IMPORT_EXTENSION_FORBIDDEN` | Show unsupported media type | Safe after selecting allowed file |
| Import | `IMPORT_DESTINATION_COLLISION` | Show collision and preserve existing file | Safe only with future explicit reimport mode |
| Import | `IMPORT_COPY_MISMATCH` | Show copy verification failed; cleanup temp file | Safe after cleanup confirmation |
| Jellyfin scan/await | `JELLYFIN_SCAN_TIMEOUT` | Show imported but not visible yet | Safe to retry await/scan |
| Jellyfin mapping | `JELLYFIN_VISIBLE_MISMATCH` | Show imported but mapping ambiguous or absent | Safe to retry after investigation |
| UI/evidence | `LIFECYCLE_EVIDENCE_UNAVAILABLE` | Show state unknown with last known transition | Retry evidence fetch; do not advance state |

Idempotency rules:

- repeating a successful import with the same source checksum and destination is a no-op success;
- repeating import with a different checksum at the same destination refuses;
- scan-await can be repeated safely;
- a failed attempt must not erase the prior successful lifecycle evidence.

## Execution Ladder

Phase 225: local import service and lifecycle state machine, local/fake evidence only.

- implement validation, naming, copy semantics, state transitions, and fake Jellyfin visibility
  proof;
- no live Jellyfin calls, no providers, no downloads.

Phase 226: live single-file end-to-end on Unraid.

- operator supplies one real test media file;
- import into the designated Unraid test library folder;
- await or trigger Jellyfin scan according to the approved boundary;
- prove `VISIBLE_IN_JELLYFIN` through the read-only path.

Phase 227: repeatability and failure-injection proof.

- run the workflow multiple times with distinct items/files;
- include one expected failure such as forbidden extension or checksum collision;
- prove retries are safe and evidence remains coherent.

Phase 228: working-foundation acceptance record.

- decide whether the new definition is satisfied;
- if satisfied, record `WORKING_FOUNDATION_E2E_ACCEPTED`;
- if not, record the named deficiency and keep product readiness open.

Each phase is gated on the previous phase's evidence. No phase may skip from a command being accepted
to a success claim without observed-state proof.

## Explicit Non-Scope

This plan does not enable or implement:

- provider integrations;
- Real-Debrid, TorBox, Usenet, scraper, or metadata-source live mode;
- download orchestration;
- playback orchestration;
- Jellyfin writes or collection mutation;
- Plex, Emby, Stremio, or other media-server integration;
- production library mutation beyond the dedicated test library folder.

Providers get defined later as "how files arrive at Step 3." The local-media pipeline contract is
intentionally shaped so that slot can be filled later without changing the lifecycle proof.

## Exit Status

Phase 224 status: `WORKING_FOUNDATION_REDEFINED_E2E_PLAN_READY`

Product readiness status: `PRODUCT_READY_FALSE_E2E_WORKFLOW_MISSING`

Phase 225 is unblocked.
