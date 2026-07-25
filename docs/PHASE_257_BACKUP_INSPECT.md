# Phase 257: is the backup you have still a rollback point?

There are no down-migrations. That is stated everywhere in this project, and it means the entire rollback
story is one sentence:

> Restore the dump you took **before** the upgrade.

Which was advice nobody could check. A folder with three `.sql` files in it does not say which one predates
which upgrade, and nothing in this product could look at a dump and tell you what schema it holds. So the
question *"is the backup I have still a rollback point?"* was answered from memory, on the day it mattered.

Phase 256 said what a complete backup is. This says whether the one you have is any good.

```
npm run ops:backup-inspect
```

or, from a release bundle with no toolchain on the host:

```
docker compose run --rm --no-deps -v "$PWD/backup:/backup:ro" \
  -e CATALOG_AUTHORITY_BACKUP_DIR=/backup app ops:backup-inspect
```

`--no-deps` is load-bearing and is asserted by a test: without it, Compose starts PostgreSQL and the migration
before running a check whose entire claim is that it needs no database.

---

## 1. Offline, by construction

No database is contacted. Nothing is fetched. No process is spawned. Nothing is restored, and nothing is
written anywhere. A test asserts each of those against the module's source, matched on code shapes rather than
words so that a comment *saying* it spawns nothing does not read as spawning something.

This matters because of when the command gets used: the moment you want to know whether a backup is any good
is not reliably a moment when the thing it backs up is running.

## 2. Every uncertainty blocks

| Verdict | Meaning | Exit |
| --- | --- | --- |
| `CURRENT` | Complete, and the dump holds the schema this build expects. | 0 |
| `ROLLBACK_POINT` | Complete, and the dump predates this build's schema — a valid rollback point for the version it came from, **and not restorable under this build**. Both halves are said. | 0 |
| `INCOMPLETE` | A required component is not there. | 1 |
| `AHEAD` | The dump holds a **newer** schema than this build understands. Refused: an older build in front of a newer schema is how data gets quietly corrupted. | 1 |
| `INDETERMINATE` | Everything required is present and the schema version could not be established. | 1 |

`INDETERMINATE` is reached deliberately and often:

* **a custom-format archive** is compressed, and this reads plain text. It is reported as a dump — it does
  satisfy the database component — with its version explicitly unknowable, and the operator is told to take a
  plain-format dump as well or to restore it into a throwaway database and read the version there;
* **a dump with no `schema_meta` row** is a partial dump or one that predates the version table, and either
  way it is not evidence of anything;
* **two `schema_meta` rows that disagree** — what concatenating two dumps produces — is `AMBIGUOUS`, and
  nothing here picks one of them;
* **a gzip-compressed dump** — what `pg_dump … | gzip` produces — counts as the database component with its
  version unknowable, rather than being counted as nothing and reporting `INCOMPLETE` with the dump sitting
  right there;
* **two dumps in one folder that disagree** likewise;
* **a readable dump beside an unreadable one** also blocks. The folder contains a dump nobody can place, and
  restoring the wrong one is the failure this exists to prevent. The readable one's version is still reported
  on its own entry;
* **a file larger than the scan bound**, with no version found in the part that was read, says exactly that.

The verdict text refuses to be read either way: *"That is not evidence the backup is fine and not evidence it
is broken — it is an unanswered question, and a rollback plan cannot rest on one."*

Missing **promotion records do not make a backup incomplete.** An empty records folder is a correct and
permanent state for many installations — Phase 253's `READY_NO_RECORDS` — and treating its absence as a fault
would report a problem on most installs. The absence is stated in the limits instead.

## 3. What it will not touch

* **No secret file is ever opened.** A secrets copy is recognised by file **names**, and reported as
  present / absent / empty. A tool that reads your KEK to tell you it is there has told you something you
  already knew, at a cost you did not agree to. A test writes distinctive values into the fixture secrets and
  asserts none of them appears anywhere in the output.
* **No symbolic link is followed.** Every entry is `lstat`ed; a link is reported and skipped, and what it
  points at is not counted as present. The test points a link at something shaped exactly like a keystore and
  asserts the backup is still `INCOMPLETE` — following it would have produced a pass. The module is asserted
  never to use `statSync`, which follows links.
* **Nothing is guessed.** An unrecognised file or directory is counted as nothing and reported by name.
* **No path is echoed.** The output carries entry basenames — which the operator chose and already knows —
  and never the directory it was pointed at, no absolute path, and no file contents.

## 4. Reading the version, without assuming a layout

