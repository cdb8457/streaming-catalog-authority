# Phases 274–276 — a real offline snapshot, a real answer about the library, and a real lifecycle

Phase 259 gave an operator a file format and told them to write it. Phases 266–272 built a collection
lifecycle and proved most of it against a fake media server. Three things were still pretend: the snapshot
every acceptance imported was **checked into this repository**, there was no way to ask "which of my records
does my media server actually have?" without naming a collection and standing one confirmation away from
writing to it, and no test could **manufacture** the drift the Phase 271 audit exists to find.

| Phase | What it adds | What it changes |
| --- | --- | --- |
| **274** | `ops:catalog-snapshot-produce` — the canonical snapshot, produced offline from an operator-supplied export of an external system | Both acceptance gates now **produce** the snapshot they import, during the run |
| **275** | `ops:collections -- match` — read-only matching between imported records and library items | An operator can ask what would be found without turning any write switch on |
| **276** | A test-only fake-admin surface on the fake server, and the whole lifecycle against disposable state | Drift can be injected behind the product's back, so the audit is proved rather than assumed |

## Phase 274 — the snapshot is produced, not written by hand

**A different, closed schema for what somebody else's system hands this one.**
`catalog-authority.external-export` v1 is what an operator EXPORTS from their other tool — a Usenet or debrid
client, a media manager, a spreadsheet — into a local file. It is deliberately not the canonical snapshot: it
has its own vocabulary (`entryId`, `references[].kind`, `attributes`), its own bounds, and its own rejections.

**The transformation cannot perform I/O, and that is checked against its own imports.**
`src/core/catalog/external-export.ts` imports `node:crypto` and two sibling catalog modules and nothing else.
It opens no file, makes no network call, spawns no process and reads no environment variable — so "producing a
snapshot contacted nothing" is a fact about what the module is made of. Everything that touches a descriptor
is in `src/ops/catalog-snapshot-produce.ts`, which is small enough to read in one sitting.

**Acquisition data is refused whole, not filtered.** An export from a download tool naturally knows things
this product must never hold. Two independent rules close that:

* an attribute key in an **acquisition or media-location namespace** (`download`, `nzb`, `usenet`, `torrent`,
  `magnet`, `tracker`, `debrid`, `seed`, `stream`, `playback`, `path`, `file`, `folder`, `library`, `media`,
  `mount`, `symlink`, `link`, `url`, `uri`) is a rejection;
* any value **that points somewhere** — a URL, a `magnet:`, an absolute POSIX path, a UNC share, a Windows
  drive path — is a rejection, wherever it appears: an attribute value, a reference id, or the entry id.

A silent drop would have been worse than useless: it would let one reappear the moment somebody deleted a
filter, and nothing would notice. The `external.` attribute namespace is reserved, so an export cannot forge a
provenance key either.

**Provenance is structural.** The produced snapshot's source is `external.<system>`, so every derived item id
is a function of it (`deriveItemId`) and the record's own `externalIds` map is keyed by it — which is what the
catalog panel and the export already display. There is no separate provenance field to strip or forget, and a
hand-written snapshot using the same external ids addresses **different** records.

**The output is deterministic to the byte and proved importable.** Items ordered by external id, references by
type, attributes by key; two-space JSON with one trailing newline; nothing consults a clock, a random source,
the environment or the filesystem. Then `produceCatalogSnapshot` parses its own output **with the shipped
importer** before returning it — so a snapshot this command emits is known to be importable rather than
believed to be.

**The write is atomic and symlink-safe.** The bytes go to a dot-prefixed temporary file in the same directory,
created with `O_CREAT | O_EXCL` (which fails if the name exists at all, including as a dangling symlink — the
check IS the creation, so there is no window), `fsync`ed, then published to the destination name in one step.
A reader — including this product's own import inbox, watching that folder — sees the old file or the complete
new one, never a prefix. A crash leaves the temporary file, whose leading dot the inbox's own name grammar
refuses. The destination is `lstat`ed and refused if it is a symlink. **Nothing creates a directory.**

