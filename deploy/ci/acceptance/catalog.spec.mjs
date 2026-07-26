import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

// Phase 262 — the SHIPPED CONSUMER EXPERIENCE, in a real headless Chromium against a real extracted Compose
// stack: an operator with an empty installation, who puts a snapshot file in the folder the release documents,
// runs the two commands the page tells them to run, and then browses their own catalog.
//
// Phase 248 proved the release loads in a browser. Phase 260 proved the catalog panel works against a fake
// DOM and a real HTTP server started from source. Neither proved the thing an operator actually does, and the
// gap between them is where a shipped product breaks: the assets in the image, the read-only import mount, the
// migration one-shot, the token, and the browser all have to agree at once.
//
// SEVERAL LEGS, ONE SPEC. The orchestrator runs this file once per leg, by tag, because the states have to be
// proved in order against a real installation rather than simulated:
//
//   @empty     before anything is imported — the first impression, on a genuinely empty install
//   @preview   the Import panel discovers the snapshot and previews it. NOTHING may be written; the
//              orchestrator counts rows, events and history entries either side of this leg.
//   @apply     the explicit, confirmation-bound apply, through the browser
//   @imported  browsing what was imported: counts, search, filters, sort, paging, detail, hostile titles
//   @workspace the Phase 265 workspace: export download, import history, and read-only-ness
//   @reapply   applying the same snapshot again through the browser — idempotent, and recorded
//   @survived  after a full stop/start: the records AND the import history are still there
//
// The operator token arrives ONLY from the environment and is never printed. Every token assertion uses the
// boolean form, expect(x.includes(TOKEN)).toBe(false), so no failure message can echo it.

const TOKEN = process.env.OPERATOR_UI_ACCEPTANCE_TOKEN ?? '';
const BASE_URL = process.env.OPERATOR_UI_ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:8098';
/** The provider reference VALUE planted in the snapshot. It must never reach the browser. */
const SECRET_REF = process.env.CATALOG_ACCEPTANCE_SECRET_REF ?? '';
/** How many records the snapshot contains. */
const RECORD_COUNT = Number(process.env.CATALOG_ACCEPTANCE_RECORD_COUNT ?? '28');
const ORIGIN = new URL(BASE_URL).host;

if (TOKEN === '') throw new Error('OPERATOR_UI_ACCEPTANCE_TOKEN is required and must not be empty');
if (SECRET_REF === '') throw new Error('CATALOG_ACCEPTANCE_SECRET_REF is required and must not be empty');

const HOSTILE_FRAGMENT = 'onerror=window.__catXss=1';
const VERDICT_TEXT = /^(?:READY|READY - NO RECORDS LOADED|NEEDS_SETUP|DEGRADED)$/;

function instrument(page) {
  const collected = { consoleErrors: [], pageErrors: [], requests: [], bodies: [], responses: [] };
  page.on('console', (msg) => { if (msg.type() === 'error') collected.consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => collected.pageErrors.push(String(err)));
  page.on('request', (req) => collected.requests.push({ url: req.url(), method: req.method(), post: req.postData() ?? '' }));
  page.on('response', async (res) => {
    collected.responses.push({ url: res.url(), status: res.status() });
    if (!res.url().includes('/api/catalog')) return;
    try { collected.bodies.push(await res.text()); } catch { /* a body that cannot be read carries nothing */ }
  });
  return collected;
}

async function load(page) {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push({ directive: event.effectiveDirective || event.violatedDirective });
    });
  });
  const collected = instrument(page);
  const response = await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  expect(response, 'the shell responded').toBeTruthy();
  expect(response.status(), 'the shell is 200').toBe(200);
  return collected;
}

/** Enter the token and press Load everything; the catalog panel populates as part of that load. */
async function loadWithToken(page) {
  const collected = await load(page);
  await page.locator('#token').fill(TOKEN);
  await page.locator('#refresh').click();
  await expect(page.locator('#verdict')).toHaveText(VERDICT_TEXT, { timeout: 30_000 });
  await expect(page.locator('#catState')).not.toHaveText('-', { timeout: 30_000 });
  // The import panel loads with everything else, so its inbox listing is populated by the time a leg runs.
  await expect(page.locator('#impInbox')).not.toHaveText('', { timeout: 30_000 });
  return collected;
}

