# Phases 289–292 — moving a shipped installation onto the ring, and monitoring what it lands on

| Phase | What it is | Why it matters |
| --- | --- | --- |
| **289** | Two custody wirings as two compose files, selected by a marker | The stack asked an operator to hand-edit shipped YAML, and an upgrade reverted it |
| **290** | The static→ring cutover as one planned, confirmed, resumable transaction | Every piece existed; none of it was joined up |
| **291** | The socket and privilege boundary, stated and narrowed | Clients mounted the socket directory read-write and could have replaced the socket |
| **292** | Doctor reports custody honestly, in every state | It told every production deployment that managed KEK custody "is not built" |

**O4 remains CLOSED by implementation evidence. O5 remains implemented and hardened and NOT live-proven —
this tranche does not close it.** Nothing here has been run against a live Unraid installation by an
operator; no operator evidence is produced by any of it. What changed is that the migration an operator was
previously expected to assemble by hand is now a command, and that the doctor stopped saying something false.

---

## Phase 289 — one steady state, one temporary state

The shipped runtime file wired the sidecar to the **static KEK** and mounted the ring's root key beside it,
with this advice for after a migration:

> AFTER migrating, set SIDECAR_ROOT_KEY_FILE, remove SIDECAR_KEK_FILE and unmount custodian_kek

Three hand-edits to a shipped file, on a NAS, in a web terminal, against a daemon that refuses to start if the
result is wrong in either direction — and the file is **replaced by the next release**, silently reverting an
installation to static custody it had already migrated away from.

There are now two files and a marker:

| Mode | Compose files | Custody |
| --- | --- | --- |
| `root-only` (default) | `docker-compose.unraid.runtime.yml` | The sidecar opens its ring with the root wrapping key. The static KEK is not mounted, declared or named anywhere in the stack. |
| `bootstrap` (temporary) | the runtime file **+** `docker-compose.unraid.bootstrap.yml` | The static KEK is wired back and the root key wiring is explicitly unset, for exactly as long as a migration takes. |

```
bash deploy/unraid-custody-mode.sh /mnt/user/projects/catalog status
bash deploy/unraid-custody-mode.sh /mnt/user/projects/catalog bootstrap
docker compose -f docker-compose.unraid.runtime.yml -f docker-compose.unraid.bootstrap.yml up -d
```

**No marker means the steady state**, deliberately: an installation nobody has spoken for should be running
the canonical stack, and if it has not migrated its sidecar refuses to start and says so. Defaulting to
bootstrap would silently keep a migrated installation on its static key. The marker is read through a
no-follow bounded reader — a symlink, a directory or a word this build does not define is a refusal, not a
guess — and written exclusive-create-then-rename, so a reader sees the old word or the new one.

**A fresh installation has no ring**, and `init` is how it gets one — never `migrate`, which is for a keystore
that already holds keys:

```
docker compose -f docker-compose.unraid.runtime.yml run --rm custody-maintenance \
  ops:kek-ring -- init --state /var/lib/catalog-sidecar/state \
  --root-file /run/catalog-custody/custodian_root_key
```

## Phase 290 — the cutover

```
npm run ops:custody-cutover -- --project <dir> --project-name catalogauthority \
  --backup-set <set-name> --plan
npm run ops:custody-cutover -- --project <dir> --project-name catalogauthority \
  --backup-set <set-name> --confirm-digest <digest from the plan>
```

The plan is bound to the exact installation: the migration's own digest (which already binds the verified
backup set's digest, a digest of the exact set of wrapped key files, and both key labels), the resolved
compose configuration, the stack name and the mode it is starting from.

**What `--plan` actually does**, stated precisely because "read-only" is not "runs nothing": it renders the
compose configuration and runs the migration planner in a one-shot container that is removed on exit. No
service is stopped or started, no marker moves, no ring is written, no key file is touched, and no image is
pulled or built — but a container is created and destroyed.

The confirmed run re-resolves everything under a lock, stops `app` then `sidecar`, runs the migration in the
one-shot container, removes the marker, starts the stack on the steady-state file with `--pull never
--no-build`, and requires a health handshake reporting `sidecar-managed-ring`.

**Resumable, and the resume proves what it is resuming.** A cutover interrupted after the ring was written
leaves a bootstrap runtime with a ring beside it. `migrate` refuses to run twice, so the plan plans the
**remaining half** — `stage: switch-only`, no migration digest, no migration command. The report says
`resumed: true` and `migrationPerformed: false`, because those are different facts.

