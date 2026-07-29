import { expect, test } from '@playwright/test';

// Phase 266-268 — the Jellyfin control plane, in a real browser against a real Compose stack and a real
// (fake) media server.
//
// WHAT ONLY THIS LEG CAN PROVE. The unit suites drive the modules; this drives the PAGE. It is the only place
// that shows the panel a person actually uses: that a disabled connector reads as a state rather than a
// fault, that discovery names no media, that a preview is visibly a preview, that the queue button stays
// disabled until the operator has typed the plan's own digest back, and that looking at all of it changes
// nothing.
//
// EVERY LEG IS TAGGED, and the orchestrator runs them one at a time in a fixed order with database counts
// read between them. A leg that ran zero tests is a failed leg, checked by the orchestrator from Playwright's
// own report rather than trusted.

const TOKEN = process.env.OPERATOR_UI_ACCEPTANCE_TOKEN ?? '';
const SECRET_REF = process.env.CATALOG_ACCEPTANCE_SECRET_REF ?? 'tt-jellyfin-acceptance-ref-1';

async function signIn(page) {
  await page.goto('/');
  await page.fill('#token', TOKEN);
  await page.click('#refresh');
  await expect(page.locator('#statusText')).not.toHaveText('Loading...', { timeout: 30_000 });
}

/** Everything the page has on screen, for the "nothing forbidden is visible" scans. */
async function pageText(page) {
  return page.locator('body').innerText();
}

