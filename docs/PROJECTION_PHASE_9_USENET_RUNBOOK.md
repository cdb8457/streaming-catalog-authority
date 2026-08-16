# Projection Phase 9 — the Usenet operator runbook

**Status: PROVIDER-FREE READY.** Everything in this document runs today except the four steps marked
**NEEDS A PROVIDER**, and those need things only you have: a SABnzbd you control, an NNTP provider configured
inside it, and content you are legally entitled to download. Nothing in this repository can supply any of
them, and nothing in this repository pretends to.

`docs/PROJECTION_PHASE_9_TORBOX_USENET.md` is the contract. This is how you operate it.

---

## 1. What this adds, in one paragraph

Your appliance already serves a read-only projection namespace that Plex, Jellyfin and Emby scan. Phase 9 lets
that same namespace also hold files a Usenet worker produced — but only after the worker has finished
downloading, repairing and unpacking them, and only after the control plane has proved the output is a real,
finished, unmoving, single-named regular file and recorded its digest. A Usenet file becomes visible when it
is **admitted**, and never before. Nothing streams from an incomplete download, because nothing is published
until the download is complete.

**Your TorBox entries are not touched by any of this.** Not their paths, their inodes, their sizes, their
visibility or their locators. That is checked before every publish, by comparing the namespace before and
after, and a publish that would move one is refused instead.

---

## 2. What you must supply

| Thing | Why | Where it goes |
| --- | --- | --- |
| A running SABnzbd you control | Phase 9 does the acquisition through a mature worker rather than reimplementing yEnc and PAR | `docker-compose.projection-usenet.yml` |
| That worker's API key, in a file | The control plane reads the worker's queue and history and submits to it | a file whose mode is `0600` |
| An NNTP provider **configured inside SABnzbd** | This project never reads, holds or templates an NNTP credential | SABnzbd's own configuration |
| A dedicated category named `projection` | So this phase never reaches into a download you started for your own reasons | SABnzbd's category settings |
| A dedicated **incomplete** directory | Same reason | `PROJECTION_USENET_INCOMPLETE_DIR` |
| A dedicated **complete** directory, **under your media root** | An admitted file is published as a `local` source, and a local locator is a relative path under a configured root | `PROJECTION_USENET_COMPLETE_DIR` |
| One NZB or indexer URL, in a file | Argv is visible in `/proc`, in your shell history and in `docker inspect` | a file whose mode is `0600` |

Run `npm run ops:usenet-diagnose` at any time to see this list generated from the code rather than from this
table, along with every refusal reason and what each one means.

---

## 3. Install

### 3.1 Create the directories

The complete directory **must be a subdirectory of the media root your appliance already serves**. If it is
not, no locator can name a file inside it, and preflight will tell you so before you submit anything.

```sh
# Adjust to your own layout. The media root here is the one PROJECTIOND_ALPHA_MEDIA_ROOT points at.
MEDIA_ROOT=/mnt/user/media
mkdir -p "$MEDIA_ROOT/usenet-complete"
mkdir -p /mnt/user/appdata/projection-usenet/{config,incomplete,secrets}
chmod 700 /mnt/user/appdata/projection-usenet/secrets
```

### 3.2 Start the worker

```sh
export PROJECTION_USENET_IMAGE=lscr.io/linuxserver/sabnzbd@sha256:<pin it>
export PROJECTION_USENET_CONFIG_DIR=/mnt/user/appdata/projection-usenet/config
export PROJECTION_USENET_INCOMPLETE_DIR=/mnt/user/appdata/projection-usenet/incomplete
export PROJECTION_USENET_COMPLETE_DIR=$MEDIA_ROOT/usenet-complete
export PROJECTION_USENET_SECRETS_DIR=/mnt/user/appdata/projection-usenet/secrets
export PROJECTION_USENET_PORT=8080
export PROJECTION_USENET_UID=$(id -u) PROJECTION_USENET_GID=$(id -g)

docker compose -f docker-compose.projection-usenet.yml up -d
```

The API is published on `127.0.0.1` **only**. SABnzbd authenticates with a key in a query string; on a
LAN-visible port that key is in every intermediary's access log.

### 3.3 Configure SABnzbd, once, in its own web UI

1. Add your NNTP provider. **This project never sees it.**
2. Create a category named exactly `projection`.
3. Point that category's completed folder at `/downloads` (which is your `usenet-complete` bind).
4. Copy the API key out of *Config → General*.

### 3.4 Give the control plane the key

```sh
umask 077
printf '%s' '<the api key>' > /mnt/user/appdata/projection-usenet/secrets/sabnzbd-api.key
chmod 600 /mnt/user/appdata/projection-usenet/secrets/sabnzbd-api.key
```

The key is refused if the file grants anything to group or other, if it is a symbolic link, if it holds more
than one line, or if it holds something that is not a key. No error message this project produces will ever
name the file's path or any part of the key.

### 3.5 Write the configuration

