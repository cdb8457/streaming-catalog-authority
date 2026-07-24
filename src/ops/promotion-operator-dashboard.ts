import type { ProofLimit } from './promotion-audit-closure-packet.js';
import {
  CONSOLE_PHASES,
  type ArtifactStatus,
  type ConsoleBlocker,
  type ConsoleOutcome,
  type OperatorConsoleReport,
} from './promotion-operator-console.js';

// Phase 243: the local-only, read-only OPERATOR DASHBOARD over the Phase 242 console.
//
// WHY IT EXISTS. Phase 242 made the chain answerable in one command; it still answers in a terminal, to
// someone who knows to run it. The people who most need to read a promotion record chain -- the ones deciding
// whether anything is outstanding, and the ones checking months later that nothing was quietly closed -- are
// not always at a shell. This phase gives that same answer a page.
//
// IT ADDS NO AUDIT SEMANTICS, AT ALL. It computes nothing, decides nothing and re-derives nothing: it takes a
// Phase 242 console report and lays it out. Every verdict, blocker, step and proof limit on the page is the
// one Phase 242 (and behind it Phase 241) already produced, character for character. If this file disagreed
// with the console, the console would be right.
//
// STATIC HTML, NO JAVASCRIPT. Not a simplification -- a boundary. There is no script, no fetch, no state and
// no client-side rendering, so `script-src 'none'` holds, there is nothing for injected content to execute in,
// and the page is fully readable by a screen reader, a text browser, and a phone with scripting off. Refresh
// is the browser's reload button; the served snapshot never changes for the life of the process, which is why
// reload is honest rather than merely convenient.
//
// NOTHING FROM THE ARTIFACTS REACHES THE PAGE. The Phase 242 report is value-free by construction -- fixed
// text, counts, phase numbers and already-public digests -- so there is no artifact value, path, filename,
// identity, timestamp, secret or approval value available to render even in principle. Everything is escaped
// on the way out regardless: defence in depth is cheap, and the day someone widens the console report is the
// day this matters.

export type DashboardTone = 'good' | 'open' | 'bad' | 'blocked';

export const DASHBOARD_BOUNDARY =
  'Local-only and read-only: no promotion run, no approval, no execution, no observation, no custody, no archival, no deletion, no mutation, no upload, no form, no browser-supplied path, no Phase 231 authorization, no real Movies library read or write, no live Jellyfin call, no secret approval-file read, no database read, no outbound network call, and no merge, tag or push. It renders one Phase 242 console report and nothing else.';

// Each outcome gets a plain-language headline, a tone, and the one sentence that stops a reader drawing the
// wrong conclusion from it. AUDIT_OPEN especially: a page that shows an unfinished chain in warning colours
// teaches people to treat honest incompleteness as a fault.
const OUTCOME_VIEW: Readonly<Record<ConsoleOutcome, { readonly tone: DashboardTone; readonly headline: string; readonly caveat: string }>> = {
  AUDIT_CLOSED: {
    tone: 'good',
    headline: 'The records are mutually consistent.',
    caveat: 'This does NOT mean the promotion happened, was correct, or was authorized by anyone in particular. Self-digests are not signatures.',
  },
  AUDIT_OPEN: {
    tone: 'open',
    headline: 'Consistent as far as it goes, and honestly unfinished.',
    caveat: 'This is normal, not a defect. A chain stops where no human has taken it further, and stopping is a valid place to be.',
  },
  AUDIT_INVALID: {
    tone: 'bad',
    headline: 'Something does not hang together.',
    caveat: 'Do not add anything to this chain until every blocker below is resolved. Re-sealing or regenerating an artifact to clear one changes nothing an auditor would see.',
  },
  NOT_ELIGIBLE: {
    tone: 'blocked',
    headline: 'There is no genuine Phase 231 gate to audit against.',
    caveat: 'Without the anchor there is no operation identity, so nothing can be concluded about any of the other artifacts.',
  },
};

// Status words, never colour alone: the symbol and the word both carry the meaning, so the table reads the
// same to a screen reader, in monochrome, and to anyone who cannot distinguish the two greens.
const STATUS_VIEW: Readonly<Record<ArtifactStatus, { readonly tone: DashboardTone; readonly mark: string; readonly meaning: string }>> = {
  PRESENT: { tone: 'good', mark: '+', meaning: 'supplied and handed to the audit' },
  ABSENT: { tone: 'open', mark: '.', meaning: 'not written yet -- normal, never a defect' },
  MALFORMED: { tone: 'bad', mark: 'x', meaning: 'not a chain report, or not a bounded regular file' },
  MISFILED: { tone: 'bad', mark: 'x', meaning: 'a genuine chain report, filed under the wrong phase' },
  DUPLICATE: { tone: 'bad', mark: 'x', meaning: 'two artifacts claim this phase; neither is assumed' },
};

