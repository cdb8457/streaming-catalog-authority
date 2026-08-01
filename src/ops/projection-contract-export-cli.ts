import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PROJECTION_CONTRACT_EXPORT_PATH,
  renderProjectionContractExport,
} from './projection-contract-export.js';

// Write the cross-language contract export, or check that the committed one is current.
//
//   npm run ops:projection-contract-export            # write it
//   npm run ops:projection-contract-export -- --check # exit non-zero if it is stale
//
// The check mode is what the test suite calls, so a change to a frozen contract that forgets to regenerate is
// a failing gate rather than a daemon quietly enforcing last week's deadline.

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const target = `${repositoryRoot}/${PROJECTION_CONTRACT_EXPORT_PATH}`;
const rendered = renderProjectionContractExport();
const check = process.argv.includes('--check');

if (check) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    console.error(`projection contract export is missing: ${PROJECTION_CONTRACT_EXPORT_PATH}`);
    process.exit(1);
  }
  if (current.replace(/\r\n/g, '\n') !== rendered) {
    console.error(`projection contract export is stale: ${PROJECTION_CONTRACT_EXPORT_PATH}`);
    console.error('run: npm run ops:projection-contract-export');
    process.exit(1);
  }
  console.log(`projection contract export is current (${PROJECTION_CONTRACT_EXPORT_PATH})`);
} else {
  writeFileSync(target, rendered);
  console.log(`wrote ${PROJECTION_CONTRACT_EXPORT_PATH} (${rendered.length} bytes)`);
}
