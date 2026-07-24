# Phase 243: Promotion Record Chain Operator Dashboard (local-only, read-only)

Status: `PHASE_243_PROMOTION_OPERATOR_DASHBOARD_READY`

A local page that shows what the promotion record chain (Phases 231–241) proves. One command reads the
artifacts, audits them through the **Phase 242 console**, and serves the answer on loopback: the outcome, how
far the chain reaches, what is outstanding, every artifact state, every blocker with what it means and what to
do, the exact safe next human steps, and the proof limits — on one page, so the caveats cannot be separated
from the verdict.

## Why this phase exists

Phase 242 made the chain answerable in one command. It still answers in a terminal, to someone who knows to
run it. The people who most need to read a promotion record chain — whoever is deciding if anything is
outstanding, and whoever checks months later that nothing was quietly closed — are not always at a shell.

## It adds no audit semantics

It computes nothing, decides nothing, and re-derives nothing. Every verdict, blocker, step and proof limit on
the page is the one Phase 242 (and behind it Phase 241) already produced, character for character. If this
phase disagreed with the console, the console would be right.

## Launch

```
npx tsx src/ops/promotion-operator-dashboard-cli.ts --dir <artifact-directory> [--port <1024-65535>]
npx tsx src/ops/promotion-operator-dashboard-cli.ts --bundle <bundle.json>
npm run ops:promotion-operator-dashboard:help
```

The direct form behaves identically on PowerShell, cmd and bash. Do **not** pass flags through
`npm run … -- <flags>`: PowerShell consumes the first `--`, so npm takes the flags as its own and the tool
receives none — the same portability trap documented in Phase 242.

Omit `--port` and the operating system picks a free one; the URL is printed. The dashboard therefore never
squats a well-known port and never collides with anything already running. Stop it with Ctrl+C.

Exit `0` = served and shut down cleanly. Exit `2` = usage or startup failure, with **nothing ever listening**.

## Boundaries

| Property | Guarantee |
| --- | --- |
| Bind address | `127.0.0.1` only. Not configurable — there is no flag, env var or code path that binds elsewhere. `0.0.0.0`, `::`, `::1`, `localhost`, a LAN address and `127.0.0.2` are all refused before any socket opens |
| Methods | `GET` only. Everything else is `405`; request bodies are drained and never read |
| Parameters | None. Any target carrying `?` or `#` is refused outright — there is no route that takes input, so none is accepted and discarded |
| Filesystem | Read **once**, before the socket opens. After `listen` the process never touches the filesystem for a request |
| Client script | None. `script-src 'none'`; the page is static server-rendered HTML |
| Mutation | None. No form, no upload, no write, no approval, no execution, no archive or delete |

Routes: `GET /` (the page), `GET /healthz`, `GET /status.json`, `GET /manifest.json`. Everything else is `404`.

### Why the snapshot is frozen

The console report is computed and rendered **before** the server starts listening, then held as immutable
strings. This closes the TOCTOU question by construction: no request can name a path, race a file, or observe
the directory changing under it, and **what was audited is what every reader gets**. Adding, swapping or
deleting artifacts while the page is open changes nothing that is served. Restart to re-read — the page says
so.

### Intake hardening

Discovery is the Phase 242 allowlist, shared through `promotion-operator-console-intake.ts` so both surfaces
have one set of semantics rather than two that can drift. Under an allowlisted filename, anything that is not
a **bounded regular file** is refused rather than followed or read:

* a **symlink**, so nothing outside the named directory is ever resolved into an artifact;
* a **directory**, device or socket;
* a file larger than `CONSOLE_INTAKE_MAX_ARTIFACT_BYTES` (1 MiB — three orders of magnitude above a real
  artifact, and far too small to hurt).

All three are reported as `MALFORMED`, never `ABSENT`: an operator whose artifact was refused must be told,
not left reading "the phase has not happened yet".

#### The check binds to the object, not the name

Inspecting a path and then separately opening that path is a **check/use race**: between the two calls the
name can be repointed at a symlink, and the open follows it, so the object validated and the object read are
different things. A name is not a handle.

The read is therefore anchored to **one opened descriptor**. The name is inspected without following links,
the descriptor is opened (with `O_NOFOLLOW` where the platform has it), and then everything that matters is
re-established on the **opened object**: it must be a regular file by `fstat`, and it must be the *same
object* the no-follow inspection saw — compared on `ino` as a `BigInt`, and on `dev` only when both stats
report one (a path-based stat leaves `dev` zero on Windows while the handle-based stat fills in the volume
serial). The bytes are then read from that same descriptor, and it is closed on every path out including
every refusal.

The property this buys is stronger than "the open did not follow a link": **the bytes parsed came from the
object that was validated, or nothing was parsed at all.** A swap during the window changes the identity and
fails closed. A swap to a link pointing back at the very same file is harmless, because that file is the one
already validated.

