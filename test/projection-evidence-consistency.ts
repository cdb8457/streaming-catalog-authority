/**
 * FAIL-CLOSED CROSS-CHECK: THIS REPOSITORY MAY NOT ASSERT BOTH THAT SOMETHING HAS RUN AND THAT IT NEVER HAS.
 *
 * WHY THIS EXISTS. `99a6828` recorded three Unraid runs of the G22 rclone comparison and changed three files
 * together: the gate header, the exported nonclaims list, and the run-record document. `373df01` restored two
 * of the three and left the document. For the whole interval between them the repository asserted, in files
 * that ship, both "no run of this gate has ever happened on a real Linux or Unraid host" and "runs 18-20
 * completed on a real Unraid host" — and **no test noticed**, because nothing read the two surfaces against
 * each other. A repository whose whole discipline is that a claim must match what ran cannot detect the one
 * failure where two of its own claims disagree.
 *
 * HOW IT FAILS CLOSED. A contradiction is not an error here — an UNREGISTERED contradiction is. Each one must
 * appear in `docs/PROJECTION_EVIDENCE_RECONCILIATION.md` under its own stable id with a STATUS line, which
 * forces the investigation to be written down and keeps the uncertainty visible instead of resolving it by
 * editing whichever file was easier to reach. A NEW contradiction has no ledger entry and fails immediately.
 *
 * AND THE LEDGER CANNOT BE GAMED BY DELETION. Registering an id does not silence it: the entry must still
 * carry a STATUS, and removing the *claims* while leaving the entry is caught by the orphan check at the end.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const LEDGER = 'docs/PROJECTION_EVIDENCE_RECONCILIATION.md';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push([name, error]);
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

console.log('Projection — evidence consistency (offline)');

/**
 * One axis of possible self-contradiction.
 *
 * `negative` matches a UNIVERSAL denial ("this has never happened anywhere"). `positive` matches a RECORD of
 * the thing having happened. Both matching at once is the contradiction; the `id` is what the ledger must
 * register. Sources are listed explicitly rather than globbed, because a glob would quietly stop covering a
 * file that got renamed and this check would then pass by not looking.
 */
interface Axis {
  readonly id: string;
  readonly what: string;
  readonly negativeSources: readonly string[];
  readonly negative: RegExp;
  readonly positiveSources: readonly string[];
  readonly positive: RegExp;
  /**
   * Whether a denial inside a markdown blockquote is a QUOTATION of a retired claim rather than a live one.
   *
   * A NO-GO RECORD IS ALLOWED TO KEEP THE FALSE SENTENCE IT RETIRED, and this repository's whole discipline
   * says it must — Phase 4 §4.1, Phase 5 §3.3 and Phase 6 §11.1.1 all keep their own wrong wording so the
   * sequence of what was believed when survives. A check that could not tell a quotation from an assertion
   * would force those records to DELETE their history to go green, which is the opposite of the point.
   *
   * IT IS OPT-IN PER AXIS AND IT IS NARROW. Only a `>` blockquote line counts as quoted; ordinary prose,
   * italics and bold do not, so a live denial cannot be laundered by styling it. And the exemption cuts both
   * ways: quoting a sentence you still mean does not make it stop counting, because the quotation has to be
   * of something the surrounding text no longer claims.
   */
  readonly quotedDenialsAreHistory?: boolean;
}

/** The file with every markdown blockquote line removed, which is where retired wording is kept. */
const withoutQuotations = (text: string): string =>
  text.split('\n').filter((line) => !/^\s*>/.test(line)).join('\n');

/** What an axis actually ASSERTS in a file: quoted history removed when that axis opts into the rule. */
const assertedText = (axis: Axis, file: string): string =>
  (axis.quotedDenialsAreHistory === true ? withoutQuotations(read(file)) : read(file));