export interface DashboardStatus {
  readonly ok: boolean;
  readonly code: 'PROMOTION_OPERATOR_DASHBOARD_STATUS';
  readonly surface: 'local-read-only-promotion-record-dashboard';
  readonly source: 'phase-242-promotion-operator-console';
  readonly overall: ConsoleOutcome;
  readonly auditOutcome: ConsoleOutcome;
  readonly terminalPhase: number | null;
  readonly nextRequiredPhase: number | null;
  readonly presentCount: number;
  readonly absentCount: number;
  readonly malformedCount: number;
  readonly misfiledCount: number;
  readonly duplicateCount: number;
  readonly blockerCount: number;
  readonly blockerCodes: readonly string[];
  readonly snapshotTakenAtLaunch: true;
  readonly consoleDigest: string;
  readonly boundary: string;
}

// `ok` is TRUE for an honestly unfinished chain. A health contract that reported AUDIT_OPEN as unhealthy would
// be making exactly the judgment this stack refuses to make: it would say an operation nobody has carried
// further is a fault. Only a chain that does not hang together, or has no anchor to hang from, is not ok.
export function buildDashboardStatus(report: OperatorConsoleReport): DashboardStatus {
  return {
    ok: report.overall === 'AUDIT_CLOSED' || report.overall === 'AUDIT_OPEN',
    code: 'PROMOTION_OPERATOR_DASHBOARD_STATUS',
    surface: 'local-read-only-promotion-record-dashboard',
    source: 'phase-242-promotion-operator-console',
    overall: report.overall,
    auditOutcome: report.auditOutcome,
    terminalPhase: report.terminalPhase,
    nextRequiredPhase: report.nextRequiredPhase,
    presentCount: report.presentCount,
    absentCount: report.absentCount,
    malformedCount: report.malformedCount,
    misfiledCount: report.misfiledCount,
    duplicateCount: report.duplicateCount,
    blockerCount: report.blockers.length,
    blockerCodes: report.blockerCodes,
    snapshotTakenAtLaunch: true,
    consoleDigest: report.consoleDigest,
    boundary: DASHBOARD_BOUNDARY,
  };
}

export interface DashboardManifest {
  readonly ok: true;
  readonly code: 'PROMOTION_OPERATOR_DASHBOARD_MANIFEST';
  readonly surface: 'local-read-only-promotion-record-dashboard';
  readonly routes: readonly string[];
  readonly methods: readonly ['GET'];
  readonly accessBoundary: 'loopback-only';
  readonly remoteExposure: 'blocked';
  readonly dataMode: 'launch-time-console-snapshot';
  readonly snapshotTakenAtLaunch: true;
  readonly clientScript: 'none';
  readonly queryParameters: 'rejected';
  readonly requestBodies: 'ignored';
  readonly boundaries: readonly string[];
}

const DASHBOARD_BOUNDARIES: readonly string[] = [
  'no-mutation',
  'no-upload',
  'no-form-or-input',
  'no-browser-supplied-path',
  'no-query-parameter',
  'no-filesystem-read-after-launch',
  'no-client-script',
  'no-db-read',
  'no-outbound-network',
  'no-provider-call-or-integration',
  'no-jellyfin-access',
  'no-movies-library-access',
  'no-secret-material',
  'no-approval-value',
  'no-artifact-value-or-filename',
  'no-identity-or-timestamp',
  'no-promotion-execution',
  'no-phase-231-authorization',
  'no-archive-or-delete',
  'no-merge-tag-or-push',
  'no-audit-semantics-of-its-own',
];

export const DASHBOARD_ROUTES: readonly string[] = ['GET /', 'GET /healthz', 'GET /status.json', 'GET /manifest.json'];

