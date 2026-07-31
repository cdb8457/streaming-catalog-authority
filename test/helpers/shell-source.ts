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
// CORRECTION 1: THE RULE ABOVE WAS A PROMISE, AND FIVE INPUTS WERE QUIETLY BREAKING IT.
// -----------------------------------------------------------------------------------------------------
//
// A hostile review probed the first version of this module directly and found that malformed input was
// SILENTLY ACCEPTED in every case it tried:
//
//   * `words('cmd "unterminated')`            → ["cmd","unterminated"], as if the quote had been closed;
//   * `commandSubstitutions('x="$(node foo')` → [], as if there were no substitution at all;
//   * `callSites` on a final dangling `\`     → a normal call, with the continuation's arguments missing;
//   * `functionBody` with the SAME FUNCTION DEFINED TWICE → the FIRST definition, silently.
//
// Each is the original defect wearing a different hat. The last is the worst of them: bash uses the LAST
// definition of a function, so a gate asserting "the custody helper performs no chmod" would have read a
// clean first definition while the script actually ran a second one that chmods. And the first three all
// make a forbidden call INVISIBLE — an unterminated quote swallows the rest of a line, an unterminated
// substitution hides the command inside it, a dropped continuation hides the arguments after it. A reader
// whose failure mode is "the dangerous thing is not there" is worse than no reader.
//
// So validation is no longer advisory. `logicalLines` below is the single gate every extractor goes through,
// and it REFUSES: unterminated quotes, unterminated command substitutions, a dangling continuation at end of
// file, an unterminated heredoc, and heredoc bodies whose expansions this reader does not model. Every
// refusal names the script and the line.
//
// -----------------------------------------------------------------------------------------------------
// WHY VALIDATION IS ON THE LOGICAL LINE, NOT THE PHYSICAL ONE.
// -----------------------------------------------------------------------------------------------------
//
// Because THE MOST IMPORTANT CONSTRUCT IN THIS WHOLE CORPUS is quote-unbalanced when read one physical line
// at a time. This is the shipped custody-helper invocation:
//
//     outcome="$(node "${CUSTODY_HELPER}" "${SECRETS_DIR}/${name}" --generate \
//       "${CUSTODY_RUNTIME_UID}" "${CUSTODY_RUNTIME_GID}")" || {
//
// Line one opens a double quote it does not close; line two closes one it never opened. A per-physical-line
// quote rule would reject the exact invocation the custody gates exist to count the arguments of. Joining
// continuations FIRST and validating the result is what makes the rule both strict and correct.
//
// -----------------------------------------------------------------------------------------------------
// WHAT THIS DELIBERATELY IS NOT.
// -----------------------------------------------------------------------------------------------------
//
// Not a POSIX shell parser, and the refusals are how it stays honest about that. It handles the constructs
// THESE scripts are written in — `name() {` functions, `case` arms, `#` comments, quoted words, `\`
// continuations, quoted heredocs — and REFUSES on anything else rather than guessing. Growing the corpus may
// mean growing this reader; it will say so with a named error instead of quietly returning the wrong region.
//
// Where a stronger proof than reading the source is available, the suites use it: the command-plan gates run
// the real script under a recording `PATH` and assert the arguments the script actually passed, and the
// signal gates send a real SIGTERM to the real script and read its real exit status. That is evidence no
// source reader can give, and it is why this module is deliberately small.

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

