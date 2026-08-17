# Projection — the content operator runbook

**Status: PROVIDER-FREE.** Everything on this page runs today, on your own appliance, with no TorBox account,
no CDN origin, no SABnzbd, no NNTP provider and no media server required to be present. Nothing here reads,
writes or touches `endpoint.json`.

`docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md` is the contract. This is how you operate it.

**What this page is for.** `deploy/projection-alpha.sh` gets you an appliance that is installed, mounted and
serving. It has eight verbs and every one of them is about the appliance itself. **None of them puts content
in the namespace.** This page is the other half: getting content in, seeing whether it is really visible, and
being told when the namespace and the disk have stopped agreeing.

---

## 1. THE ONE THING THAT IS EASY TO GET WRONG, AND IT IS FIRST FOR THAT REASON

**Registering an entry does not publish it. Nothing publishes implicitly. Ever.**

There are two places content lives, and they are different things:

| | What it is | Who reads it |
|---|---|---|
| **the registry** | the control plane's record of what you have told it exists | nothing outside the control plane |
| **a generation** | an artifact plus a pointer, in the manifest directory | `projectiond`, and through it every media server |

`add-torbox`, `add-local` and the Usenet control plane's `reconcile` all write to the **registry**. Until you
run **`publish`**, a media server sees nothing new — no error, no partial file, just an entry that is not
there.

**`status` names that state out loud.** It is `admitted-not-published`, it is marked with a `!`, and it is the
first thing to check when something you added is not showing up.

This is not a design flourish. `docs/PROJECTION_PHASE_9_USENET_RUNBOOK.md` §1 and §4.2 told operators the
opposite for a whole tranche — both sentences are kept there, marked superseded, with §1.1 and §4.2.1 as the
correction — and the reason the repair is a *visible state* rather than an *automatic publish* is Phase 10 §4's
second hard refusal: nothing in this command degrades, retires, deletes, publishes or restores anything
without a verb or a flag you typed.

---

## 2. What you need before you start

| | |
|---|---|
| **A serving appliance** | installed and started with `deploy/projection-alpha.sh`. This command never starts, stops or mounts anything. |
| **A configuration file** | §3. It names your manifest directory, your media root, and the two root labels. |
| **A catalog record per entry** | the `itemId`. Every projected entry belongs to one, because an entry with no logical media id is one no media server can attribute to anything. |
| **For TorBox entries** | a file in `deploy/real-provider-objects.template.json`'s shape, **mode 0600**, holding the opaque object reference, the exact size, the exact-millisecond mtime and — optionally — the probe digests. |
| **For local entries** | the files, under your media root. **You type no size, no mtime and no digest**: this command reads them. |

---

## 3. Install

### 3.1 The configuration

```json
{
  "manifestDir": "/mnt/user/appdata/projection/manifests",
  "mediaRoot": "/mnt/user/media",
  "rootId": "media",
  "endpointId": "vault",
  "usenetStateDir": "/mnt/user/appdata/projection-usenet/state"
}
```

Every path is **absolute and POSIX**. A relative one would resolve against whatever directory the command
happened to be run from, which for a command that publishes is the wrong thing to make convenient.

`rootId` is the label your media root is registered as; `endpointId` is the label your TorBox endpoint is
registered as. Both are created for you on first use.

`usenetStateDir` is **optional**. Supply it and `reconcile` will cross-check the Usenet job ledger against the
registry; leave it out and `reconcile` says in as many words that it did **not** look — because "there were no
unregistered ledger entries" and "nothing checked" are different facts.

Point the command at it once:

```sh
export PROJECTION_CONTENT_CONFIG=/mnt/user/appdata/projection/content.json
```

### 3.2 Preflight, which changes nothing

```sh
deploy/projection-content.sh preflight
```

It tells you everything that is wrong **in one pass**, not one thing per run: a missing or symlinked manifest
directory or media root, a manifest directory placed **inside** the media root (a generation artifact under
the tree the appliance projects would appear in the namespace it describes), a control plane that is not
answering, and a database and directory that already disagree about what is published.

---

## 4. Zero to a readable namespace

### 4.1 A local file

```json
[
  { "label": "local-one", "itemId": "<catalog record uuid>",
    "path": "Movies/Local One/Local One.bin", "relativePath": "movies/local-one.bin" }
]
```

```sh
deploy/projection-content.sh add-local --file /mnt/user/appdata/projection/local-objects.json
```

The size, the mtime and the whole probe plan are **read from the file**. The command then tells you, every
time, that nothing is visible yet.

### 4.2 A TorBox object

Take `deploy/real-provider-objects.template.json`, keep its shape — you may leave every `_comment_*` key in
place — and add the three fields a **namespace** needs that a corpus file does not: `itemId`, `path` and
`mtime`.

