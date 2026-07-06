import { createHash } from 'node:crypto';
import { OPERATOR_UI_FIXTURE_PACKETS, type OperatorUiFixturePacket } from './operator-ui-fixtures.js';
import { OPERATOR_UI_STATIC_PROTOTYPE_SCRIPT } from './operator-ui-render-allowlist.js';
import type {
  OperatorUiCategoryLabel,
  OperatorUiPacketFieldDescriptor,
  OperatorUiScreenId,
  OperatorUiStatusLabel,
} from './operator-ui-packet-contract.js';

export const OPERATOR_UI_STATIC_PROTOTYPE_SCRIPT_SHA256 = createHash('sha256')
  .update(OPERATOR_UI_STATIC_PROTOTYPE_SCRIPT, 'utf8')
  .digest('base64');

const SCREEN_TITLES: Record<OperatorUiScreenId, string> = {
  overview: 'Overview',
  'catalog-authority': 'Catalog Authority',
  'privacy-crypto-shredding': 'Privacy Crypto-Shredding',
  'key-custodian-o4-status': 'Key Custodian O4 Status',
  reconciler: 'Reconciler',
  'backup-restore': 'Backup Restore',
  'provider-availability-packets': 'Provider Availability Packets',
  'audit-queue': 'Audit Queue',
  'settings-operator-configuration': 'Settings Operator Configuration',
};

const STATUS_CLASS: Record<OperatorUiStatusLabel, string> = {
  Open: 'status-info',
  Deferred: 'status-warning',
  Verified: 'status-success',
  Warning: 'status-warning',
  Failed: 'status-danger',
  Blocked: 'status-danger',
  Synced: 'status-success',
  Static: 'status-info',
  'Count Only': 'status-info',
  Advisory: 'status-warning',
  'Reference Harness': 'status-info',
  'Not Production KMS': 'status-warning',
};

