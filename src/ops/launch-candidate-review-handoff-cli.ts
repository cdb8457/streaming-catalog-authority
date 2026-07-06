import {
  buildLaunchCandidateReviewHandoff,
  formatLaunchCandidateReviewHandoffJson,
  formatLaunchCandidateReviewHandoffText,
} from './launch-candidate-review-handoff.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const handoff = buildLaunchCandidateReviewHandoff();

process.stdout.write(
  json
    ? formatLaunchCandidateReviewHandoffJson(handoff)
    : formatLaunchCandidateReviewHandoffText(handoff),
);
