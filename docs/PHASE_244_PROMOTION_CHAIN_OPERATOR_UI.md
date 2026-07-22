# Phase 244: The promotion record chain in the operator UI, and an ordinary-computer install

Status: `PHASE_244_PROMOTION_CHAIN_OPERATOR_UI_READY`

Phase 243 built a promotion-chain dashboard that started **its own web server**. That was the wrong shape for
a product. An operator who deploys this stack gets one web UI — the authenticated service on port `8099` that
Compose already runs — and a second competing server is a second thing to launch, secure, port-map, upgrade
and forget about.

So this phase does two things:

1. Moves the chain **into the existing operator UI**, as an authenticated read-only route and a visible panel.
2. Provides a **self-contained ordinary-computer install** — not only Unraid — so someone can actually run it.

It adds **no audit semantics**. The intake is Phase 242's, the audit is Phase 241's through Phase 242, and the
view — headlines, caveats, artifact meanings, proof limits — is the Phase 243 view model, shared rather than
restated.

## Install and run

The stack itself is identical on every platform — only the setup step differs, because Windows has no Bash.
There are two setup scripts and they are one promise made twice: same folders, same secret names, same file
format (LF, no BOM), same re-run rule, same single printed token.

**Linux or macOS:**

```bash
./deploy/local-runtime-setup.sh                          # 1. generate secrets, create the artifact folder
docker compose -f docker-compose.runtime.yml up -d       # 2. start postgres + the operator UI
# open http://127.0.0.1:8099/  and paste the token the setup script printed
docker compose -f docker-compose.runtime.yml down        # 4. stop it
```