export function buildDashboardManifest(): DashboardManifest {
  return {
    ok: true,
    code: 'PROMOTION_OPERATOR_DASHBOARD_MANIFEST',
    surface: 'local-read-only-promotion-record-dashboard',
    routes: DASHBOARD_ROUTES,
    methods: ['GET'],
    accessBoundary: 'loopback-only',
    remoteExposure: 'blocked',
    dataMode: 'launch-time-console-snapshot',
    snapshotTakenAtLaunch: true,
    clientScript: 'none',
    queryParameters: 'rejected',
    requestBodies: 'ignored',
    boundaries: DASHBOARD_BOUNDARIES,
  };
}

export interface DashboardArtifactView {
  readonly phase: number;
  readonly status: ArtifactStatus;
  readonly tone: DashboardTone;
  readonly mark: string;
  readonly detail: string;
}

// EVERYTHING A SURFACE NEEDS TO PRESENT A CHAIN, and nothing a surface has to decide for itself. The standalone
// Phase 243 page and the authenticated panel in the Phase 147 operator UI both render FROM this, so the
// headline an operator reads, the caveat attached to it, what each artifact state means and which tone it
// carries are decided in ONE place. Two surfaces agreeing because they share a view model is a fact; two
// surfaces agreeing because two people wrote the same sentences twice is a coincidence waiting to end.
//
// It is value-free and JSON-safe by construction -- every field is either a fixed string from the tables
// above, a count, a phase number, or something the Phase 242 report already published.
export interface DashboardViewModel {
  readonly overall: ConsoleOutcome;
  readonly tone: DashboardTone;
  readonly headline: string;
  readonly caveat: string;
  readonly auditOutcome: ConsoleOutcome;
  readonly outcomeMatchesAudit: boolean;
  readonly terminalPhase: number | null;
  readonly nextRequiredPhase: number | null;
  readonly nextIsUnfinished: boolean;
  readonly presentCount: number;
  readonly absentCount: number;
  readonly malformedCount: number;
  readonly misfiledCount: number;
  readonly duplicateCount: number;
  readonly artifacts: readonly DashboardArtifactView[];
  readonly blockers: readonly ConsoleBlocker[];
  readonly nextSteps: readonly string[];
  readonly proofLimits: readonly ProofLimit[];
  readonly disclaimers: readonly string[];
  readonly consoleDigest: string;
  readonly boundary: string;
}

export function buildDashboardViewModel(report: OperatorConsoleReport): DashboardViewModel {
  const view = OUTCOME_VIEW[report.overall];
  return {
    overall: report.overall,
    tone: view.tone,
    headline: view.headline,
    caveat: view.caveat,
    auditOutcome: report.auditOutcome,
    outcomeMatchesAudit: report.outcomeMatchesAudit,
    terminalPhase: report.terminalPhase,
    nextRequiredPhase: report.nextRequiredPhase,
    nextIsUnfinished: report.nextRequiredPhase !== null && report.nonTerminalPhases.includes(report.nextRequiredPhase),
    presentCount: report.presentCount,
    absentCount: report.absentCount,
    malformedCount: report.malformedCount,
    misfiledCount: report.misfiledCount,
    duplicateCount: report.duplicateCount,
    artifacts: report.artifacts.map((a) => {
      const status = STATUS_VIEW[a.status];
      const phase = report.audit.phases.find((p) => p.phase === a.phase);
      // A present artifact says what the audit made of it; anything else says what its state means.
      const detail = a.status === 'PRESENT' && phase !== undefined
        ? [phase.verified ? 'verified' : 'does not recompute',
          phase.semanticallySound ? 'sound' : 'not sound',
          phase.terminal ? 'terminal' : 'not terminal',
          phase.linkedToParent === false ? 'link broken' : '',
          phase.identityMatched === false ? 'different operation' : ''].filter((f) => f !== '').join(', ')
        : status.meaning;
      return { phase: a.phase, status: a.status, tone: status.tone, mark: status.mark, detail };
    }),
    blockers: report.blockers,
    nextSteps: report.nextSteps,
    proofLimits: report.audit.proofLimits,
    disclaimers: report.disclaimers,
    consoleDigest: report.consoleDigest,
    boundary: DASHBOARD_BOUNDARY,
  };
}

