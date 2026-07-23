# Phase 246 — first-run onboarding and operational diagnostics

Phase 245 made the operator UI installable by someone with no checkout and no Node.js. This phase makes it
**legible**: after `docker compose up -d`, a person who is not a developer can now open the page and find out
whether the installation works, what is configured, what is missing, and the exact next command.

Nothing new is served, started or exposed. The panel lives inside the existing authenticated service on 8099,
behind the same operator token as every other operational route.

## The five-minute path

```
1. install Docker and start it
2. ./setup.sh                                 (Windows: powershell -ExecutionPolicy Bypass -File .\setup.ps1)
3. docker compose up -d
4. cat ./secrets/operator_ui_token             (Windows: Get-Content .\secrets\operator_ui_token)
5. open http://127.0.0.1:8099/ , paste the token, press "Load everything"
6. copy your chain artifacts into ./promotion-records/ and press it again
```

Step 5 is where the phase pays off: **Setup & Diagnostics** answers with `READY`, `NEEDS_SETUP` or
`DEGRADED`, names the component responsible, and prints the command that fixes it — for the platform the
reader is on.

The checklist is generated from `src/ops/operator-ui-first-run-checklist.ts` and rendered into three places:
the panel, the bundle README, and the support report's context. A test asserts the README contains every
shipped command verbatim, so the page a stuck user reads and the file they read first cannot drift apart.

## What the verdict means, and what it does not

| Verdict | Meaning | What to do |
| --- | --- | --- |
| `READY` | Every component this build needs is present and readable. | Nothing. |
| `NEEDS_SETUP` | An installation step has not been done yet. A fresh extraction is always this. | Work down "Do this next". |
| `DEGRADED` | Something that should be working is not. This is a fault. | Read the named component; see the troubleshooting table. |

Precedence is deliberate: **a fault outranks an unfinished step.** Telling someone to run the setup script
while the database is refusing connections sends them to the wrong place, so a single `IMPAIRED` component
makes the whole verdict `DEGRADED` even when setup steps are also outstanding.

`READY` **is not an authorization.** The payload says so in a field (`promotionAuthorization: "NOT_IMPLIED"`)
and in a sentence, because "the dashboard said READY" is exactly the phrase that would otherwise end up in a
promotion review. It means the software can read what it needs. It is not an approval, and nothing on this
surface can authorize, execute, archive or delete anything.

### Components

| Component | Answers |
| --- | --- |
| `version` | Does the running image agree with the bundle that started it? |
| `database` | Reachable? Migrated to the schema this build expects? |
| `secrets` | Are the five mounted secret files present, and shaped usably? |
| `promotion-records` | Is the read-only mount present, readable, and does it contain anything? |
| `promotion-chain` | Does the Phase 242-244 audit read, and does the chain hang together? |
| `keystore` | Is the keystore volume present and readable? |

Every component reports one of a closed set of states and an identifier for the checklist step that fixes it.
It reports **nothing about what it inspected** — not the path it stat'd, not the bytes it read, not the error
the operating system produced. Every `detail` sentence is a fixed string selected by state, so there is no
route by which an environment value, a filename or an exception message can reach a page, an API response or
a log line.

An empty-but-readable records folder is `EMPTY`, not a broken chain. The Phase 242 audit reports `ok: false`
for it — correctly, since there is nothing to anchor to — and treating that as a fault would make every fresh
install report `DEGRADED` on its first load. Emptiness is therefore read off the artifact count rather than
off the audit verdict.

## Version metadata, and why there are two of them

The image carried OCI labels, which are build metadata a running process cannot read. The bundle carried a
`VERSION` file the container never sees. The UI carried nothing. Three artifacts, no shared fact, and no way
to notice that the image you are running is not the one your bundle describes.

There are now two independent declarations:

* **the image declares itself.** `Dockerfile.runtime` bakes `CATALOG_AUTHORITY_VERSION`, `_REVISION` and
  `_BUILT_AT` into the image from build arguments. The value travels with the layers; nobody who merely runs
  the container can change it.
* **the bundle declares what it believes it deployed.** The release bundle writes
  `CATALOG_AUTHORITY_BUNDLE_VERSION` into its `.env`, and Compose passes it in.

Equal is `AGREES`. Different is `MISMATCH`, and a mismatch is a `DEGRADED` installation — "the bundle you
extracted and the image you are running are different releases" is the failure that otherwise surfaces three
hours into a support thread.

**Nothing is ever invented.** There is no fallback to a `package.json` version, no reading of a git
directory, no "probably the latest". Absent, malformed, or the development placeholder (`0.0.0-dev`) is
reported as such. A confidently wrong version stops someone looking; an unknown one makes them look.

The chain that keeps these honest is asserted end to end: the release tag, the Dockerfile build arguments and
the environment they bake, the Compose pass-through, the bundle's `.env` and `VERSION`, and the UI's view all
come from one constant, and a test fails if any link drops. CI's daemon-backed smoke additionally proves the
built image really reports the version it was built with — a file-reading test cannot.

## Authentication, honestly described

There is no username and no password. The stack authenticates with **one token**, generated by the setup
script into `./secrets/operator_ui_token` and mounted into the container as a Docker secret. The page asks
for it, holds it in an input for the life of the tab, and sends it as the `X-Operator-UI-Secret` request
header.

It is deliberately **not** a conventional login session, and the reason is worth stating rather than hiding:
a cookie session would need a login endpoint that accepts a POST, server-side session state, and a CSRF
defence — three new pieces of authenticated, mutating surface on a service whose entire security argument is
that it has no mutating surface at all. The bearer-header design keeps that argument intact.

