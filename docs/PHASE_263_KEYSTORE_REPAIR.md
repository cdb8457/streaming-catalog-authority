# Phase 263 — repairing the keystore of an installation that already exists

## The problem this finishes

Phase 262's browser gate found a defect in the shipped container: the custodian keystore lives on a Docker
volume, Docker creates a fresh volume **root-owned** when the image has nothing at that path, and the
container runs as `node`. The first thing that constructed a `FileCustodian` therefore died with

```
EACCES: permission denied, mkdir '/var/lib/catalog/keystore/keys'
```

which is `ops:doctor`, `/api/status` **and the entire catalog panel**, on every fresh install.

`Dockerfile.runtime` now creates `/var/lib/catalog/keystore` owned by `node` before dropping to that user, so
Docker gives a **fresh** volume the same ownership. That fixes every installation made from that image
onwards and fixes **nothing** for a volume that already exists: Docker initialises a named volume exactly
once, and no image change can reach back into one. An installation from v1.1.2 or earlier still has a
root-owned keystore.

That was the remaining real limitation. This phase closes it.

## What was built

### `ops:keystore-check` and `ops:keystore-repair`

One program, two script names. The difference is a single flag, and the flag is the difference between "tell
me" and "do it".

```
npm run ops:keystore-check                   # reports; writes nothing
npm run ops:keystore-repair                  # changes ownership, when the state permits it
npm run ops:keystore-check  -- --json        # the machine-readable report
npm run ops:keystore-repair -- --dir /var/lib/catalog/keystore --owner node
```

