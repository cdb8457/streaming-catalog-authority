import { checkJellyfinSecretReadiness } from './jellyfin-secret-readiness.js';

const report = checkJellyfinSecretReadiness();
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);

