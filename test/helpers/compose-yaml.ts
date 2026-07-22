// A small YAML reader for the Compose files in this repository, so tests can assert what a stack IS rather
// than how its file happens to be typed.
//
// Substring assertions over compose text are two things at once: a claim about configuration and an
// accidental claim about formatting. `compose.includes('cap_drop:\n      - ALL')` fails on a CRLF checkout
// even though every capability is still dropped, and it would keep passing if the block were moved under the
// wrong service. Parsing separates the two: line endings, indentation width, key order and quoting stop
// mattering, and the assertion lands on the value Docker would actually read.
//
// This handles the subset the repository's compose files use — block maps, block sequences, flow sequences
// and flow maps, quoted and plain scalars, comments — and nothing else. It is deliberately not a general
// YAML implementation: anchors, multi-line scalars, multiple documents and tags are not compose idioms here,
// and a parser that silently guessed at them would be worse than one that refuses.

export type YamlValue = string | number | boolean | null | YamlValue[] | { readonly [key: string]: YamlValue };
export type YamlMap = { readonly [key: string]: YamlValue };

export class ComposeYamlError extends Error {}

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly number: number;
}

/** Strip a trailing `#` comment, respecting quoted scalars. */
function stripComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote === '"') {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) return raw.slice(0, i);
  }
  return raw;
}

/** Split on any line ending, so a CRLF checkout parses identically to an LF one. */
function readLines(text: string): Line[] {
  const lines: Line[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const withoutComment = stripComment(raw).replace(/\s+$/, '');
    if (withoutComment.trim() === '') return;
    lines.push({ indent: withoutComment.length - withoutComment.trimStart().length, text: withoutComment.trimStart(), number: index + 1 });
  });
  return lines;
}

const KEY = /^(?:"([^"]+)"|'([^']+)'|([^\s:#][^:]*?)):(?:\s+(.*))?$/;

function parseScalar(raw: string): YamlValue {
  const text = raw.trim();
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.startsWith('[') || text.startsWith('{')) return parseFlow(text);
  if (text.startsWith('"') || text.startsWith("'")) return parseQuoted(text, 0).value;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+$/.test(text)) return Number(text);
  return text;
}

function parseQuoted(text: string, start: number): { value: string; end: number } {
  const quote = text[start];
  let out = '';
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === '"') {
      if (ch === '\\') { out += text[i + 1] ?? ''; i++; continue; }
      if (ch === '"') return { value: out, end: i + 1 };
    } else {
      if (ch === "'" && text[i + 1] === "'") { out += "'"; i++; continue; }
      if (ch === "'") return { value: out, end: i + 1 };
    }
    out += ch;
  }
  throw new ComposeYamlError(`unterminated quoted scalar: ${text.slice(start)}`);
}

/** Flow collections: `["CMD-SHELL", "…"]` and `{ max-size: "10m", max-file: "3" }`. */
function parseFlow(text: string): YamlValue {
  const { value, end } = parseFlowAt(text, 0);
  if (text.slice(end).trim() !== '') throw new ComposeYamlError(`trailing content after flow collection: ${text}`);
  return value;
}

function parseFlowAt(text: string, start: number): { value: YamlValue; end: number } {
  let i = start;
  while (text[i] === ' ') i++;
  const open = text[i];
  if (open !== '[' && open !== '{') return parseFlowScalar(text, i);
  const close = open === '[' ? ']' : '}';
  const items: YamlValue[] = [];
  const map: Record<string, YamlValue> = {};
  i++;
  for (;;) {
    while (text[i] === ' ' || text[i] === ',') i++;
    if (i >= text.length) throw new ComposeYamlError(`unterminated flow collection: ${text.slice(start)}`);
    if (text[i] === close) { i++; break; }
    if (open === '[') {
      const parsed = parseFlowAt(text, i);
      items.push(parsed.value);
      i = parsed.end;
    } else {
      const key = parseFlowAt(text, i);
      i = key.end;
      while (text[i] === ' ') i++;
      if (text[i] !== ':') throw new ComposeYamlError(`expected ':' in flow map: ${text.slice(start)}`);
      i++;
      const parsed = parseFlowAt(text, i);
      map[String(key.value)] = parsed.value;
      i = parsed.end;
    }
  }
  return { value: open === '[' ? items : map, end: i };
}

function parseFlowScalar(text: string, start: number): { value: YamlValue; end: number } {
  if (text[start] === '"' || text[start] === "'") {
    const quoted = parseQuoted(text, start);
    return { value: quoted.value, end: quoted.end };
  }
  let end = start;
  while (end < text.length && !',:]}'.includes(text[end]!)) end++;
  return { value: parseScalar(text.slice(start, end)), end };
}

