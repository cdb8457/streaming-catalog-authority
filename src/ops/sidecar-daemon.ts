import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileCustodian } from '../core/crypto/file-custodian.js';
import { LocalSidecarCustodianClient } from '../core/crypto/local-sidecar-custodian.js';
import {
  assertLocalSocketPath,
  startLocalSidecarRuntime,
  UnixSocketSidecarTransport,
  type LocalSidecarRuntimeHandle,
} from '../core/crypto/local-sidecar-runtime.js';

export interface SidecarDaemonConfigInput {
  readonly socketPath?: string;
  readonly stateDir?: string;
  readonly completionSecretFile?: string;
  readonly kekFile?: string;
}

export interface SidecarDaemonConfig {
  readonly socketPath: string;
  readonly stateDir: string;
  readonly completionSecretFile: string;
  readonly kekFile: string;
}

export interface StartedSidecarDaemon {
  readonly socketPath: string;
  readonly stateDir: string;
  readonly mode: 'local-filecustodian-reference-harness';
  close(): Promise<void>;
}

export interface SidecarDaemonSelfTestReport {
  readonly ok: boolean;
  readonly code: 'SIDECAR_DAEMON_SELF_TEST';
  readonly report: 'phase-187-sidecar-daemon-self-test';
  readonly redactionSafe: true;
  readonly executableImplemented: true;
  readonly localSocketOnly: true;
  readonly usesFileCustodianReferenceHarness: true;
  readonly serviceInstallAllowed: false;
  readonly composeChangeAllowed: false;
  readonly runtimeCutoverAllowed: false;
  readonly providerContactAllowed: false;
  readonly playbackAllowed: false;
  readonly mediaServerMutationAllowed: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly checks: readonly SidecarDaemonSelfTestCheck[];
}

export interface SidecarDaemonSelfTestCheck {
  readonly id: string;
  readonly state: 'pass' | 'fail';
  readonly detail: string;
}

export class SidecarDaemonConfigError extends Error {
  constructor() {
    super('unsafe or incomplete sidecar daemon config');
    this.name = 'SidecarDaemonConfigError';
  }
}

export function validateSidecarDaemonConfig(input: SidecarDaemonConfigInput): SidecarDaemonConfig {
  const socketPath = valueOrEnv(input.socketPath, 'SIDECAR_SOCKET_PATH');
  const stateDir = valueOrEnv(input.stateDir, 'SIDECAR_STATE_DIR');
  const completionSecretFile = valueOrEnv(input.completionSecretFile, 'SIDECAR_COMPLETION_SECRET_FILE');
  const kekFile = valueOrEnv(input.kekFile, 'SIDECAR_KEK_FILE');
  if (!socketPath || !stateDir || !completionSecretFile || !kekFile) throw new SidecarDaemonConfigError();
  try {
    assertLocalSocketPath(socketPath);
  } catch {
    throw new SidecarDaemonConfigError();
  }
  if (looksLikeNetworkEndpoint(stateDir) || looksLikeNetworkEndpoint(completionSecretFile) || looksLikeNetworkEndpoint(kekFile)) {
    throw new SidecarDaemonConfigError();
  }
  return { socketPath, stateDir, completionSecretFile, kekFile };
}

export async function startSidecarDaemon(config: SidecarDaemonConfig): Promise<StartedSidecarDaemon> {
  mkdirOwnerOnly(config.stateDir);
  if (process.platform !== 'win32') mkdirOwnerOnly(dirname(config.socketPath));

  const custodian = new FileCustodian(
    config.stateDir,
    readSecret(config.completionSecretFile),
    readKek(config.kekFile),
  );
  const runtime = await startLocalSidecarRuntime({ socketPath: config.socketPath, custodian });
  chmodSocketBestEffort(runtime);
  return {
    socketPath: runtime.socketPath,
    stateDir: config.stateDir,
    mode: 'local-filecustodian-reference-harness',
    close: () => runtime.close(),
  };
}

