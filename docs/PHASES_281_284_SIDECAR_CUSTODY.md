# Phases 281–284 — the custodian boundary, made a boundary

| Phase | What it is | Why it matters |
| --- | --- | --- |
| **281** | O4 runtime hardening: the sidecar's IPC and its durable state | The custodian's value is the channel to it, and the channel was open |
| **282** | O5 sidecar-managed KEK ring, and the migration onto it | A static key in a file, forever, was the whole of key management |
| **283** | Rotation: planned, journalled, verified, and reversible until it isn't | A rotation touches every key; an interrupted one could lose the catalog |
| **284** | Acceptance and runtime integration | The app started in front of a custodian that could not answer |

## What "managed" means here, before anything else

**This is not a cloud KMS, and it is not a hardware boundary.** Nothing in this tranche contacts a network and
nothing in this product does. "Sidecar-managed" means exactly one thing:

> The key-encryption keys are generated, held, rotated and used **inside the custodian sidecar process**, and
> the application never receives one.

That is a real boundary — the difference between "an attacker who reads the app's environment has your KEK"
and "an attacker who reads the app's environment has a socket that answers per-item DEK requests and nothing
else". It is not custody by a third party and it is not a device. Every document, report and command in this
tranche is held to that wording, and a suite scans for the ones that would overstate it.

---

## Phase 281 — O4: the boundary the custodian's value rests on

The sidecar holds the material every decrypt depends on and the app holds none of it. That separation is worth
exactly as much as the channel between them, and the channel had none of the following.

**Local only, and proved local.** A Unix domain socket or a Windows named pipe. There is no TCP path in the
module — not a disabled one, not a configurable one — and a suite scans the source for the spelling of one.

**Owner-only, parent included.** The socket is `0600` inside a `0700` directory the daemon owns, and the
directory's ownership and mode are re-inspected after creation. A `0600` socket inside a world-writable
directory is a socket anybody can unlink and replace — after which the app connects to *their* custodian and
hands it every key request.

**A stale socket is proved stale before it is removed.** The previous code was `if (existsSync(p))
unlinkSync(p)`, which had three separate problems: it deleted *whatever* was at that name (a file an operator
put there, a misconfiguration pointing at something real); `existsSync` follows a link while `unlink` does not,
so the check and the action disagreed about what they were looking at; and it could not tell a socket a dead
daemon left behind from one a **live** daemon is serving — taking the name from a live one leaves it running
and unreachable, which for a custodian is an outage with a healthy-looking process behind it. Now: `lstat`
without following, refuse anything that is not a socket, refuse one owned by another user, ask whether anything
answers, and only then unlink.

**Bounded in bytes, in time and in number.** A request line is capped on **bytes accumulated** (so a peer that
never sends a newline is cut off rather than buffered forever), a connection has an idle timeout and a total
timeout, responses are capped on both sides, and only so many connections may be open at once. None of these is
a performance choice.

**One request per connection.** The first newline ends the request; anything after it is discarded with the
connection. The previous version left the socket open and kept appending to the same buffer, so a second
request could arrive — and dispatch — while the first was still running.

**Closed errors.** Every failure is one of seven codes. A message from a custodian, a filesystem or a runtime is
never repeated onto the wire; those routinely carry a path, and a path is a fact about the host that the app
has no business learning from the process holding the keys.

**A real health handshake.** See Phase 284.

### The durable state

`readFileSync(p, 'utf8')` over a directory that backups read, restores write and an operator can open:

* **A name can be a link**, and `readFileSync` follows one — a key file replaced by a symlink is read as a key
  file and written back *through* the link. Every read now opens with `O_NOFOLLOW` and asks the descriptor.
* **A file can be enormous.** Every read is bounded before a byte is taken.
* **An atomic write is only atomic if it completes.** A truncated file parses as JSON right up until a field is
  missing. Every document now carries its own byte length and digest, so a partial or altered write is
  arithmetic rather than a guess.
* **Two writers are two writers.** The custodian was *documented* as single-writer and nothing enforced it; a
  `mkdir` lock does, atomically. Two well-formed writes silently discarding one another is not corruption a
  digest catches.

