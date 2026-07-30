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
| **297** | The restore model: where each component goes, in which order, and which steps are irreversible | A restore stops being prose |
| **298** | Classification of the installation being restored **into**, and of the set against it | A restore refuses before it destroys |
| **299** | The plan, its digest, and the confirmation that has to carry it back | A restore is read before it is run |
| **300** | The safety set — a verified complete backup of what is about to be destroyed | The step that cannot be undone has something behind it |
| **301** | Execution: `down -v`, place, replay, boot — the rehearsal's proven rollback leg, against a real project | The restore is the command |
| **302** | The proof afterwards, including a **decryption** proof | A restore that cannot decrypt is a failed restore, not a green one |
| **303** | The journal, `--resume` and `--abandon` | An interrupted restore is a named state |
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

**A swap is a rename, not an overwrite.** The set's copy is staged beside the target under a dot-prefixed
name, the target is renamed to `.<name>.replaced-<suffix>`, and the staged copy is renamed into place. Three
things follow: a killed run leaves a staging directory and an untouched target rather than half a secrets
folder; the previous state is still on disk under a name this command chose, which is what `--abandon` puts
back; and nothing is ever *merged*. A keystore restored **on top of** another keystore is the failure this
whole family exists to prevent — the wrapped keys of two different moments in one directory, every one of
them individually valid.

**The dump is never copied into a container.** `compose exec -T postgres psql … ` runs with **stdin bound to
the descriptor this command opened on the set's own dump file**, exactly mirroring Phase 277's
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

**Is the target occupied?** An installation that has a secrets directory, a promotion-records directory or a
sidecar state directory with anything in it is `OCCUPIED`; one where all of them are absent or empty is
`EMPTY`. The classification decides one thing only: whether a **safety set** is mandatory. It is deliberately
*not* a probe of the database — asking the database would mean starting it, and by the time a restore has
started something it has already changed the installation.

## Phase 299 — the plan, and the digest that has to come back

`--plan` verifies the set, classifies the target, resolves every path, builds the ordered step list, and
prints it. It stops nothing, creates nothing and writes nothing.

It ends with a **digest** over what it decided: the set's own `setDigest` from the verification, the declared
custody, every step id in order, the argv of every command, and whether a safety set will be taken. Running
requires that digest back through `--confirm`, and the digest is **recomputed under the maintenance lock**
before the first destructive step. A set that changed between the plan and the run, a target that changed
custody, a step list that differs by one argument — all of them are a mismatch, and a mismatch is a refusal
with nothing destroyed.

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
from a previous run, from a different set or from a different project, and it is refused outright when the
target is `EMPTY` — where there is nothing to lose, an acknowledgement of loss is a habit somebody is
building for the run where there is.

## Phase 301 — execution

The order is the guarantee, and it is the rehearsal's proven rollback leg pointed at a real project:

1. **safety set** — a verified complete backup of what is about to be destroyed.
2. **`compose down -v`** — the stack stops and its volumes are destroyed. This is the irreversible step, and
   nothing before it has changed the installation. The database and, in inline custody, the keystore are
   gone; the secrets, the promotion records and the backups are host directories and are not.
3. **place the secrets**, by swap. *Before* the database is started, and that ordering is load-bearing:
   PostgreSQL initialises a fresh volume with the password in the secret file it is given, so placing the
   set's secrets first is what makes the restored `postgres_password` the password the volume actually has.
   Restoring secrets **after** a database had been initialised is how an installation ends up unable to
   authenticate to its own volume — the caveat `backup-components.ts` has always carried, closed by ordering
   rather than by a warning.
4. **place the promotion records**, by swap.
5. **place the sidecar keystore**, by swap — sidecar custody only.
6. **`compose up -d --pull never --wait --wait-timeout 60 postgres`** — only the database, from an image
   already on this host, waited for by its own declared healthcheck. `--pull never` is not decoration: the
   command guard has no `pull` verb at all, and this says the same thing where Compose can read it.
7. **prepare the runtime role.** `pg_dump` preserves `GRANT` targets and does not dump cluster-wide roles, so
   the managed `app` role is created without a login before the ACLs land on it. It is a product constant,
   not input from the dump, and it carries no credential — the normal bootstrap sets its password from the
   restored secret afterwards.
8. **replay the dump**, from this command's descriptor, with `ON_ERROR_STOP=1`.
9. **place the inline keystore** — `compose create app`, then `compose cp` into the volume `down -v` emptied.
   The volume is empty by construction, so this is a placement and never a merge.
10. **`compose up -d --pull never --wait --wait-timeout 120`** — the whole stack. `ops:bootstrap` migrates
    (idempotently, against a schema that is already at this version), provisions the runtime credential from
    the restored secret, and gates the app on its own success.

Every step is journaled before it runs and marked after it completes. Every path out of the window runs the
same `finally`, and a restore that leaves services stopped reports the outage as a **named fact** — the same
dual-failure shape `CompleteBackupFailed` already has, for the same reason.

## Phase 302 — the proof, and why one of them is a decryption

An installation whose keystore did not arrive **starts, passes every check, and reports itself healthy**,
because a fail-closed unreadable item is indistinguishable from a correctly erased one. That sentence is in
`backup-components.ts`, it is the reason the keystore is a component, and it means a restore that proves only
liveness proves nothing about the thing most likely to have gone wrong.

So four proofs, and all four must hold:

* **`ops:version`** — the running build and the restored database agree on an exact schema version, and it is
  the one the set's manifest recorded. This is also where a project pinned to the wrong image is caught: an
  older set restored under a newer image produces a disagreement here rather than a silent forward migration.
* **`ops:doctor --json`** — the shipped read-only doctor, and its **body is consumed**, not merely its exit
  status. A doctor that reported a failure behind a zero exit is a case this family has already been caught
  by once.
* **`ops:collections status`** — a shipped primitive that must **decrypt** to answer. This is the keystore
  proof, and it is the one that fails when the set's keystore was not the set's database's keystore.
* **`ops:collections history`** — the durable identity-minimised history survived the replay.

A failed proof does not un-restore anything, and it does not claim the restore succeeded either. It reports
`RESTORED_BUT_UNPROVEN`, names which proof did not hold, and names the safety set as the way back.

## Phase 303 — an interrupted restore is a state with a name

The journal is a private file in the project root, written and `fsync`ed before each step and updated after
it. A project carrying one refuses a fresh restore: an installation half-way through a restore is not a
starting point, and running the sequence again from the top would take a "safety set" of the wreckage.

* **`--resume <digest>`** continues from the first step the journal does not record as complete, after
  re-verifying the set and re-proving the plan digest. Steps 3–5 are swaps and are idempotent by
  construction: a target already holding the set's copy is recognised by digest and skipped rather than
  swapped a second time onto a `.replaced` directory that would then hold the *restored* state.
* **`--abandon`** puts the swapped directories back from their `.replaced-<suffix>` copies and clears the
  journal. It restores host state only, and it says so plainly: the database and the inline keystore were
  destroyed by `down -v` and a rename cannot bring them back — the **safety set** is what does, through this
  same command.

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
* **It takes no credential on a command line**, and it opens no secret file. The secrets component is copied
  byte for byte through descriptors and is never read, parsed, digested by content into a report, or printed.
