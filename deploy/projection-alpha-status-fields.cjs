// The operator status surface's field filter.
//
// A FIXED LIST, AND ANYTHING NOT ON IT IS NOT PRINTED. The readiness document carries one free-text field
// (`serveError`, which predates Phase 5 and is named in its §3.2), and a status command that printed whatever
// the document happened to hold would carry it — along with every field a later tranche adds. So the surface
// names what it shows, and a new field reaches an operator only when somebody puts it here on purpose.
//
// EVERY ENTRY BELOW IS A CLOSED-SET CODE OR A NUMBER. This output is meant to be pasteable into an issue.
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let doc;
  try {
    doc = JSON.parse(raw).status ?? {};
  } catch {
    return;
  }
  const show = [
    ['mount observed', 'mountObserved'],
    ['mount observed age', 'mountObservedAgeMs'],
    ['recovery state', 'recoveryState'],
    ['recovery reason', 'recoveryReason'],
    ['recovery attempts', 'recoveryAttempts'],
    ['recovery generation', 'recoveryGeneration'],
    ['recovery outcome', 'recoveryLastOutcome'],
    ['remediation', 'recoveryRemediation'],
  ];
  for (const [label, key] of show) {
    const value = doc[key];
    if (value === undefined) continue;
    process.stdout.write(`  ${label.padEnd(20)} ${String(value)}\n`);
  }
});