/** The snapshot file the orchestrator placed in the read-only import folder. */
const SNAPSHOT = 'acceptance-snapshot.json';

/** Choose the acceptance snapshot in the Import panel and press Preview. */
async function previewInBrowser(page) {
  await page.locator('#impFile').selectOption(SNAPSHOT);
  await expect(page.locator('#impApply')).toBeDisabled();
  await page.locator('#impPreview').click();
  await expect(page.locator('#impTotal')).not.toHaveText('-', { timeout: 30_000 });
}

// -----------------------------------------------------------------------------------------------------------
// LEG 1 — the empty installation. Run BEFORE anything is imported.
// -----------------------------------------------------------------------------------------------------------

test('@empty an installation with no records says so, and says what to do about it', async ({ page }) => {
  await loadWithToken(page);

  await expect(page.locator('#catTotal')).toHaveText('0');
  await expect(page.locator('#catState')).toHaveText('EMPTY');
  // Guidance, not an error: a fresh install is not a broken one.
  const guidance = (await page.locator('#catGuidance').textContent()) ?? '';
  expect(guidance.length, 'the empty state explains itself').toBeGreaterThan(0);
  expect(/import/i.test(guidance), 'and points at importing a catalog').toBe(true);
  await expect(page.locator('#catResults')).toContainText('No records yet.');

  // The instructions it points at are on the same page, and readable without a token.
  await expect(page.locator('#import-panel')).toContainText('Import a catalog');
  await expect(page.locator('#import-panel')).toContainText('ops:catalog-import');
  await expect(page.locator('#import-panel')).toContainText('catalog-authority.snapshot');
});

test('@empty the shell loads clean, and the catalog is the panel that answered', async ({ page }) => {
  // STRICT where it is honest to be strict: the unauthenticated shell loads no operational route, so any
  // console error there is a real defect in the page itself. This mirrors the Phase 248 assertion.
  const shell = await load(page);
  expect(shell.consoleErrors, 'no console errors on the unauthenticated shell').toEqual([]);
  expect(shell.pageErrors, 'no uncaught page errors on the unauthenticated shell').toEqual([]);
  expect(await page.evaluate(() => window.__cspViolations), 'no CSP violations on the shell').toEqual([]);

  // After authenticating, the page loads every operational panel, and some of them legitimately report a
  // state rather than data: this stack plants NO promotion records, so /api/promotion-chain answers 503 and
  // the browser logs a console error for it. That is the shipped behaviour of a panel this gate is not
  // about, and asserting "no console errors" here would either fail on it or push us into planting a record
  // to keep an unrelated panel quiet. So the assertion is about THIS gate's subject, precisely: no uncaught
  // error, no CSP violation, and every catalog response a 200.
  const collected = await loadWithToken(page);
  expect(collected.pageErrors, 'no uncaught page errors after authenticating').toEqual([]);
  expect(await page.evaluate(() => window.__cspViolations), 'no CSP violations after authenticating').toEqual([]);
  const catalogResponses = collected.responses.filter((r) => r.url.includes('/api/catalog'));
  expect(catalogResponses.length, 'the catalog was actually requested').toBeGreaterThan(0);
  expect(catalogResponses.filter((r) => r.status !== 200), 'every catalog response is a 200').toEqual([]);
});

