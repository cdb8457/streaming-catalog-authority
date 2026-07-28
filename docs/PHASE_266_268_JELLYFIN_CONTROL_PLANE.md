# Phases 266–268 — the Jellyfin control plane

Everything before this could describe a catalog. This can act on one — carefully, in three steps, each one
harder to reach than the last.

| Phase | What it adds | What it can do |
| --- | --- | --- |
| **266** | An authenticated connection and a read-only discovery surface | Count. Nothing else. |
| **267** | Deterministic planning and a zero-write preview | Decide, from local state only. |
| **268** | An explicit, digest-confirmed execution workflow | Queue, carry out, retry, revoke. |

## The switches, and why there are four of them

| | | |
| --- | --- | --- |
| `JELLYFIN_ENABLE_NETWORK=true` | may this process open a socket to a media server at all | default **off** |
| `JELLYFIN_ALLOW_LIVE_PUBLISH=true` | may it perform the live create Phase 11 hard-disabled | default **off** |
| `JELLYFIN_ALLOW_COLLECTION_WRITES=true` | may the **operator UI** drive that, rather than a deliberate CLI run | default **off** |
| `PUBLISH_EXTERNAL_IDENTITY=allow` | may identity leave the crypto-shredding boundary at all | default **deny** |

They are separate because they answer separate questions, and **no one of them implies another**. Read-only
discovery needs the first. Queuing and carrying out work needs all four. A missing switch is a named refusal
with nothing queued and nothing sent — never a partial run, and never a silent no-op.

With the first switch unset, **there is no transport object in the process at all**. `resolveJellyfinTransport`
is the one expression under `src/` that can produce a real one, and it returns nothing unless the switch is
exactly `"true"`. Networking is off by absence, not by a branch somebody has to remember to write.

## Phase 266 — the connection, and what discovery is allowed to see

**The API key comes from a file, and an inline one is refused.** `JELLYFIN_API_KEY_FILE` and nothing else.
Setting `JELLYFIN_API_KEY` is a rejection with a named code, not a discouraged habit: an environment variable
is visible in `docker inspect`, in `/proc/<pid>/environ`, and in every Compose file anybody ever pastes into
an issue. This is the same shape the operator token, the KEK and the database URL already use.

**The address must be on a private network.** `src/core/adapters/jellyfin/url-policy.ts` decides once,
offline, before anything is sent:

* `http` or `https`; **no credentials in the URL**; no query string; no fragment; a bounded, dot-free path
  prefix normalised to have no trailing slash.
* The host must be a **literal private address** — loopback, RFC1918, link-local, CGNAT, IPv6 ULA — or a
  **local name**: a single label (a Compose service), or one ending `.local` / `.lan` / `.internal` /
  `.home.arpa` / `.home` / `.localdomain`. A public FQDN is refused.
* IPv4-mapped IPv6 is unwrapped and judged as the IPv4 address it is, so `http://[::ffff:169.254.169.254]/`
  cannot pass as "an IPv6 form we do not recognise". Decimal, octal and hexadecimal spellings of an address
  are refused outright rather than parsed.

**Names are judged by suffix, not by resolution.** Resolving at configuration time proves nothing — DNS can
answer differently at request time — and a check that must be re-run per request is a check that one day will
not be. A closed set of names is decidable, deterministic and offline, and cannot be moved by an attacker who
controls a DNS zone.

**Every request is re-checked at the transport.** `guardedJellyfinFetch` wraps the transport itself: a URL
whose origin is not the validated one never reaches the underlying fetch, and every request that does carries
`redirect: 'error'`. One `302` is otherwise all it takes to move a checked request to an unchecked address.

**Discovery answers four questions and no more.** Can we reach it; what version is it; how many libraries and
collections does it have; and which of those collections carry this product's own `[cat:…]` marker.

* **No media item is ever listed.** Not one title, not one path, not one provider id. The suite asserts the
  `IncludeItemTypes` of every request the client makes.
* **No Jellyfin id is ever returned.** A collection appears as a short, non-reversible digest of its id.
* **No collection this product did not create is ever named.** Those are counted. A managed one comes back by
  the name an operator typed into this UI's own form, with the marker stripped.
* **The server's name is never returned.** Its product *version* is, matched against a strict pattern; a
  version is a version, and a server name is host-identifying.

**Bounded on every axis**: a per-request `AbortController` timeout, a response byte bound (the body is read as
text and parsed here rather than handed to an unbounded `res.json()`), a page cap, and a row cap. A listing
that hits a bound reports `truncated: true` rather than implying it saw everything.

**Every failure is a class, never a message.** `unreachable`, `timed-out`, `unauthorized`, `refused`,
`redirected`, `too-large`, `unreadable`. A DNS failure's own message contains the host and a TLS failure's
contains the certificate subject; neither goes anywhere near a response a browser renders.

## Phase 267 — planning, from state this installation already holds

**Planning makes no external call, and that is provable from the types.** `buildCollectionPlan` accepts a
`CatalogReader` (three SELECTs) and a `LedgerReader` (one SELECT). There is no fetch, no client, no adapter and
no outbox in its scope. **It also writes nothing**, for the same reason: no `CatalogAuthority` and no history
store is a parameter of it.

