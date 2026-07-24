import {
  OPERATOR_UI_CATEGORY_LABELS,
  OPERATOR_UI_DISPLAY_FIELD_LABELS,
  OPERATOR_UI_SCREEN_IDS,
  OPERATOR_UI_STATUS_LABELS,
} from './operator-ui-packet-contract.js';

export type OperatorUiRenderInspectionIssueCode =
  | 'OPERATOR_UI_RENDER_FORBIDDEN_MARKUP'
  | 'OPERATOR_UI_RENDER_FORBIDDEN_EXTERNAL_REFERENCE'
  | 'OPERATOR_UI_RENDER_FORBIDDEN_TEXT';

export interface OperatorUiRenderInspectionIssue {
  readonly code: OperatorUiRenderInspectionIssueCode;
  readonly message:
    | 'Operator UI render contains forbidden markup.'
    | 'Operator UI render contains a forbidden external reference.'
    | 'Operator UI render contains text outside the static allowlist.';
}

export type OperatorUiRenderInspectionReport =
  | {
      readonly ok: true;
      readonly code: 'OPERATOR_UI_RENDER_ACCEPTED';
      readonly message: 'Operator UI render is static and allowlist-compliant.';
      readonly issues: readonly [];
      readonly visibleTextCount: number;
      readonly cssTokenCount: number;
    }
  | {
      readonly ok: false;
      readonly code: 'OPERATOR_UI_RENDER_REJECTED';
      readonly message: 'Operator UI render is not static allowlist-compliant.';
      readonly issues: readonly OperatorUiRenderInspectionIssue[];
      readonly visibleTextCount: number;
      readonly cssTokenCount: number;
    };

export const OPERATOR_UI_RENDER_SCREEN_TITLES = [
  'Overview',
  'Catalog Authority',
  'Privacy Crypto-Shredding',
  'Key Custodian O4 Status',
  'Reconciler',
  'Backup Restore',
  'Provider Availability Packets',
  'Audit Queue',
  'Settings Operator Configuration',
] as const;

export const OPERATOR_UI_RENDER_STATIC_CHROME_TEXT = [
  'Operator UI Static Prototype',
  'Static Fixture Console',
  'Read Only',
  'Fixture Only',
  'Provider Count',
  'O4 O5 Deferred',
  'Static Surface',
  'Allowlist Gate',
  'Artifact Gate',
  'Render Boundary',
  'Fixture Screens',
  'Packet Rows',
  'Static Layout',
  'Artifact Digest',
  'Sanitized Activity',
  'Seq',
  'Field',
  'Status',
  'Category',
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  'Local Packet Access',
  'Operator Secret',
  'Load Packets',
  'Packet endpoint locked',
  'Runtime Packets',
  'No runtime packet snapshot loaded',
] as const;

export const OPERATOR_UI_STATIC_PROTOTYPE_SCRIPT = [
  'const control=document.getElementById("packet-auth-control");',
  'const input=document.getElementById("operator-secret-input");',
  'const status=document.getElementById("packet-auth-status");',
  'const output=document.getElementById("runtime-packet-output");',
  'control.addEventListener("click",async()=>{',
  'const value=input.value;',
  'input.value="";',
  'status.textContent="Packet request pending";',
  'output.textContent="No runtime packet snapshot loaded";',
  'try{',
  'const response=await fetch("/operator-ui/packets.json",{method:"GET",headers:{"X-Operator-UI-Secret":value},cache:"no-store"});',
  'if(!response.ok){status.textContent="Packet endpoint locked";return;}',
  'const payload=await response.json();',
  'status.textContent="Packet snapshot loaded";',
  'output.textContent=JSON.stringify({code:payload.code,dataMode:payload.dataMode,packetCount:payload.packetCount,screens:payload.screens},null,2);',
  '}catch{',
  'status.textContent="Packet endpoint locked";',
  '}',
  '});',
].join('');

export const OPERATOR_UI_RENDER_ALLOWED_CSS_TOKENS = [
  '#111214',
  '#1A1B1E',
  '#232428',
  '#303238',
  '#ECECEC',
  '#A0A3A8',
  '#D18A3A',
  '#7E9B75',
  '#C09A4A',
  '#B96A64',
  '#7D91A8',
  'color-scheme:dark',
  'border-radius:8px',
  'border-radius:6px',
  'border-radius:4px',
] as const;