test('@empty the Import panel is the one panel that writes, and says so before anything is clicked', async ({ page }) => {
  await loadWithToken(page);

  // It is marked structurally, in words, and by the disabled control — not by colour alone.
  await expect(page.locator('#import-panel')).toHaveClass(/writes/);
  await expect(page.locator('#import-panel')).toContainText('only panel on this page that changes anything');
  await expect(page.locator('#impApply')).toBeDisabled();

  // It discovered the snapshot the operator put in the READ-ONLY import folder, and nothing else.
  const options = await page.locator('#impFile option').allTextContents();
  expect(options.some((o) => o.includes(SNAPSHOT)), 'the inbox listed the acceptance snapshot').toBe(true);
  // There is no way to name a path, fetch a URL or upload a file from this page.
  expect(await page.locator('#import-panel input[type="file"]').count(), 'no file upload control').toBe(0);
  expect(await page.locator('#import-panel input[type="url"]').count(), 'no URL control').toBe(0);
  expect(await page.locator('#import-panel input[type="text"]').count(), 'no free-text path control').toBe(0);

  // Nothing has been imported yet, so the history says so rather than being empty and silent.
  await expect(page.locator('#impHistory')).toContainText('No import has been applied');
});

// -----------------------------------------------------------------------------------------------------------
// LEG — the preview. Run on the still-empty installation; the orchestrator counts rows either side of it.
// -----------------------------------------------------------------------------------------------------------

test('@preview previewing a snapshot in the browser reports what it would do, and writes nothing', async ({ page }) => {
  await loadWithToken(page);
  await previewInBrowser(page);

  await expect(page.locator('#impTotal')).toHaveText(String(RECORD_COUNT));
  await expect(page.locator('#impCreate')).toHaveText(String(RECORD_COUNT));
  await expect(page.locator('#impSame')).toHaveText('0');
  await expect(page.locator('#impBlocked')).toHaveText('0');
  await expect(page.locator('#impStatus')).toContainText('Nothing was written');
  // Only now is apply enabled, and it says what it is bound to.
  await expect(page.locator('#impApply')).toBeEnabled();
  await expect(page.locator('#impStatus')).toContainText('bound to this exact file');

  // The catalog is still empty: a preview is a read.
  await expect(page.locator('#catTotal')).toHaveText('0');
  await expect(page.locator('#catState')).toHaveText('EMPTY');

  // And the preview echoed no content of any kind.
  const panel = (await page.locator('#import-panel').textContent()) ?? '';
  expect(panel.includes(SECRET_REF), 'the preview never shows a provider reference value').toBe(false);
  expect(panel.includes('Acceptance Fixture'), 'the preview never echoes a title').toBe(false);
});

test('@preview choosing a different file disarms the confirmation', async ({ page }) => {
  await loadWithToken(page);
  await previewInBrowser(page);
  await expect(page.locator('#impApply')).toBeEnabled();

  // The shipped example snapshot is in the same folder, placed there by the orchestrator.
  await page.locator('#impFile').selectOption('example-catalog-snapshot.json');
  await expect(page.locator('#impApply')).toBeDisabled();
  await expect(page.locator('#impStatus')).toContainText('Preview it before applying it');
});

// -----------------------------------------------------------------------------------------------------------
// LEG — the apply. The one write this whole acceptance performs through a browser.
// -----------------------------------------------------------------------------------------------------------

test('@apply applying the previewed snapshot imports exactly the previewed records', async ({ page }) => {
  await loadWithToken(page);
  await previewInBrowser(page);
  await expect(page.locator('#impCreate')).toHaveText(String(RECORD_COUNT));

  await page.locator('#impApply').click();
  await expect(page.locator('#impStatus')).toContainText('Imported', { timeout: 60_000 });
  await expect(page.locator('#impStatus')).toContainText(`${RECORD_COUNT} created`);

  // The catalog reloaded itself as part of the apply, and now holds exactly those records.
  await expect(page.locator('#catTotal')).toHaveText(String(RECORD_COUNT), { timeout: 30_000 });
  await expect(page.locator('#catState')).toHaveText('RESULTS');

  // The apply is spent: the button is disarmed until another preview is read.
  await expect(page.locator('#impApply')).toBeDisabled();

  // And it recorded itself, durably.
  await expect(page.locator('#impHistory')).toContainText('operator-ui');
  await expect(page.locator('#impHistory')).toContainText(SNAPSHOT);

  const panel = (await page.locator('#import-panel').textContent()) ?? '';
  expect(panel.includes(SECRET_REF), 'the apply never shows a provider reference value').toBe(false);
});

