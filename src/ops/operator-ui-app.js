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

  // Error text an operator can act on. A bare "request failed" sends someone to the logs for a problem whose
  // answer is "you pasted a stale token"; the status code already knows which of those it is.
  function describeFailure(status, body) {
    if (status === 401) return 'The operator token was not accepted. Re-read ./secrets/operator_ui_token and paste it with no extra spaces or line breaks.';
    if (status === 503) return 'The service answered, but a dependency it needs is not ready. See Setup & Diagnostics.';
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
  // The chain answers 503 for a chain that does not hang together and for a fresh install with no anchor yet.
  // Both are states to SHOW, not request failures to hide, so only a rejected token is treated as an error.
  async function getChain() {
    var res = await fetch('/api/promotion-chain', { headers: { 'x-operator-ui-secret': token.value }, cache: 'no-store' });
    var body = await res.json();
    if (res.status === 401) throw new Error(body.message || 'operator token required');
    return body;
  }
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
  var VERDICT_CLASS = { READY: 'verdict ready', NEEDS_SETUP: 'verdict setup', DEGRADED: 'verdict degraded' };
  // Built from the checklist the same response carried, so a step id can never render as a bare identifier.
  function renderInstallation(data) {
    var r = data.readiness;
    var steps = data.checklist || [];
    verdict.textContent = r.state;
    verdict.className = VERDICT_CLASS[r.state] || 'verdict';
    verdictHeadline.textContent = r.headline;
    authorizationNote.textContent = r.authorizationNote;
    var v = r.version;
    verVersion.textContent = v.version || 'not declared';
    verProvenance.textContent = v.provenance;
    verAgreement.textContent = v.agreement;
    verPin.textContent = v.image.pinnedByDigest ? 'digest' : (v.image.tag || v.image.state.toLowerCase());
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
    chainHeadline.textContent = ''; chainCaveat.textContent = '';
    checks.textContent = 'No status loaded.';
    logs.textContent = 'No logs loaded.';
    setList(attention, []); setList(components, []); setList(nextSteps, []); setList(advisories, []);
    setList(chainArtifacts, []); setList(chainBlockers, []); setList(chainSteps, []); setList(chainLimits, []);
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
      getJson('/api/installation'), getJson('/api/status'), getJson('/api/logs'), getChain()]);
    var i = settled[0], s = settled[1], l = settled[2], c = settled[3];
    var problems = [];
    if (i.status === 'fulfilled') renderInstallation(i.value); else problems.push(i.reason.message);
    if (s.status === 'fulfilled') renderStatus(s.value); else problems.push(s.reason.message);
    if (l.status === 'fulfilled') renderLogs(l.value); else problems.push(l.reason.message);
    if (c.status === 'fulfilled') renderChain(c.value); else problems.push(c.reason.message);
    // De-duplicated: four routes rejecting one stale token is one problem, not four lines of the same sentence.
    var unique = [];
    for (var q = 0; q < problems.length; q++) if (unique.indexOf(problems[q]) === -1) unique.push(problems[q]);
    statusText.className = unique.length === 0 ? 'status ok-text' : 'status err';
    statusText.textContent = unique.length === 0
      ? 'Updated. Everything below reflects this moment; press Load everything again after you change anything.'
      : unique.join(' ');
  }
  document.getElementById('refresh').addEventListener('click', refresh);
  document.getElementById('clear').addEventListener('click', function () {
    token.value = '';
    resetOperationalState();
    statusText.className = 'status';
    statusText.textContent = 'Token cleared from this page, along with everything it loaded.';
  });
})();
