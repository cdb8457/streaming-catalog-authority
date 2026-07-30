# Phases 297–304 — the restore, which this product had described and never performed

Phase 256 established what a complete backup **is**: four components, none of them obtainable again from
anywhere. Phase 277 made taking one a command. Phase 278 verified it in the same run. Phases 279–280
rehearsed a restore of it — **in a throwaway project**, which was the point of a rehearsal and is also its
limit.

So on the day it matters, an operator holding a verified set had a document. `LIFECYCLE_MIGRATION_BACKUP_
UPGRADE_ROLLBACK.md` said, in prose, under the heading *the honest sequence*:

> 1. `docker compose down`
> 2. Restore the database dump you took **before you upgraded**, and the **keystore from that same backup**.
> 3. Set `CATALOG_AUTHORITY_IMAGE` back to the previous version.
> 4. `docker compose up -d`

Four numbered steps, of which step 2 is four components, an ordering, a schema decision, a role that
`pg_dump` does not carry, and a database that must be **empty** before the dump is replayed into it. The one
part of this product's lifecycle with no command was the part performed by somebody who has just lost
something.

| Phase | What it adds | What it changes |
| --- | --- | --- |
| **297** | The restore model: where each component goes, in which order, which steps are irreversible, and how each component is staged and re-verified | A restore stops being prose |
| **298** | Classification of the installation being restored **into** — `OCCUPIED` or `UNKNOWN`, never `EMPTY` — and of the set against it | A restore refuses before it destroys |
| **299** | The plan, a digest over the **whole canonical operation**, and the confirmation that has to carry it back | A restore is read before it is run, and one authorisation fits one operation |
| **300** | The safety set — a verified complete backup of what is about to be destroyed | The step that cannot be undone has something behind it |
| **301** | Execution: `down -v`, place, replay, boot — the rehearsal's proven rollback leg, against a real project | The restore is the command |
| **302** | `ops:custody-proof` — a shipped, read-only proof that actually **decrypts** through the catalog authority — and the four proofs that consume it | A restore that cannot decrypt is a failed restore, not a green one |
| **303** | The journal as a validated, path-bound state machine; `--resume` and `--abandon` bound to it | An interrupted restore is a named state, and unwinding it cannot use the wrong paths |
| **304** | `ops:complete-restore`, the rendered operator surfaces, and the acceptance suite | The document and the command cannot disagree |

## What this command is, and what it is not

It is the **inverse of `ops:complete-backup`**, and it composes with it rather than re-deciding anything.
The component list is `backup-components.ts`'s. The artifact names are `COMPONENT_ARTIFACT_NAMES`. The set is
verified by Phase 278's `verifyBackupSet` before it is read and again under the lock. The safety set is taken
by Phase 277's own `runVerifiedCompleteBackup` — not by a second implementation of a backup.

It is **not** `ops:backup -- restore`, which is the Phase 3 ciphertext-only *database* artifact restored
through the owner connection. That is one component of four, and it is still there and still means what it
meant.

It is **not** an upgrade and it is **not** a migration. It puts an installation back to a moment; the
schema the moment carried must be the schema this build understands, and a set that is older is a rollback
point for the version it came from and is refused here, in the same words Phase 278 already uses.

Like every other command in this family it runs on the **host**, beside the Compose project. It stops the
stack, and it destroys its volumes; nothing inside the stack could do either.

## Phase 297 — the model

`restore-model.ts` derives, from the four components, exactly where each one lands and how:

| Component | Where it goes | How |
| --- | --- | --- |
| `secrets` | the project's secrets directory | a host-side directory **swap** |
| `promotion-records` | the project's promotion-records directory | a host-side directory **swap** |
| `keystore` (inline) | the app container's keystore volume | `compose cp` into a volume `down -v` has just emptied |
| `keystore` (sidecar) | the sidecar state directory the operator names | a host-side directory **swap** |
| `database` | the running PostgreSQL container | `psql` reading the dump **from this command's own descriptor** |

There is no fifth placement and no default. A component the model gains has to answer this table before it
compiles, which is the same anti-drift rule the backup coverage follows.

**A swap is a rename, not an overwrite.** The staged copy is placed beside the target under a dot-prefixed
name, the target is renamed to `.<name>.replaced-<suffix>`, and the staged copy is renamed into place. Three
things follow: a killed run leaves a staging directory and an untouched target rather than half a secrets
folder; the previous state is still on disk under a name this command chose, which is what `--abandon` puts
back; and nothing is ever *merged*. A keystore restored **on top of** another keystore is the failure this
whole family exists to prevent — the wrapped keys of two different moments in one directory, every one of
them individually valid.

