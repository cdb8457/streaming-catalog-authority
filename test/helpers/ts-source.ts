// Reading the shipped TypeScript sources and the Compose files STRUCTURALLY, so a claim about one is a claim
// about the file and not about how the checkout happens to be typed.
//
// -----------------------------------------------------------------------------------------------------
// THE DEFECT THIS EXISTS TO CLOSE.
// -----------------------------------------------------------------------------------------------------
//
// `test/helpers/shell-source.ts` closed exactly this defect for the shipped SHELL scripts in Phases 329-336,
// and `.gitattributes` then pinned `*.sh` to LF so a Windows checkout could not reintroduce it there. Neither
// repair reached the `.ts` and `.yml` files, which are still — deliberately — checked out with whatever this
// platform's `core.autocrlf` produces. Three structural pins were still cutting regions out of those files
// with `indexOf` on a literal carrying a bare LF:
//
//   * `test/projection-content-command.ts`  — `body.indexOf('\n}\n')` over `src/ops/projection-content.ts`;
//   * `test/projection-phase11.ts`          — `block.indexOf('\n}\n')` over the same file;
//   * `test/projection-phase11.ts`          — `compose.indexOf('\nservices:\n')` over the Phase 11 compose.
//
// AND THE MISS WAS SILENT IN BOTH DIRECTIONS, which is the actual defect rather than the line ending.
// `indexOf` answers `-1`, `String.slice(0, -1)` is a perfectly good string, and what comes back is not "no
// match" — it is THE REST OF THE FILE, or the EMPTY STRING, depending on which side of the slice the `-1`
// landed on:
//
//   * the transaction pin sliced `0 .. -1 + 1` — the empty string — and reported that `addTorboxObjects`
//     writes outside a transaction. That is a false sentence about a shipped verb, and it is the sentence an
//     operator would be shown as the reason a release was held;
//   * the field-set pin sliced `0 .. -1` — the whole rest of the file — and reported ten extra fields on
//     `ContentStatusEntry`, because the `readonly` declarations of every LATER interface came along;
//   * `test/projection-namespace-snapshot.ts` did the same thing and PASSED, over the rest of the file,
//     which is the version nobody catches: the region it was asked about was never the region it searched.
//
// Phase 12 §11 already found the first of these on a staged Linux candidate and repaired the STAGING command
// (`git -c core.autocrlf=false archive`) so the tree carried to the host is the commit. That fixed the
// symptom on the host. It could not fix the test, which still failed on any ordinary Windows checkout — and
// it did, at the Phase 10-12 integration merge, three suites at once, against bytes identical to the child
// branch's.
//
// -----------------------------------------------------------------------------------------------------
// THE RULE, WHICH IS shell-source.ts's RULE.
// -----------------------------------------------------------------------------------------------------
//
// EVERY EXTRACTOR HERE REFUSES RATHER THAN RETURNING A REGION IT IS NOT SURE OF. There is no path through
// this module that answers with a wrong slice. A declaration that is absent, declared twice, or never closed
// produces a named error mentioning the file and the thing sought. A caller therefore cannot be handed the
// rest of the file, and cannot be handed the empty string.
//
// Line endings are normalised at the door, so every offset, every anchor and every returned region is in
// terms of LF regardless of what the checkout produced.

/** A refusal from this module. Never thrown for a region this module could have read correctly. */
export class TsSourceError extends Error {}

/**
 * A file's text with this platform's line endings normalised away.
 *
 * CR-LF AND LONE CR BOTH. A lone CR is not something Git produces, but it is something an editor can leave
 * behind, and a reader that normalised only the pair would answer differently for the two.
 */
export const lfText = (text: string): string => text.replace(/\r\n?/g, '\n');

/**
 * The source lines of a top-level declaration, from its first line to its closing brace inclusive.
 *
 * `header` is matched against the START of a line at column zero, which is what "top level" means in these
 * files. The body ends at the first subsequent line that is exactly `}` — the closing brace of a top-level
 * declaration is the only brace in these files that sits at column zero.
 *
 * WHAT IT REFUSES, and why each refusal is the whole point:
 *
 *   * NO MATCH — the caller asked about something that is not there. Answering with anything at all would be
 *     answering a question about a declaration that does not exist.
 *   * MORE THAN ONE MATCH — the caller would silently get the first. `shell-source.ts` names this as the
 *     worst of the five it found, because the later definition is the one that is in force.
 *   * NEVER CLOSED — there is no region, so there is no answer.
 *   * A COLUMN-ZERO LINE INSIDE THE REGION that is not part of the declaration's own signature. This is the
 *     integrity check that catches a run-on: if the scan sailed past the declaration's real end, the next
 *     declaration's own header is inside the region, and that is caught here rather than reported as a fact
 *     about the declaration the caller asked for. Signature continuations — the `): Promise<X> {` line a
 *     multi-line parameter list ends on — are at column zero and are allowed, but only BEFORE the line that
 *     opens the body.
 */
export function topLevelDeclaration(source: string, header: string, what: string): string {
  const lines = lfText(source).split('\n');
  const starts = lines.reduce<number[]>((found, line, index) => {
    if (line.startsWith(header)) found.push(index);
    return found;
  }, []);
  if (starts.length === 0) {
    throw new TsSourceError(`${what}: no line begins "${header}" at column zero`);
  }
  if (starts.length > 1) {
    throw new TsSourceError(
      `${what}: "${header}" begins ${starts.length} lines (${starts.map((i) => i + 1).join(', ')}), and the `
      + 'later declaration is the one in force');
  }
  const start = starts[0]!;

  // THE LINE THAT OPENS THE BODY. Usually the header itself; for a multi-line parameter list it is the
  // `): Promise<X> {` that closes the list. Bounded by the first column-zero `}` so a header with no body at
  // all cannot scan to the end of the file looking for one.
  // A parameter line is INDENTED, and one of them can perfectly well end in `{` — `options: {` is an
  // ordinary way to type an argument. Only the header itself and a column-zero continuation may open the
  // body, or a destructured parameter would be mistaken for it.
  let open = -1;
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i] === '}') break;
    if (i !== start && /^\s/.test(lines[i]!)) continue;
    if (lines[i]!.endsWith('{')) { open = i; break; }
  }
  if (open < 0) throw new TsSourceError(`${what}: "${header}" opens no block`);

  let close = -1;
  for (let i = open + 1; i < lines.length; i += 1) {
    if (lines[i] === '}') { close = i; break; }
  }
  if (close < 0) throw new TsSourceError(`${what}: "${header}" is never closed by a column-zero brace`);

  for (let i = open + 1; i < close; i += 1) {
    const line = lines[i]!;
    if (line.length > 0 && !/^\s/.test(line)) {
      throw new TsSourceError(
        `${what}: line ${i + 1} of "${header}" is at column zero ("${line.slice(0, 40)}"), so the region ran `
        + 'past the declaration');
    }
  }
  return lines.slice(start, close + 1).join('\n');
}
