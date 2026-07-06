import {
  buildFinalLaunchDisposition,
  formatFinalLaunchDispositionJson,
  formatFinalLaunchDispositionText,
} from './final-launch-disposition.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const disposition = buildFinalLaunchDisposition();

process.stdout.write(
  json
    ? formatFinalLaunchDispositionJson(disposition)
    : formatFinalLaunchDispositionText(disposition),
);
