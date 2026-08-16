import { rehearse, renderRehearsal } from './usenet-rehearsal.js';
import { assertSealedSafe } from '../core/usenet/sealed.js';

// Projection Phase 9 — the provider-free mixed rehearsal, as a command.
//
// IT CONTACTS NOTHING BUT A LOOPBACK LISTENER IT STARTED ITSELF. No Usenet provider, no indexer, no TorBox,
// no operator content, no credential file, no database unless one is handed to the library form. That is what
// makes it runnable by anybody, on any host, at any time — and it is also exactly why it cannot close the
// four §5 claims that need a real provider. It says so in its own output rather than leaving a reader to
// work it out.
//
// EXIT CODES. Zero when every rehearsed step passed. One when any did. It NEVER exits zero on the strength of
// the provider-required claims, because it never emits a verdict for one.

export async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes('--json');
  if (argv.some((arg) => arg !== '--json')) {
    console.error('usage: usenet-rehearsal-cli.ts [--json]');
    return 2;
  }

  const report = await rehearse();
  assertSealedSafe(report, 'rehearsal');
  if (json) console.log(JSON.stringify(report, null, 2));
  else for (const line of renderRehearsal(report)) console.log(line);

  if (report.closureProblemsRemaining.length === 0) {
    // A REHEARSAL THAT CLOSES THE PHASE IS A BUG IN THE BOUNDARY, not a success. `phase9ClosureProblems`
    // refuses a rehearsal verdict on a provider-required claim, so an empty list here means either the
    // provider-required list was emptied or the rehearsal started stamping its verdicts as real.
    console.error('REFUSED: the provider-free rehearsal reported that nothing remains open, which cannot be '
      + 'true while §5.2, §5.3, §5.5 and §5.11 need a real Usenet provider and operator content');
    return 1;
  }
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('usenet-rehearsal-cli.ts');
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(`ERROR: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