```json
{
  "worker":        { "host": "127.0.0.1", "port": 8080, "scheme": "http" },
  "apiKeyFile":    "/mnt/user/appdata/projection-usenet/secrets/sabnzbd-api.key",
  "category":      "projection",
  "completedRoot": "/mnt/user/media/usenet-complete",
  "mediaRoot":     "/mnt/user/media",
  "rootId":        "media",
  "stateDir":      "/mnt/user/appdata/projection-usenet/state",
  "pathPrefix":    "usenet"
}
```

`stateDir` must be **durable**. The job ledger lives in `usenet-ledger/` beneath it, and the ledger is the
only reason a restart does not submit your download a second time. Do not point it at a `tmpfs`, and do not
point it at the projection daemon's cache directory — that directory is swept at daemon startup.

### 3.6 Preflight

```sh
npm run ops:usenet-preflight -- --config /mnt/user/appdata/projection-usenet/usenet.json
```

It reports **everything** that is wrong in one pass, and it deliberately does not contact the worker: a
preflight that failed on an unreachable worker could not also tell you your key file is world-readable.

---

## 4. Day-to-day

### 4.1 Submit one NZB — **NEEDS A PROVIDER**

Put the NZB or indexer URL in a file. Do not put it on the command line.

```sh
umask 077
printf '%s' 'https://your-indexer/getnzb?id=...&apikey=...' > /tmp/nzb.url
npm run ops:usenet -- submit \
  --config /mnt/user/appdata/projection-usenet/usenet.json \
  --item   <the catalog record's UUID> \
  --source /tmp/nzb.url
shred -u /tmp/nzb.url 2>/dev/null || rm -f /tmp/nzb.url
```

An indexer URL usually carries your indexer's own API key. It is treated as a credential whatever it is
called: a world-readable source file is refused.

**Submitting the same URL twice does nothing.** The submission key is derived from the URL and the category,
so the second call reports `already-known` and never reaches the worker — including after a restart, a crash
or a power cut.

### 4.2 Watch it

```sh
npm run ops:usenet-status -- --config .../usenet.json
```

Six states, and there is no seventh:

| State | What it means | What you do |
| --- | --- | --- |
| `downloading` | the worker is acquiring articles | nothing |
| `repairing` | the worker is verifying or PAR-repairing | nothing |
| `unpacking` | the worker is extracting or moving | nothing |
| `ready-to-admit` | the worker says it finished; the control plane has not proved it yet | run `reconcile` |
| `admitted` | proved and published, exactly once | nothing; it is in the namespace |
| `refused` | the control plane will not publish this, for the named reason | read the reason |

`status` contacts nothing, so it still works during a worker outage.

### 4.3 Advance everything

```sh
npm run ops:usenet-reconcile -- --config .../usenet.json
```

This is the only verb that changes anything. It is **retry-safe**: running it twice in a row is the ordinary
way to use it. It reads the worker's queue and history once, moves every job to the state the worker reports,
and admits everything that has become provable. Put it on a timer:

```sh
# Unraid: User Scripts, every 10 minutes
cd /path/to/catalog-authority && npm run ops:usenet-reconcile -- --config .../usenet.json
```

It exits non-zero when a job is refused, so a monitor can notice. Refusals that will resolve themselves — a
file still being written, an unpack artefact still present, an unreachable worker — are marked *retryable* and
are cleared by the next run.

**One command at a time, and the timer above is exactly why.** `submit` and `reconcile` both take an
exclusive lock on the job ledger for the whole of their run, because both decide what to do by reading the
state they replayed when they opened it: a `submit` you typed while the ten-minute timer was mid-`reconcile`
would otherwise be two commands that each saw no reservation and each sent the same NZB. If you meet
`LEDGER_LOCKED`, another command is holding it — wait and run yours again. A lock left behind by a killed
process is broken automatically after fifteen minutes; you never have to delete
`<stateDir>/usenet-ledger/jobs.lock` by hand, and you should not, because a lock that is still live belongs
to a command that is still running.

### 4.4 Understand a refusal

```sh
npm run ops:usenet-diagnose
```

Every refusal reason, what it means, and whether looking again could help. The ones you are most likely to
meet:

- **`output-unpack-residue`** — a `.rar` or `.par2` is still beside the media. The worker is not finished.
  Retryable; do nothing.
- **`output-still-changing`** — the file moved between two observations. Retryable; do nothing.
- **`output-not-uniquely-identified`** — the job produced no publishable file, or more than one. Phase 9 does
  not choose between them (§6: no download selection policy). Move the one you want into its own job folder.
- **`output-name-not-projectable`** — the release name contains something the namespace rules refuse. Rename
  the file. The control plane will not rewrite it for you, because a path it rewrote is a path it could not
  reproduce on the next scan.
- **`job-absent-from-worker`** — the job is in neither the queue nor the history. This is **never** read as
  success. If the reservation was never confirmed, it is recorded as lost and you may submit it again.