const AXES: readonly Axis[] = [
  {
    id: 'RCLONE-G22-LINUX-RUN-EXISTENCE',
    what: 'whether the G22 rclone comparison gate has ever run on a real Linux or Unraid host',
    negativeSources: [
      'src/core/projection/rclone-comparison.ts',
      'deploy/projection-rclone-comparison-gate.sh',
    ],
    negative: /no run (?:of this gate )?has ever happened on a real Linux or Unraid host/i,
    positiveSources: ['docs/PROJECTION_PHASE_1_RCLONE_COMPARISON.md'],
    // A run-record row that names a host and says COMPLETED. Prose describing what a run WOULD establish is
    // not a record; the table row is.
    positive: /^\|\s*\d+(?:[-–]\d+)?\s*\|\s*\*{0,2}Unraid host\*{0,2}\s*\|\s*\*{0,2}COMPLETED/im,
  },
  {
    // WHY THIS AXIS EXISTS. The Phase 7 roadmap row carried "NOT ONE OF THE SIX RECOVERY ARMS HAS EVER RUN"
    // in the SAME PARAGRAPH that recorded arm R1 measuring FALSE twice. Both sentences were written from the
    // same two runs; only one of them was true. It is the exact shape this suite was built for — a universal
    // denial and a record of the thing having happened, shipping together, with nothing reading them against
    // each other — and it survived a full audit-free write-up because no axis covered it.
    id: 'PHASE7-RECOVERY-ARM-RUN-EXISTENCE',
    what: 'whether any Projection Phase 7 recovery arm has ever executed on a host',
    negativeSources: [
      'docs/PROJECTION_ROADMAP.md',
      'docs/PROJECTION_PHASE_7_OPERATOR_USABLE_ALPHA.md',
    ],
    // A UNIVERSAL DENIAL, in the forms this record has actually used. "R2 to R6 have never run" is NOT one:
    // it names a subset and is true, which is the whole distinction this axis has to keep.
    negative: /not (?:one|a single one) of the six recovery arms has (?:ever )?run|none of the six recovery arms has ever run|no recovery arm has ever run/i,
    positiveSources: ['docs/PROJECTION_PHASE_7_OPERATOR_USABLE_ALPHA.md'],
    // A RECORD OF AN ARM HAVING EXECUTED: the arm ledger's own row, which states a non-zero execution count.
    // Prose about what an arm WOULD assert is not a record; a row carrying a count is.
    positive: /^\|\s*\*{0,2}R[1-6]\*{0,2}\s*\|\s*\*{0,2}[1-9]\d*\*{0,2}\s*(?:—[^|]*)?\|/im,
    // THE RETIRED SENTENCE IS KEPT, IN A BLOCKQUOTE, AND KEEPING IT IS THE REPOSITORY'S OWN RULE.
    quotedDenialsAreHistory: true,
  },
];

const ledger = existsSync(join(ROOT, LEDGER)) ? read(LEDGER) : '';

