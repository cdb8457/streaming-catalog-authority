// Reading the shipped shell scripts STRUCTURALLY, so a claim about one is a claim about the script and not
// about how the checkout happens to be typed.
//
// -----------------------------------------------------------------------------------------------------
// THE DEFECT THIS EXISTS TO CLOSE (Phases 329-336).
// -----------------------------------------------------------------------------------------------------
//
// Four custody gates cut a region out of a shell script with `indexOf` on a literal that embedded a bare
// LF — `'\n}\n'` for a function's closing brace, `'\n  root-only)\n'` for a `case` arm. Git's default on
// Windows is `core.autocrlf=true`, so every one of those literals misses on an ordinary Windows checkout.
//
// AND THE MISS WAS SILENT, WHICH IS THE ACTUAL DEFECT. `indexOf` answers `-1`, `String.slice(0, -1)` is a
// perfectly good string, and what came back was not "no match" — it was THE REST OF THE FILE. One gate then
// asserted that the `write_custody_secret` helper performs no `chmod`; the region it searched ran on past the
// helper into `write_secret_if_absent`, which legitimately chmods ordinary app secrets, and the gate reported
// a custody violation that did not exist. Another sliced from `-1` to `-1`, searched the EMPTY STRING, and
// would have reported a violation just as loudly had the script been deleted.
//
// A silent mis-slice can fail either way. These four failed closed and cost four release baselines; the same
// mechanism reporting a pass over the empty string is the version nobody would have caught.
//
// So the rule here is: EVERY EXTRACTOR REFUSES RATHER THAN RETURNING A REGION IT IS NOT SURE OF. There is no
// path through this module that answers with a wrong slice. If a function, a `case` arm or a call site is not
// found — or is found unbalanced — the caller gets a named error mentioning the script and the thing sought,
// which is a debuggable failure instead of a mystery about a `chmod` in the wrong paragraph.
//
// -----------------------------------------------------------------------------------------------------
// WHY THIS IS NOT `text.replace(/\r\n/g, '\n')`.
// -----------------------------------------------------------------------------------------------------
//
// Normalising the whole file and keeping the `indexOf` calls would make these four gates pass, and would
// leave every one of them still asserting that a REGION OF TEXT does or does not contain a WORD. The word
// `chmod` inside a comment, a string, or a neighbouring function reads the same to `String.includes`; the
// gate that broke here broke precisely because a paragraph of prose about chmod-ing landed inside its search
// window. Splitting lines below is tokenisation, not repair: the parser then works on WORDS AND BLOCKS, so a
// comment is excludable, a call site has an argument count, and a `case` arm ends where the shell says it
// ends rather than where the next matching byte pair happens to fall.
//
// The repository's own compose gates already made this move — they parse the YAML so that "indentation
// width, key order, quoting and line endings cannot decide the verdict". This is that principle applied to
// the shell scripts, which had been left on raw text.
//
// -----------------------------------------------------------------------------------------------------
// WHAT THIS DELIBERATELY IS NOT.
// -----------------------------------------------------------------------------------------------------
//
// Not a POSIX shell parser. It handles the constructs THESE scripts are written in — `name() {` functions,
// `case` arms, `#` comments, quoted words, `\` continuations — and refuses on anything it cannot account
// for. Where a stronger proof than reading the source is available, the suites use it: the command-plan
// gates run the real script under a recording `PATH` and assert the arguments the script actually passed,
// which is evidence no source reader can give.

export class ShellSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellSourceError';
  }
}

export interface ShellSource {
  /** How the script names itself in a refusal — a repository-relative path. */
  readonly path: string;
  /** The script's lines, with the line terminator removed. CR, LF and CRLF are all just "end of line". */
  readonly lines: readonly string[];
}

/**
 * Tokenise a script into lines.
 *
 * ALL THREE TERMINATORS, because the point is that none of them changes a verdict. A trailing CR left on a
 * line would reappear as an invisible character inside every word this module goes on to compare, which is
 * the original defect wearing a different hat.
 */
