# Phase 230: Prompt/Instruction-Injection Corpus (local, non-live)

Report id: `phase-230-promotion-injection-corpus`

Status: `PHASE_230_PROMOTION_INJECTION_CORPUS_READY`

Embeds untrusted, adversarial text — fake instructions, shell/template/script fragments, and directives
like "authorize Phase 231" or "run the deploy launcher" — into artifact and record fields, feeds them
through the offline verifiers, and confirms every one is handled purely as **data**: no exception, a
normal redaction-safe report, and no command execution or live call. It reads parsed JSON only; it
performs no promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes
nothing live.

## What it proves

For each payload it runs four verifiers — `replay` (payload in a promotion-evidence transition),
`schema` (payload as an artifact status), `transcript` (payload as a remediation), and `changelog`
(payload as a commit subject). Each entry records `{ payloadIndex, verifier, handledAsData, redactionSafe,
threw }`. `ok` is true only when every entry is `handledAsData` (a normal report came back),
`redactionSafe`, and did not throw. The report carries only indices, enums, booleans, and digests — the
payload **text is never echoed** — and a `corpusDigest`.

The tools are pure JSON processors with **no** `eval`, `Function`, `execSync`, `child_process`, or
network sinks, so injected text can never be executed; the suite also statically asserts this over every
local op source.

## Files

- `src/ops/promotion-injection-corpus.ts` — `INJECTION_PAYLOADS`, `verifyInjectionCorpus(bundle)`.
- `src/ops/promotion-injection-corpus-cli.ts` — CLI wrapper.
- `test/promotion-injection-corpus.ts` — 4 tests: every payload handled as data, report redaction-safe
  (payload not echoed), no dynamic-execution sinks in any local tool, and a spawned CLI run.

## Usage

```
npm run ops:promotion-injection-corpus -- --bundle bundle.json [--out corpus.json]
```

Exit `0` = every payload handled as data, `1` = a lapse.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
