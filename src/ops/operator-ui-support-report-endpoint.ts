import {
  assertSupportReportIsRedactionSafe,
  buildSupportReport,
  renderSupportReportText,
  type SupportReport,
} from './operator-ui-support-report.js';

// Phase 255 — the support report, reachable by the person who needs it.
//
// WHY THIS EXISTS. Phase 246 built the support report as "the thing a person pastes into an issue", and then
// shipped exactly one way to obtain it: `npm run ops:support-report`. That requires a Node.js toolchain and a
// source checkout — the two things the release bundle deliberately does not ship, and the two things the
// audience for this report definitionally does not have. Somebody running the published image under Docker
// Compose or Arcane could read every panel on the page and still had no way to produce the artifact the
// project asks them to attach to a bug report. So it is a route now, behind the same token as everything else.
//
// THE CLI IS NOT REPLACED. It is still the one that works when the container will not start, the port is
// taken or the token is lost — the situations where there is no page to open. This is the other half: the
// situations where the stack is up and the operator is not a developer.
//
// THE REDACTION ASSERTION RUNS OVER THE BYTES THAT ARE ABOUT TO BE SENT, not over the report object and not
// over the two renderings separately. The wrapper this endpoint adds is small and fixed, but "small and
// fixed" is what every leak was before it happened. What is scanned is the exact string the socket receives.
//
// A REJECTION IS A REFUSAL, NOT A DEGRADED REPORT. There is no partial body, no "some fields withheld", no
// error text quoting what tripped the scan. A report that might contain a secret is worth less than no
// report, and the operator is told to use the CLI, which fails the same way for the same reason.
//
// NO LIVE CALLS, exactly as the CLI makes none. The database is not contacted, nothing is fetched, nothing is
// resolved. The report you need is the one you can still produce while the thing you are reporting is down —
// and this route keeps that property so that the page can answer even when /api/status cannot.

export const SUPPORT_REPORT_ROUTE = '/api/support-report';
export const SUPPORT_REPORT_OK_CODE = 'OPERATOR_UI_SUPPORT_REPORT';
export const SUPPORT_REPORT_FAILED_CODE = 'OPERATOR_UI_SUPPORT_REPORT_UNAVAILABLE';

/**
 * What a caller is told when the report could not be produced safely.
 *
 * It names no field, quotes no value and repeats nothing that was about to be sent. "Which shape tripped the
 * scan" is a fact about the thing being withheld, and an error message is not the place to leak half of it.
 */
export const SUPPORT_REPORT_FAILED_MESSAGE =
  'The support report could not be produced safely, so none was produced. Nothing partial is returned. '
  + 'Run ops:support-report from a checkout for the same report and the same refusal.';

export interface SupportReportEndpointResult {
  readonly status: 200 | 503;
  /** The exact bytes to send, already serialised and already scanned. */
  readonly json: string;
  /** For the service log line. Never the reason, which is a fact about withheld content. */
  readonly ok: boolean;
}

export interface SupportReportEndpointDeps {
  readonly build: (input: { promotionRecordsDir: string; env?: NodeJS.ProcessEnv; generatedAt: string }) => SupportReport;
  readonly renderText: (report: SupportReport) => string;
}

const DEFAULT_DEPS: SupportReportEndpointDeps = {
  build: buildSupportReport,
  renderText: renderSupportReportText,
};

export interface SupportReportEndpointInput {
  readonly promotionRecordsDir: string;
  readonly generatedAt: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Build the response body for {@link SUPPORT_REPORT_ROUTE}.
 *
 * Both renderings travel together on purpose. The page shows the text — it is what a person reads and what
 * they paste — and the structured report is what a future tool, or a support engineer with `jq`, would want.
 * Producing them from one build call means the two can never describe different moments.
 *
 * `deps` is a test seam and nothing else: the running service always uses the defaults. It exists because the
 * refusal path is the important one and a scan that only ever passes has never been shown to fail closed.
 */
export function buildSupportReportEndpointResult(
  input: SupportReportEndpointInput,
  deps: SupportReportEndpointDeps = DEFAULT_DEPS,
): SupportReportEndpointResult {
  const failure = `${JSON.stringify({
    ok: false,
    code: SUPPORT_REPORT_FAILED_CODE,
    message: SUPPORT_REPORT_FAILED_MESSAGE,
  })}\n`;

  let json: string;
  try {
    const report = deps.build({
      promotionRecordsDir: input.promotionRecordsDir,
      env: input.env,
      generatedAt: input.generatedAt,
    });
    const text = deps.renderText(report);
    json = `${JSON.stringify({ ok: true, code: SUPPORT_REPORT_OK_CODE, report, text })}\n`;
    // The last thing before it leaves. `renderText` has already scanned its own output; this scans the
    // serialised envelope, which is what a browser actually receives and what a person actually pastes.
    assertSupportReportIsRedactionSafe(json);
  } catch {
    // A redaction rejection and an unexpected throw are the SAME outcome here, deliberately. Distinguishing
    // them in the response would tell a caller which one happened, and neither is a state this route reports
    // on. The expected rejection is `SupportReportRedactionError`; it is deliberately not matched on, because
    // "the scan failed" and "something else failed" must produce identical bytes.
    return { status: 503, json: failure, ok: false };
  }
  return { status: 200, json, ok: true };
}
