import { describe, expect, it } from 'vitest'
import {
  defaultFontForList,
  filterAllowedFonts,
  isFontAvailable,
  LIST_FONTS_FALLBACK,
  listLocalFonts
} from '../../src/main/fonts/list'
import { DEFAULT_FONT_FAMILY, isAllowedFontFamily, normalizeFontFamily } from '../../src/shared/settings'

describe('local font listing', () => {
  it('detects Noto CJK SC from fc-list output', () => {
    const fonts = listLocalFonts(
      () => 'Noto Sans CJK SC,Noto Sans CJK SC Black\nDejaVu Sans\nSome Random Font\n'
    )
    expect(fonts).toContain('Noto Sans CJK SC')
    expect(fonts).toContain('DejaVu Sans')
    expect(fonts).not.toContain('Some Random Font')
  })

  it('falls back to the known CJK list when fc-list fails', () => {
    const fonts = listLocalFonts(() => {
      throw new Error('no fc-list')
    })
    expect(fonts).toEqual(LIST_FONTS_FALLBACK)
    expect(fonts).toContain('Noto Sans CJK SC')
  })

  it('enumerates real fonts on this machine and only exposes allowed families', () => {
    const fonts = listLocalFonts()
    expect(fonts.length).toBeGreaterThan(0)
    for (const family of fonts) {
      expect(isAllowedFontFamily(family)).toBe(true)
    }
    // 中文字体只保证「装了就能被选出来」，不强求每台机器都装：
    // CI 的 ubuntu-latest 只有 DejaVu/Liberation，中文桌面才有 Noto。
    expect(isAllowedFontFamily(defaultFontForList(fonts))).toBe(true)
  })

  it('rejects unknown families and falls back to the default', () => {
    expect(isAllowedFontFamily('Not A Real Font XYZ')).toBe(false)
    expect(normalizeFontFamily('Not A Real Font XYZ')).toBe(DEFAULT_FONT_FAMILY)
    expect(normalizeFontFamily('Noto Sans CJK SC')).toBe('Noto Sans CJK SC')
  })

  it('picks Noto as the default and checks availability', () => {
    expect(defaultFontForList(['DejaVu Sans', 'Noto Sans CJK SC'])).toBe('Noto Sans CJK SC')
    expect(isFontAvailable(['Noto Sans CJK SC'], 'Noto Sans CJK SC')).toBe(true)
    expect(isFontAvailable(['Noto Sans CJK SC'], 'LXGW WenKai')).toBe(false)
    expect(filterAllowedFonts(['Noto Sans CJK SC', 'Evil Font', '  '])).toEqual([
      'Noto Sans CJK SC'
    ])
  })
})
