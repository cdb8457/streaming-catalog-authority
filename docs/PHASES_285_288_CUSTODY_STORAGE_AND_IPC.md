# Phases 285–288 — the storage boundary the custodian never had, and the half of the wire nobody parsed

| Phase | What it is | Why it matters |
| --- | --- | --- |
| **285** | The custodian's four record kinds, read the way its ring is read | The keystore was still `existsSync` + `readFileSync` + `JSON.parse` + a cast |
| **286** | The keystore walk as a stated set, under one lock and one directory | A rewrap walked whatever `keys` pointed at and skipped what it did not recognise |
| **287** | The IPC **response** contract, closed and operation-specific | Requests were checked field by field; answers were not checked at all |
| **288** | Adversarial gates for both, and the compatibility they must not break | A guard nobody has watched fail is a guard nobody knows works |

This tranche changes **no** custody claim. O4 remains **CLOSED by implementation evidence**; O5 remains
implemented and **NOT live-proven** — no operator has run it against a live installation, and nothing here
produces operator evidence. It is not a cloud KMS and not a hardware boundary. What follows is a hardening of
the code behind claims that were already made, and the honest description of it is: the boundary Phase 281
built for the KEK ring now covers the files beside it, and the channel it hardened in one direction is now
hardened in both.

---

## Phase 285 — the records

Phase 281 hardened the ring's file. The four record kinds beside it — wrapped key files, operation records,
tombstones, the destroy journal — were still read by a helper that predates all of this:

```ts
private read<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}
```

Four things were wrong with it, and these are the files that decide whether an item can be read at all.

**`existsSync` follows a link and answers `false` for a permission refusal.** Both mattered. A tombstone
replaced by a symlink was "there" and read the key as destroyed. A keystore this process could not read
answered `not_found` — and for a fail-closed reader `not_found` is indistinguishable from a correct erasure,
so an installation whose keystore had become unreadable reported itself as one that had never held a key.

**`readFileSync` follows a link too, and is unbounded.** A `keys/<hash>.json` pointed somewhere else was read
as a key file, and a file somebody grew was this process allocating whatever was on disk.

**`as KeyFile` is a cast, not a check.** `{}` became a key file whose `state` was `undefined` (reported as
`key not active (undefined)`) and whose `wrappedHex` was `undefined` (a `TypeError` from inside the unwrap).

**Nothing said which build wrote the file**, so a future change of shape would be read by this one as far as
the fields that happened to match.

Every record now goes through `custodian-records.ts`: the same bounded, no-follow, proved-regular-file reader
the ring uses, then a **closed schema per kind** — every field checked, every unknown field refused, and
operation-specific rules (a `destroy` record carrying a provision's `itemId`/`epoch` is refused, not read as
whichever kind the caller asked about). `null` comes back **only** for a name that is genuinely not there.

**Why these are not wrapped in the ring's `{doc, bytes, digest}` envelope.** The ring is one file written by
one command. The keystore is thousands of files that existing installations already hold and published backup
sets already contain; changing their shape would make every set taken before today unreadable by the code that
reads them. The envelope's guarantee is obtained another way, and the argument is stated where the code is:
writes go through `writeStateFileBytes` (temp `O_EXCL` at `0600`, a **loop** that handles a short `write(2)`,
fsync, rename, directory fsync) so a partial write cannot happen; a truncated record cannot parse, because a
prefix of a JSON object never closes its own brace; and the one field an attacker would want to alter is the
wrapped DEK, which is AEAD-authenticated with the key id as AAD. A `version` is written from now on and
validated exactly, stamped by the writer rather than by each caller — a read-modify-write like
`{...kf, state: 'active'}` carried the old shape straight back to disk, so a keystore would never converge.

**The destroy journal was the worst of it.** `recover()` was `if (!j) { rmSync(...); continue; }`, and `read()`
answered `null` both for "not there" and for "will not parse". An unreadable **intent to destroy a key** was
deleted, and the key stayed live with nothing recording that it should not have. A shape that did parse was
worse: `{}` reached `finishDestroy`, which hashed `undefined` into a filename and threw a `TypeError` out of
the **constructor**, so one bad file meant the custodian could not be built and nothing said why. Now a
journal entry this build cannot read is a named refusal, the entry is left where it is, and no key file is
touched.

