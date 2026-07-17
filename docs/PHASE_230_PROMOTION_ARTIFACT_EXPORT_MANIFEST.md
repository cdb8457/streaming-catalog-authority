# Phase 230: Artifact Generation / Export Manifest (local, non-live)

Report id: `phase-230-promotion-artifact-export-manifest`

Status: `PHASE_230_PROMOTION_ARTIFACT_EXPORT_MANIFEST_READY`

## Why this exists

The coverage guards (`gate-coverage`, `closure-hygiene`, `phase230-closure`) pass/fail on wiring. None
**produces** a single reproducibility catalog a coordinator can hand off to regenerate and export the whole
offline evidence set. This manifest is that catalog: for every registered Phase 230 op it records the
artifact it generates and how.

## What it records

For each op in the local ops registry, one `ArtifactExportEntry`:

- `artifact` — the op short-name (path-free).
- `reportId` — the produced report id (the module's first `report: 'phase-230-...'` literal), or `null`.
- `generateScript` / `testScript` — `ops:<base>` and `test:<base>`, the scripts that generate and check it.
- `doc` — its documentation base name.
- `registered` — the report id is verifiable by the self-digest verifier.
- `exportsToFile` — the CLI can persist its artifact to a file (a `writeFileSync` behind an `--out` /
  `--evidence-out` / `--approval-out` flag).
- `cliRedactionSafe` — the CLI emits a `-capture` id and `redactionSafe: true`.
- `generatable` — module + CLI + test + doc + `ops:`/`test:` scripts + local-gate entry all present.

`overall` is `ARTIFACT_EXPORT_MANIFEST_COMPLETE` only when every artifact is registered, generatable,
exportable, and redaction-safe — else `ARTIFACT_EXPORT_MANIFEST_INCOMPLETE` with the gap codes
(`ARTIFACT_REPORT_UNREGISTERED`, `ARTIFACT_NOT_GENERATABLE`, `ARTIFACT_EXPORT_UNSUPPORTED`,
`ARTIFACT_CLI_NONCONFORMANT`; `NO_ARTIFACTS_FOUND` guards against a vacuous pass). The manifest lists itself
as an artifact.

It reads files + the shared registries only; it performs no promotion, never touches the real Movies root,
never contacts Jellyfin, and authorizes nothing live (`authorization` is the constant `NONE`). It carries
only op short-names, fixed report ids / script names, booleans, and counts — no raw paths — and is sealed
with an `exportDigest`. **COMPLETE means the artifact set is fully generatable/exportable offline — it is NOT
an approval, a merge, or a Phase 231 / live-promotion authorization**, and this tool never contacts Jellyfin.

## Files

- `src/ops/promotion-artifact-export-manifest.ts` — `buildArtifactExportManifest(projectRoot)`.
- `src/ops/promotion-artifact-export-manifest-cli.ts` — CLI wrapper.
- `test/promotion-artifact-export-manifest.ts` — 4 tests: the real repo is COMPLETE with every artifact
  exportable; known artifacts bind to their report ids (incl. itself); an empty root fails closed on every
  gap; and a spawned CLI run.

## Usage

```
npm run ops:promotion-artifact-export-manifest -- [--out manifest.json]
```

Exit `0` = `ARTIFACT_EXPORT_MANIFEST_COMPLETE`, `1` = `ARTIFACT_EXPORT_MANIFEST_INCOMPLETE`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
