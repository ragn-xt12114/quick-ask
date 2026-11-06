/**
 * Honest compositor/blur detection for startup.
 *
 * The live state machine is `src/main/window/compositor.ts` (Task 23). This
 * module only provides the synchronous snapshot used before the monitor's
 * first async poll finishes, so `app:bootstrap` is never stale.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { BlurStatus } from '../../shared/channels'
import { blurStatusFromSignals } from '../../shared/blur-status'

export {
  BLUR_REASON_COMPOSITOR,
  BLUR_REASON_EFFECT,
  BLUR_REASON_UNKNOWN,
  blurStatusFromSignals
} from '../../shared/blur-status'
export type { BlurSignals } from '../../shared/blur-status'

export function resolveX11HelperPath(): string {
  const override = process.env['QUICKASK_X11_HELPER']
  if (override && override.length > 0) return override
  try {
    if (app?.isPackaged) return join(process.resourcesPath, 'native', 'quickask-x11')
  } catch {
    // fall through to the development path
  }
  let base = process.cwd()
  try {
    base = app?.getAppPath() ?? base
  } catch {
    // keep cwd
  }
  return join(base, 'native', 'quickask-x11')
}

export function readCompositingSync(): boolean | null {
  const path = resolveX11HelperPath()
  if (!existsSync(path)) return null
  try {
    const output = execFileSync(path, ['query-compositing'], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, DISPLAY: process.env['DISPLAY'] ?? ':0' }
    })
    const match = output.match(/COMPOSITING=(\d)/)
    return match ? match[1] === '1' : null
  } catch {
    return null
  }
}

export function parseConfigBoolean(raw: string | null | undefined): boolean | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

export function readKwinBlurEnabledSync(): boolean | null {
  try {
    const dbus = execFileSync(
      'qdbus6',
      ['org.kde.KWin', '/Effects', 'org.kde.kwin.Effects.isEffectLoaded', 'blur'],
      { encoding: 'utf8', timeout: 1500 }
    )
    const loaded = parseConfigBoolean(dbus)
    if (loaded !== null) return loaded
  } catch {
    // fall back to the configuration key
  }
  try {
    const output = execFileSync(
      'kreadconfig6',
      ['--file', 'kwinrc', '--group', 'Plugins', '--key', 'blurEnabled'],
      { encoding: 'utf8', timeout: 1500 }
    )
    return parseConfigBoolean(output)
  } catch {
    return null
  }
}

export function detectBlurStatus(): BlurStatus {
  return blurStatusFromSignals({
    compositor: readCompositingSync(),
    effectEnabled: readKwinBlurEnabledSync()
  })
}