// Escaped for HTML text AND attribute context in one pass. Nothing here is ever inserted unescaped.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = [
  ':root{color-scheme:light dark;--bg:#f6f7f9;--fg:#16202c;--muted:#4a5666;--card:#fff;--line:#c9d1dc;--good:#0f6b3f;--open:#274b8a;--bad:#a3231b;--blocked:#7a3d00;--markbg:#eef1f5}',
  '@media(prefers-color-scheme:dark){:root{--bg:#12161c;--fg:#e6ebf2;--muted:#a6b2c2;--card:#1a2029;--line:#333d4b;--good:#5fd39b;--open:#8fb4ff;--bad:#ff8f86;--blocked:#f0b464;--markbg:#232b36}}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}',
  '.skip{position:absolute;left:-9999px}.skip:focus{left:8px;top:8px;padding:8px 12px;background:var(--card);border:2px solid var(--fg);border-radius:6px;z-index:9}',
  'a{color:inherit}:focus-visible{outline:3px solid var(--open);outline-offset:2px}',
  'main{max-width:60rem;margin:0 auto;padding:1.5rem 1rem 4rem}',
  'header{padding:1.5rem 1rem .5rem;max-width:60rem;margin:0 auto}',
  'h1{font-size:1.3rem;margin:0 0 .25rem}h2{font-size:1.05rem;margin:2rem 0 .6rem}h3{font-size:.95rem;margin:1.1rem 0 .3rem}',
  '.sub{color:var(--muted);font-size:.85rem;margin:0}',
  'section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem 1.1rem;margin:0 0 1.1rem}',
  '.verdict{border-left:6px solid var(--line)}',
  '.verdict.good{border-left-color:var(--good)}.verdict.open{border-left-color:var(--open)}.verdict.bad{border-left-color:var(--bad)}.verdict.blocked{border-left-color:var(--blocked)}',
  '.code{font:600 1.05rem/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.02em}',
  '.good .code{color:var(--good)}.open .code{color:var(--open)}.bad .code{color:var(--bad)}.blocked .code{color:var(--blocked)}',
  '.lead{font-size:1.05rem;margin:.35rem 0 .5rem}.caveat{color:var(--muted);margin:.25rem 0 0}',
  'dl.facts{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1rem;margin:0}',
  'dl.facts dt{color:var(--muted);font-size:.9rem}dl.facts dd{margin:0;font-weight:600}',
  'table{border-collapse:collapse;width:100%;font-size:.92rem}',
  'caption{text-align:left;color:var(--muted);font-size:.85rem;padding-bottom:.4rem}',
  'th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}',
  'th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}',
  'td.mark{font:700 1rem/1 ui-monospace,Menlo,Consolas,monospace;background:var(--markbg);border-radius:4px;text-align:center;width:2.2rem}',
  '.good td.mark,td.mark.good{color:var(--good)}.open td.mark,td.mark.open{color:var(--open)}.bad td.mark,td.mark.bad{color:var(--bad)}',
  'ol,ul{margin:.4rem 0;padding-left:1.3rem}li{margin:.45rem 0}',
  '.blocker{border:1px solid var(--line);border-left:4px solid var(--bad);border-radius:8px;padding:.6rem .8rem;margin:.6rem 0;list-style:none}',
  '.blocker .id{font:600 .9rem ui-monospace,Menlo,Consolas,monospace;color:var(--bad);overflow-wrap:anywhere}',
  '.blocker p{margin:.35rem 0 0}.blocker .do{color:var(--muted)}',
  '.limits{font-size:.9rem}.limits td:first-child{white-space:nowrap;font-weight:600}',
  'footer{max-width:60rem;margin:0 auto;padding:0 1rem 3rem;color:var(--muted);font-size:.82rem}',
  'code{font-family:ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}',
  '@media(max-width:34rem){main,header{padding-left:.7rem;padding-right:.7rem}dl.facts{grid-template-columns:1fr;gap:.1rem .5rem}dl.facts dd{margin-bottom:.5rem}.limits td:first-child{white-space:normal}}',
].join('');

