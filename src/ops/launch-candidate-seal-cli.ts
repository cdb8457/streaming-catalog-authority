import {
  buildLaunchCandidateSeal,
  formatLaunchCandidateSealJson,
  formatLaunchCandidateSealText,
} from './launch-candidate-seal.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const seal = buildLaunchCandidateSeal();

process.stdout.write(
  json
    ? formatLaunchCandidateSealJson(seal)
    : formatLaunchCandidateSealText(seal),
);
