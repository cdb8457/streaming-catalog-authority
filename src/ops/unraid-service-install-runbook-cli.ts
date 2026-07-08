import {
  buildUnraidServiceInstallRunbook,
  formatUnraidServiceInstallRunbookJson,
  formatUnraidServiceInstallRunbookText,
} from './unraid-service-install-runbook.js';

const packet = buildUnraidServiceInstallRunbook();
process.stdout.write(process.argv.includes('--json')
  ? formatUnraidServiceInstallRunbookJson(packet)
  : formatUnraidServiceInstallRunbookText(packet));