export function parseShellSource(text: string, path: string): ShellSource {
  return { path, lines: text.split(/\r\n|\n|\r/) };
}

/** A line with its `#` comment removed — quote-aware, so a `#` inside a quoted word survives. */
export function withoutComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote === null && char === '\\') { index += 1; continue; }
    if (quote === null && (char === '"' || char === "'")) { quote = char; continue; }
    if (quote !== null && char === quote) { quote = null; continue; }
    // A `#` only starts a comment at the start of a word: `${MARKER}.tmp#1` is not a comment, and neither is
    // the `#` in a parameter expansion.
    if (quote === null && char === '#' && (index === 0 || /\s/.test(line[index - 1]!))) {
      return line.slice(0, index);
    }
  }
  return line;
}

/** The script with every comment gone — for gates about what the script DOES, not about what it explains. */
export function code(source: ShellSource): ShellSource {
  return { path: source.path, lines: source.lines.map(withoutComment) };
}

/** The lines of a region, rejoined, for a refusal message or a coarse containment check. */
export function textOf(lines: readonly string[]): string {
  return lines.join('\n');
}

/**
 * Count the braces a line opens minus the braces it closes, ignoring comments, quoted text and the `${...}`
 * of a parameter expansion — the three places a brace is not a block.
 */
function braceDelta(line: string): number {
  const stripped = withoutComment(line);
  let delta = 0;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < stripped.length; index += 1) {
    const char = stripped[index]!;
    if (quote === null && char === '\\') { index += 1; continue; }
    if (quote === null && (char === '"' || char === "'")) { quote = char; continue; }
    if (quote !== null && char === quote) { quote = null; continue; }
    if (quote === "'") continue;
    // `${NAME}` — a parameter expansion, inside or outside double quotes. Its braces are not a block, and
    // these scripts are full of them.
    if (char === '$' && stripped[index + 1] === '{') {
      const close = stripped.indexOf('}', index);
      if (close === -1) throw new ShellSourceError('an unterminated parameter expansion');
      index = close;
      continue;
    }
    if (quote !== null) continue;
    if (char === '{') delta += 1;
    else if (char === '}') delta -= 1;
  }
  return delta;
}

/**
 * The body of `name() { ... }`, brace-matched.
 *
 * The opening line and the closing brace are excluded, so what comes back is what the function DOES. A
 * function that never closes, or a name that is not defined, is an error naming the script and the function.
 */
export function functionBody(source: ShellSource, name: string): readonly string[] {
  const opener = new RegExp(`^\\s*(?:function\\s+)?${name}\\s*\\(\\s*\\)\\s*\\{`);
  const start = source.lines.findIndex((line) => opener.test(withoutComment(line)));
  if (start === -1) {
    throw new ShellSourceError(`${source.path} defines no shell function named ${name}()`);
  }
  let depth = braceDelta(source.lines[start]!);
  if (depth <= 0) {
    throw new ShellSourceError(`${source.path}: ${name}() does not open a block on its first line`);
  }
  for (let index = start + 1; index < source.lines.length; index += 1) {
    depth += braceDelta(source.lines[index]!);
    if (depth === 0) return source.lines.slice(start + 1, index);
  }
  throw new ShellSourceError(`${source.path}: ${name}() is never closed — refusing to guess where it ends`);
}

/**
 * The `case "<subject>" in ... esac` block that switches on a given subject, as a source of its own.
 *
 * THIS IS HOW AN ARM IS MADE UNAMBIGUOUS. `deploy/unraid-custody-mode.sh` has THREE `root-only)` arms: one
 * validating a marker's contents, one printing a compose command, and one performing the action. A gate about
 * "what root-only does" means the third, and the old text-slicing version knew this — its comment worried in
 * so many words that "a bare `root-only)` also appears inside the command printer, and a slice that started
 * there would swallow the bootstrap case and prove nothing". It then anchored on a line-ending-typed literal
 * and got neither. Scoping to the `case` that switches on `${ACTION}` names the block by what it decides on,
 * so the arm is selected by meaning rather than by which occurrence comes first in the file.
 */
