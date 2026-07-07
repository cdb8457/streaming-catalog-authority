import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  buildO4O5EvidenceDecisionInputErrorReport,
  buildO4O5EvidenceDecisionPacket,
  formatO4O5EvidenceDecisionJson,
  formatO4O5EvidenceDecisionText,
  o4O5EvidenceDecisionHasFailures,
  parseO4O5CustodianDescriptorJson,
  parseO4O5ImplementationDecisionJson,
  parseO4O5KekDescriptorJson,
  type O4O5EvidenceDecisionInputErrorCode,
} from './o4-o5-evidence-decision.js';

const MAX_DESCRIPTOR_BYTES = 64 * 1024;

type ReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: O4O5EvidenceDecisionInputErrorCode };

interface ParsedArgs {
  readonly decisionPath: string;
  readonly custodianPath: string;
  readonly kekPath: string;
  readonly asJson: boolean;
}

function usage(): string {
  return [
    'usage: ops:o4-o5-evidence-decision -- --decision <decision.json> --custodian <o4-descriptor.json> --kek <o5-descriptor.json> [--json]',
    '',
    'LOCAL PREFLIGHT ONLY. Reads three operator-supplied JSON files and emits a redaction-safe packet.',
    'No env read, DB read, network call, live service contact, key access, KEK mutation, provider behavior, or UI exposure.',
  ].join('\n');
}

function main(): number {
  const parsed = parseArgs(process.argv.slice(2).filter((arg) => arg !== '--'));
  if (parsed === undefined) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  const decisionInput = readBoundedFile(parsed.decisionPath, 'decision');
  if (!decisionInput.ok) return writeReport(buildO4O5EvidenceDecisionInputErrorReport(decisionInput.code), parsed.asJson);
  const decision = parseO4O5ImplementationDecisionJson(decisionInput.text);
  if (typeof decision === 'string') return writeReport(buildO4O5EvidenceDecisionInputErrorReport(decision), parsed.asJson);

  const custodianInput = readBoundedFile(parsed.custodianPath, 'custodian');
  if (!custodianInput.ok) return writeReport(buildO4O5EvidenceDecisionInputErrorReport(custodianInput.code), parsed.asJson);
  const custodianDescriptor = parseO4O5CustodianDescriptorJson(custodianInput.text);

  const kekInput = readBoundedFile(parsed.kekPath, 'kek');
  if (!kekInput.ok) return writeReport(buildO4O5EvidenceDecisionInputErrorReport(kekInput.code), parsed.asJson);
  const kekDescriptor = parseO4O5KekDescriptorJson(kekInput.text);

  return writeReport(buildO4O5EvidenceDecisionPacket(decision, custodianDescriptor, kekDescriptor), parsed.asJson);
}

function parseArgs(args: readonly string[]): ParsedArgs | undefined {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  let decisionPath: string | undefined;
  let custodianPath: string | undefined;
  let kekPath: string | undefined;
  let asJson = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      asJson = true;
      continue;
    }
    if (arg === '--decision') {
      decisionPath = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--custodian') {
      custodianPath = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--kek') {
      kekPath = args[index + 1];
      index += 1;
      continue;
    }
    return undefined;
  }

  if (!decisionPath || !custodianPath || !kekPath) return undefined;
  return { decisionPath, custodianPath, kekPath, asJson };
}

function readBoundedFile(path: string, kind: 'decision' | 'custodian' | 'kek'): ReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: readFailedCode(kind) };
    if (stat.size > MAX_DESCRIPTOR_BYTES) return { ok: false, code: tooLargeCode(kind) };
    const buffer = Buffer.alloc(stat.size);
    const bytesRead = readSync(fd, buffer, 0, stat.size, 0);
    return { ok: true, text: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch {
    return { ok: false, code: readFailedCode(kind) };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The report path is already redaction-safe.
      }
    }
  }
}

function readFailedCode(kind: 'decision' | 'custodian' | 'kek'): O4O5EvidenceDecisionInputErrorCode {
  if (kind === 'custodian') return 'CUSTODIAN_DESCRIPTOR_FILE_READ_FAILED';
  if (kind === 'kek') return 'KEK_DESCRIPTOR_FILE_READ_FAILED';
  return 'DECISION_FILE_READ_FAILED';
}

function tooLargeCode(kind: 'decision' | 'custodian' | 'kek'): O4O5EvidenceDecisionInputErrorCode {
  if (kind === 'custodian') return 'CUSTODIAN_DESCRIPTOR_FILE_TOO_LARGE';
  if (kind === 'kek') return 'KEK_DESCRIPTOR_FILE_TOO_LARGE';
  return 'DECISION_FILE_TOO_LARGE';
}

function writeReport(report: Parameters<typeof formatO4O5EvidenceDecisionJson>[0], asJson: boolean): number {
  process.stdout.write(asJson ? formatO4O5EvidenceDecisionJson(report) : formatO4O5EvidenceDecisionText(report));
  return o4O5EvidenceDecisionHasFailures(report) ? 1 : 0;
}

process.exit(main());

