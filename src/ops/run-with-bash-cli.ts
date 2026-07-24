import { spawnSync } from 'node:child_process';

import { NO_USABLE_BASH, usableBash } from './usable-shell.js';

// Run one of this repository's shipped shell steps with a bash that can actually run it.
//
// `"release:bundle-check": "bash deploy/ci/..."` was correct on the CI runner and wrong on the machine of
// anyone developing on Windows: npm hands the script line to cmd.exe, `bash` resolves to the WSL launcher,
// and the whole check then runs inside a Linux distro against a win32 `node_modules` — reported to the
// operator as a broken esbuild install rather than as the wrong shell. See src/ops/usable-shell.ts.
//
// stdio is inherited on purpose: this is a build step a person watches, not a probe. It is the caller's
// terminal that bounds it, and the child's exit code is passed through unchanged so `npm run` still fails.

function main(): number {
  const [script, ...rest] = process.argv.slice(2);
  if (script === undefined || script === '--help') {
    console.log('usage: run-with-bash <script.sh> [args...]');
    return script === undefined ? 2 : 0;
  }

  const shell = usableBash();
  if (shell === null) {
    console.error(`FAIL: ${NO_USABLE_BASH}`);
    console.error(`      (wanted to run: ${script})`);
    return 1;
  }

  const run = spawnSync(shell.command, [...shell.args(script.replace(/\\/g, '/')), ...rest],
    { stdio: 'inherit', windowsHide: true });
  if (run.error !== undefined) {
    console.error(`FAIL: ${shell.command} could not run ${script}: ${run.error.message}`);
    return 1;
  }
  if (run.signal !== null) {
    console.error(`FAIL: ${script} was killed by ${run.signal}`);
    return 1;
  }
  return run.status ?? 1;
}

process.exit(main());
