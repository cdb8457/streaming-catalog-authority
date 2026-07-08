import {
  buildUnraidOperatorReadinessBundle,
  formatUnraidOperatorReadinessBundleJson,
  formatUnraidOperatorReadinessBundleText,
} from './unraid-operator-readiness-bundle.js';

const packet = buildUnraidOperatorReadinessBundle();
process.stdout.write(process.argv.includes('--json')
  ? formatUnraidOperatorReadinessBundleJson(packet)
  : formatUnraidOperatorReadinessBundleText(packet));
