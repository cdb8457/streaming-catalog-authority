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
  function renderSupport(data) {
    supportReport.textContent = (data && data.text) || 'No support report loaded.';
    supportStatus.className = 'status';
    supportStatus.textContent = '';
  }
  // A refusal renders as a refusal. The server withholds the whole report rather than a redacted one, so the
  // panel must not leave the previous report on screen looking current.
  function renderSupportRefusal(message) {
    supportReport.textContent = 'No support report is available.';
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
    if (supportReport.textContent === '' || supportReport.textContent === 'No support report loaded.') {
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
    supportStatus.className = 'status'; supportStatus.textContent = '';
    artifactSummary.replaceChildren();
    var dt = document.createElement('dt'); dt.textContent = 'Artifacts'; artifactSummary.appendChild(dt);
    var dd = document.createElement('dd'); dd.textContent = 'Not loaded.'; artifactSummary.appendChild(dd);
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
  document.getElementById('clear').addEventListener('click', function () {
    token.value = '';
    resetOperationalState();
    statusText.className = 'status';
    statusText.textContent = 'Token cleared from this page, along with everything it loaded.';
  });
})();
