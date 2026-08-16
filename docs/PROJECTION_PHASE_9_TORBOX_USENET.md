# Projection Phase 9 — TorBox plus usable Usenet

**Status: AUTHORIZED, NOT YET BUILT OR MEASURED.** Phase 8 is closed. The operator has chosen TorBox plus
Usenet as the active product scope and has deliberately deferred Real-Debrid. Nothing in this document calls
Real-Debrid implemented, failed or permanently rejected.

## 1. Product outcome

One installed alpha shall expose a single stable projection namespace containing both:

- TorBox-backed entries served by the already-proven resolver and HTTP Range path; and
- Usenet-backed entries admitted only after download, repair, unpacking and byte verification have completed.

Plex, Jellyfin and Emby shall see ordinary read-only files through the same `projectiond` mount. A Usenet
failure shall not empty, rename or make unavailable any already-admitted TorBox or Usenet entry.

## 2. Architecture decision

Usenet is not forced through `source.Resolver`. A mature Usenet worker performs NZB acquisition, article
download, yEnc decoding, PAR repair and unpacking outside the FUSE read path. Phase 9 integrates that worker
through its bounded local API and completed-download directory.

The control plane owns admission:

1. submit an operator-approved NZB or indexer URL without logging its value;
2. retain the worker's opaque job id;
3. observe queue/history through closed-set states;
4. refuse failed, incomplete, still-changing, symlinked or non-regular output;
5. hash and size the completed file;
6. publish it as a local source through the existing manifest contract; and
7. leave `projectiond`, its cache, mount recovery and read admission limits unchanged.

The first supported worker is SABnzbd. Its API credential is read from a restrictive file and is never placed
in argv, a manifest, a log, an error, a metric label or an inline environment value. The integration shall use
a dedicated category and dedicated incomplete/complete directories rather than scanning an operator's general
download tree.

## 3. Deliverables

- a fake SABnzbd-compatible service and boundary suite before any real server is contacted;
- a read-only client for status, queue and history plus the minimum submit operation needed by this phase;
- a durable job ledger that survives process and host restarts without submitting the same job twice;
- a completed-output admission service with no-follow path checks, stable-size confirmation and digesting;
- an operator command surface for submit, status, admit, retry-safe reconciliation and refusal diagnostics;
- a canonical Unraid compose/profile extension with restrictive secret and completed-download mounts;
- manifest production for admitted local files without changing TorBox locators;
- a mixed TorBox/Usenet gate through Plex, Jellyfin and Emby; and
- an operator runbook that distinguishes downloading, repairing, unpacking, ready-to-admit, admitted and
  refused without exposing provider or content identity.

## 4. Hard refusals

Phase 9 shall not:

- stream incomplete Usenet articles through FUSE;
- publish a path while the worker can still mutate it;
- follow a symlink or admit a device, FIFO, socket or directory as media;
- infer success from a job disappearing from the queue;
- delete completed media, SABnzbd history or operator input;
- let a Usenet outage alter the TorBox namespace;
- place an NNTP or SABnzbd credential in the projection daemon; or
- claim Real-Debrid support.

## 5. Closure rule

The phase is GO only when one frozen candidate demonstrates all of the following:

1. every offline boundary, redaction, path-safety, idempotency and restart test passes;
2. a real Usenet job reaches completed and is admitted exactly once;
3. one deliberately failed or incomplete job is refused and never appears in the manifest;
4. the mixed manifest contains at least one TorBox entry and one admitted Usenet entry;
5. Plex, Jellyfin and Emby each scan and read both entries through their existing pre-attached binds;
6. a SABnzbd restart and a catalog/control-plane restart submit no duplicate job and lose no admitted entry;
7. a Usenet outage leaves the TorBox entry readable and the mounted namespace stable;
8. projection restart, recovery, upgrade and rollback remain green using the existing focused regression
   gates;
9. secrets, NZB/indexer URLs, article ids and completed source paths appear in none of the preserved evidence;
10. cleanup leaves zero phase-owned mounts, transient containers, networks and volumes; and
11. the complete mixed-provider sequence passes three consecutive fresh times.

The hours-long Phase 8 soak is re-run only if Phase 9 changes shared projection mount, recovery, cache or
operator-command source. Provider/control-plane-only changes run the focused mixed-provider and existing
mount regression gates instead.

## 6. Explicit non-goals

This phase does not provide instant Usenet streaming, automatic source failover, indexer search, download
selection policy, Real-Debrid, a second host, high availability or a production release. It produces a
rough-edged TorBox-plus-Usenet alpha whose Usenet files become available after verified completion.