// -----------------------------------------------------------------------------------------------------------
// LEG 2 — the imported catalog. Run AFTER the browser apply.
// -----------------------------------------------------------------------------------------------------------

test('@imported the imported records are counted, listed and paged', async ({ page }) => {
  await loadWithToken(page);

  await expect(page.locator('#catTotal')).toHaveText(String(RECORD_COUNT));
  await expect(page.locator('#catMatched')).toHaveText(String(RECORD_COUNT));
  await expect(page.locator('#catState')).toHaveText('RESULTS');
  // The default page size is 25, so a 28-record catalog is two pages.
  await expect(page.locator('#catPage')).toHaveText('1 of 2');
  await expect(page.locator('#catResults > li')).toHaveCount(25);

  const firstPage = await page.locator('#catResults button').allTextContents();
  await page.locator('#catNext').click();
  await expect(page.locator('#catPage')).toHaveText('2 of 2');
  await expect(page.locator('#catResults > li')).toHaveCount(RECORD_COUNT - 25);
  const secondPage = await page.locator('#catResults button').allTextContents();

  // Paging shows each record once: no repeat across the boundary, no record skipped.
  const overlap = secondPage.filter((row) => firstPage.includes(row));
  expect(overlap, 'no record appears on both pages').toEqual([]);
  expect(new Set([...firstPage, ...secondPage]).size).toBe(RECORD_COUNT);

  await page.locator('#catPrev').click();
  await expect(page.locator('#catPage')).toHaveText('1 of 2');
});

test('@imported search, a provider-reference filter and a descending title sort all work over encrypted data', async ({ page }) => {
  await loadWithToken(page);

  // Search — a substring of one record's title.
  await page.locator('#catSearch').fill('Hostile');
  await page.locator('#catApply').click();
  await expect(page.locator('#catMatched')).toHaveText('1');
  await expect(page.locator('#catTotal')).toHaveText(String(RECORD_COUNT), { timeout: 10_000 });
  await expect(page.locator('#catResults > li')).toHaveCount(1);

  // A search that matches nothing says so, and does not pretend the catalog is empty.
  await page.locator('#catSearch').fill('no-record-has-this-in-its-title');
  await page.locator('#catApply').click();
  await expect(page.locator('#catState')).toHaveText('NO_MATCH');
  await expect(page.locator('#catTotal')).toHaveText(String(RECORD_COUNT));

  // Clear puts everything back.
  await page.locator('#catReset').click();
  await expect(page.locator('#catMatched')).toHaveText(String(RECORD_COUNT));

  // Filter by provider reference TYPE — exactly one record in the snapshot carries an imdb reference.
  await page.locator('#catRefType').selectOption('imdb');
  await page.locator('#catApply').click();
  await expect(page.locator('#catMatched')).toHaveText('1');
  await expect(page.locator('#catResults')).toContainText('Zulu Acceptance Fixture 26');

  await page.locator('#catReset').click();
  await expect(page.locator('#catMatched')).toHaveText(String(RECORD_COUNT));

  // Sort by title, Z to A. The fixture's only Z-titled record leads.
  await page.locator('#catSort').selectOption('title|desc');
  await page.locator('#catApply').click();
  await expect(page.locator('#catResults button').first()).toContainText('Zulu Acceptance Fixture 26');

  // A year range narrows it, and the bounds are inclusive.
  await page.locator('#catReset').click();
  await page.locator('#catYearFrom').fill('1991');
  await page.locator('#catYearTo').fill('1993');
  await page.locator('#catApply').click();
  await expect(page.locator('#catMatched')).toHaveText('3');
});

