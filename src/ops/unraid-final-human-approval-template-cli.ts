import {
  buildUnraidFinalHumanApprovalTemplate,
  formatUnraidFinalHumanApprovalTemplateJson,
  formatUnraidFinalHumanApprovalTemplateText,
} from './unraid-final-human-approval-template.js';

const packet = buildUnraidFinalHumanApprovalTemplate();
process.stdout.write(process.argv.includes('--json')
  ? formatUnraidFinalHumanApprovalTemplateJson(packet)
  : formatUnraidFinalHumanApprovalTemplateText(packet));
