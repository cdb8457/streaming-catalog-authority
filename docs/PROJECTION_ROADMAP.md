# Projection roadmap — the reset

**Status of everything before this document:** the catalog authority is built. Phases 1–336 are history and
are not reopened. This is the roadmap for the projection appliance, and it is deliberately short.

## Where the product actually is

- The **control plane** works: catalog authority, operator UI, import/export, backup, restore, retention,
  custody, and a gated Jellyfin collection control plane.
- The **data plane** does not exist. No media server can open a file through this product.
- Therefore the product does not yet do the thing it is for.

## The only tranche

| | |
|---|---|
| **Projection Phase 0** | The executable product contract. `docs/ADR_002_PROJECTION_APPLIANCE.md`, `docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md`, `docs/schemas/projection-manifest-v1.schema.json`, `src/core/projection/*`, `test/projection-manifest-v1.ts`. **Done.** |
| **Projection Phase 1** | The **vertical slice**: manifest producer → published artifact → `projectiond` → FUSE mount → Plex, Jellyfin and Emby scanning and playing it. Local passthrough and HTTP Range adapters, in the same tranche. Gates in `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md`. **Next, and only.** |

There is no Phase 2 in this document. Writing one now would be a guess, and a guess in a roadmap is how a
product acquires thirty phases of scaffolding around a thing that has never run.

## The anti-detour rule

**No later phase, and no new evidence, ceremony, review-gate, packaging, disposition or acceptance-record
phase, may be started before the Phase 1 vertical slice passes its hard gates on three consecutive runs on a
real Linux or Unraid host.**

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