/** One logical line: physical continuations joined, and the 1-based line it started on. */
export interface LogicalLine {
  readonly text: string;
  readonly line: number;
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

/**
 * ONE LEXER, USED BY EVERYTHING.
 *
 * CORRECTION 1, SECOND ROUND. This module had FOUR separate quote walkers — in `openQuoteAt`, in
 * `withoutComment`, in `words` and in `braceDelta` — and they did not agree with each other. `openQuoteAt`
 * honoured a backslash inside a double-quoted string; `withoutComment` and `words` did not. So for a line
 * like
 *
 *     echo "she said \"hi\" # still inside the string"
 *
 * `withoutComment` decided the string had closed at the escaped quote, treated the `#` as starting a comment,
 * and returned a TRUNCATED line — dropping everything after it. `code(source)`, which several gates search,
 * is `withoutComment` mapped over a file, so a `chmod` after such a line simply was not in the text those
 * gates read. Whether a given input then also tripped `openQuoteAt` — and so failed closed instead of open —
 * was luck, and luck is precisely what this module exists to remove.
 *
 * So the state machine is written ONCE. Everything else asks it questions.
 *
 * Escape rules, as the shell has them: outside quotes a backslash escapes the next character; inside DOUBLE
 * quotes it does too (for the characters that matter here, `"` and `\`); inside SINGLE quotes there are no
 * escapes at all and a backslash is an ordinary character.
 */
interface Lexed {
  readonly text: string;
  /** Which quote each character is inside, or `null` for unquoted. */
  readonly quote: readonly (null | '"' | "'")[];
  /** Whether each character was escaped by a preceding backslash. */
  readonly escaped: readonly boolean[];
  /** The quote still open at the end of the line, or `null`. */
  readonly open: null | '"' | "'";
}

function lex(text: string): Lexed {
  const quote: (null | '"' | "'")[] = new Array<null | '"' | "'">(text.length).fill(null);
  const escaped: boolean[] = new Array<boolean>(text.length).fill(false);
  let current: null | '"' | "'" = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (current !== "'" && char === '\\' && index + 1 < text.length) {
      quote[index] = current;
      quote[index + 1] = current;
      escaped[index + 1] = true;
      index += 1;
      continue;
    }
    if (current === null && (char === '"' || char === "'")) {
      quote[index] = null;
      current = char;
      continue;
    }
    if (current !== null && char === current) {
      quote[index] = current;
      current = null;
      continue;
    }
    quote[index] = current;
  }
  return { text, quote, escaped, open: current };
}

/**
 * The shell separators that put whatever follows them into COMMAND POSITION.
 *
 * Two-character forms are matched first, so `&&` is one token rather than two `&`s. Redirections are
 * deliberately not here: `>` does not start a command, and splitting it would change argument counts the
 * custody gates depend on without making anything visible that was not already.
 */
const OPERATORS_2: readonly string[] = [';;', '&&', '||'];
const OPERATORS_1: readonly string[] = [';', '|', '&', '(', ')'];

/** True where a character is ordinary code: not inside quotes and not escaped. */
function bare(lexed: Lexed, index: number): boolean {
  return lexed.quote[index] === null && !lexed.escaped[index];
}

/**
 * The index at which a `#` comment starts, or -1.
 *
 * A `#` only starts a comment at the start of a WORD: `${MARKER}.tmp#1` is not a comment, and neither is the
 * `#` in a parameter expansion.
 */
function commentAt(lexed: Lexed): number {
  for (let index = 0; index < lexed.text.length; index += 1) {
    if (lexed.text[index] !== '#' || !bare(lexed, index)) continue;
    if (index === 0) return index;
    const previous = index - 1;
    if (/\s/.test(lexed.text[previous]!) && bare(lexed, previous)) return index;
  }
  return -1;
}

/**
 * A copy of the line in which every quoted or escaped character is blanked out.
 *
 * Offsets are preserved 1:1, so an `indexOf` or a regular expression run against the mask finds only
 * occurrences that are really CODE — which is how `;;`, `esac` and `$(` are located without four more
 * hand-written scanners drifting apart from this one.
 */
function maskQuoted(lexed: Lexed): string {
  let out = '';
  for (let index = 0; index < lexed.text.length; index += 1) {
    out += bare(lexed, index) ? lexed.text[index]! : ' ';
  }
  return out;
}

/** Which quote is still open at the end of a string, or `null`. */
function openQuoteAt(text: string): '"' | "'" | null {
  const lexed = lex(text);
  const comment = commentAt(lexed);
  // Everything after an unquoted `#` is a comment, and a comment cannot leave a quote open.
  if (comment !== -1) return lex(text.slice(0, comment)).open;
  return lexed.open;
}