**"No overwrite" is a guarantee, and `rename` could not have given it.** The first version of this module
`lstat`ed the destination, refused if something was there, and then published with `renameSync`. Both halves
are individually correct and the pair was still wrong: `rename` replaces its destination unconditionally, so
two producers that both found the name free would both write a temp and both rename — and the second would
silently destroy the first completed snapshot, under a flag whose entire documented meaning is that it will
not do that. Without `--overwrite` the publish is now `link(temp, destination)`, the POSIX primitive that
**fails when its destination exists**, atomically, with `EEXIST`, decided by the kernel rather than by
something this process observed a moment earlier. The temporary name is then unlinked. With `--overwrite` it
is still `rename`, because replacing is then what was asked for.

That hard link is between two names of one snapshot file in one directory and lives for microseconds. It is
not a symbolic link, it does not point into a media library, and the absolute invariant is untouched — the
suite now asserts *that* (no symbolic-link call anywhere in the module; a published snapshot is not a symbolic
link; exactly one link call, and it is the publish) instead of forbidding the one primitive that makes the
refusal honest. A filesystem with no hard links gets a **refusal**, not a silent fallback to a `rename` known
to clobber; the same discipline the import inbox applies to `O_NOFOLLOW`.

**The published file is 0644 and the temporary one is 0600.** A partially written document is never readable
by anyone else; the descriptor is `fchmod`ed after the last byte and before the publish, and that mode change
is `fsync`ed in its own right — it is metadata, and metadata that is not durable before the publish is a
permission the same power cut can take away from data that survived. That is not cosmetic: the shipped stack
bind-mounts the import folder into a container running as a **different uid**, so a snapshot produced on the
host at 0600 is a snapshot the product itself cannot read.

**And that step fails closed.** Its first version swallowed every error with a comment about Windows, which is
true of exactly one platform and false of the others: on POSIX an `EPERM` or an `EROFS` would have published a
0600 snapshot and reported success, and the run that discovered it would be the import that could not read the
file. Windows is now *asked for* rather than inferred from a failure — it has no POSIX mode bits, so the step
is skipped there — and everywhere else a failure removes the temporary, publishes nothing, and says so with
the errno code (which names a rule, never a path). Both branches are proved on any host through an injected
platform-and-syscall surface, because a test that could only exercise its own platform's branch is how the
swallow got there in the first place.

**Diagnostics name a position, never a key.** A key in somebody else's document is a value: an attribute key
can be a URL, an absolute media path, an api token or a film title, and an "unknown key: `<key>`" message
would print it to a terminal, a CI log and whatever gets pasted into an issue — while the check that produced
it exists precisely because that key is the hostile part. Every rejection therefore names a position (`entry
12`, `references[1]`, `attributes[3]`) and, where it helps, the closed set of names that *are* allowed, which
is strictly more actionable than echoing the wrong one.

**The produced name is one the import inbox will offer** (`INBOX_NAME_RE`), so produce → preview → apply has no
hole in the middle of it. `CATALOG_SNAPSHOT_OUT_DIR`, when set, applies the same containment discipline to
writing that `CATALOG_IMPORT_DIR` applies to reading: a bare name only, resolved inside the realpath'd folder.

**The report is redaction-safe by construction:** counts, digests, closed-set words and a base name. No title,
reference value, attribute value, directory or absolute path appears in it, and it declares `network: none`,
`acquisition: external-input-only`, `mediaAccess: none` and `symlinksCreated: 0`.

**And it does not say WHICH external system.** It carried `system: "torbox"` and `source: "external.torbox"`
while calling itself redaction-safe — which is to say it told a support bundle which acquisition tool the
operator runs, and its own test was named "no external system detail" while never checking that sentinel.
Both fields are gone; the report says `provenance: external-input` and nothing more. The **snapshot** still
carries `external.<system>`, because that is where provenance belongs and every derived record id is a
function of it, and the suite now asserts both halves: the label is in the file, and it is not in the report.

## Phase 275 — which of my records does my library actually have?

`npm run ops:collections -- match`. One switch, no name, no selection, no digest, and nothing written.

**It runs on the READ switch alone.** `JELLYFIN_ENABLE_NETWORK` — the same single switch Phase 266's discovery
and Phase 271's audit need. Requiring the write switches for a read would mean an operator has to turn
**writing on** to find out whether anything would be found. The other three switches are **reported** in the
result, so a report says what state the installation was in when it was taken.