**Windows with Docker Desktop** — native PowerShell, no WSL or Git Bash required:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\local-runtime-setup.ps1
docker compose -f docker-compose.runtime.yml up -d
# open http://127.0.0.1:8099/  and paste the token the setup script printed
docker compose -f docker-compose.runtime.yml down
```

Either script is safe to re-run: existing secrets are **kept, never regenerated**, so a re-run cannot lock
you out of a running stack. Each writes only inside the repository directory, starts nothing, and contacts
nothing. Secrets are drawn from the platform CSPRNG (`openssl`/`/dev/urandom` and .NET
`RandomNumberGenerator` respectively) and written LF-terminated without a byte-order mark, because Docker
hands the container the file's bytes exactly as written — a stray CR or BOM would become part of the
password.

### Logging in

There is no username or password. The service authenticates with a **local token file**
(`./secrets/operator_ui_token`), mounted as a Docker secret at `/run/secrets/operator_ui_token`. Paste that
token into the *Operator token* box and press **Refresh**. It is sent as the `X-Operator-UI-Secret` header;
it is never placed in a URL, a cookie, or a log.

### Where the promotion records go

Put your Phase 231–240 chain artifacts in `./promotion-records/` (or set `PROMOTION_RECORDS_HOST_DIR` to any
host folder). Compose mounts it at `/var/lib/catalog/promotion-records` **read-only** — the container cannot
write, rename or delete anything in it. Filenames are the Phase 242 allowlist (`phase-231-….json` or
`phase-231.json`, and so on for each phase); anything else in the folder is counted and left alone.

**The folder cannot be chosen from the browser.** There is no path input, no upload, no form and no query
parameter that influences which directory is read — it comes from container configuration and nowhere else.
To audit a different folder, change the mount and restart, which is a deliberate act on the host.

### Health and upgrades

`GET /healthz` is unauthenticated and redaction-safe (it reveals no chain verdict and no operational data);
Compose uses it as the container healthcheck. Check the stack with:

```bash
docker compose -f docker-compose.runtime.yml ps
curl -fsS http://127.0.0.1:8099/healthz
```

**Upgrading:** `git pull` then `docker compose -f docker-compose.runtime.yml up -d --build`. Your secrets,
database volume and artifact folder are untouched by a rebuild. Roll back by checking out the previous commit
and rebuilding.

### Safe defaults

| Default | Why |
| --- | --- |
| Published on `127.0.0.1:8099` | Reachable from this machine only. Override deliberately with `OPERATOR_UI_BIND_ADDRESS`. |
| Postgres has no published port | Only the app reaches it, over the Compose network. |
| Artifact folder mounted `:ro` | The container cannot modify your records. |
| App container `read_only: true`, `cap_drop: ALL`, `no-new-privileges`, `user: node`, tmpfs `/tmp` | Nothing to escalate to and nowhere to write. |
| `pids_limit`, `mem_limit`, `cpus`, capped json-file logs | A bounded container cannot exhaust the host. |
| No Docker socket, not privileged, no host networking | The container cannot reach the host's Docker or network stack. |

Postgres is deliberately **not** run `read_only` with all capabilities dropped — it initialises its data
directory as root before dropping privileges, and doing so breaks first boot. It is bounded, restart-policed
and unpublished instead.

## The route

`GET /api/promotion-chain` — **authenticated**, read-only, `GET` only.

| Response | Meaning |
| --- | --- |
| `200` | The directory was read and the chain is healthy (`AUDIT_CLOSED` or `AUDIT_OPEN`) |
| `503` | The chain does not hang together (`AUDIT_INVALID`), has no anchor (`NOT_ELIGIBLE`), or the directory is unreadable |
| `401` | No valid operator token — and the caller learns nothing about the chain |
| `405` | Any method other than `GET` |

An **honestly unfinished chain is healthy**. `AUDIT_OPEN` with no blockers returns `200`, exactly as the
Phase 243 rule says — a health contract that called incompleteness a fault would be making the judgment this
stack refuses to make.

A missing or empty folder is a **configuration state, not a verdict**: the payload says
`ARTIFACT_DIRECTORY_UNAVAILABLE`, carries no view, and explains that on a fresh install this is expected. It
never names the path.

Unlike the standalone Phase 243 page, which freezes its snapshot at launch, this route reads at **request
time** — a long-running service would otherwise go stale the moment an operator dropped in a new artifact. The
repeat read is safe because Phase 242's intake is anchored to an opened descriptor.

## The panel

A **Promotion Record Chain** panel in the existing UI, reachable from the section navigation, showing the
outcome and what it does and does not mean, how far the chain reaches, what is outstanding, every artifact
state, every blocker with what it means and what to do, the safe next human steps, and the proof limits.

Every list is built with `createElement` + `textContent`. No served value is ever parsed as markup, the
existing `Content-Security-Policy`, `nosniff`, `no-referrer`, `DENY` and `no-store` headers are unchanged, and
the panel renders independently of the status and logs panels — a stack with no database still has a chain
worth reading.

## Boundaries

No mutation, upload, approval, execution, observation, archival or deletion. No Movies library access, no
Jellyfin call, no Phase 231 authorization, no live or outbound call, no merge, tag or push. Every operational
route keeps the token boundary it already had; only `/healthz` is open, and it stays redaction-safe.

No path, filename, artifact value, identity, timestamp, approval value or secret appears in any response, log
line or page — the Phase 242 report is value-free by construction, and the configured directory is never
echoed, not even when it is rejected.

## Reconciling the Compose files

| File | Purpose | Changed here |
| --- | --- | --- |
| `docker-compose.yml` | CI harness (`npm run ci` against a throwaway Postgres) | No |
| `docker-compose.runtime.yml` | **New.** Ordinary-computer runtime: postgres + operator UI | Added |
| `docker-compose.deploy.yml` | One-shot ops/CLI topology | No |
| `docker-compose.unraid.yml`, `docker-compose.unraid.runtime.yml` | Unraid/Arcane stacks | No |

The root file is a test harness, not a deployment, so the runtime stack is a clearly named separate file
rather than a rewrite of it. Unraid keeps running the same service on the same port through its own file.

## Tests

`npm run test:phase244-local` — configuration validation and startup refusal; the token boundary on the new
route including what an unauthorized caller learns (nothing); unsafe methods and traversal; the **actual
P227-A chain rendering `AUDIT_OPEN`** through the authenticated route with the outstanding Phase 232 decision
shown; malformed, duplicate, symlinked and oversized artifacts failing closed; a missing directory reported as
a configuration state; the panel and navigation present with no dynamic `innerHTML`; injected markup reaching
nothing and the security headers intact; the existing status and logs routes unchanged; the Compose contract
(`:ro` mount, `read_only`, `cap_drop ALL`, `no-new-privileges`, non-root, bounded resources, loopback
publishing, unpublished Postgres, no Docker socket); CI and Unraid files untouched; **both** setup scripts
executed for real against a throwaway workspace; docs runnable; `docker compose config` validation when the
Docker CLI is present; and a full container up/down smoke behind `PHASE244_DOCKER_SMOKE=1`, which skips with a
clear reason when no Docker **daemon** is running.

The Compose assertions **parse** the files rather than matching their text (`test/helpers/compose-yaml.ts`),
so they prove the configured property — this service drops every capability, this mount carries `ro`, this
port binds loopback — instead of proving a particular indentation and line ending. A CRLF checkout is the same
stack as an LF one, and a hardening block moved under the wrong service no longer passes.

The setup scripts are covered by running them, not by reading them. Each is staged alone into a temporary
directory and executed there, which also proves it cannot reach the repository's real `./secrets`: the run
must produce six secret files with the right shape (32 random bytes base64; a 32-character URL-safe Postgres
password embedded in both database URLs), LF-terminated and BOM-free, print the operator token and **only**
the operator token, create an empty artifact folder and nothing else — and, on a second run with every secret
replaced by a sentinel, keep all six byte-for-byte and print the token actually in force.