export function caseBlock(source: ShellSource, subject: string): ShellSource {
  const opener = new RegExp(`^\\s*case\\s+.*${subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\sin\\s*$`);
  const starts = source.lines
    .map((line, index) => (opener.test(withoutComment(line)) ? index : -1))
    .filter((index) => index !== -1);
  if (starts.length !== 1) {
    throw new ShellSourceError(
      `${source.path} has ${starts.length} case statements switching on ${subject}, not one`);
  }
  const start = starts[0]!;
  let depth = 0;
  for (let index = start; index < source.lines.length; index += 1) {
    const line = withoutComment(source.lines[index]!);
    if (/(^|\s)case\s+.*\sin\s*$/.test(line)) depth += 1;
    if (/(^|\s)esac(\s|;|$)/.test(line)) {
      depth -= 1;
      if (depth === 0) return { path: `${source.path} case ${subject}`, lines: source.lines.slice(start + 1, index) };
    }
  }
  throw new ShellSourceError(`${source.path}: the case switching on ${subject} is never closed with esac`);
}

/**
 * The body of one `case` arm, from its pattern to its `;;`.
 *
 * ANCHORED ON A PATTERN THAT IS A WHOLE ARM, not on the first place the label's text appears. `root-only)`
 * occurs both as an arm of the action `case` and as an arm of the command printer; an extractor that took the
 * first hit would prove something about the wrong block. So every arm matching the pattern is found, and
 * asking for a label that appears more than once is an error unless the caller says which occurrence it
 * means — a wrong block is exactly the failure this module exists to make impossible.
 */
export function caseArms(source: ShellSource, label: string): readonly (readonly string[])[] {
  // A `case` arm's pattern may carry alternatives (`bootstrap|root-only)`), so the label must be a whole
  // alternative rather than a substring: `root-only` must not match `not-root-only)`.
  const arm = new RegExp(`^\\s*\\(?\\s*(?:[^)]*\\|)?${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\)`);
  const found: Array<readonly string[]> = [];
  for (let index = 0; index < source.lines.length; index += 1) {
    const line = withoutComment(source.lines[index]!);
    if (!arm.test(line)) continue;
    // A one-line arm (`root-only) echo ... ;;`) carries its own terminator; a block arm ends at a later `;;`.
    const head = line.slice(line.indexOf(')') + 1);
    if (head.includes(';;')) { found.push([head.slice(0, head.indexOf(';;'))]); continue; }
    let end = -1;
    for (let scan = index + 1; scan < source.lines.length; scan += 1) {
      if (withoutComment(source.lines[scan]!).includes(';;')) { end = scan; break; }
      // `esac` before `;;` means the arm was never terminated: refuse rather than run to the end of the file.
      if (/^\s*esac\b/.test(withoutComment(source.lines[scan]!))) break;
    }
    if (end === -1) {
      throw new ShellSourceError(`${source.path}: the ${label}) case arm is never terminated with ;;`);
    }
    found.push([head, ...source.lines.slice(index + 1, end + 1)]);
  }
  if (found.length === 0) {
    throw new ShellSourceError(`${source.path} has no ${label}) case arm`);
  }
  return found;
}

/** The single `case` arm for a label. An error if the script has none, or more than one. */
export function caseArm(source: ShellSource, label: string): readonly string[] {
  const arms = caseArms(source, label);
  if (arms.length !== 1) {
    throw new ShellSourceError(
      `${source.path} has ${arms.length} ${label}) case arms; name the one you mean rather than taking the first`);
  }
  return arms[0]!;
}

/**
 * Split a line into shell words, keeping quoting information.
 *
 * Enough of a splitter for these scripts: single and double quotes, backslash escapes, and `${...}` kept
 * whole. What the callers need from it is HOW MANY WORDS a call site has, which is the difference between
 * `write_custody_secret custodian_root_key` and a version that also hands over a key.
 */
