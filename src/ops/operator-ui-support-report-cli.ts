import { resolvePromotionRecordsDir, PromotionRecordsConfigError } from './operator-ui-promotion-chain.js';
import {
  buildSupportReport,
  renderSupportReportJson,
  renderSupportReportText,
  SupportReportRedactionError,
} from './operator-ui-support-report.js';

// Phase 246 — `npm run ops:support-report`, the thing to run before opening an issue.
//
// It is a CLI rather than only a page because the situations worth reporting are the ones where the page is
// not up: the container will not start, the port is taken, the token is lost. Nothing here needs the server
// to be running, and nothing here contacts the database.
//
// `--generated-at` exists so the same installation renders byte-identical output twice, which is what lets a
// test assert the whole report rather than a few fields of it.

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('usage: ops:support-report [--text] [--generated-at <iso-8601>]');
    console.log('');
    console.log('Prints a redaction-safe diagnostics report for attaching to an issue. Makes no live calls:');
    console.log('the database is not contacted and nothing is fetched. Contains no tokens, secret values,');
    console.log('file paths, URLs, record contents or host-identifying data.');
    return 0;
  }

  let promotionRecordsDir: string;
  try {
    promotionRecordsDir = resolvePromotionRecordsDir();
  } catch (err) {
    if (!(err instanceof PromotionRecordsConfigError)) throw err;
    // The rejected value is not echoed — it is operator input, and this stack does not reflect that anywhere.
    console.error('FAIL: the configured promotion records directory was rejected as unsafe.');
    return 1;
  }

  const generatedAt = valueAfter(args, '--generated-at') ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(generatedAt))) {
    console.error('FAIL: --generated-at must be an ISO-8601 timestamp.');
    return 2;
  }

  const report = buildSupportReport({ promotionRecordsDir, generatedAt });
  try {
    console.log(args.includes('--text') ? renderSupportReportText(report) : renderSupportReportJson(report));
  } catch (err) {
    if (!(err instanceof SupportReportRedactionError)) throw err;
    // Printing nothing is the correct failure. A report that might contain a secret is worth less than none.
    console.error(`FAIL: ${err.message}. Nothing was printed.`);
    return 3;
  }
  return 0;
}

process.exit(main());
