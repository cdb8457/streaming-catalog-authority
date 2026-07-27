# Phase 264 — the authenticated catalog import workflow

## What changed

Until now, filling a catalog meant a shell: `docker compose exec app npm run ops:catalog-import`. That is a
fine tool and it is not going anywhere — but it is not a product surface, and a person who installed a
container to get a web UI should not have to open a terminal to use the one thing the product is for.

This phase adds an **Import panel** and four routes behind the existing operator token. It is the only part
of this UI that can write, and everything about it is built to make that obvious and bounded.

## The four routes

| Route | Method | What it does |
| --- | --- | --- |
| `/api/import/inbox` | GET | lists the snapshot files in the read-only import folder |
| `/api/import/preview` | POST | validates and plans one snapshot. **Writes nothing.** Issues a confirmation. |
| `/api/import/apply` | POST | applies the previewed snapshot, bound to its exact bytes |
| `/api/import/history` | GET | the durable record of every import this installation has applied |

Everything else in the service is still a GET that ends in a SELECT. `preview` and `apply` are named
**explicitly** as the writable paths rather than matched by prefix — a prefix match is how a route nobody
meant to expose becomes writable later — and a GET on either answers `405` with `Allow: POST`.

## Where a snapshot may come from

**One read-only mounted folder, and nowhere else.** `CATALOG_IMPORT_DIR` is a container path fixed by the
Compose file; the host side is a folder the operator chose, mounted `:ro`. There is no path input, no URL
fetch, no browser file upload, no provider call and no directory walk. The browser contributes a **name from
a listing this service produced**, and nothing else.

### One descriptor: the file that is checked is the file that is read

The first version of this resolved the path, `lstat`ed it, and then read it **by path** — three separate
resolutions of one name, with a window between each. The import folder is read-only to the *container*; it is
not read-only to whoever is at the host. So between the check and the read the name could be pointed
somewhere else: the checks would pass against a small regular file and the read would return whatever the
name meant a moment later — a symlink's target, a different file, an unbounded one.

The name is now opened **once**, and every question after that is asked of the **descriptor**:

1. **The name matches a closed grammar** — `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$`. No separator, no
   `..`, no dot-file, no control character, no space, no percent-encoding. Traversal is not something this
   code defends against after the fact; it is something that cannot be spelled.
2. **The inbox root is resolved once.**
3. **`open(join(root, name), O_RDONLY | O_NOFOLLOW)`** — a symlink at that final component makes the *open*
   fail, atomically, rather than being detected and then re-raced.
4. **`fstat(fd)`** — asked of the open file description, not of a name. A directory, device, socket or FIFO is
   refused here even if it was substituted after the listing offered it, because this is the object we hold.
5. **The size is enforced from that `fstat`, before a single byte is read.**
6. **The bytes are read from that descriptor**, bounded at one byte more than the `fstat` promised, and the
   byte count must then equal that `fstat` **exactly, in either direction**. More is a file that grew; fewer
   is a file that was **truncated mid-read** — and the second is the more dangerous, because a prefix of a
   valid snapshot can itself parse as a valid snapshot with records missing, which would import as a smaller
   catalog nobody asked for and nothing would flag. "What I read is not what I checked" has exactly one safe
   answer: read nothing.
7. **The descriptor is closed on every path**, including every refusal.

**This is deliberately not another pathname recheck.** Re-resolving the path a second, third or fourth time
only moves the window; it never closes it. Containment is structural instead: the grammar admits no
separator, so `join(root, name)` has exactly one component below an already-resolved root, and `O_NOFOLLOW`
refuses to traverse a link at that component. After the open there is no path in use at all, so there is
nothing left for a rename to redirect.

**The listing is advisory; only the open is authoritative.** `/api/import/inbox` uses `lstat` to decide what
to offer, which is inherently a snapshot of a moment. Nothing rests on it — a candidate it offered is
re-decided from scratch, against a descriptor, when it is actually opened, so a stale listing costs a refusal
and never a disclosure.

**Without that guarantee, this returns nothing.** `O_NOFOLLOW` is POSIX. The shipped product runs in a Linux
container and has it. Where a Node build does not define the flag, the open cannot atomically refuse a link —
and the answer is to **refuse**, before any file is opened at all.

An earlier version of this phase fell back to a check-then-open there, reported `noFollowAtOpen: false`, and
had a test pinning the residual window as a documented limitation. That was honest and it was still wrong: a
documented vulnerability is a vulnerability, and a boundary that returns bytes through a path it knows can be
raced has not been made safe by writing the fact down. So:

* `readInboxFile` throws **before its first syscall** — no resolve, no stat and above all no open, because an
  open performed and then regretted is still an open. There is no flag, environment variable or argument that
  turns this off; an escape hatch would be the fallback under another name.
* `/api/import/inbox` answers `200` with state `UNSUPPORTED_PLATFORM` and guidance, so the panel explains
  itself instead of offering files that could never be opened.