/** A line with its `#` comment removed — quote-aware, escape-aware, so a `#` inside a value survives. */
export function withoutComment(line: string): string {
  const at = commentAt(lex(line));
  return at === -1 ? line : line.slice(0, at);
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
 * Where a `case` arm's `;;` terminator really is, or -1.
 *
 * CORRECTION 1, SECOND ROUND. This was `line.includes(';;')`, and a `;;` INSIDE A STRING ended the arm.
 * Probed directly, an arm reading
 *
 *     bootstrap)
 *       echo "a literal ;; inside a string"
 *       chmod 0644 "${SECRETS_DIR}/custodian_root_key"
 *       ;;
 *
 * came back as just the `echo` line — with the `chmod` two lines later OUTSIDE the region the custody gate
 * then searched. That is the module's original defect exactly: a region that is confidently wrong, and wrong
 * in the direction that hides the dangerous thing.
 */
function terminatorAt(line: string): number {
  return maskQuoted(lex(line)).indexOf(';;');
}

/** Whether a line carries the bare word `esac` as code rather than inside a string. */
function closesCase(line: string): boolean {
  return /(^|\s)esac(\s|;|$)/.test(maskQuoted(lex(line)));
}

/** Whether a line opens a `case ... in` as code. */
function opensCase(line: string): boolean {
  return /(^|\s)case\s+.*\sin\s*$/.test(maskQuoted(lex(line)));
}

const HEREDOC = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/;

/**
 * The first heredoc operator at or after `from`, located in CODE and read from the TEXT.
 *
 * `<<<` is a here-STRING, not a here-document: it takes its input from the rest of the line and consumes no
 * following lines, so it is skipped rather than treated as an opener.
 */
function heredocAt(line: string, from = 0): {
  at: number; after: number; dashed: boolean; quoted: boolean; terminator: string;
} | null {
  const lexed = lex(line);
  for (let index = from; index < line.length - 1; index += 1) {
    if (line[index] !== '<' || line[index + 1] !== '<' || !bare(lexed, index)) continue;
    if (line[index + 2] === '<') { index += 2; continue; }
    const match = HEREDOC.exec(line.slice(index));
    if (match === null) continue;
    return {
      at: index,
      after: index + match[0]!.length,
      dashed: match[1] === '-',
      quoted: match[2] !== '',
      terminator: match[3]!,
    };
  }
  return null;
}

/**
 * The script as LOGICAL lines: continuations joined, heredoc bodies removed, everything validated.
 *
 * THIS IS THE ONLY DOOR INTO THE EXTRACTORS, so a malformed script cannot reach any of them. What it rejects,
 * and why each one would otherwise hide a forbidden call:
 *
 *   UNTERMINATED QUOTE          swallows the remainder of the logical line, so a `chmod` after it is not
 *                               "absent", it is unreadable — and `!includes` cannot tell those apart.
 *   UNTERMINATED `$( `          hides the command inside it, which is precisely where a custody gate looks
 *                               for the helper invocation and its argument count.
 *   DANGLING FINAL `\`          means the arguments on the next line were never written. A call site read
 *                               without them has the wrong argument count, which is the whole proof.
 *   UNTERMINATED HEREDOC        means the rest of the file is data or code depending on a terminator that is
 *                               not there. There is no safe assumption to make.
 *   EXPANDING HEREDOC WITH `$( `A `$( )` inside an UNQUOTED heredoc really executes. This reader does not
 *                               model that, so it refuses instead of skipping past a live command.
 *
 * HEREDOC BODIES ARE SKIPPED, not parsed, and that is correct rather than convenient: a quoted heredoc body
 * is inert text. Five of the shipped scripts carry one — usage banners, exit-code tables — and one of those
 * contains an apostrophe in ordinary English prose ("the underlying command's"), which is quote-unbalanced
 * and entirely harmless. Refusing that would be refusing a comment.
 */
