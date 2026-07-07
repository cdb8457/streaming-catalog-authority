import {
  buildSidecarUnraidReviewHandoff,
  formatSidecarUnraidReviewHandoffJson,
  formatSidecarUnraidReviewHandoffText,
} from './sidecar-unraid-review-handoff.js';

const handoff = buildSidecarUnraidReviewHandoff();
process.stdout.write(process.argv.includes('--json')
  ? formatSidecarUnraidReviewHandoffJson(handoff)
  : formatSidecarUnraidReviewHandoffText(handoff));