test('@imported a record opens in detail, showing the operator their own data and no reference value', async ({ page }) => {
  await loadWithToken(page);

  await page.locator('#catSearch').fill('Zulu Acceptance Fixture 26');
  await page.locator('#catApply').click();
  await expect(page.locator('#catResults > li')).toHaveCount(1);
  await page.locator('#catResults button').first().click();

  const detail = page.locator('#catDetail');
  await expect(detail).toContainText('Zulu Acceptance Fixture 26');
  await expect(detail).toContainText('2016');
  // The operator's own identifiers and notes are shown back to them.
  await expect(detail).toContainText('acceptance-26');
  await expect(detail).toContainText('the only imdb record');
  // The provider reference is present as a TYPE and a fingerprint. The value is not shown, and saying so is
  // part of the product's promise.
  await expect(detail).toContainText('imdb reference');
  await expect(detail).toContainText('the value is never shown');
  expect((await detail.textContent()).includes(SECRET_REF), 'the detail view never shows the reference value').toBe(false);
});

test('@imported a hostile title is rendered as text and does not execute', async ({ page }) => {
  await loadWithToken(page);

  await page.locator('#catSearch').fill('Hostile');
  await page.locator('#catApply').click();
  await expect(page.locator('#catResults > li')).toHaveCount(1);

  // The row carries the markup VERBATIM, as text — mangling a legitimate title would prove nothing.
  const rowText = await page.locator('#catResults button').first().textContent();
  expect(rowText.includes(HOSTILE_FRAGMENT), 'the hostile title survives intact as text').toBe(true);
  // ...and there is no element in the list that the markup would have created.
  expect(await page.locator('#catResults img').count(), 'no img element was created from the title').toBe(0);
  expect(await page.locator('#catResults script').count(), 'no script element was created from the title').toBe(0);

  await page.locator('#catResults button').first().click();
  await expect(page.locator('#catDetail')).toContainText(HOSTILE_FRAGMENT);
  expect(await page.locator('#catDetail script').count(), 'the metadata value created no script element').toBe(0);

  // Nothing executed, in the list or the detail view.
  expect(await page.evaluate(() => window.__catXss === 1), 'the hostile title did not execute').toBe(false);
  expect(await page.evaluate(() => window.__cspViolations), 'and no CSP violation was even needed').toEqual([]);
});

test('@imported the catalog routes require the operator token', async ({ page }) => {
  // No token at all.
  for (const route of ['/api/catalog', '/api/catalog/item?id=00000000-0000-4000-8000-000000000000']) {
    const res = await page.request.get(`${BASE_URL}${route}`);
    expect(res.status(), `${route} is 401 without a token`).toBe(401);
    expect((await res.text()).includes(SECRET_REF)).toBe(false);
  }
  // A wrong token of the same length exercises the constant-time compare.
  const wrong = 'x'.repeat(TOKEN.length);
  const refused = await page.request.get(`${BASE_URL}/api/catalog`, { headers: { 'x-operator-ui-secret': wrong } });
  expect(refused.status(), 'a same-length wrong token is refused').toBe(401);
  // GET only.
  for (const method of ['post', 'put', 'patch', 'delete']) {
    const res = await page.request[method](`${BASE_URL}/api/catalog`, { headers: { 'x-operator-ui-secret': TOKEN } });
    expect(res.status(), `${method.toUpperCase()} /api/catalog is refused`).toBe(405);
    expect(res.headers()['allow']).toBe('GET');
  }
  // With the token it answers, and the body still carries no reference value.
  const ok = await page.request.get(`${BASE_URL}/api/catalog`, { headers: { 'x-operator-ui-secret': TOKEN } });
  expect(ok.status()).toBe(200);
  const body = await ok.text();
  expect(body.includes(SECRET_REF), 'the API response carries no reference value').toBe(false);
  expect(JSON.parse(body).total).toBe(RECORD_COUNT);
});

