# The TorBox projection alpha — installing it, attaching to it, using it, recovering it

**Who this is for.** An Unraid operator who wants Plex, Jellyfin or Emby to play files that live in a TorBox
account, through one `projectiond` FUSE mount, without downloading them first.

**What state this is in.** An **alpha**, on **one measured host**, with **one provider**. §6 is the list of
rough edges and every one of them is real. Read it before you install, not after.

**Where the evidence is.** `docs/PROJECTION_PHASE_6_DEPLOYABLE_ALPHA.md` §11 is what was measured about the
appliance and the operator command; `docs/PROJECTION_PHASE_7_OPERATOR_USABLE_ALPHA.md` §11 is what was
measured about it **with three real media servers attached and playing**. Neither is a marketing page: if a
thing is not in one of those run records, it has not been measured.

---

## 1. What you need before you start

| | |
|---|---|
| **A host** | Unraid, with `/dev/fuse` reachable from a container. `deploy/projection-alpha.sh preflight` is what answers that, and it changes nothing |
| **A TorBox account** | and its API key **in a file**. There is no variable in this appliance's environment contract that holds a credential, so an environment that leaked could not leak one |
| **An `allowedOrigins` set** | the CDN origins your provider hands back. **This is perishable and §5 is about it** |
| **A media server** | Plex, Jellyfin or Emby, in a container, that you are willing to **attach before the appliance first starts** — §2 is why that is not optional |
| **A durable directory** | for the appliance's cache. The recovery budget lives there, and a budget on a tmpfs is one every restart refunds |

## 2. THE ONE THING THAT IS EASY TO GET WRONG, AND IT IS FIRST FOR THAT REASON

**Attach your media server to the projected path BEFORE the appliance has ever mounted there.**

A container that binds the projected path while it is a **plain directory** becomes a slave of the parent's
mount peer group, so every later mount at that path propagates into it — including every remount the
appliance performs to recover from a fault. A container that binds the same path while a mount is **already
there** joins that mount's peer group only, and when that mount goes away nothing that happens at the path
afterwards ever reaches it.

**That is not a setting and no daemon behaviour can work around it.** It is §11 of
`docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md`, and it was measured on this host with one daemon and two
consumers differing only in when they attached:

| | bound the directory first | bound the mount itself |
|---|---|---|
| after the first mount | reads | reads |
| graceful restart | **reads** | cannot read |
| external unmount, then recovery | **reads** | cannot read |

`preflight` **refuses** to proceed with no consumer attached, and that refusal is the whole reason it exists.

So the order is: create the directory → start your media server bound to it → `preflight` → `install` →
`start`.

## 3. The commands, in the order you run them

```
deploy/projection-alpha.sh preflight        # checks everything, changes nothing
deploy/projection-alpha.sh install          # creates only this appliance's own directories
deploy/projection-alpha.sh start            # brings it up and waits for readiness
deploy/projection-alpha.sh status           # what is wrong, what is at the mount, what is being done
deploy/projection-alpha.sh stop             # down, leaving every byte of data
deploy/projection-alpha.sh upgrade          # records the running digest, then starts the new one
deploy/projection-alpha.sh rollback         # returns to the digest upgrade recorded
deploy/projection-alpha.sh reset-recovery   # clears a recovery lockout, AFTER you have fixed the fault
```

Set the environment from `deploy/projectiond-alpha.env.example` first. **Every variable is required and none
has a default that could point at somebody else's data.**

**Every one of these verbs is idempotent.** Running `install` twice, `start` on an already-ready appliance,
`stop` on a stopped one or `reset-recovery` on a clean ledger are all successes, not errors.

## 4. Reading `status`, which is the only page you need during an incident

It answers three questions in one place, deliberately: **what is wrong**, **what is actually at the mount**,
and **whether anything is being done about it**.

| Field | What it means |
|---|---|
| `ready` | whether a consumer can expect to read right now |
| `readyReason` | why readiness is being withheld, as a closed-set code |
| `mountObserved` | what the daemon **sees** at its mount point, as opposed to what it remembers |
| `recoveryState` | `disabled`, `idle`, `observing`, `acting`, `cooling-down`, `locked-out` |
| `recoveryReason` | which decision the supervisor took, as a closed-set code |
| `recoveryAttempts` | budget spent since the last refund or reset |
| `recoveryGeneration` | every attempt ever, **never refunded** — so "recovered once, an hour ago" and "recovering right now" are different |
| `recoveryLastOutcome` | `none`, `succeeded`, `failed`, `refused` |
| `recoveryRemediation` | `none`, `inspect-mount-owner`, `reset-recovery-ledger`, `check-cache-directory` |

**No field on this surface is free text, a path, a URL, an origin or a media identity.** You can paste a
`status` output into a bug report without redacting it.

### 4.1 The three remediations, and what each one means you should do

| `recoveryRemediation` | What it is telling you |
|---|---|
| `inspect-mount-owner` | **Something that is not the appliance's is mounted at its mount point, and the appliance will not touch it.** In a container topology the likeliest candidate is your own bind — which is exactly the mount that must survive. Look at `mount \| grep <your mount point>` and decide yourself |
| `reset-recovery-ledger` | The appliance spent its whole recovery budget and **stopped for good**. Fix the underlying fault, then run `reset-recovery`. It will not resume on its own, and §6.1 is why |
| `check-cache-directory` | The durable ledger could not be read or written. The cache directory is the one thing in the environment contract that has to be durable and writable |

