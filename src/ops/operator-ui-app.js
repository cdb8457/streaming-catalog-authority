// Catalog Authority operator UI — behaviour.
//
// Phase 247 moved this out of an inline script block so the page's Content-Security-Policy can be
// `script-src 'self'` with no `'unsafe-inline'`. It is served verbatim from /assets/app.js as a fixed,
// same-origin static asset. See docs/PHASE_247_CSP_HARDENING.md.
//
// TOKEN MODEL, UNCHANGED. The operator token lives in exactly one place: the value of the password input.
// It is never assigned to a variable, a global, storage, a cookie or a URL. It is read at the moment a
// request is made, sent as the `x-operator-ui-secret` request header, and nowhere else. This file is wrapped
// in an IIFE so not even the element handles leak onto `window` — there is nothing on the global object a
// bookmarklet or an extension could read a token off.
//
// EVERYTHING DYNAMIC IS textContent. No value returned by any endpoint is ever assigned to innerHTML or
// parsed as markup, so a hostile string that somehow reached a payload is shown as the text it is and can
// never execute. The only innerHTML write in this file assigns the empty string.
//
// The header name below is the literal value of OPERATOR_UI_LOCAL_AUTH_HEADER. It is asserted equal at
// startup by operator-ui-assets.ts and in the Phase 247 tests, so the two cannot drift.
(function () {
  'use strict';
  var AUTH_HEADER = 'x-operator-ui-secret';

  var token = document.getElementById('token');
  var statusText = document.getElementById('statusText');
  var service = document.getElementById('service');
  var mode = document.getElementById('mode');
  var doctor = document.getElementById('doctor');
  var port = document.getElementById('port');
  var passCount = document.getElementById('passCount');
  var warnCount = document.getElementById('warnCount');
  var failCount = document.getElementById('failCount');
  var logCount = document.getElementById('logCount');
  var attention = document.getElementById('attention');
  var checks = document.getElementById('checks');
  var logs = document.getElementById('logs');
  var chainOutcome = document.getElementById('chainOutcome');
  var chainReaches = document.getElementById('chainReaches');
  var chainNext = document.getElementById('chainNext');
  var chainBlockerCount = document.getElementById('chainBlockerCount');
  var chainHeadline = document.getElementById('chainHeadline');
  var chainCaveat = document.getElementById('chainCaveat');
  var chainArtifacts = document.getElementById('chainArtifacts');
  var chainBlockers = document.getElementById('chainBlockers');
  var chainSteps = document.getElementById('chainSteps');
  var chainLimits = document.getElementById('chainLimits');
  var verdict = document.getElementById('verdict');
  var verdictHeadline = document.getElementById('verdictHeadline');
  var authorizationNote = document.getElementById('authorizationNote');
  var verVersion = document.getElementById('verVersion');
  var verProvenance = document.getElementById('verProvenance');
  var verAgreement = document.getElementById('verAgreement');
  var verPin = document.getElementById('verPin');
  var components = document.getElementById('components');
  var nextSteps = document.getElementById('nextSteps');
  var artifactSummary = document.getElementById('artifactSummary');
  var advisories = document.getElementById('advisories');
  var evidenceNote = document.getElementById('evidenceNote');
  var supportReport = document.getElementById('supportReport');
  var supportStatus = document.getElementById('supportStatus');
  var catTotal = document.getElementById('catTotal');
  var catMatched = document.getElementById('catMatched');
  var catPageEl = document.getElementById('catPage');
  var catState = document.getElementById('catState');
  var catSearch = document.getElementById('catSearch');
  var catSort = document.getElementById('catSort');
  var catRefType = document.getElementById('catRefType');
  var catYearFrom = document.getElementById('catYearFrom');
  var catYearTo = document.getElementById('catYearTo');
  var catGuidance = document.getElementById('catGuidance');
  var catTruncated = document.getElementById('catTruncated');
  var catResults = document.getElementById('catResults');
  var catDetail = document.getElementById('catDetail');
  var catSource = document.getElementById('catSource');
  var catPageSize = document.getElementById('catPageSize');
  var catExportStatus = document.getElementById('catExportStatus');
  var impFile = document.getElementById('impFile');
  var impInbox = document.getElementById('impInbox');
  var impApplyBtn = document.getElementById('impApply');
  var impStatus = document.getElementById('impStatus');
  var impTotal = document.getElementById('impTotal');
  var impCreate = document.getElementById('impCreate');
  var impSame = document.getElementById('impSame');
  var impBlocked = document.getElementById('impBlocked');
  var impNotes = document.getElementById('impNotes');
  var impHistory = document.getElementById('impHistory');
  var jfState = document.getElementById('jfState');
  var jfHostClass = document.getElementById('jfHostClass');
  var jfNetwork = document.getElementById('jfNetwork');
  var jfWrites = document.getElementById('jfWrites');
  var jfStatus = document.getElementById('jfStatus');
  var jfLibraries = document.getElementById('jfLibraries');
  var jfCollections = document.getElementById('jfCollections');
  var jfManagedCount = document.getElementById('jfManagedCount');
  var jfVersion = document.getElementById('jfVersion');
  var jfManaged = document.getElementById('jfManaged');
  var colName = document.getElementById('colName');
  var colSearch = document.getElementById('colSearch');
  var colUseShown = document.getElementById('colUseShown');
  var colPlanStatus = document.getElementById('colPlanStatus');
  var colSelected = document.getElementById('colSelected');
  var colCreate = document.getElementById('colCreate');
  var colUpdate = document.getElementById('colUpdate');
  var colRevoke = document.getElementById('colRevoke');
  var colDigests = document.getElementById('colDigests');
  var colActions = document.getElementById('colActions');
  var colConfirm = document.getElementById('colConfirm');
  var colExecuteBtn = document.getElementById('colExecute');
  var colExecuteStatus = document.getElementById('colExecuteStatus');
  var colOutstanding = document.getElementById('colOutstanding');
  var colUnrevoked = document.getElementById('colUnrevoked');
  var colPublished = document.getElementById('colPublished');
  var colRecovery = document.getElementById('colRecovery');
  var colRunStatus = document.getElementById('colRunStatus');
  var colHistory = document.getElementById('colHistory');
  // The only pieces of state this page keeps. The token is never stored anywhere, including here.
  var catalogPage = 1;
  var catalogPageCount = 1;
  // Phase 264. The confirmation the LAST preview issued, and the file it was issued for. Held together and
  // discarded together: a confirmation without the file it names cannot be used, and a file selection that
  // changes must not leave a previous file's confirmation armed. The server refuses a mismatch anyway — this
  // is so the button an operator sees agrees with what the server would do.
  var importConfirmation = null;
  var importConfirmedFile = null;
  var knownSources = [];
  // Phase 267/268. The plan the LAST preview returned, and the confirmation it was issued with. Held
  // together and discarded together, exactly like the import's file/confirmation pair: a confirmation
  // without the digest it names cannot be used, and a plan that has been queued must not leave the button
  // armed. The server refuses a mismatch anyway — this is so the button somebody is looking at agrees with
  // what the server would do.
  var collectionPlan = null;
  var collectionConfirmation = null;
  // The record ids the catalog panel is currently showing, so a plan can be built from exactly those.
  var catalogShownIds = [];

  // Error text an operator can act on. A bare "request failed" sends someone to the logs for a problem whose
  // answer is "you pasted a stale token"; the status code already knows which of those it is.
  function describeFailure(status, body) {
    if (status === 401) return 'The operator token was not accepted. Re-read ./secrets/operator_ui_token and paste it with no extra spaces or line breaks.';
    if (status === 0) return 'The server did not answer. Check that the stack is running, then press Load everything again.';
    return (body && (body.message || body.code)) || ('The request failed with status ' + status + '.');
  }
  async function getJson(path) {
    var value = token.value;
    var res;
    try {
      res = await fetch(path, { headers: { 'x-operator-ui-secret': value }, cache: 'no-store' });
    } catch (err) {
      throw new Error(describeFailure(0, null));
    }
    var body = await res.json().catch(function () { return null; });
    if (!res.ok) throw new Error(describeFailure(res.status, body));
    return body;
  }
  function renderStatus(data) {
    service.textContent = data.service || '-';
    mode.textContent = data.mode || '-';
    doctor.textContent = data.doctor && data.doctor.ok ? 'OK' : 'Needs attention';
    port.textContent = String(data.port || '-');
    passCount.textContent = String((data.doctorSummary && data.doctorSummary.pass) || 0);
    warnCount.textContent = String((data.doctorSummary && data.doctorSummary.warn) || 0);
    failCount.textContent = String((data.doctorSummary && data.doctorSummary.fail) || 0);
    var items = data.needsAttention || [];
    attention.replaceChildren();
    if (items.length === 0) {
      var li = document.createElement('li'); li.className = 'muted'; li.textContent = 'No warnings or failures.'; attention.appendChild(li);
    } else {
      for (var i = 0; i < items.length; i++) { var el = document.createElement('li'); el.textContent = items[i]; attention.appendChild(el); }
    }
    checks.textContent = (data.doctor.checks || []).map(function (c) { return c.state.toUpperCase() + '  ' + c.name + ': ' + c.detail; }).join('\n');
  }
  function renderLogs(data) {
    var entries = data.entries || [];
    logCount.textContent = String(entries.length);
    logs.textContent = entries.map(function (e) { return e.ts + ' ' + e.level.toUpperCase() + ' ' + e.class + ' ' + e.code + ' ' + e.message; }).join('\n') || 'No log entries.';
  }
  // Every list is built with createElement + textContent. Nothing served here is ever parsed as markup, so a
  // value that somehow reached this page could still never execute.
  function setList(target, items) {
    target.replaceChildren();
    if (items.length === 0) { var li = document.createElement('li'); li.className = 'muted'; li.textContent = 'None.'; target.appendChild(li); return; }
    for (var i = 0; i < items.length; i++) { var el = document.createElement('li'); el.textContent = items[i]; target.appendChild(el); }
  }
  // Some routes answer 503 with a COMPLETE, renderable body: the chain does it for a chain that does not hang
  // together and for a fresh install with no anchor yet, and /api/status does it whenever the doctor reports
  // any failing check. Every one of those is a state to SHOW, not a request failure to hide behind a banner.
  //
  // Phase 253 fix. Treating /api/status's 503 as a thrown error is what put "a dependency it needs is not
  // ready" across the top of a working installation: the body listing exactly which check failed was already
  // in hand and was thrown away in favour of a sentence that named nothing. Now the panel renders, the failing
  // checks are listed by name under Needs Attention, and the banner is reserved for a request that genuinely
  // produced no answer. Only a rejected token is an error here, because a rejected token has no body worth
  // rendering.
  async function getState(path) {
    var res;
    try {
      res = await fetch(path, { headers: { 'x-operator-ui-secret': token.value }, cache: 'no-store' });
    } catch (err) {
      throw new Error(describeFailure(0, null));
    }
    var body = await res.json().catch(function () { return null; });
    if (res.status === 401 || body === null) throw new Error(describeFailure(res.status, body));
    return body;
  }
  async function getChain() { return getState('/api/promotion-chain'); }
  function renderChain(data) {
    var view = data && data.view;
    if (!view) {
      chainOutcome.textContent = (data && data.availability) || 'UNAVAILABLE';
      chainReaches.textContent = '-'; chainNext.textContent = '-'; chainBlockerCount.textContent = '-';
      chainHeadline.textContent = 'No promotion record chain is readable yet.';
      chainCaveat.textContent = '';
      setList(chainArtifacts, (data && data.unavailableGuidance) || []);
      setList(chainBlockers, []); setList(chainSteps, []); setList(chainLimits, []);
      return;
    }
    chainOutcome.textContent = view.overall;
    chainHeadline.textContent = view.headline;
    chainCaveat.textContent = view.caveat;
    chainReaches.textContent = view.terminalPhase === null ? 'nothing yet' : 'Phase ' + view.terminalPhase;
    chainNext.textContent = view.nextRequiredPhase === null
      ? 'nothing further'
      : 'Phase ' + view.nextRequiredPhase + (view.nextIsUnfinished ? ' (present, not finished)' : '');
    chainBlockerCount.textContent = String(view.blockers.length);
    setList(chainArtifacts, view.artifacts.map(function (a) { return 'Phase ' + a.phase + ' - ' + a.status + ' - ' + a.detail; }));
    setList(chainBlockers, view.blockers.map(function (b) { return b.code + ' - ' + b.meaning + ' Do: ' + b.humanAction; }));
    setList(chainSteps, view.nextSteps);
    setList(chainLimits, view.proofLimits.map(function (l) { return 'Phase ' + l.phase + ' establishes: ' + l.establishes + ' It does NOT establish: ' + l.doesNotEstablish; }));
  }
  // READY_NO_RECORDS deliberately does NOT get the plain `ready` styling. The installation is operational and
  // the verdict says so, but a green badge over an empty evidence folder is the visual claim this surface must
  // never make — the words next to it are what carry "nothing has been audited", and the styling must not
  // argue with them.
  var VERDICT_CLASS = {
    READY: 'verdict ready',
    READY_NO_RECORDS: 'verdict setup',
    NEEDS_SETUP: 'verdict setup',
    DEGRADED: 'verdict degraded',
  };
  // What the badge says, in words rather than an identifier. The state id is still what a test and a support
  // report read; this is what a person reads.
  var VERDICT_LABEL = {
    READY: 'READY',
    READY_NO_RECORDS: 'READY - NO RECORDS LOADED',
    NEEDS_SETUP: 'NEEDS_SETUP',
    DEGRADED: 'DEGRADED',
  };
  // Built from the checklist the same response carried, so a step id can never render as a bare identifier.
  function renderInstallation(data) {
    var r = data.readiness;
    var steps = data.checklist || [];
    verdict.textContent = VERDICT_LABEL[r.state] || r.state;
    verdict.className = VERDICT_CLASS[r.state] || 'verdict';
    verdictHeadline.textContent = r.headline;
    authorizationNote.textContent = r.authorizationNote;
    // Always rendered, in both directions. An empty-folder install has to be told what its green-ish verdict
    // does not mean, and an install WITH records has to be told that reading them is not authorizing them.
    evidenceNote.textContent = r.evidenceNote || '';
    var v = r.version;
    verVersion.textContent = v.version || 'not declared';
    verProvenance.textContent = v.provenance;
    verAgreement.textContent = v.agreement;
    // A digest pin is the strongest thing the reference can say, so it is said first — including for a local
    // build that happens to be digest-pinned. Otherwise the tag, and only then the bare state.
    verPin.textContent = v.image.pinnedByDigest
      ? (v.image.state === 'LOCAL' ? 'digest (local build)' : 'digest')
      : (v.image.state === 'LOCAL' ? (v.image.tag ? v.image.tag + ' (local build)' : 'local build') : (v.image.tag || v.image.state.toLowerCase()));
    setList(components, r.components.map(function (c) { return c.title + ' - ' + c.state + ' - ' + c.detail; }));
    var byId = {};
    for (var s = 0; s < steps.length; s++) byId[steps[s].id] = steps[s];
    nextSteps.replaceChildren();
    if (r.nextSteps.length === 0) {
      var none = document.createElement('li'); none.className = 'muted';
      none.textContent = 'Nothing outstanding.'; nextSteps.appendChild(none);
    } else {
      for (var n = 0; n < r.nextSteps.length; n++) {
        var step = byId[r.nextSteps[n]]; if (!step) continue;
        var li = document.createElement('li');
        var title = document.createElement('strong'); title.textContent = step.title; li.appendChild(title);
        var why = document.createElement('p'); why.className = 'muted'; why.textContent = step.why; li.appendChild(why);
        if (step.commands) {
          var same = step.commands.posix === step.commands.windows;
          var pairs = same
            ? [['Any platform', step.commands.posix]]
            : [['Linux / macOS', step.commands.posix], ['Windows (PowerShell)', step.commands.windows]];
          for (var p = 0; p < pairs.length; p++) {
            var wrap = document.createElement('div'); wrap.className = 'cmd';
            var name = document.createElement('span'); name.textContent = pairs[p][0]; wrap.appendChild(name);
            var code = document.createElement('code'); code.textContent = pairs[p][1]; wrap.appendChild(code);
            li.appendChild(wrap);
          }
        }
        nextSteps.appendChild(li);
      }
    }
    artifactSummary.replaceChildren();
    var a = r.artifacts;
    var kv = a === null
      ? [['Artifacts', 'No readable chain yet.']]
      : [['Present', String(a.present) + ' of ' + String(a.expected)],
         ['Blockers', String(a.blockers)],
         ['Chain reaches', a.terminalPhase === null ? 'nothing yet' : 'Phase ' + a.terminalPhase],
         ['Outstanding next', a.nextRequiredPhase === null ? 'nothing further' : 'Phase ' + a.nextRequiredPhase]];
    for (var k = 0; k < kv.length; k++) {
      var dt = document.createElement('dt'); dt.textContent = kv[k][0]; artifactSummary.appendChild(dt);
      var dd = document.createElement('dd'); dd.textContent = kv[k][1]; artifactSummary.appendChild(dd);
    }
    setList(advisories, r.advisories);
  }
  // Phase 255. The report is rendered as TEXT, into a <pre>, exactly as the server rendered it — no
  // reformatting, no field picking, no re-serialising. What is on screen is what the CLI would print and what
  // gets pasted into an issue, so a difference between the three can never be introduced here.
  //
  // Whether a report is on screen is tracked as a FLAG rather than inferred from the text. Comparing against
  // a placeholder string is the kind of check that keeps working until somebody adds a second placeholder —
  // and the second one here says "No support report is available.", which a text comparison would happily
  // copy to the clipboard and call a report.
  var supportLoaded = false;
  function renderSupport(data) {
    supportReport.textContent = (data && data.text) || 'No support report loaded.';
    supportLoaded = Boolean(data && data.text);
    supportStatus.className = 'status';
    supportStatus.textContent = '';
  }
  // A refusal renders as a refusal. The server withholds the whole report rather than a redacted one, so the
  // panel must not leave the previous report on screen looking current.
  function renderSupportRefusal(message) {
    supportReport.textContent = 'No support report is available.';
    supportLoaded = false;
    supportStatus.className = 'status err';
    supportStatus.textContent = message;
  }
  // Copy, with a fallback that is not a lie.
  //
  // navigator.clipboard exists only in a SECURE CONTEXT. Plain HTTP to 127.0.0.1 counts as one; plain HTTP to
  // a LAN address does not — and reaching this UI over a LAN address is a documented, supported Unraid
  // configuration. So on exactly the installs whose operator is least likely to have a terminal handy, the
  // API is undefined and there is no way to make it exist from a page. A
  // button that silently does nothing there is worse than no button, so the fallback selects the report and
  // says which keys to press. Both paths report what happened; neither claims success it did not have.
  function selectReport() {
    if (typeof window === 'undefined' || !window.getSelection || !document.createRange) return false;
    var selection = window.getSelection();
    if (!selection) return false;
    var range = document.createRange();
    range.selectNodeContents(supportReport);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  function copySupport() {
    if (!supportLoaded) {
      supportStatus.className = 'status err';
      supportStatus.textContent = 'There is no report to copy yet. Paste your operator token and choose Load everything.';
      return;
    }
    var manual = 'This browser will not let a page write to the clipboard here, which is normal when the UI is '
      + 'reached over a plain-HTTP network address rather than 127.0.0.1. The report is selected: press '
      + 'Ctrl+C (Cmd+C on a Mac) to copy it.';
    if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.writeText) {
      supportStatus.className = 'status';
      supportStatus.textContent = selectReport() ? manual : 'Select the report below and copy it.';
      return;
    }
    navigator.clipboard.writeText(supportReport.textContent).then(function () {
      supportStatus.className = 'status ok-text';
      supportStatus.textContent = 'Copied. Paste it into your issue as it is — it is already safe to publish.';
    }, function () {
      supportStatus.className = 'status';
      supportStatus.textContent = selectReport() ? manual : 'Select the report below and copy it.';
    });
  }
  // Return every rendered panel to its unloaded placeholder. Clear must leave nothing on screen that a
  // previous token loaded — an operator who clears the token should not still be looking at this install's
  // component list, logs or chain.
  function resetOperationalState() {
    var metrics = [service, mode, doctor, port, passCount, warnCount, failCount, logCount,
      verVersion, verProvenance, verAgreement, verPin,
      chainOutcome, chainReaches, chainNext, chainBlockerCount];
    for (var m = 0; m < metrics.length; m++) metrics[m].textContent = '-';
    verdict.textContent = 'Not loaded'; verdict.className = 'verdict';
    verdictHeadline.textContent = 'Paste your operator token above and choose Load everything.';
    authorizationNote.textContent = '';
    evidenceNote.textContent = '';
    chainHeadline.textContent = ''; chainCaveat.textContent = '';
    checks.textContent = 'No status loaded.';
    logs.textContent = 'No logs loaded.';
    setList(attention, []); setList(components, []); setList(nextSteps, []); setList(advisories, []);
    setList(chainArtifacts, []); setList(chainBlockers, []); setList(chainSteps, []); setList(chainLimits, []);
    supportReport.textContent = 'No support report loaded.';
    supportLoaded = false;
    supportStatus.className = 'status'; supportStatus.textContent = '';
    artifactSummary.replaceChildren();
    var dt = document.createElement('dt'); dt.textContent = 'Artifacts'; artifactSummary.appendChild(dt);
    var dd = document.createElement('dd'); dd.textContent = 'Not loaded.'; artifactSummary.appendChild(dd);
    resetCatalog();
    resetImportPanel();
    resetCollectionPanel();
  }
  // ---------------------------------------------------------------------------------------------------------
  // Phase 260 — the catalog.
  //
  // Every value below is written with textContent, and the query is assembled with URLSearchParams so a
  // search term containing `&`, `#` or a quote is encoded rather than becoming another parameter. The record
  // id travels in a data attribute and is validated by the server before it reaches a database at all.
  // ---------------------------------------------------------------------------------------------------------
  function catalogQuery() {
    var params = new URLSearchParams();
    if (catSearch.value.trim() !== '') params.set('q', catSearch.value.trim());
    var sortPair = String(catSort.value || 'id|asc').split('|');
    params.set('sort', sortPair[0]);
    params.set('order', sortPair[1] || 'asc');
    if (catRefType.value !== '') params.set('refType', catRefType.value);
    if (catSource.value !== '') params.set('source', catSource.value);
    if (catYearFrom.value !== '') params.set('yearFrom', catYearFrom.value);
    if (catYearTo.value !== '') params.set('yearTo', catYearTo.value);
    params.set('page', String(catalogPage));
    params.set('pageSize', String(catPageSize.value || '25'));
    return '/api/catalog?' + params.toString();
  }
  // The source filter offers what this installation actually has, and never invents a label. Two sources of
  // truth are merged because neither is complete on its own: the import history knows every source ever
  // applied (including ones whose records were later forgotten), and the current page knows the sources of
  // records that may predate the history table. The current selection is always kept, so a reload cannot
  // silently drop the filter somebody is looking through.
  function offerSources(found) {
    for (var i = 0; i < found.length; i++) {
      if (found[i] && knownSources.indexOf(found[i]) === -1) knownSources.push(found[i]);
    }
    knownSources.sort();
    var chosen = catSource.value;
    catSource.replaceChildren();
    var any = document.createElement('option'); any.value = ''; any.textContent = 'Any source';
    catSource.appendChild(any);
    for (var s = 0; s < knownSources.length; s++) {
      var option = document.createElement('option');
      option.value = knownSources[s];
      option.textContent = knownSources[s];
      catSource.appendChild(option);
    }
    catSource.value = knownSources.indexOf(chosen) === -1 ? '' : chosen;
  }
  function describeRecord(item) {
    var parts = [item.title || '(no title)'];
    if (item.year !== null && item.year !== undefined) parts.push('(' + item.year + ')');
    if (item.refTypes && item.refTypes.length > 0) parts.push('- refs: ' + item.refTypes.join(', '));
    if (item.sources && item.sources.length > 0) parts.push('- source: ' + item.sources.join(', '));
    return parts.join(' ');
  }
  function renderCatalog(data) {
    catTotal.textContent = String(data.total);
    catMatched.textContent = String(data.matched);
    catalogPageCount = data.pageCount || 1;
    catPageEl.textContent = data.page + ' of ' + catalogPageCount;
    catState.textContent = data.state;
    catGuidance.textContent = data.guidance || '';
    var notes = [];
    if (data.truncated) notes.push('Showing matches from the first ' + data.scanLimit + ' records by identifier only.');
    if (data.ignored && data.ignored.length > 0) notes.push('Ignored, and the default used instead: ' + data.ignored.join(', ') + '.');
    catTruncated.textContent = notes.join(' ');
    catResults.replaceChildren();
    catalogShownIds = [];
    var items = data.items || [];
    var seen = [];
    for (var q = 0; q < items.length; q++) {
      var rowSources = items[q].sources || [];
      for (var r = 0; r < rowSources.length; r++) seen.push(rowSources[r]);
    }
    offerSources(seen);
    if (items.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = data.state === 'EMPTY' ? 'No records yet.' : 'Nothing on this page.';
      catResults.appendChild(empty);
      return;
    }
    for (var i = 0; i < items.length; i++) {
      var li = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'linkish';
      button.textContent = describeRecord(items[i]);
      button.setAttribute('data-item-id', items[i].itemId);
      li.appendChild(button);
      catResults.appendChild(li);
      // Remembered so the collection panel can plan over exactly what is on screen. Ids only: the panel
      // sends them straight back to a route that already decides what it will disclose about each one.
      catalogShownIds.push(items[i].itemId);
    }
  }
  function setDetailRows(rows) {
    catDetail.replaceChildren();
    for (var i = 0; i < rows.length; i++) {
      var dt = document.createElement('dt'); dt.textContent = rows[i][0]; catDetail.appendChild(dt);
      var dd = document.createElement('dd'); dd.textContent = rows[i][1]; catDetail.appendChild(dd);
    }
  }
  function renderRecordDetail(item) {
    var rows = [
      ['Title', item.title || '(no title)'],
      ['Year', item.year === null || item.year === undefined ? 'not recorded' : String(item.year)],
      ['Identifier', item.itemId],
    ];
    var sources = Object.keys(item.externalIds || {}).sort();
    for (var s = 0; s < sources.length; s++) rows.push(['Your id in ' + sources[s], item.externalIds[sources[s]]]);
    var refs = item.providerRefs || [];
    for (var r = 0; r < refs.length; r++) rows.push([refs[r].type + ' reference', 'present, fingerprint ' + refs[r].fingerprint + ' (the value is never shown)']);
    var metaKeys = Object.keys(item.metadata || {}).sort();
    for (var m = 0; m < metaKeys.length; m++) rows.push([metaKeys[m], item.metadata[metaKeys[m]]]);
    if (refs.length === 0) rows.push(['Provider references', 'none']);
    if (metaKeys.length === 0) rows.push(['Metadata', 'none']);
    setDetailRows(rows);
  }
  async function loadCatalog() {
    if (token.value === '') return;
    var data;
    try {
      data = await getJson(catalogQuery());
    } catch (err) {
      catState.textContent = 'UNAVAILABLE';
      catGuidance.textContent = err.message;
      return;
    }
    renderCatalog(data);
  }
  async function loadRecord(itemId) {
    var data;
    try {
      data = await getJson('/api/catalog/item?id=' + encodeURIComponent(itemId));
    } catch (err) {
      setDetailRows([['Record', err.message]]);
      return;
    }
    renderRecordDetail(data.item);
  }
  function resetCatalog() {
    catalogPage = 1;
    catalogPageCount = 1;
    catTotal.textContent = '-'; catMatched.textContent = '-'; catPageEl.textContent = '-'; catState.textContent = '-';
    catGuidance.textContent = ''; catTruncated.textContent = '';
    catExportStatus.className = 'status'; catExportStatus.textContent = '';
    catResults.replaceChildren();
    var li = document.createElement('li'); li.className = 'muted'; li.textContent = 'Not loaded.'; catResults.appendChild(li);
    setDetailRows([['Record', 'Choose a record above.']]);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Phase 265 — the export.
  //
  // It has to be a fetch rather than a link, because every operational route on this service requires the
  // operator token in a request HEADER and a browser will not put one on a plain navigation. So the bytes are
  // fetched, wrapped in a Blob, and handed to a download anchor the page creates and revokes. The token never
  // reaches a URL, and the file never touches storage: the object URL is released as soon as the click is
  // dispatched.
  // ---------------------------------------------------------------------------------------------------------
  function exportFileNameFrom(res) {
    var disposition = res.headers.get('content-disposition') || '';
    var match = /filename="([A-Za-z0-9][A-Za-z0-9._-]{0,127})"/.exec(disposition);
    // The pattern is the same closed grammar the server builds the name from. A header that does not match it
    // is not trusted into a file name; a constant is used instead.
    return match ? match[1] : 'catalog-export.json';
  }
  async function exportCatalogFile() {
    if (token.value === '') {
      catExportStatus.className = 'status err';
      catExportStatus.textContent = 'Paste your operator token first.';
      return;
    }
    catExportStatus.className = 'status';
    catExportStatus.textContent = 'Preparing the export...';
    var params = new URLSearchParams();
    if (catSource.value !== '') params.set('source', catSource.value);
    var res;
    try {
      res = await fetch('/api/catalog/export?' + params.toString(),
        { headers: { 'x-operator-ui-secret': token.value }, cache: 'no-store' });
    } catch (err) {
      catExportStatus.className = 'status err';
      catExportStatus.textContent = describeFailure(0, null);
      return;
    }
    if (!res.ok) {
      var body = await res.json().catch(function () { return null; });
      catExportStatus.className = 'status err';
      var extra = body && body.sources && body.sources.length > 0
        ? ' Sources in this catalog: ' + body.sources.join(', ') + '.'
        : '';
      catExportStatus.textContent = describeFailure(res.status, body) + extra;
      return;
    }
    var text = await res.text();
    var name = exportFileNameFrom(res);
    var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    var omitted = res.headers.get('x-catalog-export-refs-omitted') || '0';
    catExportStatus.className = 'status ok-text';
    catExportStatus.textContent = 'Downloaded ' + name + ' — '
      + (res.headers.get('x-catalog-export-records') || '?') + ' record(s). '
      + omitted + ' provider reference(s) were deliberately left out; their values are never exported. '
      + 'Nothing was written to this installation.';
  }

  // ---------------------------------------------------------------------------------------------------------
  // Phase 264 — the import.
  //
  // TWO STEPS, AND THE SECOND IS DISABLED UNTIL THE FIRST HAS HAPPENED. Preview reads the file and writes
  // nothing; the confirmation it returns is what Apply sends back, and the server checks that confirmation
  // against the bytes on disk at the moment of the apply. Changing the selected file throws the confirmation
  // away here as well, so the button never looks armed for a file it is not armed for.
  //
  // Every value below is written with textContent, exactly like every other panel: a snapshot is an operator's
  // own file and nothing in it is ever parsed as markup.
  // ---------------------------------------------------------------------------------------------------------
  function disarmImport(why) {
    importConfirmation = null;
    importConfirmedFile = null;
    impApplyBtn.disabled = true;
    if (why) { impStatus.className = 'status'; impStatus.textContent = why; }
  }
  function resetImportCounts() {
    impTotal.textContent = '-'; impCreate.textContent = '-'; impSame.textContent = '-'; impBlocked.textContent = '-';
    setList(impNotes, []);
  }
  async function loadInbox() {
    if (token.value === '') return;
    var data;
    try {
      data = await getJson('/api/import/inbox');
    } catch (err) {
      impInbox.className = 'status err';
      impInbox.textContent = err.message;
      return;
    }
    var chosen = impFile.value;
    var candidates = data.candidates || [];
    impFile.replaceChildren();
    var none = document.createElement('option');
    none.value = '';
    none.textContent = candidates.length === 0 ? 'No snapshot files found' : 'Choose a snapshot file';
    impFile.appendChild(none);
    for (var i = 0; i < candidates.length; i++) {
      var option = document.createElement('option');
      option.value = candidates[i].name;
      option.textContent = candidates[i].name + '  (' + candidates[i].bytes + ' bytes)';
      impFile.appendChild(option);
    }
    // A selection that survived the reload is kept; one whose file went away is dropped along with any
    // confirmation that named it.
    var stillThere = false;
    for (var c = 0; c < candidates.length; c++) if (candidates[c].name === chosen) stillThere = true;
    impFile.value = stillThere ? chosen : '';
    if (!stillThere && chosen !== '') disarmImport('The file you had selected is no longer in the import folder.');
    var skippedNote = '';
    var skipped = data.skipped || {};
    var skippedTotal = 0;
    for (var key in skipped) if (Object.prototype.hasOwnProperty.call(skipped, key)) skippedTotal += skipped[key];
    if (skippedTotal > 0) {
      skippedNote = ' ' + skippedTotal + ' entr' + (skippedTotal === 1 ? 'y was' : 'ies were')
        + ' skipped because they are not plain .json files this page can offer.';
    }
    impInbox.className = 'status';
    impInbox.textContent = (data.guidance || '') + skippedNote;
  }
  function renderImportResult(counts, notes) {
    impTotal.textContent = String(counts.total);
    impCreate.textContent = String(counts.created);
    impSame.textContent = String(counts.unchanged);
    impBlocked.textContent = String(counts.blocked);
    setList(impNotes, notes);
  }
  async function postJson(path, body) {
    var res;
    try {
      res = await fetch(path, {
        method: 'POST',
        // The token travels in the same custom header every other route uses, and the body is declared JSON.
        // Both are refused by the server when they are missing, which is also what makes a cross-origin page
        // unable to reach these routes at all.
        headers: { 'x-operator-ui-secret': token.value, 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(describeFailure(0, null));
    }
    var parsed = await res.json().catch(function () { return null; });
    if (!res.ok && res.status !== 207) {
      var message = describeFailure(res.status, parsed);
      if (parsed && parsed.problems && parsed.problems.length > 0) {
        message = message + ' Problems: ' + parsed.problems.join('; ');
      }
      throw new Error(message);
    }
    return parsed;
  }
  async function previewImport() {
    var file = impFile.value;
    if (token.value === '' || file === '') {
      impStatus.className = 'status err';
      impStatus.textContent = 'Paste your operator token and choose a snapshot file first.';
      return;
    }
    disarmImport('');
    resetImportCounts();
    impStatus.className = 'status';
    impStatus.textContent = 'Previewing ' + file + '. Nothing is being written.';
    var data;
    try {
      data = await postJson('/api/import/preview', { file: file });
    } catch (err) {
      impStatus.className = 'status err';
      impStatus.textContent = err.message;
      return;
    }
    renderImportResult(data.preview, (data.preview.notes || []).concat([data.guidance]));
    importConfirmation = data.confirmation;
    importConfirmedFile = file;
    impApplyBtn.disabled = false;
    impStatus.className = 'status ok-text';
    impStatus.textContent = 'Previewed ' + file + '. Nothing was written. '
      + 'Apply is now enabled and is bound to this exact file — if it changes, the apply will be refused.';
  }
  async function applyImport() {
    if (importConfirmation === null || impFile.value !== importConfirmedFile) {
      disarmImport('Preview the snapshot you want to import, then apply it.');
      return;
    }
    impApplyBtn.disabled = true;
    impStatus.className = 'status';
    impStatus.textContent = 'Applying ' + importConfirmedFile + '...';
    var data;
    try {
      data = await postJson('/api/import/apply', { file: importConfirmedFile, confirmation: importConfirmation });
    } catch (err) {
      // The confirmation is spent either way: the server consumes it before it decides, so re-arming the
      // button here would offer an operator a retry that could only be refused.
      disarmImport('');
      impStatus.className = 'status err';
      impStatus.textContent = err.message;
      await loadHistory();
      return;
    }
    disarmImport('');
    renderImportResult(data.result, (data.result.notes || []).concat([data.guidance]));
    impStatus.className = data.ok ? 'status ok-text' : 'status err';
    impStatus.textContent = data.guidance;
    catalogPage = 1;
    await loadCatalog();
    await loadHistory();
  }
  function describeHistoryEntry(entry) {
    return entry.appliedAt + '  ' + entry.source + ' / ' + entry.fileName
      + '  (' + entry.actor + ')  created ' + entry.created + ', updated ' + entry.updated
      + ', already present ' + entry.unchanged + ', blocked ' + entry.blocked + ', failed ' + entry.failed
      + '  — ' + entry.outcome + ', snapshot ' + String(entry.snapshotDigest).slice(0, 12);
  }
  async function loadHistory() {
    if (token.value === '') return;
    var data;
    try {
      data = await getState('/api/import/history');
    } catch (err) {
      setList(impHistory, [err.message]);
      return;
    }
    var entries = data.entries || [];
    if (!data.ok) { setList(impHistory, [data.message || 'The import history is not available.']); return; }
    // The history is also the most complete answer to "which sources does this installation hold?", so the
    // catalog's source filter is offered from it.
    var sources = [];
    for (var i = 0; i < entries.length; i++) sources.push(entries[i].source);
    offerSources(sources);
    setList(impHistory, entries.length === 0 ? [data.guidance] : entries.map(describeHistoryEntry));
  }
  function resetImportPanel() {
    disarmImport('');
    resetImportCounts();
    impStatus.className = 'status'; impStatus.textContent = '';
    impInbox.className = 'status'; impInbox.textContent = '';
    impFile.replaceChildren();
    var option = document.createElement('option'); option.value = ''; option.textContent = 'Not loaded';
    impFile.appendChild(option);
    setList(impHistory, []);
    knownSources = [];
    offerSources([]);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Phase 266/267/268 — the Jellyfin control plane.
  //
  // THREE STEPS, EACH ONE HARDER TO REACH THAN THE LAST. Discovery reads and lists nothing. A plan preview
  // reads this installation's own catalog and ledger and contacts nothing. Queuing needs the deployment
  // switches, the confirmation the preview issued, AND the plan's own digest typed back — the digest is
  // deliberately NOT pre-filled, because a confirmation a page can supply for you is a confirmation that
  // confirms nothing.
  //
  // Every value below is written with textContent, exactly like every other panel here.
  // ---------------------------------------------------------------------------------------------------------
  function disarmPlan(why) {
    collectionPlan = null;
    collectionConfirmation = null;
    colExecuteBtn.disabled = true;
    if (why) { colPlanStatus.className = 'status'; colPlanStatus.textContent = why; }
  }
  function setKv(target, rows) {
    target.replaceChildren();
    for (var i = 0; i < rows.length; i++) {
      var dt = document.createElement('dt'); dt.textContent = rows[i][0]; target.appendChild(dt);
      var dd = document.createElement('dd'); dd.textContent = rows[i][1]; target.appendChild(dd);
    }
  }
  function renderConnection(connection) {
    if (!connection) return;
    jfHostClass.textContent = connection.hostClass || 'not configured';
    jfNetwork.textContent = connection.networkEnabled ? 'on' : 'off (default)';
    jfWrites.textContent = connection.writesEnabled ? 'ON' : 'off (default)';
  }
  function renderDiscovery(data) {
    jfState.textContent = data.state || '-';
    renderConnection(data.connection);
    var d = data.discovery;
    jfLibraries.textContent = d ? String(d.libraries) : '-';
    jfCollections.textContent = d ? String(d.collections) : '-';
    jfManagedCount.textContent = d ? String((d.managed || []).length) : '-';
    jfVersion.textContent = d && d.version ? d.version : 'not reported';
    var managed = (d && d.managed) || [];
    setList(jfManaged, managed.map(function (m) {
      return m.name + '  (' + m.collectionDigest + ')' + (m.marked ? '' : ' — marker unreadable');
    }));
    jfStatus.className = data.ok ? 'status' : 'status err';
    jfStatus.textContent = data.guidance || '';
  }
  async function loadJellyfin() {
    if (token.value === '') return;
    var data;
    try {
      data = await getState('/api/jellyfin/discovery');
    } catch (err) {
      jfState.textContent = 'UNAVAILABLE';
      jfStatus.className = 'status err';
      jfStatus.textContent = err.message;
      return;
    }
    renderDiscovery(data);
  }
  function describeAction(action) {
    return action.action.toUpperCase() + '  ' + (action.title || '(unreadable record)')
      + (action.year === null || action.year === undefined ? '' : ' (' + action.year + ')')
      + '  — ' + action.reason.toLowerCase().split('_').join(' ')
      + (action.refCount ? ', ' + action.refCount + ' reference(s): ' + action.refTypes.join(', ') : '')
      + '  [' + action.itemId + ']';
  }
  function renderPlan(plan) {
    colSelected.textContent = String(plan.counts.selected);
    colCreate.textContent = String(plan.counts.create);
    colUpdate.textContent = String(plan.counts.update);
    colRevoke.textContent = String(plan.counts.revoke);
    setKv(colDigests, [
      ['Plan digest', plan.planDigest],
      ['Basis digest', plan.basisDigest],
      ['Blocked', String(plan.counts.blocked)],
      ['Already published', String(plan.counts.unchanged)]]);
    setList(colActions, plan.actions.map(describeAction));
  }
  function resetPlanCounts() {
    colSelected.textContent = '-'; colCreate.textContent = '-'; colUpdate.textContent = '-';
    colRevoke.textContent = '-';
    setKv(colDigests, [['Plan digest', 'No plan previewed.']]);
    setList(colActions, []);
  }
  async function previewPlan() {
    if (token.value === '') {
      colPlanStatus.className = 'status err';
      colPlanStatus.textContent = 'Paste your operator token first.';
      return;
    }
    disarmPlan('');
    resetPlanCounts();
    var request = { name: colName.value };
    if (colUseShown.checked) request.itemIds = catalogShownIds.slice(0);
    else request.search = colSearch.value;
    colPlanStatus.className = 'status';
    colPlanStatus.textContent = 'Working out what would happen. Nothing is being written and nothing is being sent.';
    var data;
    try {
      data = await postJson('/api/collections/plan', request);
    } catch (err) {
      colPlanStatus.className = 'status err';
      colPlanStatus.textContent = err.message;
      return;
    }
    renderPlan(data.plan);
    collectionPlan = data.plan;
    collectionConfirmation = data.confirmation;
    colExecuteBtn.disabled = false;
    colPlanStatus.className = 'status ok-text';
    colPlanStatus.textContent = data.guidance
      + ' Nothing was written and no media server was contacted. To queue it, copy the plan digest below into '
      + 'the confirm box.';
    await loadCollectionHistory();
  }
  async function executePlan() {
    if (collectionPlan === null || collectionConfirmation === null) {
      disarmPlan('Preview a plan before queuing one.');
      return;
    }
    var typed = colConfirm.value.trim();
    if (typed !== collectionPlan.planDigest) {
      colExecuteStatus.className = 'status err';
      colExecuteStatus.textContent = 'That is not this plan\'s digest. Copy the plan digest exactly. Nothing was queued.';
      return;
    }
    colExecuteBtn.disabled = true;
    colExecuteStatus.className = 'status';
    colExecuteStatus.textContent = 'Queuing...';
    var request = {
      confirmation: collectionConfirmation,
      confirmDigest: typed,
    };
    if (colUseShown.checked) request.itemIds = catalogShownIds.slice(0);
    else request.search = colSearch.value;
    var data;
    try {
      data = await postJson('/api/collections/execute', request);
    } catch (err) {
      // The confirmation is spent either way: the server consumes it before it decides, so re-arming the
      // button here would offer a retry that could only be refused.
      disarmPlan('');
      colExecuteStatus.className = 'status err';
      colExecuteStatus.textContent = err.message;
      await loadCollectionStatus();
      await loadCollectionHistory();
      return;
    }
    disarmPlan('');
    colConfirm.value = '';
    colExecuteStatus.className = data.ok ? 'status ok-text' : 'status err';
    colExecuteStatus.textContent = data.guidance;
    await loadCollectionStatus();
    await loadCollectionHistory();
  }
  function renderCollectionStatus(data) {
    var st = data.status || {};
    var counts = st.counts || {};
    colOutstanding.textContent = String(st.outstanding === undefined ? '-' : st.outstanding);
    colUnrevoked.textContent = String(st.unrevoked === undefined ? '-' : st.unrevoked);
    colPublished.textContent = String(counts.published === undefined ? '-' : counts.published);
    colRecovery.textContent = st.recoveryProof || 'none recorded';
    colRunStatus.className = 'status';
    colRunStatus.textContent = (st.guidance || '') + (data.writesEnabled ? '' : ' ' + (data.writesMessage || ''));
  }
  async function loadCollectionStatus() {
    if (token.value === '') return;
    var data;
    try {
      data = await getState('/api/collections/status');
    } catch (err) {
      colRunStatus.className = 'status err';
      colRunStatus.textContent = err.message;
      return;
    }
    if (!data.ok) {
      colRunStatus.className = 'status err';
      colRunStatus.textContent = data.message || 'The collection outbox could not be read.';
      return;
    }
    renderCollectionStatus(data);
  }
  function describeCollectionHistory(entry) {
    return entry.recordedAt + '  ' + entry.action + '  ' + entry.name + '  (' + entry.actor + ')  '
      + 'selected ' + entry.selected + ', created ' + entry.created + ', resumed ' + entry.updated
      + ', revoked ' + entry.revoked + ', blocked ' + entry.blocked + ', failed ' + entry.failed
      + '  — ' + entry.outcome + ', plan ' + String(entry.planDigest).slice(0, 12);
  }
  async function loadCollectionHistory() {
    if (token.value === '') return;
    var data;
    try {
      data = await getState('/api/collections/history');
    } catch (err) {
      setList(colHistory, [err.message]);
      return;
    }
    if (!data.ok) { setList(colHistory, [data.message || 'The collection history is not available.']); return; }
    var entries = data.entries || [];
    setList(colHistory, entries.length === 0 ? [data.guidance] : entries.map(describeCollectionHistory));
  }
  // `send` is a THUNK that names its own route, rather than a path parameter. The suite asserts that every
  // route this page can POST to appears as a literal in this file; a helper taking a path would pass that
  // check while making it blind to the two routes it drives, which is exactly the drift the check exists for.
  async function runCollectionPass(send, label) {
    if (token.value === '') {
      colRunStatus.className = 'status err';
      colRunStatus.textContent = 'Paste your operator token first.';
      return;
    }
    colRunStatus.className = 'status';
    colRunStatus.textContent = label + '...';
    var data;
    try {
      data = await send();
    } catch (err) {
      colRunStatus.className = 'status err';
      colRunStatus.textContent = err.message;
      await loadCollectionStatus();
      return;
    }
    colRunStatus.className = data.ok ? 'status ok-text' : 'status err';
    colRunStatus.textContent = data.guidance || label + ' finished.';
    await loadCollectionStatus();
    await loadCollectionHistory();
  }
  function resetCollectionPanel() {
    disarmPlan('');
    resetPlanCounts();
    colConfirm.value = '';
    colPlanStatus.className = 'status'; colPlanStatus.textContent = '';
    colExecuteStatus.className = 'status'; colExecuteStatus.textContent = '';
    colRunStatus.className = 'status'; colRunStatus.textContent = '';
    colOutstanding.textContent = '-'; colUnrevoked.textContent = '-';
    colPublished.textContent = '-'; colRecovery.textContent = '-';
    setList(colHistory, []);
    jfState.textContent = '-'; jfHostClass.textContent = '-'; jfNetwork.textContent = '-';
    jfWrites.textContent = '-'; jfLibraries.textContent = '-'; jfCollections.textContent = '-';
    jfManagedCount.textContent = '-'; jfVersion.textContent = '-';
    jfStatus.className = 'status'; jfStatus.textContent = '';
    setList(jfManaged, []);
    catalogShownIds = [];
  }

  async function refresh() {
    statusText.className = 'status';
    statusText.textContent = 'Loading...';
    if (token.value === '') {
      statusText.className = 'status err';
      statusText.textContent = 'Paste your operator token first. Read it with: cat ./secrets/operator_ui_token';
      return;
    }
    // Settled independently: a stack with no database still has a promotion record chain worth reading, and one
    // panel failing must not blank the others.
    var settled = await Promise.allSettled([
      getJson('/api/installation'), getState('/api/status'), getJson('/api/logs'), getChain(),
      getState('/api/support-report')]);
    // The catalog is loaded AFTER the others rather than alongside them: /api/status closes the shared
    // connection pool when its self-check finishes, and a catalog read racing that close would fail closed
    // for no reason an operator could act on. Sequencing costs one round trip and removes the race.
    catalogPage = 1;
    await loadCatalog();
    // The import panel's two reads follow for the same reason, and in this order: the history is what the
    // catalog's source filter is offered from, and the inbox listing needs no database at all — so it still
    // answers on an installation whose database is down, which is exactly the installation whose operator is
    // trying to work out what to do next.
    await loadHistory();
    await loadInbox();
    // The Jellyfin control plane last, and in this order. Discovery may contact a media server, so it must
    // never be what a page waits on before showing everything it already knows; the two reads after it are
    // SELECTs against this installation's own database.
    await loadJellyfin();
    await loadCollectionStatus();
    await loadCollectionHistory();
    var i = settled[0], s = settled[1], l = settled[2], c = settled[3], r = settled[4];
    var problems = [];
    if (i.status === 'fulfilled') renderInstallation(i.value); else problems.push(i.reason.message);
    if (s.status === 'fulfilled') renderStatus(s.value); else problems.push(s.reason.message);
    if (l.status === 'fulfilled') renderLogs(l.value); else problems.push(l.reason.message);
    if (c.status === 'fulfilled') renderChain(c.value); else problems.push(c.reason.message);
    // A withheld report is a state of the report panel, not a failure of the page. It is said there, next to
    // the empty <pre>, rather than in the banner — the other four panels are fine and the banner saying
    // otherwise is the exact mistake Phase 253 corrected.
    if (r.status === 'fulfilled' && r.value && r.value.ok) renderSupport(r.value);
    else if (r.status === 'fulfilled' && r.value) renderSupportRefusal(r.value.message || 'No support report is available.');
    else if (r.status === 'rejected') { renderSupportRefusal(r.reason.message); problems.push(r.reason.message); }
    // A doctor failure is a real thing to say, and it is said by NAMING where to look rather than by calling
    // the whole page broken. The failing checks are already listed under Needs Attention by the time this runs.
    if (s.status === 'fulfilled' && s.value && s.value.ok === false) {
      problems.push('The self-check reports failing items. They are listed by name under Needs Attention below.');
    }
    // De-duplicated: four routes rejecting one stale token is one problem, not four lines of the same sentence.
    var unique = [];
    for (var q = 0; q < problems.length; q++) if (unique.indexOf(problems[q]) === -1) unique.push(problems[q]);
    statusText.className = unique.length === 0 ? 'status ok-text' : 'status err';
    statusText.textContent = unique.length === 0
      ? 'Updated. Everything below reflects this moment; press Load everything again after you change anything.'
      : unique.join(' ');
  }
  document.getElementById('refresh').addEventListener('click', refresh);
  document.getElementById('copySupport').addEventListener('click', copySupport);
  document.getElementById('catApply').addEventListener('click', function () { catalogPage = 1; loadCatalog(); });
  document.getElementById('catReset').addEventListener('click', function () {
    catSearch.value = ''; catSort.value = 'id|asc'; catRefType.value = ''; catSource.value = '';
    catYearFrom.value = ''; catYearTo.value = ''; catPageSize.value = '25';
    catalogPage = 1;
    loadCatalog();
  });
  document.getElementById('catExport').addEventListener('click', exportCatalogFile);
  document.getElementById('jfCheck').addEventListener('click', loadJellyfin);
  document.getElementById('colPreview').addEventListener('click', previewPlan);
  colExecuteBtn.addEventListener('click', executePlan);
  document.getElementById('colReconcile').addEventListener('click', function () {
    runCollectionPass(function () { return postJson('/api/collections/reconcile', {}); }, 'Reconciling');
  });
  document.getElementById('colRevokeBtn').addEventListener('click', function () {
    runCollectionPass(function () { return postJson('/api/collections/revoke', {}); }, 'Revoking');
  });
  // Changing what would be selected throws the previous plan away. The server refuses a stale plan anyway;
  // this is so the button somebody is looking at agrees with what the server would do.
  colName.addEventListener('input', function () { if (collectionPlan !== null) disarmPlan('The name changed. Preview the plan again.'); });
  colSearch.addEventListener('input', function () { if (collectionPlan !== null) disarmPlan('The selection changed. Preview the plan again.'); });
  colUseShown.addEventListener('change', function () { if (collectionPlan !== null) disarmPlan('The selection changed. Preview the plan again.'); });
  document.getElementById('impPreview').addEventListener('click', previewImport);
  impApplyBtn.addEventListener('click', applyImport);
  // Choosing a different file throws away the previous file's confirmation. The server would refuse the
  // mismatch anyway; this is so the button an operator is looking at agrees with what the server would do.
  impFile.addEventListener('change', function () {
    if (importConfirmedFile !== null && impFile.value !== importConfirmedFile) {
      disarmImport('You chose a different file. Preview it before applying it.');
      resetImportCounts();
    }
  });
  document.getElementById('catPrev').addEventListener('click', function () {
    if (catalogPage > 1) { catalogPage -= 1; loadCatalog(); }
  });
  document.getElementById('catNext').addEventListener('click', function () {
    if (catalogPage < catalogPageCount) { catalogPage += 1; loadCatalog(); }
  });
  // One delegated listener rather than one per row: the rows are replaced on every page, and the record id
  // is read from the element the page itself created.
  catResults.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || typeof target.getAttribute !== 'function') return;
    var itemId = target.getAttribute('data-item-id');
    if (itemId) loadRecord(itemId);
  });
  catSearch.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { catalogPage = 1; loadCatalog(); }
  });
  document.getElementById('clear').addEventListener('click', function () {
    token.value = '';
    resetOperationalState();
    statusText.className = 'status';
    statusText.textContent = 'Token cleared from this page, along with everything it loaded.';
  });
})();
