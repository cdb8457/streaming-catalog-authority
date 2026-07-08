import {
  buildUnraidInstallEvidenceManifest,
  formatUnraidInstallEvidenceManifestJson,
  formatUnraidInstallEvidenceManifestText,
} from './unraid-install-evidence-manifest.js';

const packet = buildUnraidInstallEvidenceManifest();
process.stdout.write(process.argv.includes('--json')
  ? formatUnraidInstallEvidenceManifestJson(packet)
  : formatUnraidInstallEvidenceManifestText(packet));
