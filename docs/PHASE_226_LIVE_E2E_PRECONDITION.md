# Phase 226: Live Single-File E2E Precondition

Report id: `phase-226-live-e2e-precondition`

Status: `BLOCKED_PENDING_OPERATOR_JELLYFIN_TEST_LIBRARY`

This is a precondition record for the Phase 226 live single-file E2E run. It is not the Phase 226
acceptance record and does not tag Phase 226 complete.

## Required Operator-Provided Configuration

Host folder:

`/mnt/user/media/catalog-authority-test-library`

Jellyfin container mount:

- host: `/mnt/user/media/catalog-authority-test-library`;
- container: `/media/catalog-authority-test-library`;
- access: read-only from Jellyfin.

Jellyfin library:

- name: `Catalog Authority Test`;
- content type: Movies;
- folder: `/media/catalog-authority-test-library`;
- artwork/metadata saved into media folders: off.

This library must be separate from Gelato and from any real Movies/Shows library.

## Current Observed State

Observed on Unraid before operator configuration:

- host folder exists: yes;
- Jellyfin container mount for `/media/catalog-authority-test-library`: no;
- Jellyfin library `Catalog Authority Test`: not observed;
- existing Jellyfin libraries include Gelato-backed Movies and Shows paths.

The live E2E remains blocked because importing into the existing Gelato paths would touch a real
configured library and violate the Phase 224/225 boundary.

## Added Guard

Added `ops:jellyfin-test-library-preflight` and `test:jellyfin-test-library-preflight`.

The preflight refuses Stage 226 unless:

- the host folder exists;
- Jellyfin exposes the expected container mount;
- Jellyfin has a virtual folder named `Catalog Authority Test`;
- the virtual folder points at `/media/catalog-authority-test-library`;
- the virtual folder does not point at a Gelato path;
- the library is empty or explicitly test-only before the first proof.

The preflight is read-only against Jellyfin and uses no provider, download, playback, scraper, or
Jellyfin write APIs.

## Resume Condition

Resume Stage 226 only after the preflight reports `ok:true`.
