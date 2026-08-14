// Projection Phase 8 — the gate's own WIRING, audited from its bytes rather than from a run.
//
// WHY THIS EXISTS, AND IT IS §11.2's FIRST NUMBERED ITEM IN THE HALF A SHELL SCRIPT CANNOT REACH. The Phase 8
// gate is 3,419 lines that had never been executed once. Its first execution was to be a multi-hour
// provider-facing soak against a metered account, and the class of defect that would have ended it is not a
// product defect at all: a variable the contract module stopped publishing, an id recorded without the cycle
// suffix the closure rule requires, a number recorded as a boolean where the closure rule demands a
// measurement. Every one of those is visible in the gate's own text, and none of them is visible to
// `bash -n`.
//
// WHAT THE OLD PIN COULD NOT SEE, WHICH IS WHY THERE IS A NEW ONE. `test/projection-phase8.ts` already
// asserted that "every id the module REQUIRES is an id the gate actually records" — by stripping the `:C1`
// and `:<server>` suffixes off the required id and asking whether the BARE string appeared anywhere in the
// file. That passes for a gate that records `P8-S5-action-ms` where the closure rule requires
// `P8-S5-action-ms:C1`, and it passes for a gate that records the id inside a comment. It is an ordering
// check that cannot pin the guard: the shape is asserted and the thing the shape exists to prevent is not.
//
// SO THIS MODEL EXPANDS THE IDS INSTEAD OF STRIPPING THEM. It walks the gate's function definitions, finds
// the cycle loop, follows the call graph out of it, resolves the id arguments the shared helpers are called
// with, expands `$CYCLE_ID` across the contract's own cycle count and `$server` across the contract's own
// server ids, and produces the multiset of ids a soak would actually write. An id required and not emitted is
// a soak that cannot close; an id emitted more than once is a soak the closure check refuses for carrying two
// verdicts under one name.
//
// IT IS A MODEL OF THE GATE AND A MODEL CAN DRIFT, WHICH IS WHAT `helperProblems` IS FOR. The shared helpers
// are described here by the ids they record, and the audit ASSERTS that each helper's body still contains
// exactly that many `record` statements. A helper that grows or loses one fails the audit rather than being
// silently mis-modelled — a wrong model that reports success is worse than no model.
//
// NOTHING HERE IMPORTS A GATE, RUNS A COMMAND OR TOUCHES A FILESYSTEM. The caller supplies the bytes.

import {
  PHASE8_RULES,
  PHASE8_SERVER_IDS,
  phase8BudgetKeyFor,
  requiredCycleGateIds,
  requiredSoakGateIds,
} from './phase8.js';

/** One `record` call site, after the id expression has been resolved but before it has been expanded. */
export interface GateEmission {
  /** The id expression, still carrying `$CYCLE_ID` and `$server` where the gate builds them. */
  readonly id: string;
  /** The comparison the gate passes to its recorder: `bool`, `le`, `ge` or `eq`. */
  readonly op: string;
  /** Whether this call site sits inside the cycle loop, and so runs once per cycle. */
  readonly perCycle: boolean;
  /** 1-based line of the call site in the gate, for a diagnosis that names a place. */
  readonly line: number;
  /**
   * The one place this emission belongs to — a function name, a helper call site, or the top level.
   *
   * IT IS WHAT KEEPS AN `if`/`else` FROM READING AS A DUPLICATE. A verdict recorded on the true branch and
   * again on the false branch is ONE verdict at run time, and counting the statements rather than the paths
   * would report every honest two-branch record in the gate as an id carrying two verdicts. Ids are therefore
   * counted once per scope, and a real duplicate — the same id recorded by two different scopes, or a
   * per-cycle id with no cycle in its name — still counts as many times as it is actually written.
   */
  readonly scope: string;
}

/**
 * The shared helpers, described by what they record.
 *
 * EACH ONE IS ASSERTED AGAINST THE HELPER'S OWN BODY rather than trusted. `records` is the number of `record`
 * statements the helper is modelled as making; `emits` is what each of them writes, in terms of the helper's
 * own parameters, which the resolver substitutes from the call site.
 */
interface HelperModel {
  readonly params: readonly string[];
  /** `id` may reference a parameter as `{name}`, the literal token `<server>`, or plain text. */
  readonly emits: readonly { readonly id: string; readonly op: string; readonly perServer: boolean }[];
}