---

## Phase 282 — O5: the sidecar-managed KEK ring

Until now the KEK was **static 32 bytes in a file**, mounted into two containers, with rotation as an offline
command run by hand. One key, forever, readable by anything with the mount; rotation meant holding two KEKs at
once on a command line; and nothing recorded which generation anything was under.

**A root wrapping key** — read only by the sidecar, only from an owner-only file, only through a no-follow
open, **never** from an environment variable, a command line or any evidence surface — seals a **versioned
ring** whose entries are the actual KEKs. Every KEK is generated with `randomBytes` inside the sidecar. The
ring is AEAD-sealed with its header bound into the AAD, so a wrong root key, one altered byte, a re-labelled
envelope and an unknown version are each a **refusal** rather than a subtly wrong key.

**Fail closed, in every direction.** Wrong root, corrupt ciphertext, an unknown version, a ring with no active
generation, a ring whose active number is not among its own entries, two entries with one number: each is a
refusal. There is no branch that recovers a ring by guessing, because every guess is a guess about which bytes
decrypt an installation's entire catalog. **A ring that is there and unreadable counts as present**, so an
initialisation can never write over one.

**New installations** run `ops:kek-ring init`. **Existing installations** run `ops:kek-ring migrate`, which
**adopts the static KEK as generation 1** — the keys on disk are already under it, so a ring that started from
a fresh key could open none of them. The migration is gated on a plan digest binding the state directory, the
root and the static key, and on a complete backup that verifies. It is stated everywhere, including in its own
output, as a change of **custody mechanism and not of key material**: until the rotation that follows, the key
protecting the installation is still the one that was in a file.

**The app never receives the root key or a KEK.** Its only reachable surface is the socket, whose contract
carries per-item DEKs and nothing else — asserted against the wire types, the client and the custodian factory.

---

## Phase 283 — rotation

Rewrapping a keystore was already implemented; what makes a rotation dangerous is everything around it. It
touches **every key in the installation**, a crash is not hypothetical on a NAS, and **the old key is still
needed afterwards** because every existing backup holds DEKs under the outgoing generation.

The order is fixed and each step is durable before the next begins:

1. **Plan and confirm** — a digest over where, which root, and which generation. Nothing runs without it.
2. **The lock** — one maintenance command at a time over this state directory.
3. **A complete backup that verifies NOW** — not one that exists.
4. **Quiesce** — the app and the sidecar are stopped, and started again through a `finally` on every path out.
5. **A pending generation**, generated inside the ring. Pending means nothing is under it yet.
6. **A journal**, written before the first key file changes.
7. **Per-key atomic rewrap**, resumable and idempotent.
8. **Verify all, then activate.** Every live key must read under the pending generation **while the old one is
   still active**. A single failure leaves the ring untouched, so the installation is exactly as it was.
9. **The outgoing generation is retained**, and removed only by an explicit `retire`, gated on a **post**-
   rotation backup that verifies — established by checking that the set's own keystore reads under the current
   generation, not by trusting a timestamp.

**A crash at any stage leaves an installation a restarted sidecar can still read.** That was not true before
this tranche and it is the correction that matters most here: between the rewrap and the activation, the key
files are under a generation the ring does not yet call active. A sidecar holding only the active KEK would
open nothing, every item would read as unreadable — indistinguishable from a correct erasure — and nothing
would say why. The daemon therefore holds **every retained generation for unwrapping only**; new wraps still
use the active one alone. GCM authentication makes each attempt decisive, so this is a lookup and not a guess.

**Rotating the root wrapping key is a different operation** and is kept separate. It re-seals the ring and
rewraps nothing: no key file is touched and every KEK is byte for byte what it was. That is the right answer to
"the root key file may have been read"; rotating the KEKs is the right answer to "a KEK may have been read".

**The doctor reports the age** as a closed word — `current`, `due` at 180 days, `overdue` at 365 — from a
timestamp supplied by whatever already had the ring open. A doctor that opened a ring to check its age would be
a doctor with a path to every key, and the doctor runs inside the app.

---

## Phase 284 — integration, and what is actually proven