## 5. THE PROVIDER'S CDN ORIGINS ARE PERISHABLE, AND THIS IS THE FAILURE YOU WILL MEET FIRST

The daemon **refuses a resolved URL whose origin is not in your `allowedOrigins` set**. That is the one
control standing between provider-supplied data and this appliance's egress, and it is doing its job when it
fires.

**TorBox serves its CDN from a pool and moves between members.** Measured on this host across one day: **seven
distinct origins**, each served for a stretch of roughly **forty minutes to at least eighty-four**, cycling
back to ones it had used before. An allowlist with one entry works until it does not.

**The signature, so you can recognise it in ten seconds:** `stat` on the file succeeds, the directory listing
is perfect, and **every read fails EIO in well under a second**. Nothing is wrong with the mount.

**What to do:**

```
deploy/projection-provider-origin-recheck.sh
```

It costs **one resolution and no media bytes**, contacts the provider once, and prints a status, a boolean, a
count, a scheme and **one-way digests** — never an origin, a URL, a reference or a credential. Exit `0` means
the current origin is allowed; exit `70` means it is not.

**When it says `disallowed`, add the origin to `allowedOrigins` yourself.** No tool in this repository writes
that file, deliberately: widening an egress allowlist is an operator's decision, and a script that quietly
did it would be removing the only control that has ever caught a real rotation.

**Cover the set, not the current member.** Adding one origin at a time has twice been overtaken by the next
switch. What ends this is `allowedOrigins` naming enough of the pool that a long session cannot fall off the
end of it.

## 6. The rough edges, all of them, before you meet them

### 6.1 A lockout outlives its cause

An appliance that spends its recovery budget stops for good and **stays stopped across a restart, an upgrade
and a host reboot**. That is deliberate: every automatic clearing rule that was considered — a timer, an
uptime threshold, a quiet period — is a rule under which a flapping appliance eventually resumes flapping
without anybody having looked at it.

**The cost is real and it is yours:** after you fix the fault, you must run `reset-recovery` by hand.

### 6.2 A failed recovery can leave a mount point nothing can bind

A dead FUSE mount answers `stat` with `ENOTCONN`, and Docker's bind setup reads that as *"file exists"* and
refuses to start the next container **with a message that tells you nothing about what is wrong**.

`preflight` refuses with the remediation `clear-stale-mount` and the exact command:

```
umount -l <your mount point>
```

**The appliance deliberately does not do that for you.** Unmounting something at your mount point is the one
action it refuses to take automatically.

### 6.3 A wedged probe can outlive its mount

The mount observation is sampled single-flight, and a probe parked in an uninterruptible `statfs` releases
only when the connection is torn down. A recovery that remounts *around* such a probe can leave the
observation permanently unavailable, which spends the budget and locks out. **You will see this as
`recoveryRemediation=reset-recovery-ledger` with a mount that looks fine.**

### 6.4 No alerting, no history, no trend

`status` is a point-in-time document. Everything it knows about the past is `recoveryGeneration` and
`recoveryLastOutcome`.

### 6.5 Rollback depends on the cache directory

`upgrade` records the digest it is replacing **in the cache directory**, and `rollback` reads it from there.
**If you lose the cache, you lose the recorded rollback target.**

**What to do instead, and it needs nothing durable at all:** set `PROJECTIOND_ALPHA_IMAGE` to the previous
digest and run `start`. That is the same action `rollback` performs.

**So write your current image digest down somewhere that is not the cache**, before you upgrade. One line:

```
deploy/projection-alpha.sh status    # and keep the image digest it prints
```

### 6.6 One provider, one host, one mount

TorBox only. One Unraid host has been measured. One `projectiond` FUSE mount, `rshared`, with the consumer
bound before the daemon first mounts there. Real-Debrid and Usenet have **named contracts** in
`docs/PROJECTION_PHASE_6_DEPLOYABLE_ALPHA.md` §13, and a contract is not a feature.

## 7. What to do when a media server stops seeing files

In this order, because it goes from cheapest to most disruptive:

1. **`deploy/projection-alpha.sh status`.** If `ready` is true and `mountObserved` is `live-projectiond`, the
   appliance is fine and the problem is above it.
2. **Is it EIO on read but fine on `ls`?** §5. Run the origin recheck. This is the most common cause and it
   is not a fault in the appliance.
3. **Is `recoveryState` `locked-out`?** §6.1. Fix the cause, then `reset-recovery`.
4. **Is `recoveryRemediation` `inspect-mount-owner`?** Something that is not the appliance's is at the mount
   point. Look at the mount table yourself. **Do not unmount anything you have not identified.**
5. **Did your media server start before the appliance ever mounted?** §2. If it attached afterwards, it is in
   the wrong mount peer group and it will never see a remount. Recreate the media-server container while the
   appliance is **stopped and the path is a plain directory**, then start the appliance.
6. **Only then**, `stop` and `start` the appliance. It leaves every byte of data.

## 8. What this appliance will never do to your system

- **Print a credential value, a provider URL, an origin, a media path or an arbitrary OS error.**
- **Touch an existing media library, a user share, or an unrelated container, network or volume.**
- **Change a Docker restart policy** beyond its own. `restart: unless-stopped` restarts on a crash and on
  nothing else — recovery happens *inside* the living process.
- **Delete anything outside its own directories.**
- **Unmount anything that is not its own.** It names a foreign mount and stops.
- **Accept a resolved URL from an origin you have not allowlisted.**
- **Expose a remote control surface for recovery.** There is no socket, route or flag that can trigger one
  from outside the process.