`O_NOFOLLOW` does not exist on Windows, so there the identity comparison *is* the whole no-follow guarantee —
which is why it is not optional. Where identity cannot be established at all (a filesystem reporting no
inode) **and** the platform has no `O_NOFOLLOW` either, there is no way to know what was opened, so the read
is refused.

Reads are bounded twice: the buffer is one byte past the size that was just validated, so a file that **grows**
inside the window fills it and is refused rather than read short — and no amount of growth turns into an
unbounded allocation, since the buffer is sized by the validated size and capped besides.

`readBoundedRegularFile` accepts an `afterInspect` hook that fires exactly in the window. It exists so the
race can be driven **deterministically** from a test rather than hoped at; production callers pass nothing.

## Security headers

Every response, including `404`s: `Content-Security-Policy` (`default-src 'none'`, `script-src 'none'`,
`connect-src 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`),
`Cache-Control: no-store, no-cache, must-revalidate`, `Pragma: no-cache`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and a `Permissions-Policy` denying camera,
microphone and geolocation.

Request targets over 2048 bytes are `414`. Server request, headers and keep-alive timeouts and the maximum
header count follow the Phase 70 static-runtime values.

## Redaction

Nothing from the artifacts reaches the page. The Phase 242 report is value-free by construction — fixed text,
counts, phase numbers and already-public digests — so there is no artifact value, path, filename, identity,
timestamp, secret or approval value available to render even in principle. Everything is HTML-escaped on the
way out regardless, and the rendered page is passed through the **Phase 64 markup gates** (
`operatorUiRenderHasForbiddenMarkup`, `operatorUiRenderHasExternalReference`) before it is ever served: no
script, form, iframe, image, inline event handler or external reference. A page that fails is not served at
all.

Startup errors never echo the path they were given.

## Reading the page

Accessible and readable without scripting: one `h1`, sectioned `h2`s, `aria-labelledby` on every section,
scoped table headers, captioned tables, a skip link to the verdict, visible keyboard focus, a small-screen
layout and `prefers-color-scheme` support. **Status is never carried by colour alone** — the word (`PRESENT`,
`ABSENT`, `MALFORMED`, `MISFILED`, `DUPLICATE`) always appears, and the symbol beside it is
`aria-hidden`.

`AUDIT_OPEN` is presented as **normal**, in those words, with no warning styling: a page that showed an
honestly unfinished chain as a fault would teach people to treat incompleteness as a defect. `/status.json`
agrees — `ok` is `true` for `AUDIT_CLOSED` and `AUDIT_OPEN`, and `503` is reserved for `AUDIT_INVALID` and
`NOT_ELIGIBLE`.

## No new report

This phase emits no digested report, so there is no self-digest registry entry: it renders a Phase 242 report
rather than producing one. The page and `/status.json` both carry that report's `consoleDigest`, which ties
what is on screen to the exact audit behind it.

## Relationship to the other operator surfaces

Separate surface, separate manifest. The Phase 147 operator UI service and the Phase 70 static runtime are
untouched: their blocked packet, data and auth routes stand exactly as they were, and a test asserts it. The
only changes to shared code are two **additive** exports — the Phase 64 markup gates, so this page can be held
to the same bar, and the Phase 242 intake, so discovery is shared rather than copied.

## Tests

`npm run test:phase243-local` — 25 cases: the page states the console verdict unchanged for all four outcomes
with every blocker, step and proof limit reproduced; an unfinished chain presented as normal; accessibility
and mobile structure; artifacts stuffed with `<script>`, `onerror=`, `javascript:`, `<iframe>` and `<form>`
reaching nothing; live/network/location payloads failing closed unechoed; loopback-only binding across eight
rejected hosts; bounded ports and a port already in use failing safely; traversal, encoded, absolute-URL,
null-byte, query, fragment and oversized targets all refused over a raw socket; non-GET methods and request
bodies buying nothing; security headers on every route; the health/status/manifest contracts; symlink,
directory and oversized-file intake refusal; **four check/use-window cases driven deterministically through
the read hook** — a name swapped to a symlink, a different regular file atomically renamed over it, a file
grown past the cap with the allocation measured, and the same treatment for the explicit bundle, each of
which a stat-then-`readFileSync` reader fails; a descriptor-leak run of 3000 reads across every refusal
branch; a TOCTOU case proving the served bytes do not change when the directory is rewritten mid-flight
**after** launch; redaction across every route and header; the established operator UI
boundaries unrelaxed; clean shutdown with the port provably reusable; and end-to-end launches over the
**actual P227-A chain** (`AUDIT_OPEN`, healthy, outstanding Phase 232, never headlined closed) and an
anchorless chain (`NOT_ELIGIBLE`, `503`).
