# Phase 255: the support report, reachable by the person who needs it

Phase 246 built the operator support report and designed it around one specific fear: *a user in trouble will
paste whatever we print, into a public tracker, without reading it.* Every field was chosen so the answer to
"could this be sensitive?" is no by construction, and a scan over the rendered bytes refuses to print rather
than risk it.

Then it shipped exactly one way to obtain it:

```
npm run ops:support-report
```

That needs Node.js and a source checkout. The release bundle ships neither, deliberately — the whole point of
`v1.1.1`/`v1.1.2` was that a person with Docker and nothing else can install and run this. So the artifact
designed for a user in trouble could not be produced by a user in trouble. Somebody running the published
image under Compose or Arcane could read every panel on the page, be asked to attach a support report, and
have no way to make one.

**Fixed:** `GET /api/support-report`, and a Support report panel with a Copy button.

---

## 1. It is authenticated, like everything else operational

The report is safe to publish. That is not a reason to hand it to anyone who can reach the port.

It is a description of somebody's installation — which components are configured, which secrets exist, what
version is running — and "safe for the owner to publish deliberately" and "safe for a stranger to read
without asking" are different properties. It sits behind the same operator token as `/api/status`,
`/api/installation`, `/api/version`, `/api/logs` and `/api/promotion-chain`. Without a valid token the
response is a `401` carrying no report, no report identifier and no fragment of rendered text.

Only `GET` reaches it. `HEAD` and every mutating method answer `405` with `Allow: GET` — the route is known,
and nothing about it is a write.

## 2. The scan runs over the bytes that are sent

`renderSupportReportText` already scans its own output. This endpoint scans **the serialised envelope**: the
exact string the socket receives, after the `ok`/`code`/`report`/`text` wrapper has been added and after
`JSON.stringify` has had its say.

The wrapper is four fixed keys. "Small and fixed" is what every leak was before it happened. What is checked
is what is sent, and the response is written from that same string rather than re-serialised from a parsed
object — so the bytes that were scanned and the bytes that leave are not two strings produced at two
different moments.

## 3. A refusal withholds everything

There is no partial report, no "some fields omitted", no error text quoting what tripped the scan.

* the body is `503` with `ok: false`, a fixed code and a fixed sentence;
* the sentence names no field and repeats no value, because *which shape tripped the scan* is a fact about
  the content that was deliberately withheld;
* **a redaction rejection and an unexpected internal failure produce byte-identical responses.** Telling a
  caller which one happened is itself a signal, and neither is a state this route reports on;
* the page renders the refusal in the report panel — an empty `<pre>` and the reason — and does **not** blank
  the other four panels or put a banner across the top of a working installation. That distinction is the
  Phase 253 correction and it applies here too.

The refusal points at `ops:support-report`, which fails the same way for the same reason. There is no path
through this product that produces a report the scan rejected.

## 4. It still answers when nothing else does

The report makes **no live calls** — the database is not contacted, nothing is fetched, nothing is resolved.
That property is what makes it useful, and this route keeps it: a test asserts that on a stack with no
PostgreSQL, `/api/status` answers `503` and `/api/support-report` answers `200`.

The database is reported as `UNKNOWN` with `ADVISORY` severity: an unanswered question, never a passing check
and never a fault. The CLI is not replaced — it is still the answer when the container will not start, the
port is taken or the token is lost, because then there is no page to open.

## 5. Copy, and the fallback that is not a lie

`navigator.clipboard` exists only in a **secure context**. Plain HTTP to `127.0.0.1` counts as one. Plain
HTTP to a LAN address does not — and reaching this UI over a LAN address is a documented, supported Unraid
configuration, described in this project's own troubleshooting table.

So on precisely the installs whose operator is least likely to have a terminal open on the machine, the
Clipboard API is undefined, and no page can make it exist. A button that silently does nothing there is worse
than no button.

| Situation | What happens |
| --- | --- |
| Clipboard API present, write succeeds | Copied, and the operator is told it is already safe to publish. |
| Clipboard API absent (LAN address, plain HTTP) | The report is **selected** and the operator is told to press Ctrl+C / Cmd+C, with the reason. |
| Clipboard API present, write rejected | The same fallback. A rejected write is never reported as a copy. |
| Nothing loaded yet | Says so, rather than copying a placeholder. |

The report is loaded by the existing **Load everything** button along with the other panels, and cleared by
**Clear** along with them. It is rendered as text into a `<pre>`, exactly as the server rendered it — no
reformatting, no field-picking, no re-serialising — so the page, the endpoint and the CLI cannot start
describing the same installation differently. A test asserts the page's text equals the endpoint's, and the
endpoint's equals the CLI's.

---

## What this phase does not do

It publishes nothing, tags nothing, merges nothing, releases nothing and deploys nothing. It changes no
package visibility and touches no host. It runs no promotion, approval, execution, archival or deletion;
contacts no provider, media server or library; and neither authorizes nor executes any part of Phase 231. No
route gained a write, and the UI is still read-only: `runtime-mutations` remains on the forbidden list.

## Limitations

* The report's content is unchanged from Phase 246. This phase changes who can obtain it, not what it says.
  Phases 256 and 257 deliberately do not add to it either: the backup guidance they produce is static
  instruction, and a diagnostics report is for facts about this installation, not for advice.
* The Clipboard fallback is proved against a deterministic DOM that executes the real shipped `app.js`, not
  against a real browser engine — this project has no browser dependency, by policy. The
  daemon-backed container smoke remains the rung above it and is unchanged.

## Tests

`test/operator-ui-support-report-endpoint.ts` — 25 checks, run in CI as `test:phase255-local`: the token
boundary including near-miss tokens, method handling and that a 405 is not a route oracle, the safety headers, the served bytes passing the
redaction scan with a real absolute temp path configured, page/CLI rendering parity, answering with no
database at all, the refusal withholding everything, a redaction rejection being byte-identical to an
unexpected failure, the copy path in all four of its states driven through the real shipped script, and a
withheld report rendering as withheld without the copy button offering to copy the placeholder.

`test/operator-ui-csp-assets.ts` gains the new route in its two existing invariants: every operational route
requires a token, and the page requests every route it renders.
