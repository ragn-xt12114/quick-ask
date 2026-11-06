/**
 * Keyring backend abstraction.
 *
 * Production uses `WorkerKeyringBackend` (out/main/keyring-worker.js) so a
 * locked/slow Secret Service can never freeze the Electron main process.
 * Unit tests inject a deterministic fake.
 */

export interface KeyringBackend {
  set(service: string, account: string, value: string): Promise<void>
  get(service: string, account: string): Promise<string | null>
  delete(service: string, account: string): Promise<boolean>
  /** Healthy round-trip; throws a `SecretError` when unavailable/locked. */
  ping(): Promise<boolean>
  /** Optional cleanup (terminate worker). */
  close?(): void
}

export interface KeyringCallOptions {
  timeoutMs?: number
  /** Injectable for tests: resolves the worker script path. */
  workerPath?: () => string
}