export const OPERATOR_UI_RENDER_ALLOWED_TEXT = [
  ...OPERATOR_UI_SCREEN_IDS,
  ...OPERATOR_UI_DISPLAY_FIELD_LABELS,
  ...OPERATOR_UI_STATUS_LABELS,
  ...OPERATOR_UI_CATEGORY_LABELS,
  ...OPERATOR_UI_RENDER_SCREEN_TITLES,
  ...OPERATOR_UI_RENDER_STATIC_CHROME_TEXT,
  OPERATOR_UI_STATIC_PROTOTYPE_SCRIPT,
] as const;

const ALLOWED_TEXT = new Set<string>(OPERATOR_UI_RENDER_ALLOWED_TEXT);
const ISSUE_MESSAGES: Record<OperatorUiRenderInspectionIssueCode, OperatorUiRenderInspectionIssue['message']> = {
  OPERATOR_UI_RENDER_FORBIDDEN_MARKUP: 'Operator UI render contains forbidden markup.',
  OPERATOR_UI_RENDER_FORBIDDEN_EXTERNAL_REFERENCE: 'Operator UI render contains a forbidden external reference.',
  OPERATOR_UI_RENDER_FORBIDDEN_TEXT: 'Operator UI render contains text outside the static allowlist.',
};

function issue(code: OperatorUiRenderInspectionIssueCode): OperatorUiRenderInspectionIssue {
  return { code, message: ISSUE_MESSAGES[code] };
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function extractOperatorUiRenderedTextSegments(html: string): readonly string[] {
  return html
    .replace(/<!doctype[^>]*>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map((segment) => decodeHtmlText(segment).replace(/\s+/g, ' ').trim())
    .filter((segment) => segment.length > 0);
}

function containsForbiddenMarkup(html: string): boolean {
  return /<\s*(link|img|iframe|form)\b/i.test(html)
    || /<\s*script\b/i.test(stripAllowedInlineScript(html))
    || /\son[a-z]+\s*=/i.test(html);
}

function containsExternalReference(html: string): boolean {
  return /\s(?:href|src)\s*=\s*(?:"\s*(?:https?:|data:|\/\/)|'\s*(?:https?:|data:|\/\/)|(?:https?:|data:|\/\/))/i.test(html)
    || /@import\s+(?:url\(\s*)?["']?\s*(?:https?:|data:|\/\/)/i.test(html)
    || /url\(\s*["']?\s*(?:https?:|data:|\/\/)/i.test(html);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripAllowedInlineScript(html: string): string {
  const pattern = new RegExp(`<script>${escapeRegExp(OPERATOR_UI_STATIC_PROTOTYPE_SCRIPT)}</script>`);
  return html.replace(pattern, '');
}

// The two markup gates, published so a LATER operator surface can be held to the same bar without inheriting
// this phase's fixed text allowlist, which is specific to the Phase 64 static prototype. The Phase 243
// dashboard renders generated prose, so only these two apply to it -- and it must pass both.
export function operatorUiRenderHasForbiddenMarkup(html: string): boolean {
  return containsForbiddenMarkup(html);
}
export function operatorUiRenderHasExternalReference(html: string): boolean {
  return containsExternalReference(html);
}

export function inspectOperatorUiRenderedHtml(html: string): OperatorUiRenderInspectionReport {
  const textSegments = extractOperatorUiRenderedTextSegments(html);
  const issueCodes: OperatorUiRenderInspectionIssueCode[] = [];

  if (containsForbiddenMarkup(html)) issueCodes.push('OPERATOR_UI_RENDER_FORBIDDEN_MARKUP');
  if (containsExternalReference(html)) issueCodes.push('OPERATOR_UI_RENDER_FORBIDDEN_EXTERNAL_REFERENCE');
  if (textSegments.some((segment) => !ALLOWED_TEXT.has(segment))) {
    issueCodes.push('OPERATOR_UI_RENDER_FORBIDDEN_TEXT');
  }

  const issues = [...new Set(issueCodes)].sort().map(issue);
  const cssTokenCount = OPERATOR_UI_RENDER_ALLOWED_CSS_TOKENS
    .filter((token) => html.includes(token)).length;

  if (issues.length === 0) {
    return {
      ok: true,
      code: 'OPERATOR_UI_RENDER_ACCEPTED',
      message: 'Operator UI render is static and allowlist-compliant.',
      issues: [],
      visibleTextCount: textSegments.length,
      cssTokenCount,
    };
  }

  return {
    ok: false,
    code: 'OPERATOR_UI_RENDER_REJECTED',
    message: 'Operator UI render is not static allowlist-compliant.',
    issues,
    visibleTextCount: textSegments.length,
    cssTokenCount,
  };
}
