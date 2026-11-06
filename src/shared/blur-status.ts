/**
 * Honest blur availability mapping shared by main and unit tests.
 *
 * Task 22 exposed the reason strings; Task 23 reuses the same contract for the
 * live compositor monitor so the UI can never claim a blur that KWin will not
 * honor.
 */

import type { BlurStatus } from './channels'

export interface BlurSignals {
  compositor: boolean | null
  effectEnabled: boolean | null
}

export const BLUR_REASON_COMPOSITOR =
  '合成器未运行，桌面模糊不可用（当前使用不透明模式）'
export const BLUR_REASON_EFFECT =
  'KWin 模糊效果未开启（系统设置 → 桌面效果 → 模糊），当前不会伪造模糊'
export const BLUR_REASON_UNKNOWN = '无法检测 KWin 模糊效果，当前不会伪造模糊'

export function blurStatusFromSignals(signals: BlurSignals): BlurStatus {
  const { compositor, effectEnabled } = signals
  if (compositor === false) {
    return { available: false, reason: BLUR_REASON_COMPOSITOR, compositor, effectEnabled }
  }
  if (effectEnabled === false) {
    return { available: false, reason: BLUR_REASON_EFFECT, compositor, effectEnabled }
  }
  if (effectEnabled === null) {
    return { available: false, reason: BLUR_REASON_UNKNOWN, compositor, effectEnabled }
  }
  return { available: true, reason: null, compositor, effectEnabled }
}