export const PHASE8_GATE_HELPERS: Readonly<Record<string, HelperModel>> = Object.freeze({
  phase_bytes: {
    params: ['win_id', 'stat_id', 'seed_id', 'inread_prefix', 'inread_suffix', 'what'],
    emits: [
      { id: '{stat_id}', op: 'bool', perServer: false },
      { id: '{win_id}', op: 'ge', perServer: false },
      // The local control entry, recorded on each of two branches.
      { id: '{seed_id}', op: 'bool', perServer: false },
      { id: '{seed_id}', op: 'bool', perServer: false },
      // The per-server in-container read, recorded once per server on each of two verdict branches.
      { id: '{inread_prefix}:<server>{inread_suffix}', op: 'ge', perServer: true },
      { id: '{inread_prefix}:<server>{inread_suffix}', op: 'ge', perServer: true },
    ],
  },
  phase_catalogue: {
    params: ['id', 'suffix', 'what'],
    emits: [
      { id: '{id}:<server>{suffix}', op: 'bool', perServer: true },
      { id: '{id}:<server>{suffix}', op: 'bool', perServer: true },
    ],
  },
  leak_scan: {
    params: ['id', 'label', 'dir', 'list'],
    emits: [
      { id: '{id}', op: 'bool', perServer: false },
      { id: '{id}', op: 'bool', perServer: false },
    ],
  },
  compare_sets: {
    params: ['id', 'what', 'before', 'after'],
    emits: [
      { id: '{id}', op: 'bool', perServer: false },
      { id: '{id}', op: 'bool', perServer: false },
    ],
  },
});

/** A `-` argument is the gate's own "this call takes no such measurement" token. */
const SUPPRESSED = '-';

/**
 * Split a bash command line into argument tokens, honouring double quotes and single quotes.
 *
 * IT IS DELIBERATELY NOT A SHELL. It handles exactly what the gate's own call sites use — quoted strings with
 * `$VAR` and `${VAR}` inside them, bare words, and the `-` suppression token — and it stops at a `||`, a `&&`
 * or a comment, which is where every one of those call sites ends.
 */
export function tokenizeArguments(text: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  let current = '';
  let started = false;
  const push = (): void => { if (started) { tokens.push(current); current = ''; started = false; } };
  while (index < text.length) {
    const char = text[index] as string;
    if (char === '"' || char === "'") {
      const quote = char;
      started = true;
      index += 1;
      while (index < text.length && text[index] !== quote) {
        if (quote === '"' && text[index] === '\\' && index + 1 < text.length) {
          current += text[index + 1];
          index += 2;
          continue;
        }
        current += text[index];
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === ' ' || char === '\t') { push(); index += 1; continue; }
    if (text.startsWith('||', index) || text.startsWith('&&', index) || text.startsWith(';', index)) break;
    if (char === '#' && !started) break;
    started = true;
    current += char;
    index += 1;
  }
  push();
  return tokens;
}

/**
 * Join backslash continuations into one logical line, keeping the FIRST physical line's number.
 *
 * A `record` OR A HELPER CALL WHOSE ARGUMENTS SPAN TWO LINES IS ONE CALL, and reading it as two is how a
 * model quietly stops seeing half the gate. `verify_after_cycle` passes six arguments to `phase_bytes` over
 * two lines; without this, the fourth — the id prefix every per-server in-container read is named from —
 * was simply not there, and the audit reported the ids it produces as absent from a gate that records them.
 */
export function joinContinuations(
  lines: readonly { readonly text: string; readonly line: number }[],
): { readonly text: string; readonly line: number }[] {
  const out: { text: string; line: number }[] = [];
  let pending: { text: string; line: number } | null = null;
  for (const entry of lines) {
    const trimmedEnd = entry.text.replace(/\s+$/, '');
    const continues = trimmedEnd.endsWith('\\');
    const body = continues ? trimmedEnd.slice(0, -1) : entry.text;
    if (pending === null) {
      pending = { text: body, line: entry.line };
    } else {
      pending = { text: `${pending.text} ${body.trim()}`, line: pending.line };
    }
    if (!continues) { out.push(pending); pending = null; }
  }
  if (pending !== null) out.push(pending);
  return out;
}

interface FunctionBody {
  readonly name: string;
  readonly startLine: number;
  readonly lines: readonly { readonly text: string; readonly line: number }[];
}

/** Every `name() {` ... `}` in the gate, with the body's absolute line numbers kept. */
export function readFunctions(source: string): Map<string, FunctionBody> {
  const all = source.split('\n');
  const found = new Map<string, FunctionBody>();
  for (let index = 0; index < all.length; index += 1) {
    const opener = (all[index] as string).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{\s*$/);
    if (opener === null) continue;
    const name = opener[1] as string;
    const body: { text: string; line: number }[] = [];
    let cursor = index + 1;
    while (cursor < all.length && !/^\}\s*$/.test(all[cursor] as string)) {
      body.push({ text: all[cursor] as string, line: cursor + 1 });
      cursor += 1;
    }
    // A function whose closing brace is never found is a parse this model may not guess at.
    if (cursor >= all.length) continue;
    found.set(name, { name, startLine: index + 1, lines: body });
    index = cursor;
  }
  return found;
}

