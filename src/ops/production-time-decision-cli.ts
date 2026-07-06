import {
  buildProductionTimeDecision,
  formatProductionTimeDecisionJson,
  formatProductionTimeDecisionText,
} from './production-time-decision.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const decision = buildProductionTimeDecision();

process.stdout.write(
  json
    ? formatProductionTimeDecisionJson(decision)
    : formatProductionTimeDecisionText(decision),
);