export function logicalLines(source: ShellSource): readonly LogicalLine[] {
  const out: LogicalLine[] = [];
  for (let index = 0; index < source.lines.length; index += 1) {
    const startedAt = index + 1;
    const where = `${source.path}:${startedAt}`;
    let text = source.lines[index]!;

    // ---- continuations FIRST ---------------------------------------------------------------------------
    //
    // CORRECTION 1, SECOND ROUND. Heredocs used to be detected BEFORE this join, on the unjoined physical
    // line — so a heredoc operator introduced ON a continuation could not be seen:
    //
    //     cat \
    //       <<'EOF'
    //     chmod 0644 /etc/shadow
    //     EOF
    //
    // The `<<'EOF'` arrived only after joining, by which time the body had already been handed to the caller
    // as ordinary executable lines. Probed directly, `callSites(..., 'chmod')` returned ONE — a call site
    // reported from inside a heredoc body, which is the mirror image of the hiding bug and just as wrong.
    // Joining first means the heredoc is found wherever the author put it.
    while (/\\$/.test(withoutComment(text))) {
      if (index + 1 >= source.lines.length) {
        throw new ShellSourceError(
          `${where}: the file ends on a line continuation, so the arguments after it were never written`);
      }
      text = `${withoutComment(text).slice(0, -1)} ${source.lines[index + 1]!}`;
      index += 1;
    }

    // ---- heredocs, on the joined line ------------------------------------------------------------------
    const stripped = withoutComment(text);
    // THE OPERATOR IS FOUND IN CODE; THE TERMINATOR IS READ FROM THE TEXT. A `<<` inside a string is not a
    // heredoc, so the operator's position comes from the lexer — but the terminator word is usually QUOTED
    // (`<<'EOF'`), and a masked copy has blanked exactly those characters. Masking to find the operator and
    // then reading the word from the original is what gets both right; an earlier attempt masked both and
    // silently found no heredoc at all, which put the body back into the executable stream.
    const heredoc = heredocAt(stripped);
    if (heredoc !== null) {
      // MORE THAN ONE ON A LINE IS UNSUPPORTED, NOT GUESSED AT. `cat <<'A' <<'B'` consumes two bodies in
      // order, and a reader that consumed one would treat the second body as code.
      if (heredocAt(stripped, heredoc.after) !== null) {
        throw new ShellSourceError(
          `${where}: more than one heredoc on a line. This reader models one and refuses to guess how the `
          + 'bodies pair up with the operators.');
      }
      const quoted = heredoc.quoted;
      const terminator = heredoc.terminator;
      const dashed = heredoc.dashed;
      let closed = false;
      const body: string[] = [];
      for (let scan = index + 1; scan < source.lines.length; scan += 1) {
        const line = source.lines[scan]!;
        // ---- THE DELIMITER MATCHES EXACTLY -----------------------------------------------------------
        //
        // CORRECTION 1, THIRD ROUND — CONFIRMED FAIL-OPEN. This compared `line.trim() === terminator`, so a
        // SPACE-INDENTED `  EOF` closed a plain `<<'EOF'`. The shell does not: for a non-dashed heredoc the
        // delimiter line must be exactly the word. The consequence was that a body ended early and the lines
        // after it — still data as far as the shell is concerned — were handed back as executable code, so a
        // `chmod` sitting in a heredoc body was reported as a real call site. Only the DASHED form strips
        // indentation, and only leading TABS, which is what `<<-` is defined to do.
        const candidate = dashed ? line.replace(/^\t+/, '') : line;
        if (candidate === terminator) {
          index = scan;
          closed = true;
          break;
        }
        body.push(line);
      }
      if (!closed) {
        throw new ShellSourceError(
          `${where}: a heredoc opened with ${terminator} is never terminated — refusing to guess where it ends`);
      }
      if (!quoted && (body.join('\n').includes('$(') || body.join('\n').includes('`'))) {
        throw new ShellSourceError(
          `${where}: an UNQUOTED heredoc body contains a command substitution, which really executes. This `
          + 'reader does not model that and will not skip past a live command.');
      }
      // ---- THE CODE AROUND THE OPERATOR IS STILL CODE, ON BOTH SIDES -------------------------------
      //
      // CORRECTION 1, THIRD ROUND — CONFIRMED FAIL-OPEN. Only the text BEFORE the operator was kept, so
      // `cat <<'EOF' ; chmod 0644 secret` came back as the single word `cat` and the `chmod` after the
      // delimiter word vanished — zero call sites for a line that really runs it. The tail is ordinary code:
      // a redirection (`cat <<'EOF' > "${FILE}"`), another command after a separator, anything. Only the
      // OPERATOR AND ITS DELIMITER WORD are removed; everything else on the line is kept and validated.
      const rejoined = `${stripped.slice(0, heredoc.at)} ${stripped.slice(heredoc.after)}`;
      const openInLine = openQuoteAt(rejoined);
      if (openInLine !== null) {
        throw new ShellSourceError(
          `${where}: an unterminated ${openInLine === '"' ? 'double' : 'single'} quote around a heredoc operator`);
      }
      assertSubstitutionsBalanced(rejoined, where);
      out.push({ text: rejoined, line: startedAt });
      continue;
    }

    // ---- validation, on the joined line --------------------------------------------------------------
    const open = openQuoteAt(text);
    if (open !== null) {
      throw new ShellSourceError(
        `${where}: an unterminated ${open === '"' ? 'double' : 'single'} quote — the rest of this line cannot `
        + 'be read, and an unreadable line is not an empty one');
    }
    assertSubstitutionsBalanced(text, where);
    out.push({ text, line: startedAt });
  }
  return out;
}