export async function runSidecarDaemonSelfTest(): Promise<SidecarDaemonSelfTestReport> {
  const root = mkdtempSync(join(tmpdir(), 'phase-187-sidecar-daemon-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\catalog-sidecar-daemon-${process.pid}-${Date.now()}`
    : join(root, 'run', 'catalog-sidecar.sock');
  const stateDir = join(root, 'state');
  const completionSecretFile = join(root, 'completion_secret');
  const kekFile = join(root, 'custodian_kek');
  writeFileSync(completionSecretFile, 'phase-187-sidecar-daemon-secret\n', { encoding: 'utf8', mode: 0o600 });
  writeFileSync(kekFile, `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });

  const checks: SidecarDaemonSelfTestCheck[] = [];
  let daemon: StartedSidecarDaemon | null = null;
  try {
    daemon = await startSidecarDaemon(validateSidecarDaemonConfig({
      socketPath,
      stateDir,
      completionSecretFile,
      kekFile,
    }));
    checks.push(check('daemon-started', true, 'sidecar executable wrapper started on a local socket'));

    const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(socketPath));
    const provision = await client.provision('phase-187-provision', 'phase-187-item-redacted', 0);
    await client.commitProvision('phase-187-provision');
    checks.push(check('contract-round-trip', (await client.get(provision.keyId, 0)).length === 32, 'provision/commit/get works over the socket'));
    await client.destroy('phase-187-destroy', provision.keyId);
    checks.push(check('destroy-fails-closed', await throwsAny(() => client.get(provision.keyId, 0)), 'destroyed key cannot be read'));
  } catch {
    checks.push(check('daemon-self-test', false, 'sidecar executable self-test failed closed'));
  } finally {
    if (daemon) await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }

  checks.push(check('redaction-safe', evidenceSurfaceIsRedactionSafe(checks), 'self-test evidence contains labels only'));

  return {
    ok: checks.every((item) => item.state === 'pass'),
    code: 'SIDECAR_DAEMON_SELF_TEST',
    report: 'phase-187-sidecar-daemon-self-test',
    redactionSafe: true,
    executableImplemented: true,
    localSocketOnly: true,
    usesFileCustodianReferenceHarness: true,
    serviceInstallAllowed: false,
    composeChangeAllowed: false,
    runtimeCutoverAllowed: false,
    providerContactAllowed: false,
    playbackAllowed: false,
    mediaServerMutationAllowed: false,
    closesO4: false,
    closesO5: false,
    checks,
  };
}

function valueOrEnv(value: string | undefined, envName: string): string | undefined {
  const candidate = value ?? process.env[envName];
  return candidate && candidate.trim() !== '' ? candidate : undefined;
}

function mkdirOwnerOnly(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

function readSecret(path: string): string {
  const value = readFileSync(path, 'utf8').trim();
  if (!value) throw new SidecarDaemonConfigError();
  return value;
}

function readKek(path: string): Buffer {
  const value = readFileSync(path, 'utf8').trim();
  const decoded = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (decoded.length !== 32) throw new SidecarDaemonConfigError();
  return decoded;
}

function chmodSocketBestEffort(runtime: LocalSidecarRuntimeHandle): void {
  if (process.platform === 'win32') return;
  chmodSync(runtime.socketPath, 0o600);
}

function looksLikeNetworkEndpoint(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^[^/\\]+:\d+$/i.test(value);
}

function check(id: string, passed: boolean, detail: string): SidecarDaemonSelfTestCheck {
  return { id, state: passed ? 'pass' : 'fail', detail };
}

async function throwsAny(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
  } catch {
    return true;
  }
  return false;
}

function evidenceSurfaceIsRedactionSafe(checks: readonly SidecarDaemonSelfTestCheck[]): boolean {
  const text = JSON.stringify(checks);
  return ![
    'phase-187-sidecar-daemon-secret',
    'phase-187-item-redacted',
    'key_',
    'rcpt_',
    'wrappedHex',
    'dekBase64',
    'postgres://',
    'http://',
    'https://',
  ].some((sentinel) => text.includes(sentinel));
}