**Why the ledger and not Jellyfin.** "Does this already exist over there?" is answered from the publish ledger,
because the ledger is what makes an external copy *revocable*. Planning against it means a plan can only ever
propose work this installation is able to undo.

**What an action can be:**

| | |
| --- | --- |
| `create` | no ledger row for this record and target |
| `update` | a row exists and has **not finished** — queuing again resumes it, never duplicates it |
| `unchanged` | a row exists and an external copy is live |
| `revoke` | a published copy of a record that is no longer readable — an erasure that has to reach outside |
| `blocked` | no provider reference to match a library item with, or the record cannot be read |

**Revokes are not driven by the selection.** A record that is merely not selected is not a record somebody
asked to unpublish, and proposing to delete every external copy outside the current search box would be a
catastrophic default. The one thing that compels a revoke is **erasure**.

**Two digests, and they mean different things.** The **plan digest** covers what would be done. The **basis
digest** covers what it was decided from — every selected record's identity (references hashed, never listed)
and every relevant ledger row's state. Two different states can imply the same actions, so the pair is what
makes "the world moved" detectable. Phase 268 requires **both** to still match.

**Determinism is the feature.** Same catalog, same ledger, same name → byte-identical output and the same
digests. Every ordering is total (record id is the tie-break), the canonical serialiser writes keys in sorted
order explicitly, and nothing consults a clock or a random source.

**A plan discloses no provider reference value.** An action carries the record id and title the catalog panel
already shows to the same authenticated operator, plus reference *types* and a count.

**The name you type names the PLAN, not a Jellyfin collection.** What actually gets created is one collection
per selected record, named after that record, holding the library items its provider references matched — the
Phase 10/12 model, unchanged. The name here is the operator's label for a batch of work: it is what the
durable history records, what the confirmation is bound to, and what they read back later. The panel says so
in as many words, because a field called "collection name" that does not name a collection would be a promise
this product does not keep.

> **SUPERSEDED BY PHASE 269.** This is the behaviour Phases 269–272 replaced. The name now names the
> collection, one accepted plan is one Jellyfin collection holding the selected records, and the durable model
> is `managed_collections` / `managed_collection_members` (schema v9). The per-record rows described here are
> **not** migrated or reinterpreted — they remain tracked and revocable by the engine described below. See
> `docs/PHASE_269_272_COLLECTION_LIFECYCLE.md` and `docs/ADR_001_GROUPED_COLLECTION_MODEL.md`.

## Phase 268 — execution, in two deliberate halves

**Execute = queue.** The route writes durable `planned` intents into the Phase 12 outbox and returns. **It
contacts nothing.** That is the property everything else rests on: the durable intent exists before any side
effect, so a container that dies in between leaves a row a later pass can act on rather than a change nobody
recorded. The response says `"wrote": "durable intents only"` and `"contacted": "nothing"`, because "queued"
and "happened" are different facts and conflating them is how somebody believes a media server changed when
nothing was sent.

**Reconcile = do.** This is the only route in the service that talks to a media server and can change it, and
it is the Phase 12 `OutboxService` unchanged. Recovery is **by token**: the durable correlation token, not the
possibly-lost create response, decides whether an artifact exists.

* found → **adopt** the handle;
* provably not found → **create**, within a bounded retry budget;
* **lookup failed → do nothing**, because "I could not see it" is not "it is not there".

Phase 261's recovery proof still governs: once a create has been observed to be unfindable by its own token,
`findByToken() === null` stops meaning absence and reconcile refuses to create anything further rather than
duplicate a copy it can no longer see.

**What an execute has to get past, in order.** The operator token; the request shape (JSON, same-origin,
bounded); the four switches; a **signed, single-use, expiring confirmation** issued by the preview; the
operator's **own echo of the plan digest**, compared in constant time; and finally a **recomputed** plan whose
two digests still match. A refusal at any step writes nothing, sends nothing, and says which step it was.

**Why the digest is typed rather than pre-filled.** A signed blob the page carries around is something the page
can replay by itself. A digest that has to be sent back verbatim is the part a person states on purpose. The
panel shows the digest and leaves the confirm box empty.

**Why recomputing is not redundant with the confirmation.** The confirmation proves what was *previewed*. The
recomputation proves the world has not *moved*. A record forgotten in between, a competing import, another
operator's execute, or a reconcile that settled an intent all change the basis without changing anything the
browser can see.

**Idempotency has two independent guards.** The confirmation is single-use and a moved basis is refused, so a
replayed execute cannot reach the queue at all — and the queue uses one atomic database command backed by a
partial unique index over every active `(item_id, target)` pair. Two independently confirmed requests racing
the same plan cannot both insert: exactly one owns the intent and the other counts it as *resumed*. Duplicate
external collections are the failure this whole design exists to prevent, so it is prevented twice.