/**
 * Where each top-level `$( ... )` sits, as `[open, close]` index pairs. Throws if one never closes.
 *
 * QUOTE-AWARE IN BOTH DIRECTIONS. A `$(` inside SINGLE quotes is literal text and must not be reported; a
 * `$(` inside DOUBLE quotes really runs and must be. Parentheses inside quotes do not count toward the
 * nesting, which is what stops `$(echo ")")` from closing early.
 */
function substitutionSpans(line: string, where: string): ReadonlyArray<readonly [number, number]> {
  const lexed = lex(line);
  const spans: Array<readonly [number, number]> = [];
  for (let index = 0; index < line.length - 1; index += 1) {
    if (line[index] !== '$' || line[index + 1] !== '(') continue;
    if (lexed.quote[index] === "'" || lexed.escaped[index]) continue;
    let depth = 0;
    let closed = false;
    for (let scan = index + 1; scan < line.length; scan += 1) {
      if (lexed.escaped[scan] || lexed.quote[scan] === "'") continue;
      // A paren inside double quotes is text; the substitution's own parens are unquoted at this level.
      if (lexed.quote[scan] !== null && lexed.quote[scan] !== lexed.quote[index]) continue;
      if (line[scan] === '(') depth += 1;
      else if (line[scan] === ')') {
        depth -= 1;
        if (depth === 0) { spans.push([index, scan]); index = scan; closed = true; break; }
      }
    }
    if (!closed) {
      throw new ShellSourceError(
        `${where}: an unterminated command substitution — whatever it runs is unreadable, and this reader `
        + 'will not report it as absent');
    }
  }
  return spans;
}

/** Every `$( ` in a line is closed. Named separately so `commandSubstitutions` and the gate agree exactly. */
function assertSubstitutionsBalanced(line: string, where: string): void {
  substitutionSpans(line, where);
}

/**
 * Count the braces a line opens minus the braces it closes, ignoring comments, quoted text and the `${...}`
 * of a parameter expansion — the three places a brace is not a block.
 */
function braceDelta(line: string, where: string): number {
  // THE SAME LEXER, so this cannot drift from the one that decided where the comment and the words were.
  // That drift is what produced the four disagreeing walkers this module started with.
  const stripped = withoutComment(line);
  const lexed = lex(stripped);
  let delta = 0;
  for (let index = 0; index < stripped.length; index += 1) {
    const char = stripped[index]!;
    if (lexed.escaped[index]) continue;
    // `${NAME}` — a parameter expansion, inside or outside double quotes. Its braces are not a block, and
    // these scripts are full of them.
    if (char === '$' && stripped[index + 1] === '{' && lexed.quote[index] !== "'") {
      const close = stripped.indexOf('}', index);
      if (close === -1) throw new ShellSourceError(`${where}: an unterminated parameter expansion`);
      index = close;
      continue;
    }
    if (lexed.quote[index] !== null) continue;
    if (char === '{') delta += 1;
    else if (char === '}') delta -= 1;
  }
  return delta;
}