Selecting that path on the *existence of a file* would have been the worst hole in this tranche: the last act
of the resume is to switch the runtime to root-only custody, where the sidecar opens exactly that file. So a
resume proves the ring is **this installation's own adopted ring** before it plans anything — the root key
opens it; it is the exact post-adoption shape (one generation, active 1, no pending, origin
`adopted-from-static-kek`); generation 1 **is** this installation's static KEK; every wrapped key in the
keystore opens under it; and the backup still verifies and is bound by its own digest. All of it is digested
into the plan, so the confirmed run re-proves it under the lock. A corrupt ring, one sealed under another
root, one holding a different key, one an initialisation wrote, and one already rotated on are each refused.

The backup gate on a resume is the **same** gate the migration passed — the set must verify and be the same
bytes — and deliberately not the full custody-restorability proof used elsewhere: the set a cutover is gated
on is taken *before* the migration, so its keystore holds no ring at all, and demanding that proof would
refuse every legitimate resume.

### Rollback, and the two things that word means

* **Runtime rollback** — putting the stack back on the selection it was running. That is what a failed
  cutover does, and it is proved: the marker goes back, the services start, and the sidecar answers a
  handshake **reporting the custody mechanism that selection is for**. A sidecar answering `managed-ring` on
  the bootstrap selection is not the runtime that was there before, and is not accepted as "put back".
* **State rollback** — undoing the migration. **This command cannot do that and never claims to.** Once a ring
  is written, a ring exists. If the runtime rollback happens after that point the installation is running on
  the static key with a ring beside it — a state to *finish* from by re-running the cutover, or to leave by
  restoring the verified backup the cutover was gated on.

## Phase 291 — socket and privilege boundary

The sidecar mounts its run directory read-write because it **creates** the socket. `app`, `migrate` and `ops`
mount the same directory `:ro`. A client needs to *connect*, which is a read on the directory entry; it does
not need to create, remove or rename anything, and a client that can rename the socket can put its own socket
at that name and be asked for keys.

The one-shot `custody-maintenance` service is the only thing besides the sidecar that may touch key material.
It holds the state directory, the root key and (under the overlay only) the static key — and **nothing else**:
no database, no operator token, no socket, no port, `read_only`, all capabilities dropped,
`no-new-privileges`, and `network_mode: none`, so the one container holding both keys cannot speak to
anything at all.

**Proof limit, stated rather than papered over.** "A read-only bind mount can connect but cannot create,
remove or rename" is a property of the Linux kernel and the container runtime. Proving it needs a Linux host
with a working Docker daemon; the suite in this repository does not require one and the development host does
not have one, so what is proved here is the **contract** — which services mount what, and with which flags —
and the behaviour test is not claimed. Ownership and mode of the sidecar's run/state directories and the root
key file are established by the setup scripts, which **refuse** rather than best-effort `chmod`/`chown`. All
of this is POSIX/Unraid scope; the PowerShell setup script has no equivalent and no parity is claimed.

## Phase 292 — the doctor

Removed: an unconditional production warning that said managed age KEK custody "is not built", on a build
where it is built, migrated onto, rotated and retired from. A monitoring check that is wrong in the safe
direction still trains an operator to ignore it. Outside sidecar mode the gate warning remains and now says
the true thing — the mechanism exists and this deployment does not run it.

In sidecar mode the CLI and the operator UI each perform **one** health handshake and pass the structured
result in, so no two custody statements can disagree:

| State | Checks |
| --- | --- |
| No probe supplied, or the sidecar does not answer something the strict schema accepts | `custody-sidecar-health` **FAIL** |
| Valid answer, `file-reference-harness` | `custody-sidecar-health` PASS, `custody-ring-migration` **WARN** (migration pending, names `ops:custody-cutover`) |
| Valid answer, `sidecar-managed-ring`, coherent metadata | `custody-ring-metadata` PASS, `kek-rotation-age` PASS/WARN/FAIL by age |
| Ring claimed with no active generation | `custody-ring-metadata` **FAIL** |

`kek-rotation-age` is emitted in **every** sidecar outcome. It previously appeared only when a timestamp
happened to be supplied, so the one check that says a key-encryption key is too old disappeared in exactly the
states where something was wrong. No custody check carries a path, a key-shaped value or any text from the
peer.

## Verification status

`npm run typecheck` clean. New suite `custody-cutover` (22 tests): both compose resolutions, marker refusals,
secret/mount isolation, no Docker socket or privilege escalation, read-only client mounts, plan purity,
confirm mismatch and input swap, a successful cutover whose migration is the **real** `adoptStaticKekAsRing`
over a real keystore, a resume and five adversarial rings it must refuse, a failed-health runtime rollback, a failed migration, the command boundary,
the CLI surface, and the doctor states.

Fake command ledgers are used for the orchestration — stopping and starting containers on a NAS is not
something a suite may do — and the cryptography under them is **not** faked: the migration plan digest, the
backup verification, the custody proof and the ring are all real. No disposable container was used because
none was available on this host; no Tower, Jellyfin or provider was contacted by anything here.
