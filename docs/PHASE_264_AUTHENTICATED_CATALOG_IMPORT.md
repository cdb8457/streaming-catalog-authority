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

Four independent checks, in this order, each a refusal rather than a repair:

1. **The name matches a closed grammar** — `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$`. No separator, no
   `..`, no dot-file, no control character, no space, no percent-encoding. Traversal is not something this
   code defends against after the fact; it is something that cannot be spelled.
2. **The inbox is configured and resolvable.**
3. **The resolved real path is inside the resolved inbox root** — checked after `realpath` on both sides, so a
   symlink planted inside the folder cannot point out of it — and is a **direct child**, so a file two levels
   down (which the listing never offered) is refused too.
4. **What is there is a regular, non-empty, bounded file** — checked with `lstat`, before it is read, and the
   size re-checked against the bytes actually read so a file that grew in between is refused rather than
   half-honoured.

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

`npm run test:phase264-local` (`test/operator-ui-import-endpoint.ts`) — 44 assertions covering path traversal
in fourteen spellings, symlinks, oversized and empty files, non-string names, a bounded and deterministic
listing, confirmation forgery, tampering, replay, expiry, cross-process rejection and substitution, the
content-type / origin / size rules, auth and method on all four routes, fail-closed with no database, the v6
grants and CHECKs, and the whole preview → refuse → apply → repeat flow against a real PostgreSQL.

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
