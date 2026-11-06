import { execFileSync } from 'node:child_process'
import { ALLOWED_FONT_FAMILIES, DEFAULT_FONT_FAMILY } from '../../shared/settings'

const KNOWN_CJK_FAMILIES = [
  'Noto Sans CJK SC',
  'Noto Serif CJK SC',
  'Noto Sans SC',
  'Source Han Sans SC',
  'Source Han Serif SC',
  'LXGW WenKai',
  'LXGW WenKai Mono',
  'WenQuanYi Micro Hei',
  'WenQuanYi Zen Hei'
]

export const LIST_FONTS_FALLBACK = [
  'Noto Sans CJK SC',
  'Noto Serif CJK SC',
  'Source Han Sans SC',
  'LXGW WenKai',
  'WenQuanYi Micro Hei'
]

function parseFcList(output: string): string[] {
  const seen = new Set<string>()
  for (const line of output.split('\n')) {
    for (const part of line.split(',')) {
      const name = part.trim()
      if (name.length === 0) continue
      seen.add(name)
    }
  }
  return [...seen]
}

export function filterAllowedFonts(families: readonly string[]): string[] {
  const allowed = new Set<string>(ALLOWED_FONT_FAMILIES as readonly string[])
  const result: string[] = []
  for (const family of families) {
    const trimmed = family.trim()
    if (trimmed.length > 0 && allowed.has(trimmed) && !result.includes(trimmed)) {
      result.push(trimmed)
    }
  }
  return result.sort((a, b) => a.localeCompare(b))
}

export function listLocalFonts(runFcList?: () => string): string[] {
  try {
    const output =
      runFcList?.() ?? execFileSync('fc-list', [':', 'family'], { encoding: 'utf8', timeout: 5000 })
    const detected = filterAllowedFonts(parseFcList(output))
    if (detected.length === 0) {
      return [...LIST_FONTS_FALLBACK]
    }
    return detected
  } catch {
    return [...LIST_FONTS_FALLBACK]
  }
}

export function defaultFontForList(fonts: readonly string[]): string {
  if (fonts.includes(DEFAULT_FONT_FAMILY)) return DEFAULT_FONT_FAMILY
  const cjk = fonts.find((font) => KNOWN_CJK_FAMILIES.includes(font))
  if (cjk) return cjk
  return fonts[0] ?? DEFAULT_FONT_FAMILY
}

export function isFontAvailable(fonts: readonly string[], family: string): boolean {
  return fonts.includes(family.trim())
}
