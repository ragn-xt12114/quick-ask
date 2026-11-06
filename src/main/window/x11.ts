/**
 * Thin, non-throwing wrapper around `native/quickask-x11`.
 *
 * The helper is the only component allowed to mutate X11 window properties.
 * Errors are logged after redaction and returned as typed results; renderer
 * code never sees a raw helper failure.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { getLogger } from '../logging'
import { redactSummary } from '../secrets/redact'
import type { Rect } from '../../shared/geometry'

export interface X11Result {
  ok: boolean
  stdout: string
  stderr: string
}

export interface InputShapeResult {
  ok: boolean
  count: number
  rects: Rect[]
}

export interface BoundingShapeResult {
  ok: boolean
  count: number
  rects: Rect[]
}

export interface CompositingResult {
  ok: boolean
  compositing: boolean
}

const HELPER_TIMEOUT_MS = 2000

let missingLogged = false

function helperPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'native', 'quickask-x11')
  return join(app.getAppPath(), 'native', 'quickask-x11')
}

function helperDisplayEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DISPLAY: process.env['DISPLAY'] ?? ':0' }
}

function runHelper(args: string[]): Promise<X11Result> {
  return new Promise((resolve) => {
    const path = helperPath()
    if (!existsSync(path)) {
      if (!missingLogged) {
        missingLogged = true
        getLogger().warn('x11_helper_missing', { path })
      }
      resolve({ ok: false, stdout: '', stderr: 'helper missing' })
      return
    }

    execFile(
      path,
      args,
      {
        timeout: HELPER_TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: helperDisplayEnv()
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = redactSummary((stderr || error.message || '').trim(), 200)
          getLogger().error('x11_helper_failed', {
            action: args[0] ?? 'helper',
            detail: detail || 'unknown error'
          })
          resolve({ ok: false, stdout: stdout ?? '', stderr: detail })
          return
        }
        resolve({ ok: true, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

function parseFields(stdout: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    fields.set(line.slice(0, separator), line.slice(separator + 1))
  }
  return fields
}

function parseRectList(raw: string | undefined): Rect[] {
  if (!raw) return []
  const rects: Rect[] = []
  for (const chunk of raw.split(';')) {
    if (chunk.length === 0) continue
    const values = chunk.split(',').map((value) => Number.parseInt(value, 10))
    if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
      return []
    }
    rects.push({ x: values[0]!, y: values[1]!, width: values[2]!, height: values[3]! })
  }
  return rects
}

function serializeRects(rects: Rect[]): string {
  return rects.map((rect) => `${rect.x},${rect.y},${rect.width},${rect.height}`).join(',')
}

export function getNativeWindowId(window: BrowserWindow): number | null {
  try {
    const handle = window.getNativeWindowHandle()
    if (!handle || handle.length < 4) return null
    if (handle.length >= 8) return Number(handle.readBigUInt64LE(0) & 0xffffffffn)
    return handle.readUInt32LE(0)
  } catch {
    return null
  }
}

export function windowIdHex(windowId: number): string {
  return `0x${windowId.toString(16)}`
}

export async function setWmClass(
  windowId: number,
  instance = 'quickask',
  klass = instance
): Promise<X11Result> {
  return runHelper(['set-wm-class', windowIdHex(windowId), instance, klass])
}

export async function remapStates(windowId: number, rects?: Rect[]): Promise<X11Result> {
  const args = ['remap-states', windowIdHex(windowId)]
  if (rects && rects.length > 0) args.push(serializeRects(rects))
  return runHelper(args)
}

export async function setStates(windowId: number): Promise<X11Result> {
  return runHelper(['set-states', windowIdHex(windowId)])
}

export async function setBlur(windowId: number, rects: Rect[]): Promise<X11Result> {
  if (rects.length === 0) return clearBlur(windowId)
  return runHelper(['set-blur', windowIdHex(windowId), serializeRects(rects)])
}

export async function clearBlur(windowId: number): Promise<X11Result> {
  return runHelper(['clear-blur', windowIdHex(windowId)])
}

export async function setInputShape(windowId: number, rects: Rect[]): Promise<X11Result> {
  const args = ['set-input-shape', windowIdHex(windowId)]
  if (rects.length > 0) args.push(serializeRects(rects))
  return runHelper(args)
}

export async function setBoundingShape(windowId: number, rects: Rect[]): Promise<X11Result> {
  const args = ['set-bounding-shape', windowIdHex(windowId)]
  if (rects.length > 0) args.push(serializeRects(rects))
  return runHelper(args)
}

export async function clearBoundingShape(windowId: number): Promise<X11Result> {
  return setBoundingShape(windowId, [])
}

export async function activate(windowId: number, timestamp?: number): Promise<X11Result> {
  const args = ['activate', windowIdHex(windowId)]
  if (timestamp !== undefined) args.push(String(timestamp))
  return runHelper(args)
}

export async function queryCompositing(): Promise<CompositingResult> {
  const result = await runHelper(['query-compositing'])
  if (!result.ok) return { ok: false, compositing: false }
  return {
    ok: true,
    compositing: parseFields(result.stdout).get('COMPOSITING') === '1'
  }
}

export async function queryBoundingShape(
  windowId: number
): Promise<BoundingShapeResult> {
  const result = await runHelper(['query-bounding-shape', windowIdHex(windowId)])
  if (!result.ok) return { ok: false, count: 0, rects: [] }
  const fields = parseFields(result.stdout)
  const count = Number.parseInt(fields.get('BOUNDING_SHAPE') ?? '0', 10)
  return {
    ok: true,
    count: Number.isFinite(count) ? count : 0,
    rects: parseRectList(fields.get('RECTS'))
  }
}

export async function queryInputShape(windowId: number): Promise<InputShapeResult> {
  const result = await runHelper(['query-input-shape', windowIdHex(windowId)])
  if (!result.ok) return { ok: false, count: 0, rects: [] }
  const fields = parseFields(result.stdout)
  const count = Number.parseInt(fields.get('INPUT_SHAPE') ?? '0', 10)
  return {
    ok: true,
    count: Number.isFinite(count) ? count : 0,
    rects: parseRectList(fields.get('RECTS'))
  }
}
