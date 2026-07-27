# Phases 269–272 — the collection lifecycle

Phases 266–268 built a control plane that could *act* on a media server. It acted on the wrong noun. This
turns it into something an operator can actually run: one plan, one collection, kept honest, auditable, and
drivable from a terminal.

| Phase | What it adds | What it changes |
| --- | --- | --- |
| **269** | Plan-level semantics and a durable managed-collection model (**schema v9**) | One accepted plan is now **one** collection |
| **270** | Grouped apply, reconcile and revoke | Membership is reconciled by set difference; erasure removes members |
| **271** | A read-only drift audit and an explicitly gated repair | Belief and reality can be compared, and the difference fixed on purpose |
| **272** | `npm run ops:collections` and the full acceptance loop | The whole lifecycle runs headless, through the same services |

## The thing that was wrong

Phase 267 named the *plan*. Phase 268 executed it as **one Jellyfin collection per catalog record**, each named
after that record. The Phase 266–268 document said so plainly, in its Limitations, and it was still the wrong
product: an operator who types a name and ticks thirty records has described **one** collection with thirty
things in it. A field labelled "collection name" that names no collection is a promise this product was not
keeping.

## Phase 269 — the managed collection

**A collection has its own durable identity, and it is derived from the name.**
`collectionKeyFor(target, name)` is a domain-separated digest of the target and the operator's own label.
Deriving it rather than minting a random id is what makes re-planning the same name an **update of the same
collection** instead of a second collection with the same name — the one property the whole phase turns on.

**A new table, not a new column on `publish_ledger`.** Making the ledger express a group would mean either
overloading `item_id` (which is CHECKed as a record uuid, and which the revocation driver joins to `items`) or
widening the active-uniqueness index that stops two confirmed executes from creating two external copies. Both
weaken a rule that already carries evidence. So `managed_collections` and `managed_collection_members` carry the
group, and the ledger goes on meaning exactly what it always meant.

**Membership is stored by catalog record id and never by Jellyfin item id.** That is not an accident of
convenience — storing the matched library ids would make membership *survive crypto-shredding*: after a forget
the record's identity is unrecoverable, but a stored external id would still say precisely which library items
came from it. The reconciler resolves ids afresh each pass through `withPublishableIdentity`, which fails closed
on a forgotten record.

**A member row has no foreign key to `items`.** Same reason `publish_ledger` has none: the row must survive
`forget`, because it is what drives the external cleanup. A cascade would delete the only durable evidence that
an external copy needs removing.

**What a plan says now:**

| Collection action | |
| --- | --- |
| `create` | no managed collection by that name |
| `update` | it exists and its membership or state differs |
| `unchanged` | it exists and already holds exactly this |
| `revoke` | it would hold nothing, or the operator asked for it to go |
| `blocked` | none of the selection can go in, and there is nothing out there yet |

| Member action | |
| --- | --- |
| `add` | selected, readable, has references, not yet a member |
| `keep` | already a member and still selected |
| `remove` | deselected, forgotten, out of references, or already queued to leave |
| `blocked` | cannot go in: unreadable, or no provider reference to match a library item with |

**Erasure outranks the selection.** A member whose record is forgotten is `remove`, whether or not it was
selected. A record that is merely deselected is `remove` too — but only within the collection the operator just
re-specified by name, which is a different thing from the Phase 267 rule that a plan must never propose
revoking an external copy it was not asked about.

**Both digests still mean what they meant.** The **plan digest** covers what would be done; the **basis digest**
covers what it was decided from — every considered record's identity (references hashed, never listed) *plus the
managed collection's own durable state*. A collection that settled between preview and confirmation moves the
basis without moving the plan, which is exactly the class of change a single digest would miss.

**The name is now the collection's name, and that REMOVES a disclosure.** Through Phase 268 the external
collection was named after the record it held — a decrypted catalog title, sent to a media server. A grouped
collection is named after a string the operator typed into this product's own form. The create's declared
disclosure narrowed accordingly, from `['title','providerRefs']` to `['providerRefs']`.