`schema_meta` is `(id INTEGER PRIMARY KEY, version INTEGER)`. A plain dump writes either a `COPY` block or,
with `--inserts`, an `INSERT`. All three shapes are read, and the **`COPY` column list is parsed rather than
assumed** — a column added before `version` in some future schema cannot silently shift which integer gets
read. A test inserts a fictional column to prove it.

The one form that must assume a position is the columnless `INSERT INTO schema_meta VALUES (1, 4)`. That
assumption is pinned by a **live test against a real migrated PostgreSQL**: `information_schema.columns`
reports the declared order, and the offline parser is then run over a `COPY` block built from the real column
list and the real recorded version.

The file is **streamed** with a fixed window, so memory is bounded on a dump of any size, and the carry-over
across chunk boundaries is tested with a block deliberately placed past the window. The byte bound is
respected exactly — a read never runs past it — so a bound can never be reported when the answer had actually
been found.

## 5. No default directory

Phase 254 established, by observing three different behaviours on three npm versions, that
`npm run x -- --flag value` is not portable: the flag may arrive intact, arrive as one token, or be eaten with
only its value forwarded. All three converge on the same failure — the flag is not seen and a default is used
silently.

There is **no default here**, which removes that failure rather than mitigating it.

| Channel | Use |
| --- | --- |
| `CATALOG_AUTHORITY_BACKUP_DIR` | The reliable one. Cannot be reordered, renamed or eaten between caller and process. |
| `--dir <directory>` | Direct invocation. |

A bare argument is a **hard error** — it is exactly what npm produces when it forwards a value without its
name, and treating it as "probably the directory" is how a check inspects somewhere nobody asked about. Two
channels that disagree are a refusal, not a precedence puzzle. `--dir` with no value, or followed by another
flag, is refused rather than silently consuming the next token.

Exit codes are distinct: `2` for arguments that could not be resolved (nothing inspected, nothing printed),
`3` for a directory that could not be read, `1` for a backup that does not pass.

---

## What this phase does not do

It restores nothing, writes nothing, and changes nothing about any installation. It adds no route and no
mutation to the operator UI — the panel gained a command to copy, not a button that runs one. Nothing is
published, tagged, released, deployed or pushed. No promotion, approval, execution, archival or deletion is
run; no provider, media server or library is contacted; no part of Phase 231 is authorized or executed.

## Limitations, stated rather than implied

* **Nothing is restored, so nothing is proved to replay.** This checks what a backup *contains*. A file that
  parses as a dump is not a file that restores. That sentence is in the tool's own output, not only here.
* **It cannot tell whether the dump and the keystore came from the same backup.** Two components from two
  different moments restore into an installation that cannot read itself, and no metadata in either artifact
  says when it was taken. Also in the tool's own output.
* **A real `pg_dump` is not exercised by the automated tests.** The `embedded-postgres` package ships
  `initdb`, `pg_ctl` and `postgres` and no `pg_dump` binary, and this environment has no Docker daemon. The
  suite **reports that as a skip** rather than omitting it. The one thing a fixture could be confidently wrong
  about — the shape and contents of `schema_meta` — is pinned by the live test described above. A dump
  produced by a real `pg_dump` inside the built image is the next rung, and belongs with the container smoke.
* The directory-format dump (`pg_dump -Fd`) is detected only when its `PGDMP` magic is the first thing read;
  a directory-format *directory* falls through to `UNRECOGNISED` rather than being claimed.
* A promotion-records copy is identified **by shape** — a folder whose entries are all `.json` files — so
  another folder of JSON would be described that way too. It never changes a verdict, because records are not
  a required component, and the wording says the shape is what was matched.
* A **single** file named like a secret does not satisfy the secrets component. A secrets backup is the whole
  folder the setup script created; satisfying it on one file would turn an obviously partial copy into a
  pass. What was seen is still named, so nobody goes looking in the wrong place.

## Tests

`test/backup-inspect.ts` — 47 checks and one reported skip, run in CI as `test:phase257-local`: every
verdict including `AHEAD` and each way of
reaching `INDETERMINATE`, the Phase 256 omission caught as `INCOMPLETE`, records not counting as required,
`COPY` column lists read rather than assumed, CRLF dumps, both `INSERT` forms, a similarly-named table not
mistaken for `schema_meta`, a COPY block split across a streaming chunk boundary at every offset in a window around it, the scan bound reported as a
question rather than an absence, no secret value reaching the output, an empty secret named, symlinks refused
and not followed, no path echoed, every argument-resolution refusal, the CLI's four exit codes driven as a
real process, the panel command carrying `--no-deps` and `:ro`, and the live `schema_meta` proof.