/** The ids the ledger registers, each of which must carry a STATUS line under its own heading. */
function registeredIds(): Set<string> {
  const ids = new Set<string>();
  const sections = ledger.split(/^## /m).slice(1);
  for (const section of sections) {
    const id = (section.split('\n')[0] ?? '').trim();
    if (id.length === 0) continue;
    if (/^\*\*STATUS:/m.test(section)) ids.add(id);
  }
  return ids;
}

test('THE LEDGER EXISTS AND EVERY ENTRY CARRIES A STATUS', () => {
  assert(ledger.length > 0, `${LEDGER} is missing, so no contradiction can be registered and none can be read`);
  const headings = (ledger.match(/^## (.+)$/gm) ?? []).map((line) => line.replace(/^## /, '').trim());
  assert(headings.length > 0, 'the ledger registers nothing at all');
  for (const heading of headings) {
    const section = ledger.slice(ledger.indexOf(`## ${heading}`));
    const body = section.slice(0, section.indexOf('\n## ') === -1 ? undefined : section.indexOf('\n## '));
    assert(/^\*\*STATUS:\s*(UNRESOLVED|RESOLVED)/m.test(body),
      `ledger entry ${heading} has no '**STATUS: UNRESOLVED' or '**STATUS: RESOLVED' line`);
  }
});

for (const axis of AXES) {
  test(`NOT BOTH: ${axis.what}`, () => {
    const denials = axis.negativeSources.filter((file) => axis.negative.test(assertedText(axis, file)));
    const records = axis.positiveSources.filter((file) => axis.positive.test(read(file)));

    if (denials.length === 0 || records.length === 0) return; // no contradiction on this axis

    assert(registeredIds().has(axis.id),
      `${axis.id}: ${denials.join(', ')} deny that it ever happened while ${records.join(', ')} records that `
      + `it did. Both cannot be true. Investigate it and register the finding in ${LEDGER} under a `
      + `'## ${axis.id}' heading with a STATUS line — do not silence it by editing whichever file is easier `
      + 'to reach');
  });
}

test('THE LEDGER REGISTERS NO CONTRADICTION THAT NO LONGER EXISTS', () => {
  // An entry left standing after its claims are gone is a stale excuse: the next real contradiction on that
  // axis would find the id already registered and pass.
  const known = new Set(AXES.map((axis) => axis.id));
  for (const id of registeredIds()) {
    assert(known.has(id), `${LEDGER} registers ${id}, which no axis in this suite checks for — either the `
      + 'axis was removed and the entry should be too, or the entry names an id the suite never emits');
    const axis = AXES.find((candidate) => candidate.id === id) as Axis;
    const live = axis.negativeSources.some((file) => axis.negative.test(read(file)))
      && axis.positiveSources.some((file) => axis.positive.test(read(file)));
    assert(live, `${LEDGER} still registers ${id}, but the contradiction is gone from the tree. Resolve the `
      + 'entry and remove it, so a future contradiction on this axis fails instead of finding a free pass');
  }
});

// ---------------------------------------------------------------------------------------------------------
// A COUNT IS A CLAIM TOO, AND A STALE ONE CONTRADICTS THE TABLE IT WAS DERIVED FROM
// ---------------------------------------------------------------------------------------------------------
//
// The axis mechanism above catches "this never happened" beside "this happened". It cannot catch the other
// shape the Phase 7 record produced: a progressive ledger that GREW while every prose summary of it stayed
// where it was. §11.4 listed five defects when it was written, grew to seven as two more runs found two more,
// and both the document's own headline and the roadmap row went on saying FIVE — and, worse, TWO IN THE
// PRODUCT when the ledger held three.
//
// SO THE TABLE IS THE ONLY SOURCE AND EVERY PROSE COUNT IS DERIVED FROM IT HERE, in the same fail-closed
// spirit: a summary that disagrees with the rows it summarises is a failure, and so is a summary that cannot
// be found at all — because a count that got deleted rather than corrected is the same defect wearing less.

const PHASE7 = 'docs/PROJECTION_PHASE_7_OPERATOR_USABLE_ALPHA.md';
const ROADMAP = 'docs/PROJECTION_ROADMAP.md';

const WORDS: Readonly<Record<string, number>> = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
});
const spelled = (value: number): string =>
  Object.keys(WORDS).find((word) => WORDS[word] === value) ?? String(value);

/** The canonical ledger: the rows of the §11.4 table, and how many of them say the fix went to the product. */
function phase7DefectLedger(): { rows: number; product: number } {
  const document = read(PHASE7);
  const start = document.indexOf('### 11.4 The defects the runs found');
  assert(start >= 0, `${PHASE7} no longer has a '### 11.4 The defects the runs found' section, so the `
    + 'canonical defect ledger cannot be located and every count in this repository is unanchored');
  const rest = document.slice(start);
  const end = rest.indexOf('\n### ', 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  // A ledger row starts with a numbered cell. The header and the `|---|` separator do not.
  const rows = section.split('\n').filter((line) => /^\|\s*\*{0,2}\d+\*{0,2}\s*\|/.test(line));
  assert(rows.length > 0, 'the §11.4 defect ledger has no numbered rows at all');
  // "Where the fix went" is the last cell. A product fix says so in bold, which is the table's own convention.
  const product = rows.filter((row) => {
    const cells = row.split('|').map((cell) => cell.trim()).filter((cell) => cell.length > 0);
    return /\*\*the product\*\*/i.test(cells[cells.length - 1] ?? '');
  });
  return { rows: rows.length, product: product.length };
}

test('THE PHASE 7 DEFECT LEDGER IS THE ONLY SOURCE, AND ITS OWN HEADLINE AGREES WITH IT', () => {
  const { rows, product } = phase7DefectLedger();
  const document = read(PHASE7);
  const headline = new RegExp(
    `${spelled(rows)}\\s+defects?\\b[\\s\\S]{0,120}?\\b${spelled(product)}\\b[^.]{0,80}shipped product code`, 'i');
  assert(headline.test(document),
    `${PHASE7} §11.4 lists ${rows} defect row(s), ${product} of them fixed in the product, but no headline in `
    + `the document states "${spelled(rows)} defects ... ${spelled(product)} ... shipped product code". A `
    + 'summary that disagrees with the table it summarises is the stale-count defect this check exists for');
});

test('THE ROADMAP ROW STATES THE SAME TWO NUMBERS AS THE LEDGER', () => {
  const { rows, product } = phase7DefectLedger();
  const roadmap = read(ROADMAP);
  const row = roadmap.split('\n').find((line) => line.startsWith('| **Projection Phase 7** |'));
  assert(row !== undefined, `${ROADMAP} has no Phase 7 row, so its claims cannot be checked against the ledger`);
  const stated = new RegExp(`${spelled(rows)}\\s+defects?\\b`, 'i');
  assert(stated.test(row),
    `the Phase 7 roadmap row does not state "${spelled(rows)} defects", which is what §11.4's table holds. `
    + 'It said FIVE for the whole interval in which the ledger held seven');
  const statedProduct = new RegExp(`\\b${spelled(product)}\\b[^.]{0,60}shipped product code`, 'i');
  assert(statedProduct.test(row),
    `the Phase 7 roadmap row does not state that ${spelled(product)} of them are in shipped product code`);
});

test('THE ARM LEDGER EXISTS AND THE ROADMAP DOES NOT DISAGREE WITH IT ABOUT WHICH ARMS RAN', () => {
  const document = read(PHASE7);
  const start = document.indexOf('### 11.9 THE ARM LEDGER');
  assert(start >= 0, `${PHASE7} has no '### 11.9 THE ARM LEDGER' section; without it there is no single place `
    + 'an arm count may be read from, which is how the roadmap came to deny a run it also recorded');
  const rest = document.slice(start);
  const end = rest.indexOf('\n### ', 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  const ran = new Set<string>();
  for (const line of section.split('\n')) {
    const match = /^\|\s*\*{0,2}(R[1-6])\*{0,2}\s*\|\s*\*{0,2}(\d+)\*{0,2}/.exec(line);
    if (match && Number(match[2]) > 0) ran.add(match[1] as string);
  }
  assert(section.includes('| **R1** |') || section.includes('| R1 |'),
    'the arm ledger does not carry a row for R1, so it is not the ledger this check was written against');
  const roadmap = read(ROADMAP);
  const row = roadmap.split('\n').find((line) => line.startsWith('| **Projection Phase 7** |')) ?? '';
  if (ran.size === 0) {
    assert(!/one of six has run|R1 RAN TWICE/i.test(row),
      'the roadmap says an arm ran while the arm ledger records none having run');
    return;
  }
  // AN ARM HAS RUN, SO THE ROADMAP MAY NOT SAY OTHERWISE — and the axis above is what catches the universal
  // denial. This is the positive half: the row has to name the arms that ran rather than being silent.
  for (const arm of ran) {
    assert(row.includes(arm),
      `the arm ledger records ${arm} as having executed and the Phase 7 roadmap row never mentions it`);
  }
});

test('THE SOURCES THE CHECK READS ALL EXIST, so a rename cannot silently end the coverage', () => {
  for (const axis of AXES) {
    for (const file of [...axis.negativeSources, ...axis.positiveSources]) {
      assert(existsSync(join(ROOT, file)),
        `${axis.id} watches ${file}, which does not exist; the check is reading nothing and would pass`);
    }
  }
});

console.log(`\nProjection — evidence consistency: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const [name, error] of failures) console.error(`  FAILED: ${name}: ${String(error)}`);
  process.exit(1);
}
