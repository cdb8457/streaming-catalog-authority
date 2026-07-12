import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  custodianFromEnv,
  loadCustodianConfig,
  requireAppHeldCompletionSecret,
} from '../core/crypto/custodian-factory.js';
import { startSidecarDaemon, validateSidecarDaemonConfig, type StartedSidecarDaemon } from './sidecar-daemon.js';

export interface SidecarFactoryEvidenceCheck {
  readonly id: string;
  readonly status: 'pass' | 'fail';
  readonly label: string;
}

export interface SidecarFactoryEvidencePacket {
  readonly ok: boolean;
  readonly code: 'SIDECAR_FACTORY_EVIDENCE';
  readonly report: 'phase-189-sidecar-factory-evidence';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly purpose: 'exercise-sidecar-daemon-through-custodian-factory-without-runtime-cutover';
  readonly daemonWrapperExercised: true;
  readonly custodianFactorySidecarModeExercised: true;
  readonly localSocketOnly: true;
  readonly appHeldCompletionSecretRequired: false;
  readonly appHeldKekRequired: false;
  readonly serviceInstallAllowed: false;
  readonly composeChangeAllowed: false;
  readonly runtimeCutoverAllowed: false;
  readonly providerContactAllowed: false;
  readonly playbackAllowed: false;
  readonly mediaServerMutationAllowed: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly checks: readonly SidecarFactoryEvidenceCheck[];
}

export async function buildSidecarFactoryEvidencePacket(): Promise<SidecarFactoryEvidencePacket> {
  const root = mkdtempSync(join(tmpdir(), 'phase-189-sidecar-factory-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\catalog-sidecar-factory-evidence-${process.pid}-${Date.now()}`
    : join(root, 'run', 'catalog-sidecar.sock');
  const stateDir = join(root, 'state');
  const completionSecretFile = join(root, 'completion_secret');
  const kekFile = join(root, 'custodian_kek');
  writeFileSync(completionSecretFile, 'phase-189-sidecar-factory-secret\n', { encoding: 'utf8', mode: 0o600 });
  writeFileSync(kekFile, `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });

  const checks: SidecarFactoryEvidenceCheck[] = [];
  let daemon: StartedSidecarDaemon | null = null;
  try {
    daemon = await startSidecarDaemon(validateSidecarDaemonConfig({
      socketPath,
      stateDir,
      completionSecretFile,
      kekFile,
    }));
    checks.push(check('daemon-wrapper-started', true, 'Phase 187 daemon wrapper started on local IPC'));

    const config = loadCustodianConfig({
      CUSTODIAN_MODE: 'sidecar',
      CUSTODIAN_SIDECAR_SOCKET_PATH: socketPath,
    });
    checks.push(check('factory-parsed-sidecar-mode', config.mode === 'sidecar', 'factory parsed sidecar mode without app-held secret or KEK'));
    checks.push(check('app-held-secret-rejected-for-sidecar', throwsConfig(() => requireAppHeldCompletionSecret(config, 'phase-189-evidence')), 'sidecar mode does not expose app-held completion secret'));

    const custodian = custodianFromEnv({
      CUSTODIAN_MODE: 'sidecar',
      CUSTODIAN_SIDECAR_SOCKET_PATH: socketPath,
    });
    const provision = await custodian.provision('phase-189-provision', 'phase-189-item-redacted', 0);
    await custodian.commitProvision('phase-189-provision');
    checks.push(check('factory-sidecar-round-trip', (await custodian.get(provision.keyId, 0)).equals(provision.dek), 'factory-created sidecar client round trips DEK through local socket'));
    await custodian.destroy('phase-189-destroy', provision.keyId);
    checks.push(check('destroyed-fails-closed', await throwsAny(() => custodian.get(provision.keyId, 0)), 'destroyed key cannot be read through factory-created sidecar client'));
  } catch {
    checks.push(check('phase-189-evidence-failed-closed', false, 'sidecar factory evidence failed closed'));
  } finally {
    if (daemon) await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }

  checks.push(check('redaction-safe-evidence', evidenceSurfaceIsRedactionSafe(checks), 'evidence contains labels and booleans only'));

  return {
    ok: checks.every((item) => item.status === 'pass'),
    code: 'SIDECAR_FACTORY_EVIDENCE',
    report: 'phase-189-sidecar-factory-evidence',
    version: 1,
    redactionSafe: true,
    purpose: 'exercise-sidecar-daemon-through-custodian-factory-without-runtime-cutover',
    daemonWrapperExercised: true,
    custodianFactorySidecarModeExercised: true,
    localSocketOnly: true,
    appHeldCompletionSecretRequired: false,
    appHeldKekRequired: false,
    serviceInstallAllowed: false,
    composeChangeAllowed: false,
    runtimeCutoverAllowed: false,
    providerContactAllowed: false,
    playbackAllowed: false,
    mediaServerMutationAllowed: false,
    closesO4: false,
    closesO5: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    checks,
  };
}

export function formatSidecarFactoryEvidenceText(report: SidecarFactoryEvidencePacket): string {
  const lines = [
    'Phase 189 Sidecar Factory Evidence',
    `code: ${report.code}`,
    `report: ${report.report}`,
    `redactionSafe: ${report.redactionSafe ? 'true' : 'false'}`,
    `daemonWrapperExercised: ${report.daemonWrapperExercised ? 'true' : 'false'}`,
    `custodianFactorySidecarModeExercised: ${report.custodianFactorySidecarModeExercised ? 'true' : 'false'}`,
    `localSocketOnly: ${report.localSocketOnly ? 'true' : 'false'}`,
    `appHeldCompletionSecretRequired: ${report.appHeldCompletionSecretRequired ? 'true' : 'false'}`,
    `appHeldKekRequired: ${report.appHeldKekRequired ? 'true' : 'false'}`,
    `serviceInstallAllowed: ${report.serviceInstallAllowed ? 'true' : 'false'}`,
    `composeChangeAllowed: ${report.composeChangeAllowed ? 'true' : 'false'}`,
    `runtimeCutoverAllowed: ${report.runtimeCutoverAllowed ? 'true' : 'false'}`,
    `providerContactAllowed: ${report.providerContactAllowed ? 'true' : 'false'}`,
    `playbackAllowed: ${report.playbackAllowed ? 'true' : 'false'}`,
    `mediaServerMutationAllowed: ${report.mediaServerMutationAllowed ? 'true' : 'false'}`,
    `closesO4: ${report.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${report.closesO5 ? 'true' : 'false'}`,
    '',
    'Checks:',
  ];
  for (const check of report.checks) lines.push(`- ${check.status.toUpperCase()} ${check.id}: ${check.label}`);
  return `${lines.join('\n')}\n`;
}

function check(id: string, passed: boolean, label: string): SidecarFactoryEvidenceCheck {
  return { id, status: passed ? 'pass' : 'fail', label };
}

function throwsConfig(fn: () => unknown): boolean {
  try {
    fn();
  } catch {
    return true;
  }
  return false;
}

async function throwsAny(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
  } catch {
    return true;
  }
  return false;
}

function evidenceSurfaceIsRedactionSafe(checks: readonly SidecarFactoryEvidenceCheck[]): boolean {
  const text = JSON.stringify(checks);
  return ![
    'phase-189-sidecar-factory-secret',
    'phase-189-item-redacted',
    'key_',
    'rcpt_',
    'wrappedHex',
    'dekBase64',
    'postgres://',
    'http://',
    'https://',
  ].some((sentinel) => text.includes(sentinel));
}