* `/api/import/preview` and `/api/import/apply` answer `503 OPERATOR_UI_IMPORT_UNSUPPORTED_PLATFORM` — a
  statement about the *installation*, not a `400` about the file, because reporting it as a bad file would
  send an operator to check a file that is perfectly fine.
* `ops:catalog-import` is **unaffected**. It resolves a path an operator typed in a shell they already have
  inside the container; it takes no untrusted name, so it is not the boundary this defends.

**Nothing about the Linux behaviour changes.** Everything else — one descriptor, `fstat` on it, both size
bounds, no re-open by name — is unchanged, and `noFollowAtOpen` is now `true` on every value this module
returns, because the only other outcome is a refusal.

The listing itself skips anything that is not a plain, bounded `.json` file and **counts** what it skipped by
reason. A skipped name is never echoed: it is still somebody's filesystem.

## Preview is mandatory, and provably writes nothing

`previewImport` is handed a read-only lookup function and **no authority and no history store**. There is no
object in its scope that could write a catalog row, an event or a history row, so "the preview wrote nothing"
is a property of what it was given rather than a claim about what it did.

The suite proves it twice: structurally, and empirically — row, event and history counts across a real
PostgreSQL are unchanged by a preview. The CI acceptance proves it a third time, on a real Compose stack.

A snapshot that does not validate is refused **whole**, before the database is asked anything, with every
problem listed. Each problem names a field and a position and never a value.

## Applying is bound to the exact previewed bytes

A preview that only agreed on a file **name** would not prove much: between preview and apply, the file can be
replaced (the folder is read-only to the container, not to the person at the host), the operator can preview
one file and confirm another by clicking the wrong row, a tab can be re-submitted hours later, and a page left
open across a restart can confirm against a different installation.

So a preview issues a **confirmation**: a signed statement of exactly what was previewed — the file name, its
size, the sha256 of its bytes, the digest of the normalised snapshot, and a single-use nonce with an issue
time. The apply re-reads the file, recomputes that digest, and requires all of it to match.

| What happens | What the apply does |
| --- | --- |
| the file was replaced | `409 CONFIRMATION_FILE_CHANGED`, nothing written |
| a different file is confirmed | `409 CONFIRMATION_FILE_MISMATCH`, nothing written |
| the confirmation is replayed | `409 CONFIRMATION_ALREADY_USED`, nothing written |
| the preview is older than 15 minutes | `409 CONFIRMATION_EXPIRED`, nothing written |
| the confirmation is forged or tampered | `409 CONFIRMATION_BAD_SIGNATURE`, nothing written |
| the service restarted since the preview | `409 CONFIRMATION_BAD_SIGNATURE`, nothing written |

The signing key is **random and per-process**. It is not a secret an operator holds, configures, rotates or
can lose; it is never written to disk, an environment variable, a log line or a response. Losing it (a
restart) invalidates outstanding previews, which is the fail-closed direction.

The nonce is spent **before** the content is compared, so a caller cannot use a failing apply to probe
repeatedly whether a file has changed yet.

**A confirmation is not a credential.** It authorises nothing on its own — every route still requires the
operator token. It only says "this apply is the apply that preview described".

## Authentication, CSRF and the confused deputy

Authentication is unchanged: the operator token, in the `x-operator-ui-secret` **request header**. It is never
in a URL, a cookie, storage, the HTML, a log line, a diagnostic, a trace or an artifact.

That is also the CSRF answer, and it is a structural one: **this service holds no ambient credential.** There
is no cookie, no session and no browser-managed authenticator, so a cross-site request carries no authority to
abuse. On top of that, three checks make an accidental or forged cross-origin write fail before it reaches any
logic:

* the token must arrive in a **custom header**, which a cross-origin page cannot set without a CORS preflight
  this service never approves — it sends no CORS header at all;
* the body must be declared `application/json`, which excludes every "simple request" a plain HTML form can
  make;
* an `Origin` or `Sec-Fetch-Site` that says the request came from somewhere else is refused outright.

The `Origin` check compares **host and port, deliberately not the scheme**. A supported deployment puts this
behind a reverse proxy that terminates TLS, so the browser's `Origin` is `https://…` while the request
arriving here is `http://`. Refusing that would break every proxied install to stop an attacker who would
already have to be serving TLS on this exact host and port. A cross-*site* origin always differs by host.

Requests with **neither** header are accepted: that is `curl`, the shipped acceptance harness and the
documented command-line path, and a browser always sends `Origin` on the cross-origin request this rule
exists to refuse.

## Everything fails closed

A body larger than 4 KiB, not declared JSON, not valid JSON, or not an object is refused before it is parsed
further — the bound is enforced **as bytes arrive**, so a caller that streams megabytes at this endpoint is
stopped at the limit rather than buffered to it. A `Content-Length` that already exceeds the bound is refused
before a single chunk is read.

## The durable import history