## Phase 286 — the keystore as a stated set

`rewrapKeystore` and `planRewrapKeystore` listed `keys/`, filtered to names ending in `.json`, and trusted
what they read. Three consequences, all closed:

* **The no-follow boundary escaped through the parent.** Every per-file check was a no-follow check on a
  *file*; `readdirSync('<root>/keys')` follows a `keys` that is a link. The directory is now identified on a
  descriptor before the walk and again after it, so a rewrap cannot run over a link and cannot be one count
  spread across two directories.
* **An unexpected entry was skipped rather than refused.** Including the `.tmp` an interrupted write leaves —
  precisely the state in which the set is not settled. The name must now be one this custodian writes and the
  entry must be a regular file; anything else stops the walk instead of shortening it. This is the same rule
  `keystoreSetDigest` already applied one module over.
* **`existsSync(keysDir)` decided whether there was a keystore at all**, so an unreachable one counted as
  zero files and "nothing to do". Only a directory that is genuinely absent is an empty set now.

`rewrapKeystore` keeps the custodian writer lock across its whole transaction, and the recovery path takes it
too. `planRewrapKeystore` deliberately takes **no** lock and says why: it is run against verified backup sets,
and creating a lock directory inside one would change the bytes its manifest is a digest of. What it can
promise is the directory identity; what it cannot promise is that no file changed mid-walk, and the callers
that need that (`runKekMigration`) hold the writer lock across their own transaction and re-check the set
digest afterwards.

## Phase 287 — the answer, parsed

Requests crossing the sidecar socket were checked field by field. Answers were:

```ts
parsed = JSON.parse(line) as WireResponse;
if (parsed.ok !== true) fail();
resolve(parsed.response);   // whatever the peer put here
```

The app must survive a hostile or malfunctioning custodian exactly as the custodian survives a hostile app, so
the answer is now parsed with the same closed, operation-specific schemas:

* **A frame cannot be a success and a refusal at once.** `{"ok":true,"code":"SIDECAR_BUSY","response":{…}}`
  used to read as a success to the client and as a refusal to anything reading the code beside it. The
  envelope's keys are now exact in both cases, the `op` on a refusal is a closed word, and the `code` must be
  one this build defines — a peer's invented code is text, and text from a peer never becomes a diagnostic.
* **An answer must be about the question that was asked**, in the shape that operation declares: no unknown
  fields, a DEK that is 32 bytes and round-trips its base64, an attestation that is a 64-character hex HMAC
  and not prose, a status from the closed set, a bounded stale list whose entries carry no control character.
* **One answer per connection, on the client side too.** Anything after the first newline is a peer that has
  misunderstood a contract whose whole shape is one line and a close; the right response is to take none of
  it rather than the first message of it.
* **`String(doc.op)` is gone.** `String(['get'])` is `'get'`, so `{"op":["get"],…}` selected the `get` schema,
  passed every field check, matched no case in the dispatcher, and was answered as a **success carrying
  nothing** — which threw a raw `TypeError` inside the app. The operation must be a string before it is
  looked up.
* **The daemon validates its own answer before writing it.** The custodian behind the socket is an interface,
  not necessarily this repository's class; a receipt whose attestation is not an attestation becomes a closed
  refusal rather than something the client has to survive.

The operation surface is unchanged and is asserted closed: `provision`, `commitProvision`, `get`, `destroy`,
`status`, `listStaleProvisioning`, and the `health` handshake. There is no administrative operation on this
boundary, no network path in these modules, and nothing here touches a media server or an acquisition system.

## Phase 288 — the gates

`test/custodian-storage-ipc-gates.ts`, 36 tests. Each adversarial one was **run against the previous code and
watched to fail**: reverting `file-custodian.ts` alone fails 8 of them; restoring `String(doc.op)` and the
permissive response parse fails 2 more. The rest are the positive half that the strictness must not break —
a journaled destroy still completes on restart and is still idempotent across two of them, a legacy versionless
keystore still reads and is rewritten in the current shape, a rewrap is still resumable and idempotent, and
the real daemon still answers every custody operation over a real socket.