**The object graph is the boundary.** It borrows Phase 271's audit runtime, whose target's `create`,
`addMembers`, `removeMembers` and `remove` all throw. It calls exactly one method on it — `resolve` — and holds
no pool writer, no outbox, no ledger and no history store. It is deliberately **not** recorded in the durable
plan history either: every other row there describes a decision about a collection, and this command names no
collection and authorises nothing.

**Provider identity goes nowhere.** Matching is local, as it has been since Phase 11: the candidate listing is
fetched with its `ProviderIds` and compared here. A reference value never becomes a query parameter, a path
segment, a header or a search term — asserted against the request lines the fake server actually **received**,
because only those can show what was transmitted.

**Five outcomes, and the last three are why it exists:**

| | |
| --- | --- |
| `matched` | the library holds at least one item carrying one of this record's references |
| `unmatched` | the scan was **complete**, the record has references, and none is in the library |
| `no-references` | the record has nothing to match **by**. A property of the record, not a statement about the library |
| `unreadable` | forgotten, shredded or key-inactive. Never decrypted, never judged, never "missing" |
| `unknown` | this pass could not see enough to say |

A listing that failed and a listing that hit its page bound both make every record they would have judged
`unknown`, and the report says `libraryComplete: false`. Reporting "your media server does not have these"
from a listing that stopped early is the same false proof Phase 270's removals and Phase 271's audit refuse,
and a report is not exempt from it because it writes nothing — an operator acts on a report.

**What it will not print:** no title, no year, no reference value, no Jellyfin item id (not even a digest of
one), no server address, no api key, no external handle, no correlation token, and nothing from an acquisition
system. What it carries is the opaque catalog record id the operator already holds, a closed-set verdict, a
bounded count, and the reference **types** — six closed words that identify nothing.

## Phase 276 — the lifecycle, against disposable state

**The fake server can now be mutated behind the product's back.** Phase 271 could detect membership drift;
nothing could manufacture it, because every route the acceptance had was one the product itself drives — so a
"drift" produced through them was the product agreeing with itself. Real drift is somebody opening Jellyfin's
web UI and dragging a film out of a collection.

`deploy/ci/acceptance/fake-jellyfin/server.mjs` therefore gained a **fake-admin** surface:

| | |
| --- | --- |
| `POST /_control/membership?id=&add=&remove=` | mutate a collection's membership directly — drift injection |
| `POST /_control/fail-next?read=items\|boxsets\|members` | the next such read answers 500, once |
| `POST /_control/lose-next-create` | the create succeeds server-side and drops its response (Phase 268) |
| `GET /_control/state` | what the server holds, including how many collections carry this product's marker |

**It is never shipped in production runtime code, and four independent things say so.** It lives only under
`deploy/ci/acceptance/`; no file under `src/` names `/_control/` or `JELLYFIN_FAKE_ADMIN`; the production image
copies `src` and nothing from `deploy/`; and the consumer release bundle generator names no acceptance
artifact at all. **It is off unless `JELLYFIN_FAKE_ADMIN=enabled` exactly** — `true`, `1`, `Enabled` and
`enabled ` all leave every `/_control/` path answering 404 as if it did not exist. That is proved by *running*
the server twice rather than by scanning for the string, because a static scan would pass against a server
that read the variable and ignored it. Everything it adds is namespaced under `/_control/`, which no Jellyfin
route uses, so the product cannot reach one by accident. The application container is never told the switch
exists: it is the fixture's, not the product's.

**The write gates now all start closed.** `JELLYFIN_ALLOW_LIVE_PUBLISH` used to be hard-coded `true` in the
acceptance override; it is now a parameter with a fail-closed default like the other two. The run therefore
begins with the read switch on and **all three write switches closed**, proves a queue is refused with
`WRITES_DISABLED` and that the refusal wrote nothing and contacted nothing, and only then opens all three
together, by name, for one stage of one disposable stack.

**The lifecycle the gate now runs, in order:**

1. the snapshot is **produced** from an external export, and the shipped image produces byte-identical output
   from the same input (Phase 274);
2. a shipped installation with no configuration reports `DISABLED` and contacted nothing;
3. every write gate closed → a queue is refused and names the gate;
4. read-only **match** (Phase 275) with every write gate still closed, writing nothing, and reporting
   `unknown` rather than absence when a one-shot library-read failure is injected;
