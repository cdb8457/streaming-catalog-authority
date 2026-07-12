# Phase 196 - Cutover Doctor Parser Fix

Report id: `phase-196-cutover-parser-fix`

Phase 196 fixes the Phase 195 cutover doctor checkpoint parser before any switch retry. This phase
does not change runtime, Docker Compose, custody mode, sidecar service state, providers, playback,
downloads, scraping, Plex, Jellyfin, or media servers.

## Root Cause

The Phase 195 rollback was caused by a parser false negative, not a confirmed unhealthy doctor
report.

Retained artifact: `test/fixtures/phase-196/phase-195-post-switch-doctor.raw.txt`

The retained artifact contains npm wrapper banner lines followed by the actual doctor JSON payload:

```text
> catalog-authority@0.1.0 ops:doctor
> tsx src/ops/doctor-cli.ts --json
{... "ok": true, "checks": [...]}
```

The live cutover checkpoint used shell text matching against the captured file:

```sh
grep -q '\"ok\":true' post-switch-doctor.json
```

On the Unraid shell this escaped grep pattern did not match the retained output, even though the
doctor JSON payload later parsed as `ok:true`. The defect class is text-pattern parsing of mixed
wrapper output. It conflated two different states:

- doctor reported unhealthy;
- checkpoint output could not be parsed or matched.

Those states have different rollback semantics and must not share the same `post_switch_doctor_failed`
branch.

## Fix

New parser:

- source: `src/ops/cutover-doctor-check.ts`
- CLI: `npm run ops:cutover-doctor-check -- <doctor-output-file> --json`
- test: `npm run test:cutover-parser`

The parser:

- accepts captured output with npm banner lines before the JSON payload;
- extracts the doctor JSON object by schema, not by grep;
- validates `reportVersion: 1`, boolean `ok`, and `checks[]` shape;
- returns `healthy` only when `ok:true` and no `fail` checks are present;
- returns `unhealthy` when the doctor JSON is valid but reports `ok:false` or fail checks;
- returns `parse-error` when no valid doctor JSON can be extracted;
- treats `parse-error` as retryable checkpoint failure;
- treats a nonzero process exit with healthy JSON as retryable checkpoint disagreement.

## Corrected Checkpoint Semantics

Future cutover scripts must run the post-switch doctor checkpoint as:

```sh
docker compose -f docker-compose.unraid.runtime.yml run --rm ops ops:doctor -- --json > "$doctor_file"
doctor_exit=$?
npm run --silent ops:cutover-doctor-check -- "$doctor_file" --exit-code "$doctor_exit" --json
```

Retry taxonomy:

| Parser Status | Meaning | Cutover Action |
|---|---|---|
| `healthy` | Doctor JSON parsed and reports no fail checks | Continue |
| `unhealthy` | Doctor JSON parsed and reports unhealthy/fail checks | Roll back per Phase 193 |
| `parse-error` | Doctor output is missing, malformed, incomplete, or exit code disagrees with healthy JSON | Retry checkpoint read/run up to the configured limit before rollback |

Recommended retry behavior for `parse-error`:

- retry up to 3 times;
- wait 5 seconds between attempts;
- capture every failed parse attempt by digest;
- roll back only after retries are exhausted or if a later parse returns `unhealthy`.

## Regression Evidence

`test:cutover-parser` verifies:

- the retained Phase 195 artifact parses as `healthy`;
- genuine unhealthy doctor JSON returns `unhealthy`;
- malformed/missing doctor JSON returns retryable `parse-error`;
- healthy JSON with a nonzero command exit code returns retryable `parse-error`.

## Dry-Run

The fixed parser was dry-run against the live file-mode Unraid system without changing runtime or
custody mode. The live doctor output parsed as `healthy`.

Dry-run evidence id: `phase-196-live-file-mode-parser-dry-run`

Live file-mode doctor output digest:
`d1d57dc8cad277e26c3f8dd35bb7f72ad618e949f1ce51538bb9bab802274074`

Live file-mode parser dry-run digest:
`3e37d63d31b206f8c489a632fbfd46e195e9a9f496a61f868d755386d12cb944`

Parser verdict: `healthy`, `ok:true`, `pass:12`, `warn:2`, `fail:0`, `total:14`

## Phase 193 Runbook Update

Phase 193 now requires schema-aware doctor checkpoint parsing and distinguishes parse retry from
doctor-unhealthy rollback.

## Status

O4 status after Phase 196: `open/deferred`

O5 status after Phase 196: `open/deferred`

Phase 195 remains `attempted-with-rollback`. Phase 196 unblocks a future explicit Phase 197 switch
retry using the corrected parser.