/**
 * The body of `name() { ... }`, brace-matched.
 *
 * THE FUNCTION MUST BE DEFINED EXACTLY ONCE, and this is not pedantry. Bash uses the LAST definition of a
 * name, so a script defining `write_custody_secret` twice runs the second one — while the first version of
 * this extractor returned the FIRST, silently. A gate asserting "the custody helper performs no chmod" would
 * have read a clean definition and approved a script that chmods. Two definitions is an ambiguity this reader
 * refuses to resolve on the caller's behalf.
 *
 * The opening line and the closing brace are excluded, so what comes back is what the function DOES.
 */
export function functionBody(source: ShellSource, name: string): readonly string[] {
  const lines = logicalLines(source);
  const opener = new RegExp(`^\\s*(?:function\\s+)?${name}\\s*\\(\\s*\\)\\s*\\{`);
  const starts = lines
    .map((line, index) => (opener.test(withoutComment(line.text)) ? index : -1))
    .filter((index) => index !== -1);
  if (starts.length === 0) {
    throw new ShellSourceError(`${source.path} defines no shell function named ${name}()`);
  }
  if (starts.length > 1) {
    throw new ShellSourceError(
      `${source.path} defines ${name}() ${starts.length} times (lines `
      + `${starts.map((index) => lines[index]!.line).join(', ')}). Bash would run the LAST one; refusing to `
      + 'choose for you.');
  }
  const start = starts[0]!;
  let depth = braceDelta(lines[start]!.text, `${source.path}:${lines[start]!.line}`);
  if (depth <= 0) {
    throw new ShellSourceError(`${source.path}: ${name}() does not open a block on its first line`);
  }
  for (let index = start + 1; index < lines.length; index += 1) {
    depth += braceDelta(lines[index]!.text, `${source.path}:${lines[index]!.line}`);
    if (depth === 0) return lines.slice(start + 1, index).map((line) => line.text);
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
  const lines = logicalLines(source);
  const opener = new RegExp(`^\\s*case\\s+.*${subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\sin\\s*$`);
  const starts = lines
    .map((line, index) => (opener.test(withoutComment(line.text)) ? index : -1))
    .filter((index) => index !== -1);
  if (starts.length !== 1) {
    throw new ShellSourceError(
      `${source.path} has ${starts.length} case statements switching on ${subject}, not one`);
  }
  const start = starts[0]!;
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    // IN CODE, NOT IN TEXT. A line containing the word `esac` inside a string used to close the block, which
    // truncated it — and a truncated block hides whichever arms came after the string that mentioned it.
    const line = withoutComment(lines[index]!.text);
    if (opensCase(line)) depth += 1;
    if (closesCase(line)) {
      depth -= 1;
      if (depth === 0) {
        return {
          path: `${source.path} case ${subject}`,
          lines: lines.slice(start + 1, index).map((entry) => entry.text),
        };
      }
    }
  }
  throw new ShellSourceError(`${source.path}: the case switching on ${subject} is never closed with esac`);
}

/**
 * The body of one `case` arm, from its pattern to its `;;`.
 *
 * ANCHORED ON A PATTERN THAT IS A WHOLE ARM, not on the first place the label's text appears. Asking for a
 * label that appears more than once is an error unless the caller scopes it with `caseBlock` first — a wrong
 * block is exactly the failure this module exists to make impossible.
 */
