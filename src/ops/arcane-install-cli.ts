import {
  ARCANE_BIND_ADDRESS_ENV,
  ARCANE_PROJECT_DIR_ENV,
  checkArcaneInstall,
} from './arcane-install.js';

/**
 * Phase 253 — Arcane/Unraid install preflight.
 *
 *   npm run ops:arcane-preflight
 *   npm run ops:arcane-preflight -- --json
 *   npm run ops:arcane-preflight -- --no-filesystem     structural checks only, from any machine
 *
 * Answers one question before `docker compose -f docker-compose.arcane.yml up -d` is worth trying: will this
 * stack's bind sources resolve on the machine the Docker daemon is actually running on, and is the operator
 * UI published where the operator meant. Exits non-zero on any BLOCKER.
 *
 * It reads the environment and stats a fixed set of paths. It starts nothing, writes nothing, contacts no
 * provider, media server or library, and reads no promotion record.
 */
const args = process.argv.slice(2);
const json = args.includes('--json');
const checkFilesystem = !args.includes('--no-filesystem');

const result = checkArcaneInstall(process.env, { checkFilesystem });

if (json) {
  console.log(JSON.stringify(result));
} else {
  console.log('Catalog Authority — Arcane/Unraid install preflight\n');
  // The operator's own values, echoed back to the operator who just typed them, in their own terminal. This
  // is the one surface where showing them is the point: "you set it to THIS" is most of the diagnosis. They
  // reach no log buffer, no page and no report.
  console.log(`  ${ARCANE_PROJECT_DIR_ENV}   ${process.env[ARCANE_PROJECT_DIR_ENV] ?? '(not set)'}`);
  console.log(`  ${ARCANE_BIND_ADDRESS_ENV}     ${process.env[ARCANE_BIND_ADDRESS_ENV] ?? '(not set)'}`);
  if (!checkFilesystem) console.log('\n  (structural checks only — the filesystem was not inspected)');
  console.log('');
  if (result.findings.length === 0) {
    console.log('  OK — nothing to fix.');
  } else {
    for (const item of result.findings) {
      console.log(`  ${item.severity.padEnd(9)} ${item.code}`);
      console.log(`            ${item.detail}`);
      console.log(`            Do: ${item.fix}\n`);
    }
  }
  console.log(`\n${result.ok ? 'arcane preflight: PASS' : 'arcane preflight: BLOCKED'}`);
  console.log(`\n${result.note}`);
}

process.exit(result.ok ? 0 : 1);