function parseBlock(lines: readonly Line[], from: number, indent: number): { value: YamlValue; next: number } {
  if (from >= lines.length) return { value: null, next: from };
  return lines[from]!.text.startsWith('- ') || lines[from]!.text === '-'
    ? parseSequence(lines, from, indent)
    : parseMap(lines, from, indent);
}

function parseMap(lines: readonly Line[], from: number, indent: number): { value: YamlValue; next: number } {
  const map: Record<string, YamlValue> = {};
  let i = from;
  while (i < lines.length && lines[i]!.indent >= indent) {
    const line = lines[i]!;
    if (line.indent > indent) throw new ComposeYamlError(`unexpected indentation on line ${line.number}: ${line.text}`);
    const match = KEY.exec(line.text);
    if (match === null) throw new ComposeYamlError(`expected a "key: value" mapping on line ${line.number}: ${line.text}`);
    const key = match[1] ?? match[2] ?? match[3]!;
    const inline = match[4];
    if (inline !== undefined && inline.trim() !== '') {
      map[key] = parseScalar(inline);
      i++;
      continue;
    }
    const child = i + 1;
    if (child < lines.length && lines[child]!.indent > indent) {
      const parsed = parseBlock(lines, child, lines[child]!.indent);
      map[key] = parsed.value;
      i = parsed.next;
    } else {
      map[key] = null;
      i = child;
    }
  }
  return { value: map, next: i };
}

function parseSequence(lines: readonly Line[], from: number, indent: number): { value: YamlValue; next: number } {
  const items: YamlValue[] = [];
  let i = from;
  while (i < lines.length && lines[i]!.indent === indent && (lines[i]!.text.startsWith('- ') || lines[i]!.text === '-')) {
    const line = lines[i]!;
    const content = line.text === '-' ? '' : line.text.slice(2).trim();
    // A sequence item that is itself a mapping (`- key: value`) may continue on the following lines, which
    // are indented to the item's content column rather than to the dash.
    if (content !== '' && KEY.exec(content) !== null) {
      const contentIndent = indent + 2;
      const synthetic: Line[] = [{ indent: contentIndent, text: content, number: line.number }];
      let j = i + 1;
      while (j < lines.length && lines[j]!.indent >= contentIndent) { synthetic.push(lines[j]!); j++; }
      items.push(parseMap(synthetic, 0, contentIndent).value);
      i = j;
      continue;
    }
    items.push(parseScalar(content));
    i++;
  }
  return { value: items, next: i };
}

/** Parse a compose file (or any file in this YAML subset) into plain JavaScript values. */
export function parseYaml(text: string): YamlMap {
  const lines = readLines(text);
  if (lines.length === 0) return {};
  const parsed = parseBlock(lines, 0, lines[0]!.indent);
  if (parsed.next !== lines.length) throw new ComposeYamlError(`unparsed content from line ${lines[parsed.next]!.number}`);
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    throw new ComposeYamlError('expected a mapping at the top level');
  }
  return parsed.value;
}

// -------------------------------------------------------------------------------------------------------
// Compose-shaped accessors
// -------------------------------------------------------------------------------------------------------

export interface ComposeMount {
  readonly source: string;
  readonly target: string;
  readonly options: readonly string[];
}

/** Every value in the document, flattened to strings — for "this stack mentions nothing of the sort" checks. */
export function yamlStrings(value: YamlValue): string[] {
  if (value === null) return [];
  if (Array.isArray(value)) return value.flatMap(yamlStrings);
  if (typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => [key, ...yamlStrings(child)]);
  return [String(value)];
}

/** Split a short-syntax mount on `:`, leaving `${VAR:-default}` interpolation intact. */
export function parseMount(entry: string): ComposeMount {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < entry.length; i++) {
    const ch = entry[i]!;
    if (ch === '$' && entry[i + 1] === '{') { depth++; current += '${'; i++; continue; }
    if (ch === '}' && depth > 0) { depth--; current += ch; continue; }
    if (ch === ':' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  if (parts.length < 2) throw new ComposeYamlError(`not a short-syntax mount: ${entry}`);
  return { source: parts[0]!, target: parts[1]!, options: parts.slice(2) };
}

export function asMap(value: YamlValue, what: string): YamlMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ComposeYamlError(`${what} is not a mapping`);
  return value;
}

export function asList(value: YamlValue, what: string): readonly YamlValue[] {
  if (!Array.isArray(value)) throw new ComposeYamlError(`${what} is not a sequence`);
  return value;
}

export function stringList(value: YamlValue, what: string): string[] {
  return asList(value, what).map((item) => {
    if (typeof item !== 'string') throw new ComposeYamlError(`${what} contains a non-string entry`);
    return item;
  });
}

export function service(doc: YamlMap, name: string): YamlMap {
  const services = asMap(doc.services ?? null, 'services');
  const found = services[name];
  if (found === undefined) throw new ComposeYamlError(`no service named ${name}`);
  return asMap(found, `service ${name}`);
}