test('@imported browsing the catalog persists nothing in the browser and leaks no value', async ({ page, context }) => {
  const collected = await loadWithToken(page);
  // Drive a real browse before checking: search, page, and open a detail view.
  await page.locator('#catSearch').fill('Acceptance');
  await page.locator('#catApply').click();
  await expect(page.locator('#catMatched')).not.toHaveText('-');
  await page.locator('#catResults button').first().click();
  await expect(page.locator('#catDetail')).toContainText('Identifier');

  // The token is in no persisted surface, and neither is the catalog.
  const cookies = await context.cookies();
  expect(cookies.length, 'no cookies at all').toBe(0);
  const storage = await page.evaluate(async () => {
    const dbs = window.indexedDB && indexedDB.databases ? await indexedDB.databases() : [];
    return {
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
      localLen: window.localStorage.length,
      sessionLen: window.sessionStorage.length,
      idbCount: dbs.length,
    };
  });
  expect(storage.localLen, 'localStorage is empty').toBe(0);
  expect(storage.sessionLen, 'sessionStorage is empty').toBe(0);
  expect(storage.idbCount, 'no IndexedDB database was created').toBe(0);
  expect(storage.local.includes(TOKEN)).toBe(false);
  expect(storage.session.includes(TOKEN)).toBe(false);
  expect(storage.local.includes('Acceptance Fixture'), 'no catalog record is persisted').toBe(false);
  expect(storage.session.includes('Acceptance Fixture'), 'no catalog record is persisted').toBe(false);

  // The address bar never carries the token or a query.
  expect(page.url().includes(TOKEN)).toBe(false);
  expect(page.url().includes('?')).toBe(false);

  // Requests: same-origin only, the token never in a URL or a body, and every catalog response body free of
  // the provider reference value.
  for (const req of collected.requests) {
    expect(new URL(req.url).host, 'same-origin').toBe(ORIGIN);
    expect(req.url.includes(TOKEN), 'no request URL carries the token').toBe(false);
    expect(req.post.includes(TOKEN), 'no request body carries the token').toBe(false);
  }
  expect(collected.bodies.length, 'catalog responses were observed').toBeGreaterThan(0);
  for (const body of collected.bodies) {
    expect(body.includes(SECRET_REF), 'no catalog response carries the reference value').toBe(false);
  }

  // The whole document, serialized, contains neither the token nor the reference value.
  const serialized = await page.evaluate(() => document.documentElement.outerHTML);
  expect(serialized.includes(TOKEN)).toBe(false);
  expect(serialized.includes(SECRET_REF)).toBe(false);

  // A reload leaves an empty token field and an unloaded catalog — nothing survived the document.
  await page.reload({ waitUntil: 'networkidle' });
  expect(await page.locator('#token').inputValue()).toBe('');
  await expect(page.locator('#catState')).toHaveText('-');
  await expect(page.locator('#catResults')).toContainText('Not loaded.');
});

test('@imported browsing produces no console error, no CSP violation and no cross-origin request', async ({ page }) => {
  const collected = await loadWithToken(page);
  await page.locator('#catSort').selectOption('title|asc');
  await page.locator('#catApply').click();
  await expect(page.locator('#catResults > li').first()).toBeVisible();
  await page.locator('#catNext').click();
  await expect(page.locator('#catPage')).toHaveText('2 of 2');

  expect(collected.pageErrors, 'no uncaught page errors while browsing').toEqual([]);
  expect(await page.evaluate(() => window.__cspViolations), 'no CSP violations while browsing').toEqual([]);
  // As in the empty leg: the promotion-chain panel legitimately answers 503 on a stack with no records, so
  // the assertion is about the catalog's own responses rather than about every panel on the page.
  const catalogResponses = collected.responses.filter((r) => r.url.includes('/api/catalog'));
  expect(catalogResponses.length, 'the catalog was actually requested').toBeGreaterThan(0);
  expect(catalogResponses.filter((r) => r.status !== 200), 'every catalog response is a 200').toEqual([]);
  for (const req of collected.requests) {
    expect(req.url.startsWith('https://'), 'no mixed content on the loopback stack').toBe(false);
  }
});

// -----------------------------------------------------------------------------------------------------------
// LEG — the Phase 265 workspace: export, history, page size and the source filter.
// -----------------------------------------------------------------------------------------------------------