**The dump is never copied into a container.** `compose exec -T postgres psql … ` runs with **stdin bound to
the descriptor this command opened on the STAGED, re-verified dump**, exactly mirroring Phase 277's
`FileOutputRunner`, which binds `pg_dump`'s stdout to a descriptor. The bytes never enter this process, so
they cannot be re-encoded; nothing is written inside the container, so there is no temporary copy of the
operator's database to forget to remove; and the file that is replayed is proved by `fstat` to be the file
that was verified, not a name that could have become a link in between.

## Phase 298 — classification, before anything is destroyed

Three questions, answered from evidence, all of them before the first service is stopped.

**Is the set restorable at all?** `verifyBackupSet` must return `ok` **and**
`restorableUnderThisBuild`. Those are two different facts and both are required: an intact set from an older
build verifies and is not restorable here, and saying so is the whole point of the flag.

**Does the set's custody topology match the one declared?** The manifest records `inline` or `sidecar`. A
sidecar set restored as inline puts the keystore in a volume the sidecar never reads; an inline set restored
as sidecar puts it in a directory the app never reads. Both produce an installation that starts, passes its
checks and decrypts nothing. A disagreement is `TOPOLOGY_DISAGREEMENT` and it is refused — the command does
not choose which of the two the operator meant.

**Is the target occupied — and can that even be answered?** This is where the first cut of this tranche was
wrong, and the correction is a **removal**.

It classified a project whose host directories were empty as `EMPTY` and skipped the safety set on the
strength of it. But the components a restore destroys are not all on the host: `docker compose down -v`
destroys the **database volume** and, in inline custody, the **keystore volume**. A project can have an empty
`secrets/` directory and a volume holding an entire catalog — which is exactly the state of an installation
whose host files were lost and whose Docker state was not. Empty host directories are not evidence about
volumes; they are the absence of evidence about anything.

Reading a volume's contents means starting a container against it, and starting something is a change this
command must not make before it has been authorised. So **emptiness is never inferred**, and there is no
`EMPTY`:

| State | What it means | What it requires |
| --- | --- | --- |
| `OCCUPIED` | Positive evidence of state: a host component directory holds something, the project has containers, or a probe could not answer | A **verified safety set** |
| `UNKNOWN` | No evidence either way, and none obtainable without mutating | The digest-bound **`--accept-data-loss`** — a safety set cannot be taken, because there is no host state to back up |

The probe is `docker compose ps`, which resolves and lists and **starts nothing**. It can only ever *add*
occupancy: containers mean the project has been up and therefore has state, while their absence proves
nothing at all, because `docker compose down` removes containers and keeps volumes. A probe that cannot
answer counts as occupied — "I could not see it" is not "it is not there".

## Phase 299 — the plan, and the digest that has to come back

`--plan` verifies the set, classifies the target, resolves every path, builds the ordered step list, and
prints it. It stops nothing, creates nothing and writes nothing.

It ends with a **digest over the whole operation**, and that is the second thing the first cut got wrong.
It hashed the set name, the set's own digest, the topology, the safety-set boolean and the step list — and
*not* which project, which destination, which secrets/records/sidecar directory, what the safety set would be
**called**, or what this command had concluded about the installation. Two projects holding a copy of one set
therefore produced the **same digest**, so a confirmation read off one authorised destroying the other. Inline
custody was protected only *incidentally*, because one command in its step list happens to carry an absolute
path; sidecar custody, which places its keystore by rename and issues no such command, collided outright.

The canonical operation identity now binds, exhaustively: the project root, the backup destination, the set
name and its resolved path and its verified `setDigest` and schema version, the custody topology, **every
component's target path**, which components the set carries, the target-state classification, the safety-set
name, whether a safety set will be taken, whether loss was acknowledged, and the exact ordered argv of every
command. Running requires the digest back through `--confirm`, and it is **recomputed under the maintenance
lock** over a fresh verification before the first destructive step.

**Paths go into the hash and never into the output.** A rendered plan shows `<project>` for the project root
and `<staged>` for the run's private staging directory, so it is exactly readable as a sequence of operations
without naming anybody's appdata layout — while the digest behind it remains unambiguous.