export function caseArms(source: ShellSource, label: string): readonly (readonly string[])[] {
  const lines = logicalLines(source).map((entry) => entry.text);
  // A `case` arm's pattern may carry alternatives (`bootstrap|root-only)`), so the label must be a whole
  // alternative rather than a substring: `root-only` must not match `not-root-only)`.
  const arm = new RegExp(`^\\s*\\(?\\s*(?:[^)]*\\|)?${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\)`);
  const found: Array<readonly string[]> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = withoutComment(lines[index]!);
    if (!arm.test(line)) continue;
    // A one-line arm (`root-only) echo ... ;;`) carries its own terminator; a block arm ends at a later `;;`.
    // BOTH ARE LOCATED IN CODE, NOT IN TEXT: a `;;` inside a string is two semicolons in a value.
    //
    // ---- AND A NESTED `case` HAS TERMINATORS OF ITS OWN --------------------------------------------
    //
    // CORRECTION 1, FINAL ROUND — CONFIRMED FAIL-OPEN. This took the FIRST `;;` after the pattern, and an
    // inner `case` supplies one long before the outer arm ends:
    //
    //     bootstrap)
    //       case "${MODE}" in
    //         a) echo inner-a ;;          <- the arm used to stop HERE
    //         *) echo inner-other ;;
    //       esac
    //       chmod 0644 "${SECRETS_DIR}/custodian_root_key"
    //       ;;
    //
    // The returned arm was the two lines above the marker and nothing else, so the `chmod` was outside the
    // region the custody gate searched. Depth is tracked instead: only a `;;` at the arm's own level ends it,
    // and an `esac` at that level means the arm was never terminated at all.
    const head = line.slice(line.indexOf(')') + 1);
    let depth = (opensCase(head) ? 1 : 0) - (closesCase(head) ? 1 : 0);
    const inHead = terminatorAt(head);
    if (depth <= 0 && inHead !== -1) { found.push([head.slice(0, inHead)]); continue; }
    if (depth < 0) depth = 0;
    let end = -1;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const scanned = withoutComment(lines[scan]!);
      if (depth === 0 && terminatorAt(scanned) !== -1) { end = scan; break; }
      if (opensCase(scanned)) { depth += 1; continue; }
      if (closesCase(scanned)) {
        // At depth 0 this is the OUTER case ending: the arm was never terminated with `;;`.
        if (depth === 0) break;
        depth -= 1;
      }
    }
    if (end === -1) {
      throw new ShellSourceError(`${source.path}: the ${label}) case arm is never terminated with ;;`);
    }
    found.push([head, ...lines.slice(index + 1, end + 1)]);
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
 * REFUSES AN UNTERMINATED QUOTE. It used to return `['cmd', 'unterminated']` for `cmd "unterminated`, which
 * reads exactly like a well-formed two-word command — so a gate counting arguments got a plausible number
 * from a line it had not actually understood, and a gate checking that a word is ABSENT got its wish for the
 * wrong reason. What the caller needs from this is HOW MANY WORDS a call site has, and that number is only
 * meaningful if the line parsed.
 */
