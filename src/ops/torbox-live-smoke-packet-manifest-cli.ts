import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  buildTorBoxLiveSmokePacketManifestInputErrorReport,
  buildTorBoxLiveSmokePacketManifestReport,
  formatTorBoxLiveSmokePacketManifestJson,
  formatTorBoxLiveSmokePacketManifestText,
  parseTorBoxLiveSmokePacketManifestJson,
  torBoxLiveSmokePacketManifestHasFailures,
  type TorBoxLiveSmokePacketManifestInputErrorCode,
} from './torbox-live-smoke-packet-manifest.js';

const MAX_MANIFEST_BYTES = 64 * 1024;

type ManifestFileReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: TorBoxLiveSmokePacketManifestInputErrorCode };

/**
 * Phase 53 - TorBox live smoke packet manifest preflight.
 *
 * LOCAL REVIEW PREP ONLY. Reads one explicit operator-supplied manifest JSON file and emits fixed,
 * redaction-safe readiness labels. It does not scan directories, read artifact contents, echo paths,
 * read env values, read credentials, call TorBox, construct transports, or close review.
 */
function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:torbox-live-smoke-packet-manifest -- <packet-manifest.json> [--json]');
    return 0;
  }

  const normalized = args.filter((arg) => arg !== '--');
  const asJson = normalized.includes('--json');
  const unsupported = normalized.filter((arg) => arg.startsWith('-') && arg !== '--json');
  const paths = normalized.filter((arg) => !arg.startsWith('-'));
  if (unsupported.length > 0 || paths.length > 1) {
    console.error('usage: ops:torbox-live-smoke-packet-manifest -- <packet-manifest.json> [--json]');
    return 2;
  }

  let report = paths.length === 0
    ? buildTorBoxLiveSmokePacketManifestInputErrorReport('PACKET_MANIFEST_INPUT_REQUIRED')
    : null;

  if (report === null) {
    const input = readManifestFile(paths[0] ?? '');
    if (!input.ok) {
      report = buildTorBoxLiveSmokePacketManifestInputErrorReport(input.code);
    } else {
      const parsed = parseTorBoxLiveSmokePacketManifestJson(input.text);
      report = typeof parsed === 'string'
        ? buildTorBoxLiveSmokePacketManifestInputErrorReport(parsed)
        : buildTorBoxLiveSmokePacketManifestReport(parsed);
    }
  }

  process.stdout.write(asJson ? formatTorBoxLiveSmokePacketManifestJson(report) : formatTorBoxLiveSmokePacketManifestText(report));
  return torBoxLiveSmokePacketManifestHasFailures(report) ? 1 : 0;
}

function readManifestFile(path: string): ManifestFileReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: 'PACKET_MANIFEST_FILE_READ_FAILED' };
    if (stat.size > MAX_MANIFEST_BYTES) return { ok: false, code: 'PACKET_MANIFEST_FILE_TOO_LARGE' };

    const buffer = Buffer.alloc(stat.size);
    const bytesRead = readSync(fd, buffer, 0, stat.size, 0);
    return { ok: true, text: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch {
    return { ok: false, code: 'PACKET_MANIFEST_FILE_READ_FAILED' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preflight output remains fixed and redaction-safe.
      }
    }
  }
}

process.exit(main());