Three of the six hostile-peer replies were already handled by the per-operation checks the client happened to
make; the other three — an empty success, a success carrying an error code, and a valid answer followed by a
second message — were not, and are what this phase closes.

## Corrections after review, and what each one closes

The first cut of this tranche was reviewed against the source rather than against the suite, and six things
came back. Every one of them was a gap the suite could not see, which is the point: a test that passes proves
what it exercises, not what it left out.

**A valid record at another valid record's address was accepted.** Every schema checked that a record was well
FORMED; none checked that it was the record ASKED FOR, because the id built the path and was then discarded.
A file copied from one valid name to another — the one operation anybody who can write the directory
certainly has — passed everything, and each caller then believed the id INSIDE it. That is a `get` returning
a working DEK for a key nobody asked about, a fresh `provision` replaying somebody else's operation, a live
key reported destroyed, and worst of all a journal entry making recovery destroy the key named inside it. Now
the address and the contents must agree: every read by id checks the record's own id, every walk checks the
filename against `sha256(id)`, and recovery checks the journal entry before `finishDestroy` touches anything.

**The parent-directory escape was closed only in the static rewrap.** `mkdirSync(d, {recursive: true})`
establishes nothing about a name that already exists, so `<root>/keys` as a symbolic link was a keystore this
class read and wrote every key through with the no-follow rules on the FILES intact and useless. The five
directories are now proved at construction — opened without following a link, proved to be directories on the
descriptor, identities remembered — and the walks that list them re-check the identity so a directory swapped
underneath one is a refusal. The destroy journal is a closed, bounded set of names like the keystore: an entry
nobody can account for stops recovery instead of being filtered out of it.

Ownership and mode: a directory belonging to another user, or one that is group- or world-**writable**, is
refused — an account that can write into `keys/` decides which wrapped keys this custodian believes it has.
Group- or world-**readable** (`0755`, which is what `mkdir` under the default umask produces) is deliberately
**not** refused: every installation made before this build has exactly that, the material in those directories
is wrapped under a key that is not in them, and refusing would turn an upgrade into an outage. Nothing is
re-moded — a create gets `0700`, an existing directory is judged and left alone, and `ops:keystore-repair`
remains what narrows one deliberately.

**Fragmented multi-frame answers were accepted.** The client resolved as soon as it saw a newline and refused
a second frame only when that frame happened to arrive in the SAME chunk — so a peer that wrote frame one,
waited, and wrote frame two had its first frame accepted and acted on. The check was against an accident of
buffering. Nothing is acted on now until the peer has finished and the whole answer is known to be exactly one
newline-terminated frame; the shipped daemon writes one line and ends, so this costs nothing real. A frame
legitimately split across chunks still arrives.

**A health answer the client rejects travelled as a success.** `ok: true` was written around any health object
whose `ready` was false and around a malformed one that did not claim readiness — but `validateSidecarHealth`,
the schema the CLIENT applies, refuses those alike. A reader could not tell "the custodian is not ready" from
"this peer is not this product". Not-ready is now the closed `SIDECAR_NOT_READY` refusal, which is what a
client that fails closed on readiness needs to hear.

**Two fields were held to "some text" where this build writes one exact form.** `destroyedAt` is attestation
input — the receipt is an HMAC over the key id, the receipt id and it — so a tombstone could say
`destroyedAt: "soon"` and be signed. It is now the canonical instant format, round-tripped through `Date` so
`2026-02-30T00:00:00.000Z` is refused rather than merely matching a regex, in stored records and in wire
receipts. `ageMs` is a safe, non-negative integer rather than any finite number.

**A raced read returned a prefix.** `readStateFileBytes` took the size once, read exactly that many bytes, and
then compared the bytes read against the size from before — trivially satisfied, and silent about a writer
appending to the same inode during the read. A prefix that closes its own brace parses. The file is now
re-interrogated on the descriptor after the last byte: growth and shrink are both refusals.

**And the recovery's bracket was still not a bracket.** The correction above proved the journal directory
once, before the listing, and then read each entry INSIDE the destruction loop — so entry two was read after
entry one had already been destroyed. Three ways out of that, all closed now:

* A listed entry that VANISHED was treated as a shorter complete set. `readCustodianRecord` answers `null`
  for a name that is not there and the loop `continue`d on it, so a destroy intent removed between the
  listing and the read was silently dropped and the key it named stayed live — the same silent loss the phase
  before had just removed from this function, reintroduced one line further down.
* A directory REPLACED after the single precheck could supply entries the recovery acted on: every file it
  read could pass its schema and its address check while coming from a directory nobody had proved.
* The unlocked probe that decides whether a recovery happens at all proved the directory BEFORE its listing
  and not after, so the one answer that ENDS the recovery — the empty one — rested on an unproved directory.
  A `journal` swapped for an empty directory in that window returned clean, and the intents in the directory
  that had been moved aside were never carried out. That failure leaves no trace at all: no refusal, no
  tombstone, and a key an operator was told was gone.

Recovery now takes a closed snapshot before anything is destroyed: prove the directory, list, read EVERY
listed name through the strict no-follow reader, refuse one that has gone, prove each entry is filed under
the key it names, and re-establish the directory's identity. Only then does it act — and it re-proves the
journal, the keystore and the tombstone directories BEFORE each destruction and after the last one, because
a check that runs only at the end of the loop reports a swap that has already been acted on. The unlocked
probe is bracketed the same way, so "nothing to recover" is believed only when it came from the directory
this custodian proved.

Each of those four guards was verified by neutralising it ALONE and watching the gate that covers it fail;
one of them — the snapshot's own re-establishment — needed a test that swaps the directory in for the read
window and puts it back before the first destruction, because with the per-destruction checks also in place
nothing else could tell it apart.

One further correction fell out of the first: `assertStaticKekOpensKeystore` reported EVERY preflight failure
as "the static KEK you named does not open the wrapped keys", including structural refusals that have nothing
to do with which key was named. An operator would have gone looking for a key file while their keystore held
something they needed to see. It now distinguishes the two.

## Verification status

`npm run typecheck` clean. The focused suites (`custodian-contract` 64, `custodian-acceptance` 19,
`local-sidecar-custodian` 18, `sidecar-daemon` 5, `sidecar-runtime-prototype` 5, `kek-rewrap` 12,
`keystore-repair` 40, `kek-ring` 13, `kek-rotation` 12, `kek-correction-gates` 38, `o4-o5-runtime-acceptance`
11, `sidecar-ipc-hardening` 17, and the new `custodian-storage-ipc-gates` 36) and the aggregate `offline`
group — **283 of 283 suites** — were run and passed on this branch.

The corrections' own gates were held to the same bar as the tranche's: **run against the committed code and
watched to fail**. Reverting the four hardened source files to that commit fails ten of them, covering every
one of the six corrections; the record-level timestamp rule was verified separately by neutralising it alone.

**One flake found and fixed in this suite, and one left as an observation.** These gates placed their POSIX
sockets directly in `/tmp`, which `prepareSocketDirectory` refuses on every Linux host because `/tmp` is
`1777` — it passed on Windows, which has no parent directory to own, and would have failed on the deployment
platform. They now use a private `0700` directory, and the one case here that expects a SUCCESS rather than a
refusal no longer runs on a short timeout. Separately, `external-snapshot-produce.ts` failed once in four
aggregate runs and passes standalone three times on this branch and three times on a clean tree; it shares no
code with this tranche and spawns CLI subprocesses, so it is recorded here as an unrelated flake under
parallel load rather than as something this work touched.

The `db` group was run as well — **32 of 32 suites** against an embedded Postgres — because several of its
suites read wrapped key files directly and one drives journal recovery through a real restart, which is
exactly the behaviour this tranche changed.

**No Docker-dependent gate was run, no service was deployed, and no operator evidence was produced.** The
suites drive real sockets, real keystores and real key material in temporary directories; they do not start a
container, and nothing here should be read as saying they did.

**Known limitation, unchanged by this tranche.** `FileCustodian` creates its four directories `0700` when it
creates them and does **not** re-mode ones that already exist; the ownership and mode of an existing keystore
remain `ops:keystore-repair`'s business, which reports what it finds and refuses what it cannot account for.
