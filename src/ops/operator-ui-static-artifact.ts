import { createHash } from 'node:crypto';
import {
  inspectOperatorUiRenderedHtml,
  type OperatorUiRenderInspectionReport,
} from './operator-ui-render-allowlist.js';
import { renderOperatorUiStaticPrototypeHtml } from './operator-ui-static-prototype.js';

export const OPERATOR_UI_STATIC_ARTIFACT_FILENAME = 'operator-ui-static-prototype.html';

export interface OperatorUiStaticArtifact {
  readonly ok: true;
  readonly code: 'OPERATOR_UI_STATIC_ARTIFACT_READY';
  readonly message: 'Operator UI static artifact passed render allowlist inspection.';
  readonly artifactFilename: typeof OPERATOR_UI_STATIC_ARTIFACT_FILENAME;
  readonly contentType: 'text/html; charset=utf-8';
  readonly byteCount: number;
  readonly sha256: string;
  readonly inspection: Extract<OperatorUiRenderInspectionReport, { ok: true }>;
  readonly html: string;
}

export interface OperatorUiStaticArtifactMetadata {
  readonly ok: true;
  readonly code: 'OPERATOR_UI_STATIC_ARTIFACT_READY';
  readonly message: 'Operator UI static artifact passed render allowlist inspection.';
  readonly artifactFilename: typeof OPERATOR_UI_STATIC_ARTIFACT_FILENAME;
  readonly contentType: 'text/html; charset=utf-8';
  readonly byteCount: number;
  readonly sha256: string;
  readonly inspection: Extract<OperatorUiRenderInspectionReport, { ok: true }>;
}

export class OperatorUiStaticArtifactError extends Error {
  readonly code = 'OPERATOR_UI_STATIC_ARTIFACT_REJECTED';
  readonly inspection: OperatorUiRenderInspectionReport;

  constructor(inspection: OperatorUiRenderInspectionReport) {
    super('Operator UI static artifact failed render allowlist inspection.');
    this.name = 'OperatorUiStaticArtifactError';
    this.inspection = inspection;
  }
}

export function buildOperatorUiStaticArtifact(): OperatorUiStaticArtifact {
  const html = renderOperatorUiStaticPrototypeHtml();
  const inspection = inspectOperatorUiRenderedHtml(html);
  if (!inspection.ok) throw new OperatorUiStaticArtifactError(inspection);

  return {
    ok: true,
    code: 'OPERATOR_UI_STATIC_ARTIFACT_READY',
    message: 'Operator UI static artifact passed render allowlist inspection.',
    artifactFilename: OPERATOR_UI_STATIC_ARTIFACT_FILENAME,
    contentType: 'text/html; charset=utf-8',
    byteCount: Buffer.byteLength(html, 'utf8'),
    sha256: createHash('sha256').update(html, 'utf8').digest('hex'),
    inspection,
    html,
  };
}

export function describeOperatorUiStaticArtifact(
  artifact: OperatorUiStaticArtifact = buildOperatorUiStaticArtifact(),
): OperatorUiStaticArtifactMetadata {
  return {
    ok: artifact.ok,
    code: artifact.code,
    message: artifact.message,
    artifactFilename: artifact.artifactFilename,
    contentType: artifact.contentType,
    byteCount: artifact.byteCount,
    sha256: artifact.sha256,
    inspection: artifact.inspection,
  };
}