5. read-only discovery and a zero-write preview in a real browser;
6. the three write switches opened deliberately, inside this stack only;
7. digest-confirmed queue → durable state only, nothing sent;
8. reconcile: a lost create response adopted **by token**, no duplicate; a third pass does nothing at all;
9. restart of the application and database while the external fake keeps running; adoption and idempotence;
10. **membership drift injected** in both directions through the fake-admin surface;
11. an audit that notices `missing: 1` and `extra: 1`, writes nothing, and changes nothing on either side;
12. a one-shot member-listing failure → `unknown`, never repairable; the immediate retry judges it again;
13. a **stale** repair confirmation refused, and a **wrong** digest refused;
14. a confirmed repair that writes durable state only, then a reconcile, then **exact** membership verified
    against the ids the collection held before the drift, and a final audit that says `ok`;
15. partial erasure: forgetting one member takes its items out and leaves the collection standing;
16. a browser-driven revoke, end to end, which this script deliberately does not finish for it;
17. **zero** Catalog-Authority-managed artifacts left: no collection carrying the `[cat:` marker, no
    outstanding managed rows, no membership rows, no per-record ledger rows — and the **foreign** collection
    the fixture also holds is still there, untouched.

## The absolute invariant, and the guards that keep it

Catalog Authority never downloads, scrapes, plays, streams or acquires media, and never creates a media
symlink. Usenet acquisition and symlink creation are **external systems that can provide explicit local inputs
only**. This tranche adds three static or behavioural guards that would catch an accidental coupling:

* the transformation module's import list is asserted to be `node:crypto` and siblings, and its text is
  scanned for `node:fs`, `node:http`, `node:net`, `node:dns`, `node:child_process`, `process.env` and a
  transport call;
* the writing module is scanned for `symlinkSync`, a bare `linkSync` (and **not** the `unlinkSync` it is a
  substring of, which the temporary-file cleanup legitimately uses), directory creation, and the same
  network modules;
* the matcher is scanned for every durable-model writer, for the four mutating target methods by name, and
  for a transport of its own — and the one target method it does call is asserted to be `resolve`.

## Compatibility and schema

**No schema change, no migration, and no new database role.** Phase 274 writes a file; Phase 275 reads
`items`, `item_key_control` and `provider_refs` through the same `CatalogReader` and `CatalogAuthority` the
catalog panel already uses; Phase 276 changes only test fixtures and the acceptance orchestrator. The release
coordinate stays **v1.1.4**.

`example-catalog-snapshot.json` and the hand-written snapshot format are unchanged and still supported: an
operator who writes a snapshot by hand does not need the producer at all.

## Proof

| | |
| --- | --- |
| `npm run test:phase274-local` | `test/external-snapshot-produce.ts` — the transformation cannot perform I/O; the writing module creates no symbolic link, no media link and no directory, and its one link call is the publish; no production caller touches the publish-window seam; the closed schema in every direction; every acquisition namespace and every location-shaped value refused; input, entry-count and **produced-output** bounds; byte-identical determinism independent of export order; the output parsed by the shipped importer; structural provenance and the ids it derives; a preview writing nothing; an atomic write whose on-disk bytes equal the reported digest; **a destination that appears inside the publish window is not replaced and the rival's complete bytes survive**; **two no-overwrite publishers cannot both succeed**; a published snapshot is a plain regular file, readable by another uid and writable by no one else; a symlink destination refused with its target untouched; the produced name offered by the real inbox listing; output-directory containment; a redaction scan of the report and the JSON **including the external system's own label**; **hostile-key sentinels across root, entry, reference and every attribute branch, and on the CLI's own stderr**; and the strict CLI parser. |
| `npm run test:phase275-local` | `test/jellyfin-library-match.ts` — against a real embedded PostgreSQL and a fake media server over real HTTP: the module reaches for no writer; the read-only target refuses every write; the read switch alone; every write gate closed and reported; all five outcomes; a whole session writing nothing in any table; determinism to the digest; a failed library read producing `unknown` and **not one** inferred absence; a forgotten record leaving the comparison entirely; the transport ledger showing only `GET /Items` and `GET /System/Info` and no write route; opening the write switches changing nothing; and a full disclosure scan of everything the command printed. |
| `npm run test:phase276-local` | `test/disposable-collection-lifecycle.ts` — the fake-admin surface is in no file under `src/`, in no `COPY` of the production image and in no release-bundle artifact; it is off unless the exact switch is set, proved by **running** the server with five near-miss values; drift injection and one-shot read failures really work; the Jellyfin surface still requires the api key; the override starts with every write switch closed; and the orchestrator opens them only after proving the refusal, stages every step of the lifecycle, and names no real service, media path or registry in anything it executes. |
| `npm run test:phase262-local` | `test/catalog-browser-acceptance.ts` — updated: the gate PRODUCES its snapshot, the ready-made canonical fixture is gone, and the shipped image is made to produce byte-identical output. |
| `npm run test:phase268-acceptance` | `test/jellyfin-control-acceptance.ts` — updated: the fake library and the **produced** snapshot agree. |
| `npm run test:phase250-local` | `test/release-readiness.ts` — updated: removing **any** required suite from the CI suites job blocks `suites-run-the-acceptances`, one mutation per suite rather than one for the whole list, and the suites job's name may not state a phase range it cannot keep current. The mutation table is now driven by `REQUIRED_SUITE_SCRIPTS` and `REQUIRED_SUITES_TYPECHECK_COMMAND` **imported from the check itself**: it had been a second hand-typed copy under a comment claiming otherwise, which is the same silent-drift defect one level up. |
| `deploy/ci/catalog-acceptance.sh`, `deploy/ci/jellyfin-control-acceptance.sh` | drive the shipped image, the migration, a real Chromium and a local fake Jellyfin through the whole thing. **NOT RUN for this change — see below.** |