**It cannot bypass anything that was already there.** A create runs inside
`CatalogAuthority.withPublishableIdentity`, which fails closed on a forgotten or shredded record and discloses
only `title` and `providerRefs`. The consent gate is asserted by the outbox itself on every live call.
Revocation is driven from the ledger's own `revoke_pending` rows, and a revoke that fails leaves the row
queued and retryable rather than marked done — an unrevoked external copy of a forgotten record is the worst
state this product can be in, so it stays visible.

## The durable plan and audit history

Schema **v7** adds `collection_control_history`: one append-only row per decision — previewed, queued,
reconciled, revoked — written through one SECURITY DEFINER function the runtime holds `EXECUTE` on, over a
table it holds only `SELECT` on. There is no update path and no delete path exposed to the runtime at all.

Schema **v8** adds the active-intent uniqueness invariant and `cat_publish_plan_if_absent`, the atomic
insert-or-resume command used by collection execution. (Schema **v9**, Phase 269, adds the managed-collection
model beside this one and changes nothing here.) The invariant lives in PostgreSQL rather than in a
caller-side check, so concurrent service requests and separate service processes receive the same answer.

A row holds counts, an outcome, the two digests, an actor, an action and the collection **name** the operator
typed into this product's own form. That is the complete list: no record id, no title, no provider reference
of any kind, no external id, no Jellyfin id, no external handle, no address, no key, no path. The schema's own
CHECKs constrain the name to the planner's closed grammar and both digests to 64 hex characters, so an unsafe
row is impossible rather than merely unwritten.

**A preview is recorded too**, as `planned` / `preview`. It is the evidence that a digest was seen before it
was confirmed, and it costs one row.

## What did not change

* **Authentication.** Same operator token, same header, same boundary. Every route above requires it.
* **CSP.** `default-src 'none'` with `script-src 'self'` and `style-src 'self'`. No inline anything.
* **Nothing is parsed as markup.** Every dynamic value in the new panel is written with `textContent`.
* **Accessibility.** Every new control has a `<label for>`; every new status is an `aria-live="polite"`
  `role="status"` region.
* **The catalog panel is still a read.** Selecting records for a plan sends their ids to a route that already
  decides for itself what it will disclose about each one.

## Proof

`npm run test:phase266-local` (`test/jellyfin-control-plane.ts`) — the address policy against twenty hostile
spellings, the file-only key rule, the four failure classes, pagination and both bounds, a real timeout, a
real redirect refused, the transport guard, "no transport exists with the switch off", route auth and method,
and a scan of every response body this suite produced for the key, the token, the address and every Jellyfin
id.

`npm run test:phase267-local` (`test/collection-plan-preview.ts`) — determinism to the digest, the basis
digest moving when identity moves, every rejection, the confirmation's replay/expiry/forgery/cross-issuer
refusals, and — against a real PostgreSQL — that an entire planning session writes no row, no event and no
ledger entry.

`npm run test:phase268-local` (`test/collection-execution.ts`) — the four gates, sequential and concurrent
queue idempotency (two independently confirmed executions produce one intent), a stale plan refused, a
replayed confirmation refused, a lost create response recovered by token without duplicating, restart
persistence, revocation of a forgotten record, and the cross-origin and body-bound refusals.

`deploy/ci/jellyfin-control-acceptance.sh` drives all of it through a real Chromium against a real Compose
stack and a **local fake Jellyfin server**, and proves that browsing the panel writes no database row and
sends no external request.

## Limitations

* **The private-network policy is an allowlist with exactly one denylist inside it.** The link-local and ULA
  ranges are admitted because an operator's own LAN legitimately uses them; the cloud instance-metadata
  endpoints that live inside those ranges are refused by name. That denylist is a named list of literals, not
  a heuristic, so an endpoint nobody has thought of yet is admitted if it is on a private range — the guarded
  transport still pins every request to the one configured origin, so nothing can be *steered* anywhere.
* **A name is judged by suffix, not by resolution.** An operator whose media server is at a public DNS name is
  refused and told to use its address on their own network. That is deliberate and conservative.
* **A plan is decided from the ledger, not from Jellyfin.** A collection deleted directly in Jellyfin is still
  `published` here until a reconcile or revoke pass notices. Discovery is what shows the difference.
* ~~**One collection per record, not one collection per plan.**~~ **RESOLVED IN PHASE 269.** A plan of thirty
  records produced thirty Jellyfin collections here, each named after its own record. Phase 269 replaced that
  with one managed collection per accepted plan; the per-record rows this phase created are still tracked,
  still finished and still revoked, and are never adopted into a group. See
  `docs/PHASE_269_272_COLLECTION_LIFECYCLE.md`.
* **The plan name is stored in the audit history.** It is the operator's own label, in a closed grammar,
  exactly as `import_history.file_name` is — but it is free-ish text somebody typed, and an operator who names
  a plan after a single record has put that name in a durable row.
* **Queuing is not doing.** Nothing reaches a media server until a reconcile pass runs. That is the property
  that makes a crash survivable, and it means an operator has two steps rather than one.
* **`createCollection` (the bare, untracked create) is still hard-disabled.** Every live create goes through
  the outbox, tagged with its own recovery token.
