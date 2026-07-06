import {
  buildLaunchCandidateReviewChecklist,
  formatLaunchCandidateReviewChecklistJson,
  formatLaunchCandidateReviewChecklistText,
} from './launch-candidate-review-checklist.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const checklist = buildLaunchCandidateReviewChecklist();

process.stdout.write(
  json
    ? formatLaunchCandidateReviewChecklistJson(checklist)
    : formatLaunchCandidateReviewChecklistText(checklist),
);