// The whole page, server-rendered from the console report. Ordered the way a person actually reads it: the
// verdict and what it does not mean, then what is outstanding and what to do, then the evidence behind it,
// and the proof limits last -- present on the same page as the verdict, so the caveat cannot be screenshotted
// away from the conclusion.
export function renderOperatorDashboardHtml(report: OperatorConsoleReport): string {
  const model = buildDashboardViewModel(report);
  const view = { tone: model.tone, headline: model.headline, caveat: model.caveat };
  const rows = model.artifacts.map((a) => `<tr class="${a.tone}"><td class="mark ${a.tone}" aria-hidden="true">${escapeHtml(a.mark)}</td>`
    + `<th scope="row">Phase ${a.phase}</th>`
    + `<td>${escapeHtml(a.status)}</td><td>${escapeHtml(a.detail)}</td></tr>`).join('');

  const blockers = model.blockers.length === 0
    ? '<p>None. Nothing about this chain is contradictory or defective.</p>'
    : `<ul>${model.blockers.map((b) => `<li class="blocker"><span class="id">${escapeHtml(b.code)}</span>`
      + `<p>${escapeHtml(b.meaning)}</p><p class="do"><strong>Do:</strong> ${escapeHtml(b.humanAction)}</p></li>`).join('')}</ul>`;

  const steps = `<ol>${model.nextSteps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`;

  const limits = `<table class="limits"><caption>What each phase's green state does and does not establish. This travels with the verdict on purpose.</caption>`
    + '<thead><tr><th scope="col">Phase</th><th scope="col">Establishes</th><th scope="col">Does NOT establish</th></tr></thead><tbody>'
    + model.proofLimits.map((l) => `<tr><td>${l.phase}</td><td>${escapeHtml(l.establishes)}</td><td>${escapeHtml(l.doesNotEstablish)}</td></tr>`).join('')
    + '</tbody></table>';

  const disclaimers = `<ul>${model.disclaimers.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>Promotion record chain -- ${escapeHtml(model.overall)}</title>
<style>${STYLE}</style>
</head>
<body>
<a class="skip" href="#outcome">Skip to the outcome</a>
<header>
<h1>Promotion record chain</h1>
<p class="sub">Phases 231-241, audited locally and offline. Read-only: this page changes nothing and decides nothing.</p>
</header>
<main>
<section id="outcome" class="verdict ${view.tone}" aria-labelledby="outcome-h">
<h2 id="outcome-h" class="code">${escapeHtml(model.overall)}</h2>
<p class="lead">${escapeHtml(view.headline)}</p>
<p class="caveat">${escapeHtml(view.caveat)}</p>
</section>

<section aria-labelledby="where-h">
<h2 id="where-h">Where the chain stands</h2>
<dl class="facts">
<dt>Chain reaches</dt><dd>${model.terminalPhase === null ? 'nothing -- no usable Phase 231 anchor' : `Phase ${model.terminalPhase}`}</dd>
<dt>Outstanding next</dt><dd>${model.nextRequiredPhase === null ? 'nothing further' : `Phase ${model.nextRequiredPhase}${model.nextIsUnfinished ? ' -- present, but not finished' : ''}`}</dd>
<dt>Artifacts</dt><dd>${model.presentCount} present, ${model.absentCount} absent, ${model.malformedCount} malformed, ${model.misfiledCount} misfiled, ${model.duplicateCount} duplicate</dd>
<dt>Blockers</dt><dd>${model.blockers.length === 0 ? 'none' : String(model.blockers.length)}</dd>
<dt>Audit verdict</dt><dd>${escapeHtml(model.auditOutcome)}${model.outcomeMatchesAudit ? '' : ' -- the intake itself is defective; see blockers'}</dd>
</dl>
</section>

<section aria-labelledby="do-h">
<h2 id="do-h">What a human should do next</h2>
<p class="sub">Fixed guidance, looked up from the outcome and the outstanding phase. It is not advice about whether the promotion should proceed, and no human decision is read or inferred here.</p>
${steps}
</section>

<section aria-labelledby="art-h">
<h2 id="art-h">Artifacts</h2>
<table>
<caption>One row per phase. ABSENT is normal: it means the phase has not happened yet, not that something is wrong.</caption>
<thead><tr><th scope="col"><span aria-hidden="true">&nbsp;</span></th><th scope="col">Phase</th><th scope="col">State</th><th scope="col">Detail</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</section>

<section aria-labelledby="block-h">
<h2 id="block-h">Blockers</h2>
${blockers}
</section>

<section aria-labelledby="limit-h">
<h2 id="limit-h">Proof limits</h2>
${limits}
</section>

<section aria-labelledby="about-h">
<h2 id="about-h">About this page</h2>
${disclaimers}
<p>Snapshot taken when this server started. It does not change while the server runs, so what was audited is what you are reading; restart the server to re-read the artifacts.</p>
<p>Console digest: <code>${escapeHtml(model.consoleDigest)}</code></p>
</section>
</main>
<footer><p>${escapeHtml(DASHBOARD_BOUNDARY)}</p></footer>
</body>
</html>
`;
}

// Sanity net for callers that want to assert the shape without re-deriving it.
export const DASHBOARD_PHASE_COUNT = CONSOLE_PHASES.length;