**The closed grammar is unchanged**, and is now enforced by two CHECKs (the audit history's and the collection
table's) as well as the planner. `[` and `]` stay excluded because they delimit the `[cat:<token>]` recovery
marker.

## Compatibility — what happens to the v8 rows

**Nothing.** A per-record collection created before this phase is still a per-record collection: still in
`publish_ledger`, still tracked, still revocable, still swept by `cat_publish_reconcile_forgotten`, and still
finished by the Phase 12 engine on the next reconcile. There is **no** data migration, **no** reinterpretation
and **no** adoption:

* The planner **counts** them (`plan.legacy.perItemLive`, `…LiveSelected`, `…RevokePending`) so an operator can
  see they exist, and reports them in `status` under `legacy`.
* A legacy row for a selected record does **not** make that record "already a member" — it is still an `add`.
* Legacy counts are deliberately **outside both digests**: no action in a grouped plan is decided from them, so
  a legacy row settling must not make an unrelated plan stale.
* `runCollectionReconcile` and `runCollectionRevocation` each run **both** engines and report both results
  separately. A forgotten record's older per-record copies still come back.

The migration is additive and idempotent: two tables, sixteen `SECURITY DEFINER` functions, their grants, and one
`CHECK` replacement on `collection_control_history.action` so an already-deployed v7/v8 database gains Phase
271's two verbs. There are no down-migrations; the supported rollback is the pre-upgrade backup, as it has been
since Phase 6.

## Phase 270 — apply, reconcile, revoke

**Execute is still queue.** `queueCollectionPlan` writes the managed collection row and its membership and
returns. It contacts nothing. The durable record exists before any side effect, so a container that dies in
between leaves rows a later pass acts on rather than a change nobody recorded. The response says
`"wrote": "durable collection state only"` and `"contacted": "nothing"`.

**Idempotency is one atomic statement.** `cat_collection_upsert` is backed by a partial unique index over every
*active* `(target, collection_key)` pair. Two independently confirmed executes racing the same plan cannot both
insert: one owns the collection, the other adopts it, and **neither can change the correlation token** — a
changed token is an orphaned external artifact. The queue path takes the same per-collection advisory lock the
reconciler takes, so a membership rewrite cannot land halfway through a pass.

**Reconcile is still recovery by token.** Found → adopt the handle. Provably not found → create, within a
bounded retry budget. **Lookup failed → do nothing**, because "I could not see it" is not "it is not there".
Phase 261's durable proof still governs, and is now read across *both* tables: the marker is the same marker on
the same server, so a proof made by either engine is evidence about the target.

**Membership reconciles by set difference, and that is what makes erasure work.**

```
intended = ⋃ resolve(refs of each readable member)      # withPublishableIdentity: fails closed
current  = the collection's library items
add      = intended − current
remove   = current − intended                            # only when BOTH reads were complete
```

A forgotten member resolves to nothing, falls out of `intended`, and its library items are removed as "present
but not intended" — **without this product ever having recorded what they were**.

**No removal is ever computed from partial knowledge.** A resolution that threw, and a listing that hit its page
bound, both mean the pass does not know the full set. Additions still happen (adding what belongs is safe under
any uncertainty); removals are deferred to a pass that can see everything. `JellyfinHttpClient` gained
`findItemsByRefsChecked` and `listCollectionItemIdsChecked` precisely so a bound that is hit is *reported*
rather than absorbed.

**An emptied collection is deleted, not left empty.** The test is the *recorded* membership, not the resolved
one: a collection whose members all still exist but match no library item has a library problem, and deleting an
operator's collection over that would be a destructive answer to a benign situation.

**Removing a collection is something an operator asks for, on either surface.** `mode: 'revoke'` — the
panel's "Remove this collection from the media server instead" checkbox, or the CLI's `--revoke` — produces a
plan whose action is `revoke` and whose members are all `remove`. It takes no selection: a caller who sends one
has misread what it does, and being told is better than being surprised. It is confirmed by digest like any
other plan, and it queues; the revoke pass is what deletes.

**Revoke creates nothing.** It sweeps the forgotten, takes their items out of the collections that survive,
deletes the collections that must go, and then runs the per-record revocation for the v8 rows. A delete that
fails leaves the row `revoke_pending` and retryable — an unrevoked external copy of a forgotten record is the
worst state this product can be in, so it stays visible rather than being marked done. `not_found` is success:
already gone is the state a revoke is trying to reach.

## Phase 271 — drift audit and gated repair

**An audit is a read, and the object graph says so.** `createCollectionAuditRuntime` hands the auditor a target
whose `create`, `addMembers`, `removeMembers` and `remove` methods **throw**. It requires only
`JELLYFIN_ENABLE_NETWORK` — the same single switch Phase 266's read-only discovery needs — because demanding the
three write switches for a read would mean an operator has to turn writing **on** to find out whether something
is wrong.

**Why that narrower gate does not touch the consent boundary.** `PUBLISH_EXTERNAL_IDENTITY` gates identity
*leaving* the crypto-shredding boundary. An audit decrypts identity in process — which an authenticated
operator's catalog panel already does, with no media-server switch at all — and **sends none of it**: reference
matching is local, so the candidate listing is fetched and compared here and a reference value never becomes a
query parameter. That is asserted directly, against the request lines the fake server received rather than
against the responses this product produced, because only the former can show what was transmitted.

**Six verdicts, and the third one is the point:**

| | |
| --- | --- |
| `ok` | the collection holds exactly what is intended |
| `unsettled` | it never settled; the reconcile path owns it |
| `membership-drift` | items missing, extra, or both |
| `external-missing` | the token lookup was authoritative and found nothing |
| `revoke-outstanding` | the revoke pass owns it |
| `unknown` | **this audit could not judge it** — and it is never repairable |

A lookup that failed, a listing that failed, a listing that hit its bound, a resolution that could not complete,
and a target whose recovery proof is not `verified` are all `unknown`. The failure this prevents is the obvious
one: a media server that is down for a minute must not be read as "every collection has been deleted", because
the repair for *that* reading is to recreate them all.

**A repair writes durable state only.** `recreate` **re-arms** the collection to `planned` and drops a handle
that names nothing; it does not create. `sync` flags a membership comparison. `revoke` queues the deletion the
revoke pass already performs. Anything external happens on the next reconcile or revoke pass, under those
passes' own gates — so a repair can never be a shortcut past one.

**And a repair that was wrong ends in an adoption.** Re-arming deliberately **keeps the correlation token**, so
if the artifact is actually still there, the next reconcile finds it by that token and adopts it rather than
making a second one.

**A repair is confirmed like a plan, by a different issuer.** Four switches, a single-use signed confirmation
issued by the audit, the operator's own echo of the repair digest — and then the audit is **re-run** and both
digests must still match. The repair issuer holds its own HMAC key, so a plan confirmation cannot verify as a
repair confirmation: they authorise different writes.

## Phase 272 — the operator CLI

`npm run ops:collections -- <command>`:

| | |
| --- | --- |
| `preview` | what would happen, and the digest. Writes nothing, contacts nothing. |
| `apply` | queue a previewed plan. Requires `--confirm-digest`. Contacts nothing. |
| `status` | the managed model and the legacy per-record rows, separately |
| `audit` | read-only drift comparison, and the repair digest |
| `repair` | apply a digest-confirmed repair. Durable state only. |
| `reconcile` | create, adopt by token, make membership match |
| `revoke` | take the forgotten out, delete what must go |
| `history` | the durable record of every decision |

**It is not a second implementation.** Every command calls the function the HTTP route calls —
`checkCollectionWriteGates`, `buildCollectionPlan`, `queueCollectionPlan`, `runCollectionReconcile`,
`runCollectionRevocation`, `auditCollectionDrift`, `buildCollectionRepairPlan`, `applyCollectionRepair` — and the
suite asserts that the command module imports no Jellyfin client, no transport and no `node:http`. Only the
entrypoint resolves a transport, and only when `JELLYFIN_ENABLE_NETWORK` is exactly `"true"`.

**What it does not carry is the signed confirmation token, and that is deliberate.** The token exists to bind a
preview performed in one HTTP request to an execute performed in another, across a browser that could replay it.
In a terminal the preview and the apply are the same process, microseconds apart, with no intermediary — the
token would be this process signing a note to itself. The part a human states on purpose is the **digest**, and
the digest is required, compared with `digestEchoMatches` (the same constant-time comparison the routes use),
against a plan **recomputed at the moment of the write**.

**Its output is stricter than the browser's, on purpose.** A panel shows an authenticated operator a title in
their own browser; a terminal writes to scrollback, to a CI log, to a support bundle somebody pastes into an
issue. So this surface prints the opaque record id — which is what the next command takes as input — and never a
title, a year, a provider reference, a Jellyfin id, an external handle, a correlation token, an api key or an
address. `--json` prints the same plan with `title` and `year` **removed** (not blanked), never a fuller one.

## What did not change

* **The four switches**, each independent, each fail-closed, none implying another. A repair is a write and needs
  all four; an audit is a read and needs the first.
* **Authentication.** Same operator token, same header, same boundary.
* **`withPublishableIdentity`.** Every resolution runs inside it, so a forgotten or shredded record discloses
  nothing — which is also what makes its removal work.
* **The consent gate**, now asserted by the grouped engine on its own terms as well as at the deployment gate.
* **Crypto-shredding.** Nothing durable, in either new table, survives a forget in a form that could identify
  what was erased.
* **`createCollection`** (the bare, untracked create) is still hard-disabled.

## Proof

| | |
| --- | --- |
| `npm run test:phase269-local` | `test/collection-plan-preview.ts` — one plan is one collection; the derived key; re-planning updates; deselection removes; erasure outranks selection; determinism to the digest; the basis moving without the plan; the closed grammar in both CHECKs; the v9 model's identity-free columns; no FK to `items`; the one-active-collection invariant; `set_members` semantics; the v8 rows reported and untouched; a whole planning session writing nothing. |
| `npm run test:phase270-local` | `test/collection-execution.ts` — the four gates; the narrowed disclosure; one execute → one collection; replay and staleness refused; one collection on the real server holding both items, named by the operator; add-only and remove-only set differences; **no removal from a failed listing or an incomplete resolution**; a lost create response adopted by token; a failing lookup creating nothing; restart persistence; partial and total erasure; a failed delete staying queued; the v8 engine still finishing and revoking; cross-origin/body-bound refusals; a full disclosure scan. |
| `npm run test:phase271-local` | `test/collection-drift.ts` — the read-only target refusing every write; an audit writing nothing at all; external deletion and two-way membership drift detected; every failure mode as `unknown` and never repairable; recovery-untrusted suppressing recreate; a repair changing nothing external; a wrong re-arm ending in adoption; audit-vs-repair gating; the separate confirmation issuer; a stale repair refused. |
| `npm run test:phase272-local` | `test/collection-cli.ts` — strict parsing; the shared services; the digest echo; a closed switch refusing; the whole loop end to end; audit read-only and repair gated; revoke end to end; the same durable history; and a scan of everything the command line printed. |
| `deploy/ci/jellyfin-control-acceptance.sh` | drives the shipped image, the migration, a real Chromium and a **local fake Jellyfin** through the grouped lifecycle. **NOT RUN for this change — see below.** |

## Verification status

The four suites above, `npm run typecheck`, and the aggregate `offline` and `db` groups were run and passed.
The Docker/Chromium acceptance gate **was not run, and nothing here should be read as saying it passed.**

**What was attempted, verbatim:**

```
$ docker info --format '{{.ServerVersion}}'
29.6.1
exit=0

$ timeout 90 docker pull hello-world
Using default tag: latest
exit=124                      # 124 = timed out; the pull never progressed past the tag line

$ timeout 300 bash deploy/ci/jellyfin-control-acceptance.sh
==> prerequisites
    docker daemon reachable, node present, pinned Playwright harness present
==> assemble the consumer release bundle and extract it
    extracted v1.1.2 standalone to a directory named catalog-authority-operator-ui-v1.1.2
==> the shipped bundle wires no media server and turns no switch on
    the shipped bundle names no JELLYFIN_ setting anywhere
==> build the production image locally (local-only tag, never published)
#0 building with "desktop-linux" instance using docker-container driver
#1 [internal] booting buildkit
#1 pulling image moby/buildkit:buildx-stable-1
                              # stalled here until the bound killed it; teardown ran
```

**The blocker, precisely:** the environment has a working Docker daemon but no route to a container registry.
The gate must build the production image, and BuildKit must first pull `moby/buildkit:buildx-stable-1`. It
never arrives. This is environmental and says nothing about the change.

**Why the gate's own `skip()` did not catch it.** Its prerequisite check asks whether the daemon is
*reachable* — and it is. A reachable daemon with an unreachable registry is indistinguishable from a working
one until the first pull. A registry preflight was deliberately NOT added: under `REQUIRE_ACCEPTANCE=1` a
`skip` becomes a hard failure, so a probe with any timeout would turn a CI runner with a merely slow registry
into a red build. Trading a real gate for a convenience on one laptop is the wrong direction.

**What therefore remains unproven by execution here**, and should be run before this branch is merged:

* the shipped image, the migration one-shot and the operator token end to end;
* the browser legs (`@jf-disabled`, `@jf-discovery`, `@jf-plan`, `@jf-refused`, `@jf-queue`, `@jf-reconcile`,
  `@jf-history`) against a real Chromium, including the panel changes this phase made to them;
* the orchestrator's new Phase 269-272 steps: one collection rather than one per record, partial erasure
  leaving the collection standing, the drift audit noticing an externally deleted collection without changing
  durable state, a refused repair digest, and the operator CLI parity leg.

What IS covered without it: every one of those behaviours has an assertion in the four suites above, against a
real PostgreSQL and a fake media server over real HTTP. `test/jellyfin-control-acceptance.ts` (12 assertions,
offline) additionally checks that the orchestrator asserts each new claim, that every spec tag it runs exists
and every spec tag is run, and that helpers are defined before their first use. That is a static check of the
gate, not a run of it.

Run it with:

```
REQUIRE_ACCEPTANCE=1 bash deploy/ci/jellyfin-control-acceptance.sh
```

on a host that can reach a registry, or rely on the CI job `jellyfin-acceptance`.

## Limitations

* **A managed collection is owned by its plan.** Items added to it by hand in Jellyfin are `extra` to the audit
  and are removed by the next reconcile. That is what makes forgetting work at all, and it is the reason the
  planner refuses to touch a collection it did not create (no `[cat:…]` marker, no management).
* **The collection name is the durable identity.** Renaming a collection in this product's own form addresses a
  *different* collection; the old one stays managed under its old name until it is revoked. Renaming the artifact
  in Jellyfin's UI is invisible to the token lookup only if the marker survives — if somebody strips the marker,
  the audit reports `external-missing` and a repair would recreate it, leaving the renamed one untracked.
* **Membership is resolved, not stored.** A record whose provider references match nothing in the library
  contributes nothing, and a collection whose members all match nothing is reported `unresolved` rather than
  created. That is visible in `status` and in the reconcile counts, but it is not an alert.
* **A collection that exhausts the retry budget is terminal.** It is marked `failed`, surfaced in `status`, and
  needs a fresh plan; the same name then starts a new collection with a new token. It cannot leave an
  untracked artifact behind: a pass only reaches the budget check *after* the token lookup returned nothing,
  and a lookup that cannot be trusted defers before the check rather than reaching it.
* **Two steps, still.** Queuing is not doing. That is the property that makes a crash survivable.
* **The audit does not enumerate a media server.** It looks at the collections this installation created, by
  their own tokens. A collection this product created and then lost every record of is not findable by it.
