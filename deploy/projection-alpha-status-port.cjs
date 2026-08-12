// The status port, read out of the operator's OWN configuration rather than guessed.
//
// IT IS A FILE RATHER THAN AN INLINE `node -e`, and that is a rule with a test behind it:
// `test/custody-runtime-closure.ts` parses every shipped script under all three line endings and refuses one
// whose quotes do not close. A multi-line program inside a single-quoted shell argument is exactly the shape
// that breaks, and an unreadable line is not an empty one.
//
// IT PRINTS A PORT OR NOTHING. An unreadable configuration prints the empty string, so the caller fails on a
// non-value instead of proceeding on a default.
const { readFileSync } = require('node:fs');
try {
  const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const addr = typeof cfg.statusAddr === 'string' ? cfg.statusAddr : '';
  const port = addr.includes(':') ? addr.slice(addr.lastIndexOf(':') + 1) : '';
  console.log(/^[0-9]+$/.test(port) ? port : '');
} catch {
  console.log('');
}
