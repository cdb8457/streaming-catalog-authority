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
}

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
    const denials = axis.negativeSources.filter((file) => axis.negative.test(read(file)));
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
