import {
  buildOperatorUiAuthPacketAcceptanceReport,
  formatOperatorUiAuthPacketAcceptanceText,
} from './operator-ui-auth-packet-acceptance.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    process.exitCode = 1;
    process.stderr.write('Operator UI auth packet acceptance accepts only --json.\n');
    return;
  }

  const report = await buildOperatorUiAuthPacketAcceptanceReport();
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatOperatorUiAuthPacketAcceptanceText(report));
}

void main();
