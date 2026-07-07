import {
  CustodianTransportError,
  type DestructionReceipt,
  type KeyCustodian,
  type KeyStatus,
  type ProvisionResult,
  type StaleProvisioning,
} from './custodian.js';

export type LocalSidecarCustodianOperation =
  | 'provision'
  | 'commitProvision'
  | 'get'
  | 'destroy'
  | 'status'
  | 'listStaleProvisioning';

export type LocalSidecarCustodianRequest =
  | {
      readonly op: 'provision';
      readonly operationId: string;
      readonly itemId: string;
      readonly epoch: number;
    }
  | {
      readonly op: 'commitProvision';
      readonly operationId: string;
    }
  | {
      readonly op: 'get';
      readonly keyId: string;
      readonly epoch: number;
    }
  | {
      readonly op: 'destroy';
      readonly operationId: string;
      readonly keyId: string;
    }
  | {
      readonly op: 'status';
      readonly keyId: string;
    }
  | {
      readonly op: 'listStaleProvisioning';
    };

export type LocalSidecarCustodianResponse =
  | {
      readonly op: 'provision';
      readonly keyId: string;
      readonly dekBase64: string;
    }
  | {
      readonly op: 'commitProvision';
      readonly ok: true;
    }
  | {
      readonly op: 'get';
      readonly dekBase64: string;
    }
  | {
      readonly op: 'destroy';
      readonly receipt: DestructionReceipt;
    }
  | {
      readonly op: 'status';
      readonly status: KeyStatus;
    }
  | {
      readonly op: 'listStaleProvisioning';
      readonly stale: readonly StaleProvisioning[];
    };

export interface LocalSidecarCustodianTransport {
  dispatch(request: LocalSidecarCustodianRequest): Promise<LocalSidecarCustodianResponse>;
}

export class LocalSidecarCustodianClient implements KeyCustodian {
  constructor(private readonly transport: LocalSidecarCustodianTransport) {}

  async provision(operationId: string, itemId: string, epoch: number): Promise<ProvisionResult> {
    const response = await this.dispatch({ op: 'provision', operationId, itemId, epoch });
    if (response.op !== 'provision' || !isNonEmptyString(response.keyId)) throw malformed('provision');
    return { keyId: response.keyId, dek: decodeDek(response.dekBase64, 'provision') };
  }

  async commitProvision(operationId: string): Promise<void> {
    const response = await this.dispatch({ op: 'commitProvision', operationId });
    if (response.op !== 'commitProvision' || response.ok !== true) throw malformed('commitProvision');
  }

  async get(keyId: string, epoch: number): Promise<Buffer> {
    const response = await this.dispatch({ op: 'get', keyId, epoch });
    if (response.op !== 'get') throw malformed('get');
    return decodeDek(response.dekBase64, 'get');
  }

  async destroy(operationId: string, keyId: string): Promise<DestructionReceipt> {
    const response = await this.dispatch({ op: 'destroy', operationId, keyId });
    if (response.op !== 'destroy' || !isDestructionReceipt(response.receipt)) throw malformed('destroy');
    return response.receipt;
  }

  async status(keyId: string): Promise<KeyStatus> {
    const response = await this.dispatch({ op: 'status', keyId });
    if (response.op !== 'status' || !isKeyStatus(response.status)) throw malformed('status');
    return response.status;
  }

  async listStaleProvisioning(): Promise<StaleProvisioning[]> {
    const response = await this.dispatch({ op: 'listStaleProvisioning' });
    if (response.op !== 'listStaleProvisioning' || !Array.isArray(response.stale) || !response.stale.every(isStaleProvisioning)) {
      throw malformed('listStaleProvisioning');
    }
    return response.stale.map((stale) => ({ ...stale }));
  }

  private async dispatch(request: LocalSidecarCustodianRequest): Promise<LocalSidecarCustodianResponse> {
    try {
      return await this.transport.dispatch(request);
    } catch {
      throw new CustodianTransportError(request.op);
    }
  }
}

export async function dispatchLocalSidecarCustodianRequest(
  custodian: KeyCustodian,
  request: LocalSidecarCustodianRequest,
): Promise<LocalSidecarCustodianResponse> {
  switch (request.op) {
    case 'provision': {
      const result = await custodian.provision(request.operationId, request.itemId, request.epoch);
      return { op: 'provision', keyId: result.keyId, dekBase64: encodeDek(result.dek) };
    }
    case 'commitProvision':
      await custodian.commitProvision(request.operationId);
      return { op: 'commitProvision', ok: true };
    case 'get':
      return { op: 'get', dekBase64: encodeDek(await custodian.get(request.keyId, request.epoch)) };
    case 'destroy':
      return { op: 'destroy', receipt: await custodian.destroy(request.operationId, request.keyId) };
    case 'status':
      return { op: 'status', status: await custodian.status(request.keyId) };
    case 'listStaleProvisioning':
      return { op: 'listStaleProvisioning', stale: await custodian.listStaleProvisioning() };
  }
}

export function buildLocalSidecarCustodianDescriptor() {
  return {
    adapterName: 'LocalSidecarCustodianClient',
    adapterVersion: 'phase-98-prototype',
    custodyBoundary: 'external-self-hosted',
    implementsKeyCustodian: true,
    attestationFormatDocumented: true,
    durableTombstones: true,
    appCannotForgeAttestation: true,
    failClosedSemanticsDocumented: true,
    liveValidationEvidenceLabel: 'local-sidecar-prototype-contract-redacted',
    contractKitCommandLabel: 'test-local-sidecar-custodian-redacted',
    redactionReviewStatus: 'passed',
    noRawSecretsInEvidence: true,
    backupRestoreFailClosedEvidence: true,
  } as const;
}

function encodeDek(dek: Buffer): string {
  if (dek.length !== 32) throw malformed('provision');
  return dek.toString('base64');
}

function decodeDek(value: unknown, op: LocalSidecarCustodianOperation): Buffer {
  if (typeof value !== 'string' || value.length === 0) throw malformed(op);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) throw malformed(op);
  return decoded;
}

function malformed(op: LocalSidecarCustodianOperation): CustodianTransportError {
  return new CustodianTransportError(op);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isKeyStatus(value: unknown): value is KeyStatus {
  return value === 'provisional' || value === 'active' || value === 'destroyed' || value === 'not_found';
}

function isDestructionReceipt(value: unknown): value is DestructionReceipt {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DestructionReceipt>;
  return isNonEmptyString(candidate.keyId)
    && isNonEmptyString(candidate.receiptId)
    && isNonEmptyString(candidate.destroyedAt)
    && isNonEmptyString(candidate.attestation);
}

function isStaleProvisioning(value: unknown): value is StaleProvisioning {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StaleProvisioning>;
  return isNonEmptyString(candidate.operationId)
    && isNonEmptyString(candidate.itemId)
    && isNonEmptyString(candidate.keyId)
    && typeof candidate.ageMs === 'number'
    && Number.isFinite(candidate.ageMs)
    && candidate.ageMs >= 0;
}