## Verification status

`npm run typecheck`, the three new suites above, the affected existing suites
(`test/catalog-browser-acceptance.ts`, `test/jellyfin-control-acceptance.ts`, `test/catalog-import.ts`,
`test/collection-plan-preview.ts`, `test/collection-execution.ts`, `test/collection-drift.ts`,
`test/collection-cli.ts`, `test/jellyfin-control-plane.ts`, the backup and release suites) and the aggregate
`offline` and `db` groups were run and passed on this branch.

The Docker/Chromium acceptance gates **were not run, and nothing here should be read as saying they passed.**
The environment this tranche was built in has no Docker daemon reachable from the workspace, which is the same
blocker Phases 269–272 recorded and is environmental. What that leaves unproven by execution here is exactly
the set of legs the two orchestrators add — the produced-snapshot legs, the read-only match leg, the drift
injection, the stale-repair refusal and the exact-membership verification — each of which has a static
contract assertion in `test/disposable-collection-lifecycle.ts` and a behavioural assertion in the two focused
suites against a real database and a real HTTP server. That is a check of the gate, not a run of it.

Run them with:

```
REQUIRE_ACCEPTANCE=1 bash deploy/ci/catalog-acceptance.sh
REQUIRE_ACCEPTANCE=1 bash deploy/ci/jellyfin-control-acceptance.sh
```

on a host that can reach a container registry, or rely on the CI jobs `catalog-acceptance` and
`jellyfin-acceptance`.

## Limitations

* **The producer is not an integration.** It never contacts the external system, authenticates to it, polls it
  or names it in a request. An operator exports by hand and this reads the file. That is the whole design, and
  it is the reason the absolute invariant survives the feature.
* **An export's reference vocabulary is closed.** A system that spells a reference some other way is rejected
  rather than silently losing the reference — which is the right failure, but it does mean adding a spelling
  is a code change.
* **`match` answers about references, not about titles.** A record with no provider reference is
  `no-references`, permanently; this product does not guess a library item from a title, and adding that would
  be exactly the fuzzy matching that makes a collection hold the wrong film.
* **`match` reads the library, not the collections.** It says what would be found; it says nothing about what
  is currently in any managed collection. That is `audit`, and it is a different question.
* **The fake-admin surface is unauthenticated.** It is the harness talking to its own fixture over a private
  Compose network with no host port, and adding a second secret to it would prove nothing and would put
  another key in the run. It is off by default and cannot ship; those are the properties that matter.
* **The lifecycle gate proves the product against a fake.** A real Jellyfin still differs in ways a double
  cannot capture; the opt-in `smoke:jellyfin` path remains the only thing that speaks to that, and it is still
  not part of any automated gate.