```json
[
  { "label": "remote-one", "itemId": "<catalog record uuid>",
    "path": "Movies/Remote One/Remote One.bin",
    "ref": "<opaque object reference>",
    "sizeBytes": 4194304,
    "mtime": "2026-06-01T10:00:00.000Z",
    "sha256": null,
    "probeDigests": [ { "offset": 0, "length": 1048576, "sha256": "…" } ] }
]
```

```sh
chmod 600 /mnt/user/appdata/projection/torbox-objects.json
deploy/projection-content.sh add-torbox --file /mnt/user/appdata/projection/torbox-objects.json
```

**The reference is never an argument.** Argv is visible to every process on the host through `/proc`, is
recorded by your shell, and is printed in full by `docker inspect`. The file is refused if its mode grants
anything to group or other.

**If your probe offsets are wrong the command says exactly which windows to digest**, rather than failing
later with an offset mismatch. The plan is fixed by the size: below 3 MiB it is one whole-file probe; at or
above it, three 1 MiB windows at `head`, `middle` and `tail`.

### 4.3 Publish

```sh
deploy/projection-content.sh publish
```

Or add `--publish` to `add-local` / `add-torbox` to do both in the command you already typed. That flag is the
only shortcut, and it is a thing you type.

Running `publish` twice reports `unchanged` and mints nothing. That is not a failure: publishing an identical
generation would burn a sequence and make every reader re-read what it already has.

### 4.4 Check

```sh
deploy/projection-content.sh status
```

```
projection content status
  generation 2  agrees=true
  registered=2  published=2  admitted-not-published=0  degraded=0  held=0
    Movies/Local One/Local One.bin
      local  2097152 bytes  available  published
    Movies/Remote One/Remote One.bin
      http-range  4194304 bytes  available  published
```

A `!` in the left column is an entry in no generation. If you see one, run `publish`.

---

## 5. Reconcile — the page you read when something looks wrong

```sh
deploy/projection-content.sh reconcile
```

**IT CHANGES NOTHING.** Not one code path in it writes. It exits 1 when it finds a divergence, so it is safe
to put on a timer, and the exit status is the report rather than an action.

| Divergence | What it means | What you do |
|---|---|---|
| `registry-ahead-of-generation` | registered, in no generation, invisible | `publish` |
| `generation-pointer-disagrees` | the database, the pointer and the artifact do not agree | `publish` — it recovers the directory before it builds anything |
| `local-source-file-absent` | the file this entry names is gone from the media root | put it back, or `hold` the entry |
| `local-source-bytes-changed` | the file's size or mtime no longer matches the registered version | re-run `add-local` for it, or `hold` it |
| `entry-degraded` | the entry is degraded, with the reason it carries | depends on the reason; `operator-hold` means you did it |
| `ledger-entry-unregistered` | the Usenet ledger calls a job admitted and the registry has no entry | `npm run ops:usenet-reconcile` |

**Every admitted Usenet file is a `local` source under your media root**, so a SABnzbd cleanup, a share move
or a disk shuffle removes one without anything else in this system noticing. That is what
`local-source-file-absent` is for, and it is why this command exists at all.

---

## 6. Hold and release

```sh
deploy/projection-content.sh hold    --path "Movies/Local One/Local One.bin"
deploy/projection-content.sh release --path "Movies/Local One/Local One.bin"
```

`hold` degrades the entry with `operator-hold`. **It stays in the namespace**, with its inode, size and mtime
untouched, because a source that cannot be reached must not be able to shrink a media server's library — and
neither must one you are holding on purpose.

Both are idempotent and both say when they changed nothing. `release` **refuses** an entry that is `retiring`
rather than making it available again: a retiring entry is not a held one, and cancelling a deletion intent
somebody declared elsewhere is not what "release" means.

Run `publish` afterwards for either change to reach a generation.

---

## 7. What this command will never do

- write inside the projection mount point, or mount or unmount anything;
- start, stop, upgrade or roll back the appliance — that is `deploy/projection-alpha.sh`, which is still the
  sole owner of the mount point;
- publish unless you typed `publish` or `--publish`;
- repair anything `reconcile` found;
- delete media, a worker's history or your input;
- contact TorBox, a CDN origin, an indexer, SABnzbd or an NNTP server, or read, write or touch
  `endpoint.json`;
- print an object reference, a credential, a URL, an origin, an absolute media path or an arbitrary OS error.

---

## 8. Two things that are still rough

**A `local` divergence is found by `reconcile` and by nothing else.** There is no timer, no watcher and no
event. If you want to know within an hour that a file went missing, run `reconcile` on a schedule; if you do
not run it, nothing will tell you.

**The content plane and the Usenet control plane are not run concurrently.** The TorBox drift guard answers
"did the provider half of the namespace move across this publish", and a registration made by another process
during a Usenet publish is indistinguishable from drift — which is refused, permanently, and correctly in the
conservative direction. Run `ops:usenet reconcile` and this command's write verbs one at a time.
`docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md` §7 R2 is the record.