export function words(line: string): readonly string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  const text = withoutComment(line);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote === null && char === '\\') {
      const next = text[index + 1];
      if (next !== undefined) { current += next; started = true; index += 1; }
      continue;
    }
    if (quote === null && (char === '"' || char === "'")) { quote = char; started = true; continue; }
    if (quote !== null && char === quote) { quote = null; continue; }
    if (quote === null && /\s/.test(char)) {
      if (started) { out.push(current); current = ''; started = false; }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

/**
 * The inner text of every TOP-LEVEL `$( ... )` command substitution in a line, parens balanced.
 *
 * Top-level only, so the spans do not overlap and a caller counting them counts commands rather than nesting
 * depth. `callSites` descends by applying this to each span's inner text, which reaches a nested substitution
 * exactly once.
 *
 * A SUBSTITUTION IS A COMMAND, AND ITS ARGUMENTS ARE STILL ARGUMENTS. `outcome="$(node "${HELPER}" "${PATH}"
 * --generate "${UID}" "${GID}")"` runs a program with five words on its command line — the exact thing a
 * custody gate counting argv needs to see — and to a plain word-splitter it is one quoted blob. Pulling the
 * substitutions out and parsing each as its own logical line is what makes that call visible as a call.
 */
export function commandSubstitutions(line: string): readonly string[] {
  const found: string[] = [];
  for (let index = 0; index < line.length - 1; index += 1) {
    if (line[index] !== '$' || line[index + 1] !== '(') continue;
    let depth = 0;
    for (let scan = index + 1; scan < line.length; scan += 1) {
      if (line[scan] === '(') depth += 1;
      else if (line[scan] === ')') {
        depth -= 1;
        // Resume AFTER the whole span, so a nested substitution is not also reported at this level.
        if (depth === 0) { found.push(line.slice(index + 2, scan)); index = scan; break; }
      }
    }
  }
  return found;
}

/** The words of a line that begins a command — statement position, or the head of a substitution. */
function headWords(parts: readonly string[], command: string, into: Array<readonly string[]>): void {
  for (let at = 0; at < parts.length; at += 1) {
    if (parts[at] !== command) continue;
    const previous = at === 0 ? null : parts[at - 1]!;
    if (previous === null || [';', '&&', '||', '|', 'then', 'else', 'do', '{', '('].includes(previous)) {
      into.push(parts.slice(at));
    }
  }
}

/**
 * Every call site of a command, as its list of words — the command name first.
 *
 * LOGICAL LINES, so a call split across a `\` continuation is one call with all of its arguments, and a gate
 * counting arguments cannot be fooled by where the author wrapped the line. Command substitutions are
 * descended into, so a program run inside `$( ... )` is a call site with the arguments it really receives.
 */
export function callSites(source: ShellSource, command: string): readonly (readonly string[])[] {
  const found: Array<readonly string[]> = [];
  for (let index = 0; index < source.lines.length; index += 1) {
    let logical = withoutComment(source.lines[index]!);
    while (/\\$/.test(logical) && index + 1 < source.lines.length) {
      logical = `${logical.slice(0, -1)} ${withoutComment(source.lines[index + 1]!)}`;
      index += 1;
    }
    if (logical.trim() === '') continue;
    headWords(words(logical), command, found);
    // The substitutions inside it, each parsed as the command line it is. Nested ones come along because
    // `commandSubstitutions` is applied to the inner text too.
    const pending = [...commandSubstitutions(logical)];
    while (pending.length > 0) {
      const inner = pending.pop()!;
      headWords(words(inner), command, found);
      pending.push(...commandSubstitutions(inner));
    }
  }
  return found;
}

/** The one call site of a command. An error if there is not exactly one. */
export function callSite(source: ShellSource, command: string): readonly string[] {
  const sites = callSites(source, command);
  if (sites.length !== 1) {
    throw new ShellSourceError(`${source.path} calls ${command} ${sites.length} times, not once`);
  }
  return sites[0]!;
}
