/**
 * Dedicated worker thread for @napi-rs/keyring.
 *
 * A locked/slow Secret Service blocks the sync keyring call, so every
 * operation runs here and the main process enforces a 3s timeout by
 * terminating this worker.
 *
 * Protocol:
 *   { id, op: 'set'|'get'|'delete'|'ping', service?, account?, value? }
 *   -> { id, ok: true, value?: string|null|boolean }
 *   -> { id, ok: false, error: { code, reason } }
 */

import { parentPort } from 'node:worker_threads'
import { Entry } from '@napi-rs/keyring'
import { classifyKeyringError } from './errors'

interface WorkerRequest {
  id: number
  op: 'set' | 'get' | 'delete' | 'ping'
  service?: string
  account?: string
  value?: string
}

interface WorkerErrorPayload {
  code: string
  reason: string
}

/** Pin the Linux store: never silently fall back to kernel keyutils. */
const ENTRY_OPTIONS = { linux: { store: 'secret-service' as const } }

function entryFor(service: string, account: string): Entry {
  return new Entry(service, account, ENTRY_OPTIONS)
}

function handle(request: WorkerRequest): string | boolean | null | undefined {
  switch (request.op) {
    case 'ping': {
      // A read of a non-existent account proves DBus/Secret Service works
      // without creating credentials.
      const probe = entryFor('quickask-health', `ping:${process.pid}`)
      probe.getPassword()
      return true
    }
    case 'set': {
      if (!request.service || !request.account) throw new Error('missing service/account')
      entryFor(request.service, request.account).setPassword(request.value ?? '')
      return undefined
    }
    case 'get': {
      if (!request.service || !request.account) throw new Error('missing service/account')
      return entryFor(request.service, request.account).getPassword()
    }
    case 'delete': {
      if (!request.service || !request.account) throw new Error('missing service/account')
      return entryFor(request.service, request.account).deletePassword()
    }
    default:
      throw new Error(`unknown op: ${String((request as { op?: unknown }).op)}`)
  }
}

function errorPayload(error: unknown): WorkerErrorPayload {
  const mapped = classifyKeyringError(error)
  return {
    code: mapped.code,
    reason: mapped.reason ?? 'keyring operation failed'
  }
}

if (!parentPort) {
  throw new Error('keyring-worker must run inside a worker thread')
}

parentPort.on('message', (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null) return
  const request = raw as WorkerRequest
  if (typeof request.id !== 'number') return

  try {
    const value = handle(request)
    parentPort?.postMessage({ id: request.id, ok: true, value })
  } catch (error) {
    parentPort?.postMessage({ id: request.id, ok: false, error: errorPayload(error) })
  }
})
