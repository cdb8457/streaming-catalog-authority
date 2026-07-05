import {
  buildOperatorUiStaticArtifact,
  describeOperatorUiStaticArtifact,
  OperatorUiStaticArtifactError,
} from './operator-ui-static-artifact.js';

function main(): void {
  try {
    const artifact = buildOperatorUiStaticArtifact();
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(describeOperatorUiStaticArtifact(artifact), null, 2)}\n`);
      return;
    }

    process.stdout.write(artifact.html);
  } catch (err) {
    process.exitCode = 1;
    if (err instanceof OperatorUiStaticArtifactError) {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        code: err.code,
        message: err.message,
        inspection: err.inspection,
      })}\n`);
      return;
    }

    process.stderr.write('Operator UI static artifact failed.\n');
  }
}

main();