test('@workspace the catalog exports as a sanitized, downloadable snapshot that discloses no reference value', async ({ page }) => {
  await loadWithToken(page);
  await expect(page.locator('#catTotal')).toHaveText(String(RECORD_COUNT));

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.locator('#catExport').click(),
  ]);
  // The file name comes from a closed grammar the service builds; nothing a browser sent chose it.
  expect(download.suggestedFilename(), 'the download has a safe, fixed-grammar name')
    .toMatch(/^catalog-export-[a-z0-9][a-z0-9._-]*\.json$/);

  const body = readFileSync(await download.path(), 'utf8');
  const parsed = JSON.parse(body);
  expect(parsed.format, 'the export is a snapshot document').toBe('catalog-authority.snapshot');
  expect(parsed.version).toBe(1);
  expect(Array.isArray(parsed.items) && parsed.items.length, 'the export carries every record').toBe(RECORD_COUNT);
  // The whole point: not one provider reference value, and not the structure either.
  expect(body.includes(SECRET_REF), 'the export discloses a provider reference value').toBe(false);
  expect(body.includes('providerRefs'), 'the export carries a reference structure').toBe(false);
  expect(body.includes(TOKEN), 'the export carries the operator token').toBe(false);
  // The panel says what was left out rather than producing a file that looks complete.
  await expect(page.locator('#catExportStatus')).toContainText('provider reference');
  await expect(page.locator('#catExportStatus')).toContainText('Nothing was written');
});

test('@workspace the import history is durable, identity-free, and shown back to the operator', async ({ page }) => {
  await loadWithToken(page);
  const history = (await page.locator('#impHistory').textContent()) ?? '';
  expect(history.includes('operator-ui'), 'the history names the surface that did it').toBe(true);
  expect(history.includes(SNAPSHOT), 'the history names the file').toBe(true);
  expect(history.includes(SECRET_REF), 'the history holds a provider reference value').toBe(false);
  expect(history.includes('Acceptance Fixture'), 'the history holds a title').toBe(false);
  expect(history.includes('/var/lib'), 'the history holds a container path').toBe(false);

  // The API agrees, and carries the same bounded, identity-free shape.
  const res = await page.request.get(`${BASE_URL}/api/import/history`, { headers: { 'x-operator-ui-secret': TOKEN } });
  expect(res.status()).toBe(200);
  const raw = await res.text();
  expect(raw.includes(SECRET_REF)).toBe(false);
  expect(JSON.parse(raw).entries.length).toBeGreaterThan(0);
});

test('@workspace page size and the source filter work, and an out-of-range value is reported not honoured', async ({ page }) => {
  await loadWithToken(page);
  await page.locator('#catPageSize').selectOption('50');
  await page.locator('#catApply').click();
  await expect(page.locator('#catPage')).toHaveText('1 of 1');
  await expect(page.locator('#catResults > li')).toHaveCount(RECORD_COUNT);

  // The source the snapshot declared is offered, and narrows to it.
  const sources = await page.locator('#catSource option').allTextContents();
  expect(sources.length, 'the source filter offers what this installation holds').toBeGreaterThan(1);
  await page.locator('#catSource').selectOption({ index: 1 });
  await page.locator('#catApply').click();
  await expect(page.locator('#catMatched')).toHaveText(String(RECORD_COUNT));

  // Bounds: an out-of-range page size falls back and SAYS it was ignored, rather than being honoured.
  const res = await page.request.get(`${BASE_URL}/api/catalog?pageSize=100000&page=0`, {
    headers: { 'x-operator-ui-secret': TOKEN },
  });
  const body = JSON.parse(await res.text());
  expect(body.pageSize).toBe(25);
  expect(body.page).toBe(1);
  expect(body.ignored.length).toBeGreaterThanOrEqual(2);
});