const CATEGORY_CLASS: Record<OperatorUiCategoryLabel, string> = {
  'System Health': 'category-system',
  'Catalog Authority': 'category-catalog',
  'Privacy Gate': 'category-privacy',
  'Backup Gate': 'category-backup',
  'Reconcile Gate': 'category-reconcile',
  'Provider Availability': 'category-provider',
  'Audit Review': 'category-audit',
  'Operator Configuration': 'category-operator',
  'Redaction Policy': 'category-redaction',
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderStatus(field: OperatorUiPacketFieldDescriptor): string {
  if (field.statusLabel === undefined) return '<span class="status-chip status-info">Static</span>';
  return `<span class="status-chip ${STATUS_CLASS[field.statusLabel]}">${escapeHtml(field.statusLabel)}</span>`;
}

function renderCategory(field: OperatorUiPacketFieldDescriptor): string {
  if (field.categoryLabel === undefined) return '<span class="category-chip category-system">System Health</span>';
  return `<span class="category-chip ${CATEGORY_CLASS[field.categoryLabel]}">${escapeHtml(field.categoryLabel)}</span>`;
}

function renderOverviewCards(packets: readonly OperatorUiFixturePacket[]): string {
  return packets.slice(0, 4).map((packet) => {
    const first = packet.rows[0]?.cells[0];
    return [
      '<article class="summary-card">',
      '<div class="summary-card-topline">',
      `<span class="summary-label">${escapeHtml(packet.screenLabel)}</span>`,
      '<span class="mono-cell">Static</span>',
      '</div>',
      `<h3>${escapeHtml(SCREEN_TITLES[packet.screenId])}</h3>`,
      `<div class="summary-state">${first === undefined ? '<span class="status-chip status-info">Static</span>' : renderStatus(first)}</div>`,
      '</article>',
    ].join('');
  }).join('');
}

function renderPacketPanel(packet: OperatorUiFixturePacket): string {
  const rows = packet.rows.flatMap((row) => row.cells).map((field, index) => [
    '<tr>',
    `<td class="mono-cell">${escapeHtml(String(index + 1).padStart(2, '0'))}</td>`,
    `<td>${escapeHtml(field.label)}</td>`,
    `<td>${renderStatus(field)}</td>`,
    `<td>${renderCategory(field)}</td>`,
    '</tr>',
  ].join('')).join('');

  return [
    `<section class="screen-panel" id="${escapeHtml(packet.screenId)}">`,
    '<div class="panel-heading">',
    '<div class="panel-title-block">',
    `<p>${escapeHtml(packet.screenLabel)}</p>`,
    `<h2>${escapeHtml(SCREEN_TITLES[packet.screenId])}</h2>`,
    '</div>',
    '<div class="panel-state-stack"><span class="panel-mode">Read Only</span><span class="panel-mode">Fixture Only</span></div>',
    '</div>',
    '<div class="table-frame">',
    '<table>',
    '<thead><tr><th>Seq</th><th>Field</th><th>Status</th><th>Category</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    '</div>',
    '</section>',
  ].join('');
}

function renderActivityRows(packets: readonly OperatorUiFixturePacket[]): string {
  return packets.map((packet, index) => {
    const field = packet.rows[0]?.cells[0];
    return [
      '<div class="activity-row">',
      `<span class="mono-cell">${escapeHtml(String(index + 1).padStart(2, '0'))}</span>`,
      `<span>${escapeHtml(SCREEN_TITLES[packet.screenId])}</span>`,
      field === undefined ? '<span class="status-chip status-info">Static</span>' : renderStatus(field),
      '</div>',
    ].join('');
  }).join('');
}

export function renderOperatorUiStaticPrototypeHtml(): string {
  const packets = OPERATOR_UI_FIXTURE_PACKETS;
  const nav = packets.map((packet) => (
    `<a class="nav-link" href="#${escapeHtml(packet.screenId)}">${escapeHtml(SCREEN_TITLES[packet.screenId])}</a>`
  )).join('');
  const panels = packets.map(renderPacketPanel).join('');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Operator UI Static Prototype</title>',
    '<style>',
    ':root{color-scheme:dark;--bg:#111214;--panel:#1A1B1E;--raised:#232428;--border:#303238;--text:#ECECEC;--muted:#A0A3A8;--accent:#D18A3A;--success:#7E9B75;--warning:#C09A4A;--danger:#B96A64;--info:#7D91A8;}',
    '*{box-sizing:border-box}',
    'html{scroll-behavior:smooth;}',
    'body{margin:0;background:#111214;color:#ECECEC;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.45;}',
    '.shell{min-height:100vh;display:grid;grid-template-columns:240px minmax(0,1fr);}',
    '.sidebar{position:sticky;top:0;height:100vh;background:#1A1B1E;border-right:1px solid #303238;padding:18px 14px;overflow:auto;}',
    '.brand{border-bottom:1px solid #303238;padding:0 4px 16px;margin-bottom:12px;}',
    '.brand h1{font-size:16px;margin:0 0 6px;font-weight:650;letter-spacing:0;}',
    '.brand p,.panel-heading p,.summary-label,.metric-label{margin:0;color:#A0A3A8;font-size:12px;text-transform:uppercase;letter-spacing:.08em;}',
    '.nav-link{display:flex;align-items:center;min-height:36px;color:#ECECEC;text-decoration:none;border:1px solid transparent;border-radius:6px;padding:8px 10px;margin:3px 0;font-size:13px;}',
    '.nav-link:first-of-type{border-color:#D18A3A;background:#232428;}',
    '.content{min-width:0;}',
    '.top-strip{position:sticky;top:0;z-index:1;background:#1A1B1E;border-bottom:1px solid #303238;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 18px;}',
    '.strip-group{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0;}',
    '.strip-group strong{font-size:14px;}',
    '.strip-pill,.panel-mode{border:1px solid #303238;border-radius:4px;background:#232428;color:#A0A3A8;padding:5px 8px;font-size:12px;white-space:nowrap;}',
    'main{padding:18px;display:grid;gap:16px;}',
    '.overview-band{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(240px,.5fr);gap:12px;align-items:stretch;}',
    '.summary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;}',
    '.summary-card,.screen-panel,.activity-panel,.status-rail{background:#1A1B1E;border:1px solid #303238;border-radius:8px;}',
    '.summary-card{padding:14px;min-height:120px;display:flex;flex-direction:column;justify-content:space-between;}',
    '.summary-card-topline{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
    '.summary-card h3{font-size:17px;margin:10px 0 14px;letter-spacing:0;}',
    '.summary-state{display:flex;}',
    '.status-rail{display:grid;grid-template-columns:1fr;align-content:start;padding:14px;}',
    '.metric-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;border-top:1px solid #303238;padding:10px 0;font-size:13px;}',
    '.metric-row:first-child{border-top:0;padding-top:0;}',
    '.metric-label{display:block;}',
    '.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 14px 12px;border-bottom:1px solid #303238;}',
    '.panel-title-block{min-width:0;}',
    '.panel-heading h2{font-size:18px;margin:5px 0 0;letter-spacing:0;}',
    '.panel-state-stack{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;}',
    '.table-frame{overflow:auto;}',
    'table{width:100%;border-collapse:collapse;font-size:13px;min-width:620px;}',
    'th{color:#A0A3A8;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;background:#232428;}',
    'th,td{border-bottom:1px solid #303238;padding:8px 10px;vertical-align:middle;}',
    'tbody tr:last-child td{border-bottom:0;}',
    'tbody tr:hover{background:#232428;}',
    '.mono-cell{font-family:"Cascadia Mono","Consolas",monospace;color:#A0A3A8;font-size:12px;}',
    '.status-chip,.category-chip{display:inline-flex;align-items:center;min-height:22px;border:1px solid #303238;border-radius:4px;padding:2px 7px;font-size:12px;white-space:nowrap;}',
    '.status-success{color:#CFE0C8;background:rgba(126,155,117,.14);border-color:#7E9B75;}',
    '.status-warning{color:#F0D59B;background:rgba(192,154,74,.14);border-color:#C09A4A;}',
    '.status-danger{color:#EDC0BC;background:rgba(185,106,100,.14);border-color:#B96A64;}',
    '.status-info{color:#CCD8E6;background:rgba(125,145,168,.14);border-color:#7D91A8;}',
    '.category-chip{color:#ECECEC;background:#232428;}',
    '.category-provider,.category-audit,.category-redaction{border-color:#D18A3A;}',
    '.activity-panel{padding:14px;}',
    '.activity-panel h2{font-size:16px;margin:0 0 10px;}',
    '.activity-row{display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:10px;align-items:center;border-top:1px solid #303238;padding:8px 0;font-size:13px;}',
    '.auth-panel{background:#1A1B1E;border:1px solid #303238;border-radius:8px;padding:14px;display:grid;gap:10px;}',
    '.auth-panel h2{font-size:16px;margin:0;}',
    '.auth-control{display:grid;grid-template-columns:minmax(160px,1fr) auto;gap:8px;align-items:end;}',
    '.auth-control label{display:grid;gap:5px;color:#A0A3A8;font-size:12px;text-transform:uppercase;letter-spacing:.08em;}',
    '.auth-control input{width:100%;min-height:36px;border:1px solid #303238;border-radius:4px;background:#111214;color:#ECECEC;padding:7px 9px;font:inherit;}',
    '.auth-control button{min-height:36px;border:1px solid #D18A3A;border-radius:4px;background:#232428;color:#ECECEC;padding:7px 10px;font:inherit;cursor:pointer;}',
    '.packet-output{margin:0;min-height:72px;overflow:auto;border:1px solid #303238;border-radius:4px;background:#111214;color:#A0A3A8;padding:9px;font-size:12px;}',
    '@media (max-width:980px){.overview-band{grid-template-columns:1fr}.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '@media (max-width:900px){.shell{grid-template-columns:1fr}.sidebar{position:relative;height:auto}.top-strip{position:relative;align-items:flex-start;flex-direction:column}.nav-link{display:inline-flex;margin:3px 3px 3px 0}.panel-heading{align-items:stretch;flex-direction:column}.panel-state-stack{justify-content:flex-start}}',
    '@media (max-width:560px){main{padding:12px}.summary-grid{grid-template-columns:1fr}.top-strip{padding:12px}.brand{padding-bottom:12px}.auth-control{grid-template-columns:1fr}table{min-width:520px}th:nth-child(4),td:nth-child(4){display:none}}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="shell">',
    '<aside class="sidebar">',
    '<div class="brand"><h1>Catalog Authority</h1><p>Static Fixture Console</p></div>',
    `<nav aria-label="Operator screens">${nav}</nav>`,
    '</aside>',
    '<div class="content">',
    '<header class="top-strip">',
    '<div class="strip-group"><strong>Operator UI Static Prototype</strong><span class="strip-pill">Static Surface</span><span class="strip-pill">Fixture Only</span><span class="strip-pill">Read Only</span></div>',
    '<div class="strip-group"><span class="status-chip status-info">Provider Count</span><span class="status-chip status-success">Allowlist Gate</span><span class="status-chip status-warning">O4 O5 Deferred</span></div>',
    '</header>',
    '<main>',
    '<section class="overview-band" aria-label="Overview status">',
    `<div class="summary-grid">${renderOverviewCards(packets)}</div>`,
    '<aside class="status-rail">',
    '<div class="metric-row"><span class="metric-label">Render Boundary</span><span class="status-chip status-info">Static Layout</span></div>',
    '<div class="metric-row"><span class="metric-label">Fixture Screens</span><span class="mono-cell">09</span></div>',
    '<div class="metric-row"><span class="metric-label">Packet Rows</span><span class="mono-cell">09</span></div>',
    '<div class="metric-row"><span class="metric-label">Artifact Gate</span><span class="status-chip status-success">Artifact Digest</span></div>',
    '</aside>',
    '</section>',
    '<section class="activity-panel" aria-label="Sanitized Activity"><h2>Sanitized Activity</h2>',
    renderActivityRows(packets),
    '</section>',
    '<section class="auth-panel" aria-label="Local Packet Access">',
    '<h2>Local Packet Access</h2>',
    '<div class="auth-control">',
    '<label for="operator-secret-input">Operator Secret<input id="operator-secret-input" type="password" autocomplete="off" spellcheck="false"></label>',
    '<button id="packet-auth-control" type="button">Load Packets</button>',
    '</div>',
    '<div id="packet-auth-status" class="status-chip status-warning">Packet endpoint locked</div>',
    '<h2>Runtime Packets</h2>',
    '<pre id="runtime-packet-output" class="packet-output">No runtime packet snapshot loaded</pre>',
    '</section>',
    panels,
    '</main>',
    '</div>',
    '</div>',
    `<script>${OPERATOR_UI_STATIC_PROTOTYPE_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('');
}