**The app is gated on sidecar HEALTH, not on a socket file.** The shipped stack's check was `test -S
<socket>`. A socket file appears the instant `listen` is called — before the daemon has opened its state
directory or established that its ring is intact — and it **survives a crashed process**. Worse, a daemon whose
keystore has become unreadable serves the socket and fails every request: the app in front of it comes up,
reports itself healthy, and answers every catalog read with a fail-closed unreadable item. An operator sees a
working installation with an empty catalog and no error anywhere. The check is now `ops:sidecar-health`, a
handshake the daemon answers only after exercising its custodian against its real state, and `app` and
`migrate` both wait on `service_healthy`.

**The stack declares the root custody secret beside the static KEK, not instead of it.** An installation that
has not migrated still needs its static KEK; a stack that swapped them on upgrade would leave every existing
deployment with a sidecar that cannot open its own keystore. After migrating, an operator sets
`SIDECAR_ROOT_KEY_FILE`, removes `SIDECAR_KEK_FILE` and unmounts `custodian_kek` — and **the daemon refuses to
start wired to both**, so the cutover cannot be half done.

**`custodian_root_key` is in the required-secret model**, so every backup, verification and rehearsal checks
for it. A backup holding the ring and not the root key is a sealed box with no key.

### Status of the open design gates

**O4 — the external/runtime custodian boundary — is CLOSED by implementation evidence.** The sidecar runs as
its own process; its IPC is local-only, owner-only, bounded, single-request, schema-closed and fail-closed; its
durable state is no-follow, bounded, self-describing and single-writer; its health is a handshake the app
depends on; and the acceptance suites drive all of it against real sockets, a real keystore and real keys.

**O5 — the managed KEK ring — is IMPLEMENTED AND HARDENED, and is NOT live-proven and NOT closed.** Everything
above is built and its suites pass, and **no operator has run an initialisation, a migration or a rotation
against a live installation**. What would close it is operator evidence: a migration and a rotation performed
on a real deployment, with the complete backups they are gated on, and the resulting reports kept. Until that
exists this is a capability, not a proven one, and nothing in this repository may say otherwise.

## The absolute invariant

Catalog Authority never downloads, scrapes, plays or acquires media, never creates a media symlink, never
contacts a media server here, and never invokes an acquisition system. In this tranche that is enforced by the
same three mechanisms as Phases 277–280 — the permitted-program and subcommand allowlists, the
forbidden-argument scan, and a post-hoc scan of the command ledger — plus a source scan over every new module
in the acceptance suite.

## Proof

| | |
| --- | --- |
| `npm run test:phase281-local` | `test/sidecar-ipc-hardening.ts` — no TCP surface and network-shaped paths refused; a stale socket proved stale (an arbitrary object, a symlink and a **live** daemon each refused, nothing unlinked); socket and parent mode; a world-writable socket directory refused before anything listens; the request schema closed against extra fields, long ids, newline ids, fractional/negative/enormous epochs; closed wire codes carrying no path, key or runtime message; a request past the byte bound refused rather than buffered; one request per connection proved by the second one never running; an idle connection timed out; health proved to be a handshake a bare socket file does not pass; a runtime with no probe never claiming ready; the contract round-tripping; and state documents proved self-describing, bounded, no-follow, single-writer and value-free in every refusal. |
| `npm run test:phase282-local` | `test/kek-ring.ts` — the root key read only from a private file (mode, link and size refused; no `process.env`/`process.argv` in the module); a generated generation 1 and no second initialisation, including over an **unreadable** ring; wrong root, altered byte, re-labelled envelope and future version each refused; seven shapes of incomplete ring refused; migration adopting the static KEK and recording that it did; pending/active/retained transitions; retirement refusing the active and the pending; root rotation re-sealing and rewrapping nothing; and no key, wrapped value or root in any summary, message or unsealed file. |
| `npm run test:phase283-local` | `test/kek-rotation.ts` — nothing without the digest or a backup that verifies; a full rotation over a real keystore with the outgoing generation retained; **a crash at every one of the five stages, built from the real operations, proved to leave an installation a restarted sidecar can still read, and proved to resume to completion**; a foreign journal and an orphan pending refused; a key that does not read under the new generation stopping the rotation **before the ring moves**; idempotence; retirement refused against a pre-rotation backup and allowed against a post-rotation one; the doctor's due/overdue words; and no key, path or runtime message in a report. |
| `npm run test:phase284-local` | `test/o4-o5-runtime-acceptance.ts` — the app's only surface asserted against the wire types and the custodian factory; a daemon refusing to be wired to both key sources or neither; a ring daemon serving, restarting and naming its generation in health; a wrong root failing closed at start; a migrated installation opening pre-migration keys; the shipped stack's health gate and `service_healthy` dependencies; the root secret declared beside the static KEK; the required-secret model; no raw key on any evidence surface or in the state directory; no key material acceptable on a command line; and the O4-closed / O5-not-live-proven wording held to exactly. |

## Review corrections

A review of the first commit found seven defects, each fixed with a regression that fails against the code
being corrected:

* **A plan mutated.** `rotate --root-rotate --plan` called the re-seal directly — the flag whose purpose is
  "tell me what would happen" had already done it, and the only warning was the past tense in its output. Root
  rotation is now a real plan/confirm operation: the digest binds the current ring generation, both root
  labels and the verified set's own digest; execution re-resolves under the lock and proves the new root opens
  the **exact** ring before reporting success. **Retirement** — the one irreversible operation here — gained
  the same gate, plus a lock and a re-resolution.
* **The migration never checked the key it adopted.** Adopting the wrong static KEK produces a perfectly
  well-formed ring that opens **nothing**, and an item nothing can open is indistinguishable from a correctly
  erased one — so the installation would have looked empty rather than broken. Every live wrapped key must now
  open under the supplied key before a ring is written, re-proved under the lock, with the backup's own digest
  re-verified there too.
* **A failed sidecar stop left the app stopped.** The quiesce loop sat outside the block whose `finally`
  restarts, so stopping `app` and failing to stop `sidecar` reported a refusal about the sidecar and left the
  installation down. The quiesce is now inside it, and a failure whose restart also fails raises
  `KekRotationFailed` carrying the primary refusal **and** the still-stopped services.
* **The rotation bound a path, not a set.** The plan digest now binds `verification.setDigest`, and the lock
  is followed by a re-resolution and a re-verification of the same digest before anything is stopped.
* **A journal was trusted.** `verified` skipped the check that makes activation safe. Every resumed stage is
  now reconciled against the ring and the keystore and resumes from the earliest stage the evidence supports;
  the journal schema is closed and bounded.
* **Retirement skipped its whole proof** when the set had no keystore — the one set that cannot restore a
  custodian at all. It now requires the artifact, proves the backed-up root opens the backed-up ring, proves
  every backed-up key opens under that ring's active generation, and proves that generation is the one this
  installation is on.
* **The shipped transition could not run.** Setup wrote `custodian_root_key` `0644` while the reader refuses
  any group or other bit, and Compose's short syntax mounts a secret `0444` root-owned. The host mode is now
  owner-only and the sidecar mounts it in long syntax as `0400` owned by the non-root user the image runs as —
  the fix is the mount, **not** a weakened reader, which still requires owner-only.

Two smaller ones: the doctor's rotation-age check was dead code (nothing supplied the timestamp), so the
sidecar's health handshake now carries the active generation's creation time — a number, never a key — and
`ops:doctor` consumes it without any path to the ring; and the doctor's claim that managed KEK custody was
"not built" was simply false and has been replaced with the accurate one. Health answers are validated field
by field with no extras and no contradictions, the ring's outer and inner schemas are closed and bounded,
`writeStateDocument` loops on short writes, and the writer lock is now **taken** by the function that writes
the ring rather than being a helper nobody called.

## Verification status

`npm run typecheck`, the four new suites, the affected existing suites and the aggregate `offline` and `db`
groups were run and passed on this branch.

**No Docker-dependent gate was run, no service was deployed, and no operator evidence was produced.** The
suites drive real sockets, real keystores and real key material in temporary directories; they do not start a
container, and nothing here should be read as saying they did.
