/**
 * Worker-thread-backed keyring backend.
 *
 * One operation at a time is expected (provider settings are user-driven),
 * but the protocol supports multiple in-flight ids. Every call has a hard
 * timeout; on timeout the worker is terminated and recreated on the next use.
 */

import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  SECRET_ERROR_CODES,
  SecretError,
  type SecretErrorCode
} from './errors'
import type { KeyringBackend, KeyringCallOptions } from './keyring-backend'

export const DEFAULT_KEYRING_TIMEOUT_MS = 3000

interface WorkerResponse {
  id: number
  ok: boolean
  value?: string | boolean | null
  error?: { code?: string; reason?: string }
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout
}

function isSecretErrorCode(value: unknown): value is SecretErrorCode {
  return typeof value === 'string' && (SECRET_ERROR_CODES as readonly string[]).includes(value)
}

export class WorkerKeyringBackend implements KeyringBackend {
  private readonly timeoutMs: number
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private closed = false

  constructor(private readonly options: KeyringCallOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_KEYRING_TIMEOUT_MS
  }

  private scriptPath(): string {
    if (this.options.workerPath) return this.options.workerPath()
    return join(__dirname, 'keyring-worker.js')
  }

  private ensureWorker(): Worker {
    if (this.closed) throw new SecretError('KEYRING_UNAVAILABLE', 'keyring backend closed')
    if (this.worker) return this.worker

    let worker: Worker
    try {
      worker = new Worker(this.scriptPath())
    } catch (error) {
      throw new SecretError(
        'KEYRING_UNAVAILABLE',
        error instanceof Error ? error.message.slice(0, 200) : 'worker start failed'
      )
    }

    worker.on('message', (message: WorkerResponse) => this.onMessage(message))
    worker.on('error', (error: Error) => {
      this.failAll(new SecretError('KEYRING_UNAVAILABLE', error.message.slice(0, 200)))
    })
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = null
      this.failAll(new SecretError('KEYRING_UNAVAILABLE', 'keyring worker exited'))
    })

    this.worker = worker
    return worker
  }

  private onMessage(message: WorkerResponse): void {
    if (!message || typeof message.id !== 'number') return
    const call = this.pending.get(message.id)
    if (!call) return
    this.pending.delete(message.id)
    clearTimeout(call.timer)

    if (message.ok) {
      call.resolve(message.value)
      return
    }

    const code = isSecretErrorCode(message.error?.code)
      ? message.error.code
      : 'KEYRING_UNAVAILABLE'
    call.reject(new SecretError(code, message.error?.reason))
  }

  private failAll(error: SecretError): void {
    for (const [, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(error)
    }
    this.pending.clear()
  }

  private discardWorker(): void {
    const worker = this.worker
    this.worker = null
    if (!worker) return
    worker.removeAllListeners()
    void worker.terminate()
  }

  private call<T>(payload: {
    op: 'set' | 'get' | 'delete' | 'ping'
    service?: string
    account?: string
    value?: string
  }): Promise<T> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    const timeoutMs = this.timeoutMs

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        // A hung Secret Service call cannot be cancelled; kill the thread.
        this.failAll(
          new SecretError('KEYRING_TIMEOUT', `keyring worker exceeded ${timeoutMs}ms`)
        )
        this.discardWorker()
        reject(new SecretError('KEYRING_TIMEOUT', `keyring ${payload.op} exceeded ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })

      try {
        worker.postMessage({ id, ...payload })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(
          new SecretError(
            'KEYRING_UNAVAILABLE',
            error instanceof Error ? error.message.slice(0, 200) : 'worker postMessage failed'
          )
        )
      }
    })
  }

  async set(service: string, account: string, value: string): Promise<void> {
    await this.call<void>({ op: 'set', service, account, value })
  }

  async get(service: string, account: string): Promise<string | null> {
    const value = await this.call<string | null>({ op: 'get', service, account })
    return typeof value === 'string' ? value : null
  }

  async delete(service: string, account: string): Promise<boolean> {
    return (await this.call<boolean>({ op: 'delete', service, account })) === true
  }

  async ping(): Promise<boolean> {
    return (await this.call<boolean>({ op: 'ping' })) === true
  }

  close(): void {
    this.closed = true
    this.failAll(new SecretError('KEYRING_UNAVAILABLE', 'keyring backend closed'))
    this.discardWorker()
  }
}