- **`worker-rejected-credential`** — check the key file and its permissions.
- **`torbox-namespace-drifted`** — publishing this Usenet entry moved a TorBox-backed entry, which §4 forbids
  outright. The admission was **not** recorded and the refusal is permanent: this is a defect in the control
  plane, not something you can fix by looking again. Report it with the entry prefix the refusal names.
- **`worker-response-too-large`** on every job at once — the worker's dedicated-category history is longer
  than one reading walks (ten pages of two hundred). Nothing has been assumed about any job: a reading that
  could not be completed is refused rather than treated as "these are all the jobs there are", because
  "absent from the history" is what lets a reservation be submitted again. Purging the worker's history is
  **yours** to decide (§4 forbids this project doing it), and it costs nothing already admitted.

---

## 5. What happens when things break

| Event | What happens to admitted entries | What you do |
| --- | --- | --- |
| SABnzbd stops | nothing | start it; `reconcile` picks up |
| SABnzbd's history is purged | nothing already admitted; unadmitted jobs become `refused: job-absent-from-worker` | resubmit those |
| The control plane restarts | nothing; the ledger replays | nothing |
| The whole host reboots | nothing; the ledger is fsynced | nothing |
| Your NNTP provider goes down | nothing | nothing; the worker retries |
| A Usenet job fails | it is refused and never enters the namespace | read the reason |
| SABnzbd does not keep the submission marker as the job's name | the job reports `job-absent-from-worker` even though it is running | confirm the category's *Name* handling is not rewriting job names; the control plane finds its own jobs by that marker, and by the worker's job reference once one has been recorded |

**No Usenet failure can empty, rename or make unavailable an already-admitted entry.** There is no code path
in this tranche that retires, degrades or deletes a published entry — not "we are careful not to", but "the
verb is not available to it", which `test/usenet-admission.ts` checks as source.

---

## 6. What this project will never do

From §4 of the contract, and each one is enforced rather than promised:

- stream incomplete Usenet articles through FUSE;
- publish a path while the worker can still mutate it;
- follow a symlink or admit a device, FIFO, socket or directory as media;
- infer success from a job disappearing from the queue;
- delete completed media, SABnzbd history or operator input — which means yours, and this is the one refusal
  worth restating in your own terms: nothing here removes a file you downloaded or a row from your worker's
  history, ever;
- let a Usenet outage alter the TorBox namespace;
- place an NNTP or SABnzbd credential in the projection daemon;
- claim Real-Debrid support.

---

## 7. Verifying it before you trust it

### 7.1 The provider-free rehearsal — runs today, on any host

```sh
npm run go:phase9-rehearsal
```

It starts a fake SABnzbd-compatible worker on loopback, runs the whole mixed sequence — submit once, observe
the lifecycle, admit exactly once, compare the namespace before and after, restart, survive an outage — and
cleans up after itself. It contacts no Usenet provider, no indexer and no TorBox endpoint.

**It closes nothing.** It says so in its own output, and `src/core/projection/phase9.ts` refuses to let any
verdict it emits close a claim that needs a real provider.

### 7.2 The offline suites

```sh
npm run test:phase9
```

Thirteen suites: sealed values, the worker contract, the API key file, the client boundary against a real HTTP
fake, the durable ledger, the path-safety and race refusals, the manifest bridge, the admission service, the
status surface, the command surface, the rehearsal, the phase rules and the gate audit.

### 7.3 The four steps that **NEED A PROVIDER**

These are what remains before Phase 9 can close, and only you can run them:

1. **§5.2** — submit a real NZB, let it complete, and confirm it is admitted exactly once.
2. **§5.3** — submit an NZB you expect to fail or arrive incomplete, and confirm it is refused and never
   appears in the manifest.
3. **§5.5** — confirm Plex, Jellyfin and Emby each scan and read both the TorBox entry and the admitted
   Usenet entry through their existing pre-attached binds.
4. **§5.11** — run the complete mixed-provider sequence three consecutive fresh times.

`npm run ops:usenet-diagnose` prints the exact inputs each of these needs.

---

## 8. Where things live

| What | Where |
| --- | --- |
| The contract | `docs/PROJECTION_PHASE_9_TORBOX_USENET.md` |
| The worker boundary | `src/core/usenet/sab-contract.ts` |
| The client | `src/core/usenet/sab-client.ts`, `sab-http-transport.ts` |
| The fake worker | `src/core/usenet/sab-fake-service.ts` |
| The API key file | `src/core/usenet/sab-api-key.ts` |
| The durable ledger | `src/core/usenet/job-ledger.ts` |
| The output checks | `src/core/usenet/completed-output.ts`, `output-fs.ts` |
| Admission | `src/core/usenet/admission.ts` |
| The manifest bridge | `src/core/usenet/manifest-bridge.ts` |
| The operator surface | `src/ops/usenet-command.ts`, `usenet-command-cli.ts` |
| The rehearsal | `src/ops/usenet-rehearsal.ts`, `deploy/projection-phase9-rehearsal.sh` |
| The phase rules | `src/core/projection/phase9.ts` |
| The deployable worker profile | `docker-compose.projection-usenet.yml` |