## Phase 300 — the safety set

**`down -v` is irreversible and it is three steps in.** So before it, against an `OCCUPIED` target, this
command takes a complete backup of the installation it is about to destroy, using Phase 277's
`runVerifiedCompleteBackup` unchanged, and requires it to be `ok` — taken, restarted and **verified**. A
safety set that did not verify is not a safety set, and the restore stops there with the installation
untouched and running.

It is taken **inside the restore's own lock**, through the documented `holdingLock` seam. The alternative —
taking it before the lock — would leave a window in which another maintenance command could act between the
safety set and the restore, and the digest re-proof would then be checking the wrong moment.

`--accept-data-loss <digest>` is the only way past it. It takes the **plan digest**, so it cannot be pasted
from a previous run, from a different set, from a different project or from the same operation planned
*with* a safety set — those are two different plans and two different digests.

The first cut **refused** the acknowledgement when it believed the target was empty, reasoning that an
acknowledgement of loss with nothing to lose is a habit somebody is building for the run where there is. The
reasoning was sound and the premise was false: it could not know the installation was empty. On an `UNKNOWN`
target the acknowledgement is not a shortcut past a check — it is the **only** way through, because a safety
set cannot be taken of an installation with no host state to back up. A run without either stops at its
first step with nothing destroyed.

## Phase 301 — execution

The order is the guarantee, and it is the rehearsal's proven rollback leg pointed at a real project:

1. **safety set** — a verified complete backup of what is about to be destroyed.
2. **stage the components.** Every component is copied out of the set through descriptor-safe reads and
   the copy is **re-verified against the manifest's own recorded digest, entry count and byte count**.

   This closes the fourth thing the first cut got wrong. `verifyBackupSet` runs once, at resolution — and
   every placement afterwards then re-opened the set **by path**: a `copyTree` walked the component
   directories again, and the replay bound a descriptor to the dump again. Between the verification and
   those reads the set could change — an operator tidying up, a second process, a scheduled sync, anything
   holding a handle on that directory — and the restore would place bytes no verification had ever
   approved, silently. Staging happens **before the teardown**, so a set that changed under this command
   costs nothing; and from here on nothing reads the set again.
3. **`compose down -v`** — the stack stops and its volumes are destroyed. This is the irreversible step, and
   nothing before it has changed the installation. The database and, in inline custody, the keystore are
   gone; the secrets, the promotion records and the backups are host directories and are not.
4. **place the secrets**, by swap. *Before* the database is started, and that ordering is load-bearing:
   PostgreSQL initialises a fresh volume with the password in the secret file it is given, so placing the
   set's secrets first is what makes the restored `postgres_password` the password the volume actually has.
   Restoring secrets **after** a database had been initialised is how an installation ends up unable to
   authenticate to its own volume — the caveat `backup-components.ts` has always carried, closed by ordering
   rather than by a warning.
5. **place the promotion records**, by swap.
6. **place the sidecar keystore**, by swap — sidecar custody only.
7. **`compose up -d --pull never --wait --wait-timeout 60 postgres`** — only the database, from an image
   already on this host, waited for by its own declared healthcheck. `--pull never` is not decoration: the
   command guard has no `pull` verb at all, and this says the same thing where Compose can read it.
8. **prepare the runtime role.** `pg_dump` preserves `GRANT` targets and does not dump cluster-wide roles, so
   the managed `app` role is created without a login before the ACLs land on it. It is a product constant,
   not input from the dump, and it carries no credential — the normal bootstrap sets its password from the
   restored secret afterwards.
9. **replay the dump** — the STAGED, re-verified one — from this command's own descriptor, with
   `ON_ERROR_STOP=1`.
10. **place the inline keystore** — `compose create app`, then `compose cp` into the volume `down -v` emptied.
   The volume is empty by construction, so this is a placement and never a merge.
11. **`compose up -d --pull never --wait --wait-timeout 120`** — the whole stack. `ops:bootstrap` migrates
    (idempotently, against a schema that is already at this version), provisions the runtime credential from
    the restored secret, and gates the app on its own success.

The staging directory holds a copy of every secret in the installation, so a **completed** restore removes it
by digest-checked ownership. A failed one leaves it for the resume, and says so.

Every step is journaled before it runs and marked after it completes. Every path out of the window runs the
same `finally`, and a restore that leaves services stopped reports the outage as a **named fact** — the same
dual-failure shape `CompleteBackupFailed` already has, for the same reason.