export function words(line: string, where = 'a shell line'): readonly string[] {
  const text = withoutComment(line);
  const open = openQuoteAt(text);
  if (open !== null) {
    throw new ShellSourceError(
      `${where}: an unterminated ${open === '"' ? 'double' : 'single'} quote, so these are not its words`);
  }
  // SPLIT USING THE SHARED LEXER, so "is this whitespace a separator" and "is this quote real" are answered
  // by the same state machine that decided where the comment was.
  const lexed = lex(text);
  const out: string[] = [];
  let current = '';
  let started = false;
  const flush = (): void => {
    if (started) { out.push(current); current = ''; started = false; }
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    // ---- BARE OPERATORS ARE TOKENS, WHITESPACE OR NOT ------------------------------------------------
    //
    // CORRECTION 1, THIRD ROUND — CONFIRMED FAIL-OPEN. Words were split on WHITESPACE ALONE, so `echo
    // x;chmod 0644 secret` tokenised as `["echo","x;chmod","0644","secret"]`. `chmod` was never the head of a
    // word, so it was never in command position, so `callSites(..., 'chmod')` answered ZERO — for a line that
    // really does run chmod. The same held for `true&&chmod`, `false||chmod`, `printf x|chmod` and
    // `(chmod ...)`. Every one of those is a way to run a forbidden command that the no-chmod and no-docker
    // gates could not see. A shell separator separates whether or not anybody typed a space around it.
    if (bare(lexed, index)) {
      const two = text.slice(index, index + 2);
      const operator = OPERATORS_2.includes(two) ? two : (OPERATORS_1.includes(char) ? char : null);
      if (operator !== null) {
        flush();
        out.push(operator);
        index += operator.length - 1;
        continue;
      }
    }
    // The quote characters themselves are structure, not content: they are the only characters the lexer
    // marks as unquoted while their neighbours are quoted.
    const isDelimiter = (char === '"' || char === "'") && !lexed.escaped[index]
      && (lexed.quote[index] === null || lexed.quote[index] === char);
    if (isDelimiter && !lexed.escaped[index]) {
      const opensHere = lexed.quote[index] === null;
      const closesHere = lexed.quote[index] === char;
      if (opensHere || closesHere) { started = true; continue; }
    }
    if (char === '\\' && !lexed.escaped[index] && lexed.quote[index] !== "'") continue;
    if (bare(lexed, index) && /\s/.test(char)) { flush(); continue; }
    current += char;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

/**
 * The inner text of every TOP-LEVEL `$( ... )` command substitution in a line, parens balanced.
 *
 * REFUSES AN UNTERMINATED ONE. It used to answer `[]` — "there are no substitutions here" — for
 * `x="$(node foo`, which is the most dangerous answer available: the caller is looking for a command, and
 * this told it there was none. Top-level only, so the spans do not overlap and a caller counting them counts
 * commands rather than nesting depth; `callSites` descends by applying this to each span's inner text.
 */
export function commandSubstitutions(line: string, where = 'a shell line'): readonly string[] {
  return substitutionSpans(line, where).map(([open, close]) => line.slice(open + 2, close));
}

/**
 * Everything that can precede a word and still leave it in COMMAND POSITION.
 *
 * CORRECTION 1, THIRD ROUND FOLLOW-UP. This list is the whole answer to "is this command really run", and it
 * had two holes. `&` was being EMITTED as a token by the splitter but was not accepted here, so
 * `echo x&chmod 0644 secret` still hid the chmod — a token nobody consumed is worse than one nobody produced,
 * because the tokeniser looks correct. And a command reached through an assignment prefix or a control
 * keyword was not recognised at all: `VAR=x chmod`, `if chmod`, `while chmod`, `! chmod` and
 * `sudo chmod` each ran the command while every gate answered zero.
 *
 * Probed directly, FIFTEEN valid shapes all returned zero call sites. Each is a plausible way to write a
 * forbidden command, and a gate that cannot see any of them is not a gate.
 */
const SEPARATORS: readonly string[] = [';', ';;', '&&', '||', '|', '&', '(', '{'];
const CONTROL_PREFIXES: readonly string[] = [
  'then', 'else', 'elif', 'do', 'if', 'while', 'until', '!',
  // Wrappers that run their argument as a command. `xargs chmod` chmods; so does `sudo chmod`.
  'command', 'builtin', 'exec', 'env', 'sudo', 'time', 'nohup', 'xargs',
];
/** `NAME=value` in front of a command sets a variable FOR that command — the command still runs. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The words of a line that begins a command — statement position, or the head of a substitution. */
function headWords(parts: readonly string[], command: string, into: Array<readonly string[]>): void {
  for (let at = 0; at < parts.length; at += 1) {
    if (parts[at] !== command) continue;
    // A DEFINITION IS NOT A CALL. Now that `(` and `)` are their own tokens, `write_custody_secret() {`
    // tokenises with the name in command position — and counting it as a call site made the shipped script
    // look as though it invoked the custody helper twice. `name ( )` is how bash spells a definition.
    if (parts[at + 1] === '(' && parts[at + 2] === ')') continue;
    const previous = at === 0 ? null : parts[at - 1]!;
    if (previous === null
      || SEPARATORS.includes(previous)
      || CONTROL_PREFIXES.includes(previous)
      || ASSIGNMENT.test(previous)) {
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
 *
 * A malformed script does not reach this function: `logicalLines` refuses first. That matters more here than
 * anywhere else, because the answer is a LIST — and an empty list from a line nobody could parse looks
 * exactly like an empty list from a script that never made the call.
 */
export function callSites(source: ShellSource, command: string): readonly (readonly string[])[] {
  const found: Array<readonly string[]> = [];
  for (const logical of logicalLines(source)) {
    if (logical.text.trim() === '') continue;
    const where = `${source.path}:${logical.line}`;
    headWords(words(logical.text, where), command, found);
    // The substitutions inside it, each parsed as the command line it is. Nested ones come along because
    // `commandSubstitutions` is applied to the inner text too.
    const pending = [...commandSubstitutions(logical.text, where)];
    while (pending.length > 0) {
      const inner = pending.pop()!;
      headWords(words(inner, where), command, found);
      pending.push(...commandSubstitutions(inner, where));
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