`--dir` defaults to `CUSTODIAN_KEYSTORE_DIR`. `--owner` defaults to `CATALOG_KEYSTORE_OWNER`, then to `node`,
and accepts a user name (resolved against the system's own `/etc/passwd`, never assumed to be uid 1000) or a
numeric `uid[:gid]`.

**Exit codes.** `0` the keystore is already correct. `1` a repair is needed and was not run, or the state was
refused. `2` bad usage. A *check* that finds work to do exits **non-zero on purpose** — a preflight that
reports "your keystore is unwritable" and exits 0 is a preflight nothing can gate on.

### What it is allowed to do

Two operations, and this is the complete list:

* create the keystore root if it is missing, owned by the runtime user, mode `0700`;
* change the **owner** of entries that are already there, and — on the root directory only — tighten the mode.

### What it will never do

* It does not read, write, move, rename, truncate or **delete** one byte of keystore material.
* It does not generate, rotate, unwrap or print a key, a KEK or a completion secret.
* It does not create, destroy or recreate a volume.
* It does not touch the database, open a socket, or need a network.
* It reads no secret file, so there is no secret for it to leak.

### It fails closed on anything it does not understand

Every one of these is a **refusal** with a named code and **nothing changed** — never a best-effort chown:

| Code | What it means |
| --- | --- |
| `UNSAFE_SYMLINK` | a symbolic link is the keystore path, or is inside it |
| `UNSAFE_ROOT_NOT_A_DIRECTORY` | the keystore path exists and is not a directory |
| `UNSAFE_SPECIAL_FILE` | a device, socket or FIFO is in the tree |
| `UNSAFE_MIXED_OWNERSHIP` | **two or more** different foreign owners — which is correct is not a repair's decision |
| `UNSAFE_WORLD_WRITABLE` | a key file anybody on the host can write: investigate, do not re-own |
| `UNSAFE_UNEXPECTED_ENTRY` | something that is not part of a keystore is in the directory |
| `UNSAFE_TOO_DEEP` | the tree nests deeper than a keystore's 2 levels |
| `UNSAFE_TOO_MANY_ENTRIES` | more entries than a keystore can hold |
| `UNSAFE_UNREADABLE` | an entry could not be examined at all |

A **single** foreign owner is understood: that is the legacy root-owned case, and a partially re-owned tree
left behind by an interrupted run finishes rather than refusing.

### Redaction

Every report carries counts, uids, a mode and fixed code strings. It never carries a file name from inside
the keystore, a path beyond the directory that was configured, or any file content — so the whole thing is
safe to paste into an issue exactly as printed.

### The `keystore-prepare` one-shot

`docker-compose.runtime.yml` and `docker-compose.arcane.yml` — the two shipped stacks whose long-running app
runs as a non-root user over a file-mode keystore — now run the repair as a one-shot **before anything that
needs the keystore**. Both `migrate` and `app` declare
`depends_on: { keystore-prepare: { condition: service_completed_successfully } }`, so a refusal stops the
stack instead of producing a half-working UI.

It is **the only thing in either stack that runs as root**, and it is as narrow as a container can be made:

* `user: "0:0"` — stated plainly, because that is the whole point of it;
* `network_mode: none` — no network at all, so it cannot contact anything even in principle;
* `read_only: true` — its own filesystem is read-only; its writes land on the keystore volume;
* `cap_drop: ALL` plus exactly `CHOWN`, `FOWNER`, `DAC_OVERRIDE` — what changing an owner needs, and nothing;
* `no-new-privileges:true`;
* **no secrets at all** — not the KEK, not the completion secret, not a database URL, not the operator token;
* one mount: the keystore.

**The long-running app is unchanged.** Still `user: "node"`, still `read_only: true`, still `cap_drop: ALL`
with nothing added back, still `no-new-privileges`. Elevated authority lives in a one-shot for a few
milliseconds and nowhere else.

It is **idempotent and free after the first run**: a correct keystore reports `ALREADY_CORRECT` and performs
no filesystem write at all.

### The stacks that deliberately do NOT get it

`docker-compose.unraid.yml` and `docker-compose.deploy.yml` run their containers as root over the same
keystore, so root ownership is **correct** there and a chown to `node` would break them. Adding the one-shot
everywhere "for consistency" would be the change that turned a working deployment into a broken one. The
suite asserts both that they have no `keystore-prepare` service and that no service in them runs as `node`,
so if that ever changes the test says so.

### `ops:doctor` now reports ownership

`accessSync(W_OK)` answers "can I write the directory" and stops there, which is why the shipped container
could report a writable keystore and still die on the first subdirectory it had to create. A new
`keystore-ownership` check answers the question that actually predicts failure — *is this whole tree mine?* —
using the same inspection the repair uses, and names the command that fixes it.

A foreign **owner** is a `fail` (that is what produces `EACCES`). A root directory that is merely readable
beyond its owner is a `warn` — the root-running stacks have exactly that state, legitimately.

## Manual fallback

If you would rather do it yourself, or the one-shot refused and you want to look first, **stop the stack**
and then:

```bash
# Look, without changing anything:
docker compose -f docker-compose.runtime.yml run --rm --user root --entrypoint npm \
  keystore-prepare run ops:keystore-check

# List the volume yourself:
docker compose -f docker-compose.runtime.yml run --rm --user root --entrypoint sh \
  keystore-prepare -c 'ls -lan /var/lib/catalog/keystore'

# The one-command repair, if you prefer the shell to the tool:
docker compose -f docker-compose.runtime.yml run --rm --user root --entrypoint sh \
  keystore-prepare -c 'chown -R node:node /var/lib/catalog/keystore && chmod 700 /var/lib/catalog/keystore'
```

On the Arcane/Unraid stack the keystore is a host directory, so the host's own tools work directly:

```bash
chown -R 1000:1000 /path/to/your/project/keystore
chmod 700 /path/to/your/project/keystore
```

## Rollback

The repair changes **ownership and one directory mode**. Nothing else. To undo it, put the ownership back:

```bash
docker compose -f docker-compose.runtime.yml run --rm --user root --entrypoint sh \
  keystore-prepare -c 'chown -R root:root /var/lib/catalog/keystore'
```

Because no key material is read, written, moved or removed, **there is nothing else to roll back** and no
backup is required before running it. If you want one anyway, the keystore backup procedure in
`docs/PHASE_6_LIFECYCLE.md` is unchanged and is the right one.

To take the automatic one-shot out of the startup path entirely, remove the `keystore-prepare` service and
the two `depends_on` entries that name it; the stack then behaves exactly as it did before this phase, and
`ops:keystore-check` still works by hand.

## Proof

`npm run test:phase263-local` (`test/keystore-repair.ts`).

Ownership is the whole subject, and a test cannot create a root-owned file without being root — nor can it
create one at all on a platform with no uids. So the decision logic runs against an **injected filesystem**,
which presents every state that matters exactly and deterministically on every platform: fresh,
already-correct, legacy root-owned, partially re-owned, symlinked, mixed-owner, world-writable, over-deep,
over-wide and unreadable. The real filesystem is exercised too, for the states a real filesystem can produce
here.

The shipped wiring is checked **as shipped**: the one-shot exists in each stack that needs it, is as narrow as
it claims, gates the services that would otherwise start against a broken keystore, and the long-running app
is asserted to be exactly as hardened as it was before this phase.

The end-to-end proof — a **legacy root-owned keystore, repaired, on a real Compose stack, with the app then
starting non-root** — is part of the required CI acceptance in `deploy/ci/catalog-acceptance.sh`.

## Limitations

* **It fixes ownership, not corruption.** A keystore whose files are damaged is a restore-from-backup
  problem, and this tool will not pretend otherwise: it reports ownership and stops.
* **It cannot repair what it cannot reach.** A keystore on a mount the container is not given is invisible to
  it; the manual fallback above is the answer there.
* **`UNSAFE_MIXED_OWNERSHIP` is not automatable.** Two foreign owners means a human has to decide which is
  correct, and the tool deliberately refuses rather than choosing.
* **Windows is not a deployment target for this.** The suite asserts the decision logic on every platform via
  the injected filesystem, and skips the POSIX permission assertions honestly where there are no POSIX
  permissions.