/** The body of the cycle loop, which is what makes an emission per-cycle rather than once. */
export function readCycleLoop(source: string): {
  readonly lines: readonly { readonly text: string; readonly line: number }[];
  readonly found: boolean;
} {
  const all = source.split('\n');
  const start = all.findIndex((line) => /^for CYCLE_INDEX in /.test(line));
  if (start === -1) return { lines: [], found: false };
  let depth = 1;
  const body: { text: string; line: number }[] = [];
  for (let index = start + 1; index < all.length; index += 1) {
    const text = all[index] as string;
    if (/^\s*(for|while|until)\b.*\bdo\s*$/.test(text)) depth += 1;
    if (/^\s*done\b/.test(text)) {
      depth -= 1;
      if (depth === 0) return { lines: body, found: true };
    }
    body.push({ text, line: index + 1 });
  }
  return { lines: body, found: false };
}

/** Which of the gate's own functions a block of shell calls, directly. */
function calledFunctions(lines: readonly string[], known: ReadonlySet<string>): string[] {
  const called = new Set<string>();
  for (const raw of lines) {
    const text = raw.trim();
    if (text.startsWith('#')) continue;
    for (const candidate of known) {
      const pattern = new RegExp(`(?:^|[;&|(]|\\bthen\\s+|\\belse\\s+|\\bdo\\s+|\\$\\()\\s*${candidate}(?=\\s|$|;|\\))`);
      if (pattern.test(text)) called.add(candidate);
    }
  }
  return [...called];
}

/** Substitute `{param}` references in a helper's modelled id from the tokens at one call site. */
function resolveHelperId(modelId: string, params: readonly string[], args: readonly string[]): string | null {
  let out = modelId;
  for (let index = 0; index < params.length; index += 1) {
    const name = params[index] as string;
    if (!out.includes(`{${name}}`)) continue;
    const value = args[index];
    if (value === undefined) return null;
    // The gate's own "no such measurement here" token: the helper skips the record entirely.
    if (value === SUPPRESSED) return null;
    out = out.split(`{${name}}`).join(value);
  }
  return /\{[a-z_]+\}/.test(out) ? null : out;
}

/**
 * Every id the gate would record, resolved through the helpers and marked per-cycle or not.
 *
 * IT FOLLOWS THE CALL GRAPH RATHER THAN GUESSING AT IT. A `record` inside `step_S5_recovery` is per-cycle
 * because the cycle loop reaches it through `step_S5_recovery_cycle`, and this walks that edge instead of
 * assuming a naming convention holds.
 */