test.describe('Jellyfin control plane', () => {
  test('@jf-disabled the panel exists, and a stack with writes off says so and refuses to queue', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('#jellyfin-panel')).toBeVisible();
    // Networking is ON for this run (the override sets it), so discovery connects; WRITES are off.
    await expect(page.locator('#jfState')).toHaveText('CONNECTED', { timeout: 30_000 });
    await expect(page.locator('#jfWrites')).toHaveText('off (default)');

    // The queue button is disabled before any preview, whatever the switches say.
    await expect(page.locator('#colExecute')).toBeDisabled();

    // The status panel says plainly that this installation may not act.
    await expect(page.locator('#colRunStatus')).toContainText('switched off');
  });

  test('@jf-discovery discovery counts, and names no media item and no foreign collection', async ({ page }) => {
    await signIn(page);
    await page.click('#jfCheck');
    await expect(page.locator('#jfState')).toHaveText('CONNECTED', { timeout: 30_000 });
    await expect(page.locator('#jfLibraries')).toHaveText('2');
    // The fake server holds one collection this product did not create. It is COUNTED and never named.
    await expect(page.locator('#jfCollections')).not.toHaveText('-');
    const text = await pageText(page);
    for (const forbidden of ['Somebody elses private collection', 'jf-item-1', 'jf-lib-movies', 'jf-foreign-1',
      'fake-jellyfin-acceptance', 'fake-server-id', SECRET_REF, TOKEN]) {
      expect(text, `the page disclosed ${forbidden}`).not.toContain(forbidden);
    }
    // A version is a version, and it IS shown — it is the one thing about the server that helps and cannot
    // identify a host.
    await expect(page.locator('#jfVersion')).toHaveText('10.9.11');
  });

  /** The plan digest, located by its LABEL rather than by its position in the list. */
  async function planDigest(page) {
    return (await page.locator('#colDigests dt', { hasText: /^Plan digest$/ })
      .locator('xpath=following-sibling::dd[1]').first().innerText()).trim();
  }

  test('@jf-plan a plan preview shows what would happen, and says it wrote and contacted nothing', async ({ page }) => {
    await signIn(page);
    await page.fill('#colName', 'Acceptance picks');
    await page.fill('#colSearch', 'Acceptance Collection');
    await page.click('#colPreview');
    await expect(page.locator('#colPlanStatus')).toContainText('Nothing was written', { timeout: 30_000 });
    await expect(page.locator('#colPlanStatus')).toContainText('no media server was contacted');
    await expect(page.locator('#colSelected')).not.toHaveText('-');

    // The plan digest is on screen, in full, because it is what the operator has to type back. It is found
    // BY ITS LABEL rather than by position: the collection's own verdict now leads the list, and a positional
    // locator would silently start asserting about a different row.
    const digest = await planDigest(page);
    expect(digest, 'the plan digest is a full sha256').toMatch(/^[0-9a-f]{64}$/);

    // ONE PLAN IS ONE COLLECTION. The panel says which collection, and how many records it would hold.
    await expect(page.locator('#colDigests')).toContainText('This collection');
    await expect(page.locator('#colDigests')).toContainText('Would hold');

    // A plan never shows a provider reference value.
    const text = await pageText(page);
    expect(text).not.toContain(SECRET_REF);

    // The confirm box is EMPTY. A digest the page fills in for you confirms nothing.
    await expect(page.locator('#colConfirm')).toHaveValue('');
  });

  test('@jf-refused with writes off, queuing the exact plan is refused and nothing is queued', async ({ page }) => {
    await signIn(page);
    await page.fill('#colName', 'Acceptance picks');
    await page.fill('#colSearch', 'Acceptance Collection');
    await page.click('#colPreview');
    await expect(page.locator('#colPlanStatus')).toContainText('Nothing was written', { timeout: 30_000 });
    const digest = await planDigest(page);

    // A WRONG digest is refused by the page itself, before a request is made.
    await page.fill('#colConfirm', 'f'.repeat(64));
    await page.click('#colExecute');
    await expect(page.locator('#colExecuteStatus')).toContainText('not this plan');

    // The right digest reaches the server, and the server refuses because the switch is off.
    await page.fill('#colConfirm', digest);
    await page.click('#colExecute');
    await expect(page.locator('#colExecuteStatus')).toContainText('switched off', { timeout: 30_000 });
  });

  test('@jf-queue with writes on, the exact plan queues durable intents and says nothing was sent', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('#jfWrites')).toHaveText('ON', { timeout: 30_000 });
    await page.fill('#colName', 'Acceptance picks');
    await page.fill('#colSearch', 'Acceptance Collection');
    await page.click('#colPreview');
    await expect(page.locator('#colPlanStatus')).toContainText('Nothing was written', { timeout: 30_000 });
    const digest = await planDigest(page);

    await page.fill('#colConfirm', digest);
    await page.click('#colExecute');
    // ONE collection, holding the records that were chosen — not one collection per record.
    await expect(page.locator('#colExecuteStatus')).toContainText('One collection is now recorded as holding', { timeout: 30_000 });
    await expect(page.locator('#colExecuteStatus')).toContainText('Nothing has been sent to a media server yet');
    // The confirm box is cleared and the button re-disabled: one preview, one execute.
    await expect(page.locator('#colConfirm')).toHaveValue('');
    await expect(page.locator('#colExecute')).toBeDisabled();
    await expect(page.locator('#colOutstanding')).not.toHaveText('0');
  });

  test('@jf-reconcile a reconcile pass carries the queued work out, and a second one does nothing', async ({ page }) => {
    await signIn(page);
    await page.click('#colReconcile');
    await expect(page.locator('#colRunStatus')).toContainText('Created', { timeout: 60_000 });
    await expect(page.locator('#colOutstanding')).toHaveText('0', { timeout: 30_000 });
    await expect(page.locator('#colPublished')).not.toHaveText('0');

    await page.click('#colReconcile');
    // With no durable intent left, the execution preflight now returns the stronger no-work verdict instead
    // of entering a zero-effect run. This is the same terminal state the removal leg already asserts below.
    await expect(page.locator('#colRunStatus')).toContainText('Nothing is outstanding', { timeout: 60_000 });
  });

  test('@jf-history the durable history survived the restart, and still discloses nothing', async ({ page }) => {
    await signIn(page);
    const entries = page.locator('#colHistory li');
    await expect(entries.first()).not.toHaveText('Not loaded.', { timeout: 30_000 });
    // SOMEWHERE in the list, not first: the history is newest-first and the reconcile passes that ran after
    // the queue are newer than it. Asserting the first row would be asserting the order of the run rather
    // than the thing this leg is about — that the plan somebody confirmed is still recorded after a restart.
    await expect(page.locator('#colHistory')).toContainText('Acceptance picks');
    await expect(page.locator('#colHistory')).toContainText('queued');
    const text = await pageText(page);
    for (const forbidden of [SECRET_REF, TOKEN, 'jf-col-', 'jf-item-']) {
      expect(text, `the history disclosed ${forbidden}`).not.toContain(forbidden);
    }
    // And the outbox status is still what it was before the restart.
    await expect(page.locator('#colOutstanding')).toHaveText('0');
  });

  test('@jf-remove the panel removes a managed collection end to end, and proves it from the panel', async ({ page }) => {
    await signIn(page);

    // WHAT THIS LEG IS FOR. Not "the browser can queue a removal" — the browser can drive the WHOLE
    // lifecycle: preview, confirm by digest, queue, carry out, and then see for itself that the collection
    // is gone from the media server. An acceptance that queued in the panel and then finished the job with
    // curl would prove the queue and call it the lifecycle.

    // Where we start: the product's own read-only discovery says one collection out there is its own.
    await page.click('#jfCheck');
    await expect(page.locator('#jfState')).toHaveText('CONNECTED', { timeout: 30_000 });
    await expect(page.locator('#jfManagedCount')).toHaveText('1');
    await expect(page.locator('#jfManaged')).toContainText('Acceptance picks');

    await page.fill('#colName', 'Acceptance picks');
    // Revoke mode takes NO selection: the server refuses one, so the page must not send one either.
    await page.check('#colRemove');
    await page.click('#colPreview');
    await expect(page.locator('#colPlanStatus')).toContainText('Nothing was written', { timeout: 30_000 });
    await expect(page.locator('#colPlanStatus')).toContainText('no media server was contacted');
    // The plan says the COLLECTION goes, not merely that records leave it.
    await expect(page.locator('#colDigests')).toContainText('REVOKE');

    const digest = await planDigest(page);
    expect(digest, 'the revoke plan digest is a full sha256').toMatch(/^[0-9a-f]{64}$/);

    // A WRONG digest is refused by the page itself, before a request is made. A destructive plan is exactly
    // the one where that must hold.
    await page.fill('#colConfirm', 'f'.repeat(64));
    await page.click('#colExecute');
    await expect(page.locator('#colExecuteStatus')).toContainText('not this plan');

    // The right digest queues the removal — and STILL sends nothing. Queuing is not doing, here too.
    await page.fill('#colConfirm', digest);
    await page.click('#colExecute');
    await expect(page.locator('#colExecuteStatus')).toContainText('queued for removal', { timeout: 30_000 });
    await expect(page.locator('#colExecuteStatus')).toContainText('Nothing has been sent yet');
    await expect(page.locator('#colConfirm')).toHaveValue('');
    await expect(page.locator('#colExecute')).toBeDisabled();
    await expect(page.locator('#colUnrevoked')).toHaveText('1', { timeout: 30_000 });

    // AND THE PANEL PROVES IT SENT NOTHING, by asking the media server: the collection is still there.
    await page.click('#jfCheck');
    await expect(page.locator('#jfManagedCount')).toHaveText('1', { timeout: 30_000 });
    await expect(page.locator('#jfManaged')).toContainText('Acceptance picks');

    // Now carry it out, from the panel's own control.
    await page.click('#colRevokeBtn');
    // runCollectionPass refreshes status after the response, so the stable visible completion contract is
    // the refreshed zero-outstanding state rather than the transient response guidance.
    await expect(page.locator('#colRunStatus')).toContainText('Nothing is outstanding', { timeout: 60_000 });
    await expect(page.locator('#colUnrevoked')).toHaveText('0', { timeout: 30_000 });

    // THE BROWSER VERIFIES ABSENCE ITSELF, through the same read-only discovery surface it started from —
    // not through a shell command reading the fixture behind the product's back.
    await page.click('#jfCheck');
    await expect(page.locator('#jfState')).toHaveText('CONNECTED', { timeout: 30_000 });
    await expect(page.locator('#jfManagedCount')).toHaveText('0', { timeout: 30_000 });
    await expect(page.locator('#jfManaged')).not.toContainText('Acceptance picks');
    // The collection this product did NOT create is still there and still unnamed: a revoke removes what
    // this installation owns, and nothing else.
    await expect(page.locator('#jfCollections')).toHaveText('1');

    const text = await pageText(page);
    for (const forbidden of [SECRET_REF, TOKEN, 'jf-col-', 'jf-item-', 'Somebody elses private collection']) {
      expect(text, `the removal leg disclosed ${forbidden}`).not.toContain(forbidden);
    }
  });
});
