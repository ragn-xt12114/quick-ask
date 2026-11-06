/**
 * Renderer-side appearance application.
 *
 * Theme/primary/opacity only touch web content: `data-theme`/`data-primary`
 * drive the token overrides and `--card-alpha` controls card translucency.
 * Desktop blur is a KWin property owned by main, so there is deliberately no
 * `backdrop-filter` here. Opaque mode and reduced motion are visual fallbacks
 * driven by the runtime fields of `ui:appearance`.
 */

import type { BlurStatus } from '../../../shared/channels'
import { reducedMotionEnabled } from '../../../shared/motion'
import {
  fontSizeVariables,
  type AppearanceSettings,
  type ThemeSetting
} from '../../../shared/settings'

export interface ApplyAppearanceRuntime {
  blurStatus?: BlurStatus
  opaqueMode?: boolean
  animationDurationFactor?: number
}

export interface RendererAppearanceRuntime {
  blurStatus: BlurStatus
  opaqueMode: boolean
  animationDurationFactor: number
}

export function resolveTheme(setting: ThemeSetting, prefersLight: boolean): 'dark' | 'light' {
  if (setting === 'system') return prefersLight ? 'light' : 'dark'
  return setting
}

export function runtimeFromSignals(
  blurStatus: BlurStatus | null,
  opaqueMode: boolean | null,
  animationDurationFactor: number | null
): RendererAppearanceRuntime {
  return {
    blurStatus:
      blurStatus ?? {
        available: false,
        reason: null,
        compositor: null,
        effectEnabled: null
      },
    opaqueMode: opaqueMode ?? blurStatus?.compositor === false,
    animationDurationFactor:
      typeof animationDurationFactor === 'number' && Number.isFinite(animationDurationFactor)
        ? animationDurationFactor
        : 1
  }
}

export function applyAppearance(
  appearance: AppearanceSettings,
  runtime: ApplyAppearanceRuntime = {}
): void {
  const doc = document.documentElement
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const factor = runtime.animationDurationFactor ?? 1
  const opaque = runtime.opaqueMode === true

  doc.dataset['theme'] = resolveTheme(appearance.theme, prefersLight)
  doc.dataset['themeMode'] = appearance.theme
  doc.dataset['primary'] = appearance.primary
  doc.dataset['blur'] = appearance.blurEnabled ? 'on' : 'off'
  doc.dataset['blurActive'] =
    !opaque && appearance.blurEnabled && runtime.blurStatus?.available === true ? '1' : '0'
  doc.dataset['opaque'] = opaque ? '1' : '0'
  doc.dataset['reducedMotion'] = reducedMotionEnabled(factor, prefersReduced) ? '1' : '0'
  doc.style.setProperty('--card-alpha', opaque ? '1.00' : (appearance.opacity / 100).toFixed(2))
  doc.style.setProperty(
    '--font-ui',
    `'${appearance.fontFamily}', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', sans-serif`
  )
  for (const [token, value] of Object.entries(fontSizeVariables(appearance.fontSize))) {
    doc.style.setProperty(token, value)
  }
}