export function collectEmissions(source: string): GateEmission[] {
  const functions = readFunctions(source);
  const loop = readCycleLoop(source);
  const names = new Set(functions.keys());

  // Everything the cycle loop can reach, transitively.
  const perCycleFunctions = new Set<string>();
  const queue = calledFunctions(loop.lines.map((entry) => entry.text), names);
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (perCycleFunctions.has(next)) continue;
    perCycleFunctions.add(next);
    const body = functions.get(next);
    if (body === undefined) continue;
    for (const call of calledFunctions(body.lines.map((entry) => entry.text), names)) {
      if (!perCycleFunctions.has(call)) queue.push(call);
    }
  }

  const emissions: GateEmission[] = [];
  const scan = (
    physical: readonly { text: string; line: number }[], perCycle: boolean, scope: string,
  ): void => {
    for (const { text, line } of joinContinuations(physical)) {
      const trimmed = text.trim();
      if (trimmed.startsWith('#')) continue;

      const direct = trimmed.match(/(?:^|[;&|]\s*|\bthen\s+|\belse\s+)record\s+(.*)$/);
      if (direct !== null) {
        const args = tokenizeArguments(direct[1] as string);
        const id = args[0];
        const op = args[1] ?? '';
        // An id the gate builds from a variable this model cannot see is resolved at the call site of the
        // helper that owns it, never guessed at here.
        if (id !== undefined && !/^\$\{?[a-z_]/.test(id)) emissions.push({ id, op, perCycle, line, scope });
        continue;
      }

      for (const [helper, model] of Object.entries(PHASE8_GATE_HELPERS)) {
        const pattern = new RegExp(`(?:^|[;&|]\\s*|\\bthen\\s+|\\belse\\s+)${helper}\\s+(.*)$`);
        const call = trimmed.match(pattern);
        if (call === null) continue;
        const args = tokenizeArguments(call[1] as string);
        for (const emit of model.emits) {
          const resolved = resolveHelperId(emit.id, model.params, args);
          if (resolved === null) continue;
          // The call site is its own scope: two calls of one helper are two measurements, and the branches
          // inside one call are one.
          emissions.push({ id: resolved, op: emit.op, perCycle, line, scope: `${helper}@${line}` });
        }
      }
    }
  };

  // The cycle loop's own body, then every function it reaches, then everything else in the file once.
  scan(loop.lines, true, '#cycle-loop');
  for (const [name, body] of functions) {
    if (PHASE8_GATE_HELPERS[name] !== undefined) continue; // modelled at its call sites instead
    scan(body.lines, perCycleFunctions.has(name), name);
  }
  // EVERYTHING NOT ALREADY SCANNED, ONCE. A line inside a function or inside the cycle loop has already been
  // counted with the right multiplicity, and scanning it again here would report every per-cycle id as
  // carrying one more verdict than the gate writes.
  const alreadyScanned = new Set<number>();
  for (const body of functions.values()) for (const entry of body.lines) alreadyScanned.add(entry.line);
  for (const entry of loop.lines) alreadyScanned.add(entry.line);
  const topLevel = source.split('\n')
    .map((text, index) => ({ text, line: index + 1 }))
    .filter((entry) => !alreadyScanned.has(entry.line));
  scan(topLevel, false, '#top-level');

  // ONE ID PER SCOPE, because two branches of one decision are one verdict at run time.
  const seen = new Set<string>();
  return emissions.filter((emission) => {
    const key = `${emission.scope} ${emission.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Expand one emission across the cycles it runs in and the servers it names. */
export function expandEmission(emission: GateEmission): string[] {
  let forms = [emission.id];
  if (/<server>|\$\{?server\}?/.test(emission.id)) {
    forms = forms.flatMap((form) => PHASE8_SERVER_IDS.map(
      (server) => form.replace(/<server>/g, server).replace(/\$\{?server\}?/g, server)));
  }
  if (/\$\{?CYCLE_ID\}?/.test(emission.id)) {
    const cycles = emission.perCycle
      ? Array.from({ length: PHASE8_RULES.CYCLES_PER_SOAK }, (_, index) => index + 1)
      : [1];
    forms = forms.flatMap((form) => cycles.map(
      (cycle) => form.replace(/\$\{?CYCLE_ID\}?/g, `C${cycle}`)));
  } else if (emission.perCycle) {
    // A PER-CYCLE EMISSION WITH NO CYCLE IN ITS NAME IS THE SAME ID THREE TIMES, and that is the defect this
    // whole model exists to make visible rather than a modelling artefact.
    forms = forms.flatMap((form) => Array.from(
      { length: PHASE8_RULES.CYCLES_PER_SOAK }, () => form));
  }
  return forms;
}

/** The helpers still record exactly what this model says they record. */
export function helperProblems(source: string): string[] {
  const problems: string[] = [];
  const functions = readFunctions(source);
  for (const [helper, model] of Object.entries(PHASE8_GATE_HELPERS)) {
    const body = functions.get(helper);
    if (body === undefined) {
      problems.push(`the gate no longer defines ${helper}(), which this audit models by name; the model is `
        + 'now describing a function that does not exist and would report success about nothing');
      continue;
    }
    const records = body.lines.filter((entry) => {
      const text = entry.text.trim();
      return !text.startsWith('#') && /(?:^|[;&|]\s*|\bthen\s+|\belse\s+)record\s/.test(text);
    }).length;
    if (records !== model.emits.length) {
      problems.push(`${helper}() makes ${records} record call(s) where this audit models ${model.emits.length}`
        + '; the model has drifted from the gate and must be corrected before its verdict means anything');
    }
  }
  return problems;
}

export interface GateAuditReport {
  readonly problems: readonly string[];
  readonly emitted: readonly string[];
  readonly required: readonly string[];
}

/**
 * Everything wrong with the gate's wiring, as sentences.
 *
 * @param gateSource the Phase 8 gate's bytes.
 * @param publishedShellNames every `P8_*` name the contract CLI publishes for the gate to `eval`.
 */
export function phase8GateWiringProblems(
  gateSource: string,
  publishedShellNames: readonly string[],
): GateAuditReport {
  const problems: string[] = [...helperProblems(gateSource)];

  const loop = readCycleLoop(gateSource);
  if (!loop.found) {
    problems.push('the gate has no `for CYCLE_INDEX in ...` loop this audit can find, so nothing below could '
      + 'tell a per-cycle measurement from a once-per-soak one');
  }

  // ---------------------------------------------------------------------------------------------------
  // EVERY `P8_*` THE GATE READS IS ONE SOMETHING GIVES IT. Under `set -u` an unpublished name is not a
  // wrong number, it is the gate exiting where it stands — which for a soak means hours of provider traffic
  // ending on a variable.
  // ---------------------------------------------------------------------------------------------------
  const assignedInGate = new Set<string>();
  const referenced = new Map<string, number>();
  gateSource.split('\n').forEach((raw, index) => {
    const text = raw.trim();
    if (text.startsWith('#')) return;
    for (const match of raw.matchAll(/(?:^|\s|;|\(|&&|\|\|)(P8_[A-Z0-9_]+)=/g)) {
      assignedInGate.add(match[1] as string);
    }
    for (const match of raw.matchAll(/(?:^|\s)(?:local|export|readonly)\s+(P8_[A-Z0-9_]+)/g)) {
      assignedInGate.add(match[1] as string);
    }
    for (const match of raw.matchAll(/P8_[A-Z0-9_]+/g)) {
      const name = match[0];
      if (!referenced.has(name)) referenced.set(name, index + 1);
    }
  });
  const published = new Set(publishedShellNames);
  for (const [name, line] of [...referenced].sort((a, b) => a[1] - b[1])) {
    if (published.has(name) || assignedInGate.has(name)) continue;
    problems.push(`the gate reads ${name} at line ${line} and nothing publishes or assigns it; under `
      + '`set -u` that is not a wrong value, it is the gate exiting at that line');
  }

  // ---------------------------------------------------------------------------------------------------
  // THE IDS, EXPANDED RATHER THAN STRIPPED.
  // ---------------------------------------------------------------------------------------------------
  const emissions = collectEmissions(gateSource);
  const counts = new Map<string, number>();
  const opFor = new Map<string, string>();
  for (const emission of emissions) {
    for (const id of expandEmission(emission)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      opFor.set(id, emission.op);
    }
  }

  const required: string[] = [];
  for (let cycle = 1; cycle <= PHASE8_RULES.CYCLES_PER_SOAK; cycle += 1) {
    required.push(...requiredCycleGateIds(cycle));
  }
  required.push(...requiredSoakGateIds());

  for (const id of required) {
    if ((counts.get(id) ?? 0) >= 1) continue;
    problems.push(`the closure rule requires ${id} and no call site in the gate records it; an absent `
      + 'measurement is not a passing one, so this soak could never close');
  }

  for (const [id, count] of [...counts].sort()) {
    if (count <= 1) continue;
    problems.push(`the gate records ${id} ${count} times in one soak; the closure check refuses an id that `
      + 'carries two verdicts, so every one of these is a problem it would report');
  }

  // ---------------------------------------------------------------------------------------------------
  // A BUDGETED ID RECORDED AS A BOOLEAN CARRIES NO MEASUREMENT, and the closure check says so in terms: it
  // demands a finite number and the budget the contract names. `bool` writes neither field.
  // ---------------------------------------------------------------------------------------------------
  for (const [id, op] of [...opFor].sort()) {
    const key = phase8BudgetKeyFor(id);
    if (key === undefined) continue;
    if (op === 'le' || op === 'ge' || op === 'eq') continue;
    problems.push(`${id} is measured against the contract's ${key} but the gate records it with '${op}'; a `
      + 'boolean verdict carries no measurement and no budget, which the closure check refuses');
  }

  return { problems, emitted: [...counts.keys()].sort(), required };
}
