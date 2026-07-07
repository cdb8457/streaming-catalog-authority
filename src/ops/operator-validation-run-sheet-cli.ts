import {
  buildOperatorValidationRunSheet,
  formatOperatorValidationRunSheetJson,
  formatOperatorValidationRunSheetText,
} from './operator-validation-run-sheet.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const sheet = buildOperatorValidationRunSheet();

process.stdout.write(
  json
    ? formatOperatorValidationRunSheetJson(sheet)
    : formatOperatorValidationRunSheetText(sheet),
);
