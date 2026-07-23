import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OPERATOR_UI_LOCAL_AUTH_HEADER } from './operator-ui-local-auth-runtime.js';

// Phase 247 — the operator UI's JavaScript and CSS as fixed, same-origin static assets.
//
// WHY THIS EXISTS. The page used to carry its script and its styles inline, which forced the
// Content-Security-Policy to allow `script-src 'unsafe-inline'` and `style-src 'unsafe-inline'`. Those two
// allowances are the difference between "an injected <script> cannot run" and "it can": with them, the whole
// escaping discipline elsewhere is the only thing standing between a hostile string and execution. Serving
// the behaviour and the presentation as external files lets the policy be `script-src 'self'; style-src
// 'self'` with no inline allowance at all, so the browser refuses to execute anything the page did not load
// from this origin — belt as well as braces.
//
// LOADED ONCE, SERVED FROM MEMORY. The bytes are read from disk exactly once, here, at module load. No
// request ever causes a filesystem read: the routes select between a fixed, exact allowlist of paths and
// serve a precomputed Buffer. There is therefore no path derived from a request, and no way for a crafted
// target to reach a file this module did not choose. The container runs read-only; these files ship inside
// the image (Dockerfile.runtime `COPY src ./src`) and are never written.
//
// CHECKED AT LOAD. The assets are validated the moment they are read, and a violation throws rather than
// serves: a script that smuggled in an inline `<script>` marker, a sourcemap directive, or that drifted from
// the real auth header name is a bug that must fail loudly at startup, not a page that half-works.

export class OperatorUiAssetError extends Error {
  readonly code = 'OPERATOR_UI_ASSET_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'OperatorUiAssetError';
  }
}

export interface OperatorUiAsset {
  /** The exact request path this asset is served at. */
  readonly route: string;
  readonly contentType: string;
  readonly body: Buffer;
  readonly bytes: number;
}

/** No single asset should ever approach this. It is a backstop against a file that grew a runaway paste. */
export const OPERATOR_UI_ASSET_MAX_BYTES = 128 * 1024;

export const OPERATOR_UI_APP_JS_ROUTE = '/assets/app.js';
export const OPERATOR_UI_APP_CSS_ROUTE = '/assets/app.css';

function loadAsset(fileName: string, route: string, contentType: string, validate: (text: string) => void): OperatorUiAsset {
  const path = fileURLToPath(new URL(fileName, import.meta.url));
  let body: Buffer;
  try {
    body = readFileSync(path);
  } catch {
    // The path is fixed and relative to this module, so a failure here is a broken image, not user input.
    throw new OperatorUiAssetError(`the operator UI asset ${fileName} could not be read`);
  }
  if (body.byteLength === 0) throw new OperatorUiAssetError(`the operator UI asset ${fileName} is empty`);
  if (body.byteLength > OPERATOR_UI_ASSET_MAX_BYTES) throw new OperatorUiAssetError(`the operator UI asset ${fileName} is larger than expected`);
  validate(body.toString('utf8'));
  return { route, contentType, body, bytes: body.byteLength };
}

/**
 * Rules every shipped asset must satisfy. These are the properties the CSP relies on being true of the files
 * it points at, enforced here so they cannot quietly stop being true.
 */
function assertNoInlineOrRemoteHazards(fileName: string, text: string): void {
  // A source-map directive would advertise an off-origin (or inline data:) map; there is no build step, so
  // there is never a legitimate one.
  if (/sourceMappingURL/i.test(text)) throw new OperatorUiAssetError(`${fileName} carries a source-map directive`);
  // A `<script` or `</script` marker inside an external file is only ever a mistake or an attempt to break
  // out of the response; the assets are pure JS/CSS and never contain markup.
  if (/<\/?script/i.test(text)) throw new OperatorUiAssetError(`${fileName} contains a script tag marker`);
  // Nothing off-origin: no absolute URL, no protocol-relative reference, no data:/blob: URI, no @import.
  if (/https?:\/\//i.test(text)) throw new OperatorUiAssetError(`${fileName} references an absolute URL`);
  if (/\burl\(\s*['"]?\s*(?:https?:)?\/\//i.test(text)) throw new OperatorUiAssetError(`${fileName} references a remote url()`);
  if (/\b(?:data|blob):/i.test(text)) throw new OperatorUiAssetError(`${fileName} references a data: or blob: URI`);
  if (/@import/i.test(text)) throw new OperatorUiAssetError(`${fileName} uses @import`);
}

function assertJsHazards(fileName: string, text: string): void {
  assertNoInlineOrRemoteHazards(fileName, text);
  // No dynamic code generation. `script-src 'self'` blocks these at runtime anyway, but forbidding them in
  // the source means the file cannot even try, and the ban is visible to a reviewer.
  for (const [pattern, what] of [
    [/\beval\s*\(/, 'eval'],
    [/new\s+Function\s*\(/, 'the Function constructor'],
    [/\bimportScripts\s*\(/, 'importScripts'],
    [/serviceWorker/i, 'a service worker'],
    [/localStorage|sessionStorage|indexedDB|document\.cookie/i, 'browser storage or cookies'],
    [/\.innerHTML\s*=\s*(?!'')(?!"")/, 'a non-empty innerHTML assignment'],
    [/document\.write/i, 'document.write'],
    [/location\.(?:search|hash)/, 'the token being read out of the URL'],
  ] as const) {
    if (pattern.test(text)) throw new OperatorUiAssetError(`${fileName} uses ${what}`);
  }
  // The single source of truth for the auth header: the shipped script must send exactly the header the
  // server verifies, or a green build could ship a UI that cannot authenticate.
  if (!text.includes(`'${OPERATOR_UI_LOCAL_AUTH_HEADER}'`)) {
    throw new OperatorUiAssetError(`${fileName} does not send the ${OPERATOR_UI_LOCAL_AUTH_HEADER} header`);
  }
}

const APP_JS = loadAsset('operator-ui-app.js', OPERATOR_UI_APP_JS_ROUTE, 'text/javascript; charset=utf-8',
  (text) => assertJsHazards('operator-ui-app.js', text));
const APP_CSS = loadAsset('operator-ui-app.css', OPERATOR_UI_APP_CSS_ROUTE, 'text/css; charset=utf-8',
  (text) => assertNoInlineOrRemoteHazards('operator-ui-app.css', text));

/** The exact-match static asset table. A request path is looked up here and nowhere else. */
export const OPERATOR_UI_ASSETS: ReadonlyMap<string, OperatorUiAsset> = new Map([
  [APP_JS.route, APP_JS],
  [APP_CSS.route, APP_CSS],
]);

export function operatorUiAsset(route: string): OperatorUiAsset | undefined {
  return OPERATOR_UI_ASSETS.get(route);
}