## Phase 302 — the proof, and why one of them has to actually decrypt

An installation whose keystore did not arrive **starts, passes every check, and reports itself healthy**,
because a fail-closed unreadable item is indistinguishable from a correctly erased one. That sentence is in
`backup-components.ts`, it is the reason the keystore is a component, and it means a restore that proves only
liveness proves nothing about the thing most likely to have gone wrong.

**The first cut then proved liveness and called it decryption.** Its "decryption proof" ran
`ops:collections status`, which reads the managed-collection and history tables and **counts rows**. It
constructs no `CatalogAuthority`, asks the custodian for no key, and decrypts nothing — so it answers
exactly as well on an installation whose keystore is missing, wrong, or from another moment as on one whose
keystore is correct. A check like that is not weaker than nothing; it is worse, because it carries the word
"proof".

So there is now a shipped command that decrypts: **`ops:custody-proof`**. It selects active, encrypted items
straight from the tables and, for each one, calls the shipped `CatalogAuthority.readIdentity` — which asks
the custodian for the key, decrypts the identity envelope, decrypts every provider ref, and re-checks the
lineage at its linearization point. There is no way to satisfy it without the key material.

It is **read-only** (two `SELECT`s and a decryption), it runs inside the privileges the least-privileged
runtime role already has, and its report carries a verdict, five counts and a bound — no title, no provider
reference, no item id, no key id, no host path and no address.

**Its bound is a documented policy.** It attempts up to `--sample` records (default 25) in a deterministic
order, and the report states both how many exist and how many were attempted, so "all of them" and "the
first twenty-five of them" are never the same sentence. `PROVEN` means every attempted record decrypted.

**And it is honest about an empty catalog.** An installation with no encrypted records cannot prove custody,
because there is nothing encrypted to decrypt. That is a correct and permanent state for a fresh
installation, and the temptation is to round it up to a pass. It reports `NO_ENCRYPTED_RECORDS` with
`proven: false`, and the restore records `custodyProven: false` and says so in words. "I had nothing to
check" is not "I checked".

So four proofs:

* **`ops:version`** — the running build and the restored database agree on an exact schema version, and it is
  the one the set's manifest recorded. This is also where a project pinned to the wrong image is caught: an
  older set restored under a newer image produces a disagreement here rather than a silent forward migration.
* **`ops:doctor --json`** — the shipped read-only doctor, and its **body is consumed**, not merely its exit
  status. A doctor that reported a failure behind a zero exit is a case this family has already been caught
  by once.
* **`ops:custody-proof --json`** — the one that **decrypts**. Its body is read through the shipped
  `readCustodyProof`, which checks the report identifier, the version, the verdict, that `proven` agrees with
  the verdict, and that the outcome counts add up to the attempt. A body outside that contract makes the
  answer `UNKNOWN`, which is not a pass.
* **`ops:collections history`** — the durable identity-minimised history survived the replay.

A failed proof does not un-restore anything, and it does not claim the restore succeeded either. It reports
`RESTORED_BUT_UNPROVEN`, names which proof did not hold, and names the safety set as the way back. **Every
proof runs even after one fails** — they are independent diagnoses, they change nothing, and an operator
whose version check failed still needs to know whether their installation can decrypt.

`ok` and `custodyProven` are separate fields, and the CLI exits non-zero unless **both** hold. A restore that
came up without demonstrating custody has not earned a zero exit, because a scheduler reading zero would put
it into service.
## Phase 303 — an interrupted restore is a validated, path-bound state

The journal is a private file in the project root, staged and renamed on every update so a reader sees the
previous complete journal or the new one and never a prefix of either. A project carrying one refuses a
fresh restore: an installation half-way through a restore is not a starting point, and running the sequence
again from the top would take a "safety set" of the wreckage.

**Every field is validated, because every field is acted on.** This file decides which steps a resume skips,
which directories an abandon renames, and what suffix goes into the names it builds — and it lives in a
directory an operator owns. The first cut checked five types and a literal. It now refuses, before any
mutation: a suffix that is not exactly the twelve hex characters `stagingSuffix()` produces (one carrying a
separator or a traversal would build a sibling path nobody chose); a set or safety-set name that is not a
usable name; a custody mode and sidecar path that disagree; a safety set recorded as taken but never planned;
an unknown, duplicated or out-of-order step; a step recorded as both running and complete; a running step
that is not the one this operation would have reached; a swap of a component this build does not have; and a
`.replaced-` name this command would not have created.