> **Phase 247 note.** The page's behaviour and styles are served as fixed same-origin static assets
> (`/assets/app.js`, `/assets/app.css`), and the Content-Security-Policy is `default-src 'none'; script-src
> 'self'; style-src 'self'; connect-src 'self'` with no `'unsafe-inline'`. This section's token model is
> unchanged — token in the password input and in memory, sent only as the `X-Operator-UI-Secret` header — and
> Phase 247 hardened the surface it runs on. See `docs/PHASE_247_CSP_HARDENING.md`.

What Phase 246 improved, without weakening it:

* the page says where the token is and how to read it, on both platforms, **before** you are logged in — the
  checklist and troubleshooting table are part of the unauthenticated shell, because the person who cannot
  log in is exactly the person who needs the "read your token" line;
* a rejected token now says so, and says what to check, instead of "request failed";
* a server that does not answer is distinguished from one that refuses;
* four routes rejecting the same stale token report one problem, not four copies of it.

The token is **never** written to a URL, a cookie, `localStorage`, `sessionStorage`, the page's HTML, a
response body or a server log. Tests assert each of those, including that no `Set-Cookie` header is ever
emitted and that the served HTML contains no pre-filled value.

## Routes

| Route | Auth | Notes |
| --- | --- | --- |
| `/` | none | The shell, plus the static checklist and troubleshooting table. No installation data. |
| `/healthz` | none | Unchanged, and still exactly four keys. Reveals no configuration and carries no verdict. |
| `/api/installation` | token | Readiness, checklist and troubleshooting. Always `200`: `NEEDS_SETUP` is an answer, not a server error. |
| `/api/version` | token | The parsed version view. Authenticated because "what version is this host running" is what an enumerator wants. |
| `/api/status`, `/api/logs`, `/api/promotion-chain` | token | Unchanged by this phase. |

Only `GET` reaches any of them; every other method is `405` with an `Allow` header.

## The support report

```
docker compose exec app npm run ops:support-report          # add -- --text for prose instead of JSON
```

For attaching to an issue. It **makes no live calls** — the database is not contacted, nothing is fetched —
which is the point: the report you need is the one you can still produce while the thing you are reporting is
down. The database component reports `UNKNOWN`/`ADVISORY` rather than guessing.

It contains no tokens, no secret values, no file paths, no URLs, no record contents, no provider or media
server data, and nothing identifying the machine. The image is reported as `EXPECTED` or `CUSTOM` rather than
by name, so a user running a private mirror does not publish their registry hostname to get help with a port
conflict.

This is **checked, not merely intended**: `assertSupportReportIsRedactionSafe` scans the rendered bytes for
URLs, private keys, base64 secrets, over-long hex, absolute POSIX paths, Windows paths and paths into
`./secrets`, and the CLI prints nothing and exits non-zero rather than emit a report that trips it. A
reviewer can be wrong about what a field contains; a scan over the bytes about to be printed cannot be.

## Troubleshooting

The shipped table covers port conflict, Docker daemon unavailable, image pull denied or not found, unhealthy
PostgreSQL, wrong token, missing records folder, unreadable records folder, malformed records and version
mismatch. Every entry names a symptom, a likely cause and a safe fix; a test asserts that no fix suggests
`docker compose down -v`, `rm -rf`, `docker volume rm` or a recursive delete, because nothing here may tell a
frightened user to destroy the data they are trying to diagnose.

## Tests

`npm run test:phase246-local` — 43 tests covering: token required on both new routes and identical
refusals for wrong, empty and near-miss tokens; method restriction; `/healthz` minimality and the absence of
any verdict in it; no token, path, URL or workspace in the readiness payload or the logs; HTML escaping,
including that a shell redirect survives as `&gt;` rather than being stripped; no cookie, no browser storage,
no token in the HTML; the full categorical derivation for every database, records, chain, secret, keystore and
version fact; precedence of faults over setup steps; secret-file and directory inspection against a real
filesystem; the chain summary reducing to five numbers with no blocker detail; version shape validation,
image-reference parsing (including a hostile value and a registry with a port), and image/bundle agreement;
the release tag through Dockerfile, Compose, `.env` and `VERSION`; both platform forms for every command;
README generated from the checklist; support-report redaction against a workspace containing a real token and
a real database URL; that the page's external script (`/assets/app.js`, Phase 247) parses and every element
it reaches for exists; and
that the existing status, logs and promotion-chain routes are unchanged.

**Not proven locally.** This machine has the Docker CLI but no running daemon, so the image was never built
or run here. The daemon-backed assertions are CI-required and explicit in
`deploy/ci/runtime-image-smoke.sh`: that the built image reports the version it was built with, that
`/api/installation` returns a bounded state inside a real container with real Docker secrets and a real
database, that it reports those secrets as `OK` and reaches the database, that the payload leaks no secret,
path or URL when the values are genuinely present, that `/api/version` agrees with the build argument, and
that the support report can be produced from inside the container. A local suite that pretended to have
proven a container reads its own mounted secrets would be worth less than one that says it did not.

## Boundaries

No image is published, no tag created, no branch merged, nothing deployed. No promotion, approval, execution,
archival or deletion. No Movies library access, no Jellyfin or provider call, no Phase 231 authorization, and
no live or outbound call from any test or script added here. The records mount stays read-only, the database
stays unpublished, `/healthz` stays the only open route, and the UI still offers no form, no `POST` and no
mutation of any kind.
