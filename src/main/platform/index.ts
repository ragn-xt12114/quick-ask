/**
 * Platform adapter selector.
 *
 * `selectPlatform` is pure and takes an explicit platform string so unit tests
 * can cover every branch on a Linux host. `getPlatform` caches the real adapter
 * and falls back to the no-op adapter if construction ever throws.
 */

import { createLinuxAdapter } from './linux'
import { createNoopAdapter } from './noop'
import { createWin32Adapter } from './win32'
import type { PlatformAdapter } from './types'

export function selectPlatform(platform: string = process.platform): PlatformAdapter {
  if (platform === 'linux') return createLinuxAdapter(platform)
  if (platform === 'win32') return createWin32Adapter(platform)
  return createNoopAdapter(platform)
}

let cached: PlatformAdapter | null = null

export function getPlatform(): PlatformAdapter {
  if (cached !== null) return cached
  try {
    cached = selectPlatform(process.platform)
  } catch {
    cached = createNoopAdapter(process.platform)
  }
  return cached
}

/** Test-only: clear the cached adapter after changing mocks or environment. */
export function resetPlatformCache(): void {
  cached = null
}

export type { PlatformAdapter } from './types'
