import {
  buildUnraidSwitchEvidenceCapturePacket,
  formatUnraidSwitchEvidenceCaptureJson,
  formatUnraidSwitchEvidenceCaptureText,
} from './unraid-switch-evidence-capture.js';

const packet = buildUnraidSwitchEvidenceCapturePacket();
process.stdout.write(process.argv.includes('--json')
  ? formatUnraidSwitchEvidenceCaptureJson(packet)
  : formatUnraidSwitchEvidenceCaptureText(packet));