**`completed` must be a strict ordered prefix of the rederived plan.** A journal that records a later step as
done and an earlier one as not is not an interrupted run — a run cannot finish a later step first — and
resuming it would perform the missing step against state that is already past it.

**The journal carries the operation, so resume and abandon are bound to it and not to a command line.**

* **`--resume <digest>`** takes only `--project`. The set, the destination, the custody mode, the safety-set
  name and every target path come from what the interrupted run recorded; the plan is rederived from those
  and must produce the same digest. It continues from the first step the journal does not record as complete.
  The swaps are idempotent by digest: a target already holding the staged copy is recognised and skipped
  rather than swapped a second time onto a `.replaced` directory that would then hold the *restored* state.
* **`--abandon`** takes only `--project`, and that is a correction rather than a convenience. The first cut
  re-derived its targets from the CLI's `--secrets` / `--promotion-records` / `--sidecar-state` flags — which
  can differ from the ones the interrupted run actually swapped, by a typo, a different habit or a second
  operator. The consequence was silent: abandon found no `.replaced-` directory at the path it was told
  about, reported success with nothing put back, and **cleared the journal**, leaving the real swapped
  directories orphaned and the project accepting a fresh restore over them. It now walks the journal's own
  swaps, and it **refuses to clear the journal while any recorded swap is still unresolved** — a partial
  unwind is a state that must stay visible.

Abandon restores host state only, and says so plainly: the database and, in inline custody, the keystore were
destroyed by `down -v`, and a rename cannot bring either back. The **safety set** is what does, through this
same command. The restored copy it displaces is moved aside rather than deleted, so an operator who abandons
and then changes their mind still holds both.

**A report after a resume names every directory the operation kept**, from the journal — not only the ones
the current process happened to move. The first cut reported an empty list on a resumed run, telling an
operator nothing had been kept while three directories of their previous secrets sat on disk, unnamed.
## Phase 304 — the surfaces

`ops:complete-restore` is the CLI, with the same flag discipline every maintenance command has: long flags
only, no credential ever on a command line, `--json` for the machine-readable report, and refusals that name
a rule and never a path.

`backup-components.ts` gains, for each component, the **command this product now runs** beside the by-hand
form it already carried — from the same model, so the operator UI's *Backup & restore* panel, the first-run
checklist and the lifecycle document cannot disagree with the command about what a restore is. That was the
original Phase 256 defect (three surfaces, three answers) and it is closed the same way it was closed for
backup: one model, rendered.

## What it does not do, stated rather than implied

* **It does not synthesise a backup.** Without a verified set there is no restore, and nothing here pretends
  otherwise.
* **It does not restore an older set.** A set from before this build's schema is a rollback point for the
  version it came from. Roll the image back *and* restore under that build.
* **It does not choose your image pin.** The project's `CATALOG_AUTHORITY_IMAGE` is the operator's decision
  and this command does not edit it. A pin that disagrees with the set is caught by the `ops:version` proof
  **after** the restore, not before it — the image's schema cannot be read without running it, and running it
  against the old database would be the migration a restore exists to avoid. The safety set is what makes
  that ordering acceptable, and it is why the safety set is mandatory.
* **It contacts nothing.** No network, no registry, no media path, no media server, no acquisition system —
  asserted against the command ledger the run actually produced, not against a claim about it.
* **It cannot prove your Docker volumes are empty**, and it does not claim to. This is the limitation behind
  the `UNKNOWN` classification: reading a volume means starting a container against it, and starting
  something is a change. Every restore therefore needs either a verified safety set or an explicit,
  digest-bound acknowledgement that volumes of unknown contents are about to be destroyed.
* **A custody proof over a sample is a proof about that sample.** With more active encrypted records than the
  bound, `PROVEN` means the attempted ones decrypted — the report always states both numbers. Raise
  `--sample` to widen it.
* **It cannot prove custody of a catalog with nothing in it.** `NO_ENCRYPTED_RECORDS` is reported as
  `custodyProven: false`, not as a pass. A set taken from an empty installation restores correctly and
  demonstrates nothing about the keystore, and both halves of that are said.
* **It takes no credential on a command line**, and it opens no secret file. The secrets component is copied
  byte for byte through descriptors and is never read, parsed, digested by content into a report, or printed.