Schema **v6** adds `import_history` and one SECURITY DEFINER writer, `cat_import_record`. The runtime role
holds `SELECT` on the table and `EXECUTE` on that function: it can append and read, and it has **no UPDATE and
no DELETE path at all**.

A row holds counts, an outcome, two digests, the snapshot's own `source` label and the **base name** of the
file. That is the complete list. There is no title, no year, no provider ref value, no external id, no
metadata value, no item id, no ciphertext and no path — `file_name` is CHECK-constrained to a single path-free
component in the schema itself, so a directory cannot reach the column even if a caller tried, and the suite
proves the database refuses one.

The history row is **best-effort and says so**. An import that succeeded and a history row that failed is an
honest `recorded: false`, not a failed import: the catalog write already happened, and pretending it did not
would be worse than an incomplete audit trail.

## One implementation, two surfaces

`src/ops/catalog-import-service.ts` is the only implementation of "preview an import" and "apply an import".
`ops:catalog-import` and the routes above call it and nothing else, so the preview a person reads in a
terminal and the preview they read in a browser are produced by the same code — and so is the apply behind
each. **The CLI's behaviour is unchanged** apart from one addition: it now records what it did in the same
durable history, so an operator who uses both surfaces has one answer to "what have I loaded", not two partial
ones.

What is *not* shared is how the file was **chosen** — the CLI takes a path from an operator who already has
shell access; the UI takes a name from a closed listing of one read-only folder. Those are genuinely different
questions with different threat models, and collapsing them would mean the browser could name a path.

## Invariants that did not change

* Every write still goes through `CatalogAuthority.addItem` / `updateIdentity`. Identity is encrypted in this
  process with a per-item key from the custodian, exactly as before; the database only ever sees ciphertext.
* Item ids are still derived from `(source, externalId)`, so **a repeat import is a no-op** and cannot
  duplicate a record.
* An item that was **forgotten** is reported blocked and skipped. An import cannot undo an erasure.
* Nothing here reads, writes, references or implies a promotion record.
* Nothing contacts a provider, a media server, a library or any network endpoint.

## Proof

`npm run test:phase264-local` (`test/operator-ui-import-endpoint.ts`) — 61 assertions covering path traversal
in fourteen spellings, symlinks, oversized and empty files, non-string names, a bounded and deterministic
listing, confirmation forgery, tampering, replay, expiry, cross-process rejection and substitution, the
content-type / origin / size rules, auth and method on all four routes, fail-closed with no database, the v6
grants and CHECKs, and the whole preview → refuse → apply → repeat flow against a real PostgreSQL.

**The check-to-open race is proved, not argued.** A real filesystem cannot be made to lose that race on
demand, so the syscalls are injected and the swap is scheduled exactly where it hurts: the pathname is
repointed at a symlink *at the moment of the open*, after every validation has passed. The suite asserts the
open refuses it, that no byte from outside the folder appears in the refusal, that **no call after the open
carries a pathname at all** (a re-resolution would be another window), that the descriptor is closed exactly
once on every path, and separately covers a symlink present at open time, a non-regular descriptor, a file
that grew between the `fstat` and the read, one that was **truncated** between them, both size bounds, an
empty descriptor by either route, a stale listing, and a platform without `O_NOFOLLOW` returning **no content
and performing no open at all** — asserted down to "the refusal made zero filesystem calls".

`deploy/ci/catalog-acceptance.sh` proves the same workflow through a real browser against a real Compose
stack.

## Limitations

* **The confirmation does not survive a restart**, by design. A page left open across an upgrade must preview
  again. That is the fail-closed direction and it costs one click.
* **Whole-run atomicity is still not claimed.** Per-record atomicity is the database's; a run that fails
  part-way is resumable, because identities are derived and a record that is already present is left alone.
  The report says which records landed and which did not.
* **The history is an audit of imports, not of the catalog.** It records what an import did, not what the
  catalog subsequently became — a later erasure does not rewrite an older row, and should not.
* **The inbox lists at most 200 files** and says when it stopped. A folder with more than that needs the
  command line, which takes a name directly.
* **`O_NOFOLLOW` is POSIX, and without it the browser import does not work at all.** That is deliberate: the
  module refuses rather than falling back. On a developer machine without the flag the Import panel reports
  `UNSUPPORTED_PLATFORM` and `ops:catalog-import` is the way in. The shipped container is Linux and is
  unaffected.
* **The real-filesystem inbox tests and the HTTP preview/apply flow cannot run on such a platform**, because
  the module declines to read anything. They are skipped loudly rather than adjusted to pass — adjusting them
  would mean asserting the fallback that was removed. The injected-syscall suite proves the decision logic
  everywhere, and CI runs on Linux, where nothing is skipped.
* **The command-line path resolves by name**, as it always has. It is used by an operator who already has
  shell access to the container, so a race against themselves is not a boundary this product is defending;
  the browser path is the one that takes an untrusted name, and it is the one bound to a descriptor.