test('@workspace the import routes require the token, are POST-only, and refuse a cross-origin write', async ({ page }) => {
  for (const route of ['/api/import/inbox', '/api/import/history']) {
    expect((await page.request.get(`${BASE_URL}${route}`)).status(), `${route} is 401 without a token`).toBe(401);
  }
  for (const route of ['/api/import/preview', '/api/import/apply']) {
    const noToken = await page.request.post(`${BASE_URL}${route}`, { data: { file: SNAPSHOT } });
    expect(noToken.status(), `${route} is 401 without a token`).toBe(401);

    const wrongMethod = await page.request.get(`${BASE_URL}${route}`, { headers: { 'x-operator-ui-secret': TOKEN } });
    expect(wrongMethod.status(), `${route} refuses GET`).toBe(405);
    expect(wrongMethod.headers()['allow']).toBe('POST');

    const form = await page.request.post(`${BASE_URL}${route}`, {
      headers: { 'x-operator-ui-secret': TOKEN, 'content-type': 'application/x-www-form-urlencoded' },
      data: `file=${SNAPSHOT}`,
    });
    expect(form.status(), `${route} refuses a form post`).toBe(400);

    const cross = await page.request.post(`${BASE_URL}${route}`, {
      headers: { 'x-operator-ui-secret': TOKEN, 'content-type': 'application/json', origin: 'http://evil.example' },
      data: { file: SNAPSHOT },
    });
    expect(cross.status(), `${route} refuses a cross-origin write`).toBe(403);
  }

  // A path is not a name: the inbox is the only place a snapshot can come from.
  for (const file of ['../../etc/passwd', '/etc/passwd', 'subdir/nested.json', '..']) {
    const res = await page.request.post(`${BASE_URL}/api/import/preview`, {
      headers: { 'x-operator-ui-secret': TOKEN, 'content-type': 'application/json' },
      data: { file },
    });
    expect(res.status(), `a path (${file}) is refused`).toBe(400);
    expect((await res.text()).includes('/etc'), 'the refusal echoed the path').toBe(false);
  }

  // A forged confirmation is refused, with nothing written.
  const forged = await page.request.post(`${BASE_URL}/api/import/apply`, {
    headers: { 'x-operator-ui-secret': TOKEN, 'content-type': 'application/json' },
    data: { file: SNAPSHOT, confirmation: 'ZmFrZQ.ZmFrZQ' },
  });
  expect(forged.status(), 'a forged confirmation is refused').toBe(409);
  expect((await forged.text()).includes('CONFIRMATION_')).toBe(true);
});

// -----------------------------------------------------------------------------------------------------------
// LEG — applying the same snapshot again, through the browser. Idempotent, and still recorded.
// -----------------------------------------------------------------------------------------------------------

test('@reapply applying the same snapshot again changes nothing, and says so', async ({ page }) => {
  await loadWithToken(page);
  await previewInBrowser(page);

  await expect(page.locator('#impCreate')).toHaveText('0');
  await expect(page.locator('#impSame')).toHaveText(String(RECORD_COUNT));
  await page.locator('#impApply').click();
  await expect(page.locator('#impStatus')).toContainText('Nothing changed', { timeout: 60_000 });
  await expect(page.locator('#catTotal')).toHaveText(String(RECORD_COUNT), { timeout: 30_000 });
});

// -----------------------------------------------------------------------------------------------------------
// LEG — after a full stop/start. The data AND the history are still there.
// -----------------------------------------------------------------------------------------------------------

test('@survived the records and the import history survive a full stop and start', async ({ page }) => {
  await loadWithToken(page);
  await expect(page.locator('#catTotal')).toHaveText(String(RECORD_COUNT));
  await expect(page.locator('#catState')).toHaveText('RESULTS');
  // Both applies are still recorded: the history outlived the container that wrote it.
  const res = await page.request.get(`${BASE_URL}/api/import/history`, { headers: { 'x-operator-ui-secret': TOKEN } });
  expect(res.status()).toBe(200);
  const entries = JSON.parse(await res.text()).entries;
  expect(entries.length, 'both browser applies are still in the history').toBeGreaterThanOrEqual(2);
  expect(entries.every((e) => e.actor === 'operator-ui' || e.actor === 'cli'), 'the actors survived').toBe(true);

  // A record still opens, and still shows no reference value.
  await page.locator('#catSearch').fill('Zulu Acceptance Fixture 26');
  await page.locator('#catApply').click();
  await expect(page.locator('#catResults > li')).toHaveCount(1);
  await page.locator('#catResults button').first().click();
  await expect(page.locator('#catDetail')).toContainText('the value is never shown');
  expect(((await page.locator('#catDetail').textContent()) ?? '').includes(SECRET_REF)).toBe(false);
});
