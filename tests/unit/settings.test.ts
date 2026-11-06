import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BAR_WIDTH_MAX,
  BAR_WIDTH_MIN,
  DEFAULT_APPEARANCE,
  DEFAULT_BEHAVIOR,
  DEFAULT_DATA,
  DEFAULT_FONT_FAMILY,
  DEFAULT_INFERENCE,
  DEFAULT_MODEL_SETTINGS,
  DEFAULT_SHORTCUT,
  DEFAULT_STARTUP,
  DEFAULT_WINDOW_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  computeOnboardingState,
  deriveProfileName,
  isAllowedFontFamily,
  isLoopbackBaseUrl,
  isValidAccelerator,
  normalizeAppearance,
  normalizeBarWidth,
  normalizeBehavior,
  normalizeData,
  normalizeInference,
  normalizeModelSettings,
  normalizeSettings,
  fontSizeVariables,
  normalizeShortcut,
  type OnboardingProfileInfo
} from '../../src/shared/settings'
import { computeLayout, GUTTER } from '../../src/shared/geometry'
import { openDbService, type DbService } from '../../src/main/db/service'
import { SettingsService, SettingsError } from '../../src/main/settings/service'
import { blurStatusFromSignals } from '../../src/main/settings/blur'

const tempDirs: string[] = []
const dbs: DbService[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function dbService(): DbService {
  const dir = mkdtempSync(join(tmpdir(), 'quickask-settings-'))
  tempDirs.push(dir)
  const db = openDbService({ dataDir: dir })
  dbs.push(db)
  return db
}

describe('settings defaults and normalization', () => {
  it('returns the documented defaults for missing data', () => {
    expect(normalizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE)
    expect(normalizeAppearance({})).toEqual(DEFAULT_APPEARANCE)
    expect(normalizeModelSettings(undefined)).toEqual(DEFAULT_MODEL_SETTINGS)
    expect(normalizeSettings(undefined)).toEqual({
      appearance: DEFAULT_APPEARANCE,
      model: DEFAULT_MODEL_SETTINGS,
      onboardingComplete: false,
      shortcut: DEFAULT_SHORTCUT,
      behavior: DEFAULT_BEHAVIOR,
      inference: DEFAULT_INFERENCE,
      data: DEFAULT_DATA,
      window: DEFAULT_WINDOW_SETTINGS,
      startup: DEFAULT_STARTUP,
      schemaVersion: SETTINGS_SCHEMA_VERSION
    })
  })

  it('clamps opacity to 40..100 and rounds', () => {
    expect(normalizeAppearance({ opacity: -5 }).opacity).toBe(40)
    expect(normalizeAppearance({ opacity: 1000 }).opacity).toBe(100)
    expect(normalizeAppearance({ opacity: 63.6 }).opacity).toBe(64)
    expect(normalizeAppearance({ opacity: Number.NaN }).opacity).toBe(40)
  })

  it('clamps and snaps bar width to the 20px grid', () => {
    expect(normalizeBarWidth(100)).toBe(BAR_WIDTH_MIN)
    expect(normalizeBarWidth(560)).toBe(560)
    expect(normalizeBarWidth(675)).toBe(680)
    expect(normalizeBarWidth(680)).toBe(680)
    expect(normalizeBarWidth(699)).toBe(700)
    expect(normalizeBarWidth(900)).toBe(900)
    expect(normalizeBarWidth(2000)).toBe(BAR_WIDTH_MAX)
    expect(normalizeBarWidth(Number.NaN)).toBe(680)
  })

  it('rejects unknown enums instead of persisting them', () => {
    const value = normalizeAppearance({
      theme: 'neon',
      primary: 'magenta',
      blurEnabled: 'yes',
      barWidth: 700,
      opacity: 80
    })
    expect(value.theme).toBe('dark')
    expect(value.primary).toBe('everforest')
    expect(value.blurEnabled).toBe(true)
    expect(value.barWidth).toBe(700)
    expect(value.opacity).toBe(80)
  })

  it('normalizes the model ref', () => {
    expect(normalizeModelSettings({ profileId: 'p1' })).toEqual({ profileId: 'p1' })
    expect(normalizeModelSettings({ profileId: '' })).toEqual({ profileId: null })
    expect(normalizeModelSettings({ profileId: 42 })).toEqual({ profileId: null })
    expect(normalizeModelSettings('nope')).toEqual({ profileId: null })
  })
})

describe('settings schema v2 groups', () => {
  it('migrates a legacy v1 payload and ignores unknown keys', () => {
    const migrated = normalizeSettings({
      schemaVersion: 1,
      appearance: { theme: 'light', opacity: 80 },
      model: { profileId: 'p-legacy' },
      onboardingComplete: true,
      unknown: { nested: true }
    })

    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(migrated.appearance.theme).toBe('light')
    expect(migrated.appearance.fontFamily).toBe(DEFAULT_FONT_FAMILY)
    expect(migrated.appearance.fontSize).toBe(DEFAULT_APPEARANCE.fontSize)
    expect(migrated.model.profileId).toBe('p-legacy')
    expect(migrated.onboardingComplete).toBe(true)
    expect(migrated.shortcut).toEqual(DEFAULT_SHORTCUT)
    expect(migrated.behavior).toEqual(DEFAULT_BEHAVIOR)
    expect(migrated.inference).toEqual(DEFAULT_INFERENCE)
    expect(migrated.data).toEqual(DEFAULT_DATA)
    expect(migrated.window).toEqual(DEFAULT_WINDOW_SETTINGS)
    expect(migrated.startup).toEqual(DEFAULT_STARTUP)
    expect('unknown' in migrated).toBe(false)
  })

  it('accepts only Electron accelerators with a modifier and a key', () => {
    for (const valid of [
      'Control+Alt+Space',
      'Control+Shift+Space',
      'Super+Space',
      'Meta+Shift+K',
      'Control+Alt+K',
      'CommandOrControl+P'
    ]) {
      expect(isValidAccelerator(valid)).toBe(true)
      expect(normalizeShortcut({ accelerator: valid }).accelerator).toBe(valid)
    }

    for (const invalid of [
      '',
      '   ',
      'Space',
      'K',
      'Control+Alt',
      'Control++',
      '+Space',
      'Control+Alt+Space\r',
      'Control+Alt+Space\n',
      'Control+Alt+Space\u0000',
      'A'.repeat(65)
    ]) {
      expect(isValidAccelerator(invalid)).toBe(false)
    }

    expect(normalizeShortcut({ accelerator: 'Space' })).toEqual(DEFAULT_SHORTCUT)
    expect(normalizeShortcut(undefined)).toEqual(DEFAULT_SHORTCUT)
  })

  it('normalizes behavior booleans and clamps numeric limits', () => {
    expect(normalizeBehavior(undefined)).toEqual(DEFAULT_BEHAVIOR)
    expect(
      normalizeBehavior({
        escDirectHide: true,
        hideOnBlur: false,
        streamingHideDelayMs: 100,
        contextRounds: 500
      })
    ).toEqual({
      escDirectHide: true,
      hideOnBlur: false,
      streamingHideDelayMs: 500,
      contextRounds: 50
    })
    expect(
      normalizeBehavior({
        escDirectHide: 'yes',
        hideOnBlur: 1,
        streamingHideDelayMs: 99_999,
        contextRounds: 0
      })
    ).toEqual({
      escDirectHide: false,
      hideOnBlur: true,
      streamingHideDelayMs: 10_000,
      contextRounds: 1
    })
    expect(
      normalizeBehavior({ streamingHideDelayMs: Number.NaN, contextRounds: Number.NaN })
    ).toEqual(DEFAULT_BEHAVIOR)
  })

  it('normalizes inference sampling, prompt length and timeout', () => {
    expect(normalizeInference(undefined)).toEqual(DEFAULT_INFERENCE)
    expect(
      normalizeInference({
        systemPrompt: '你是 QuickAsk。',
        temperature: 1.2,
        maxTokens: 2048,
        timeoutMs: 45_000
      })
    ).toEqual({
      systemPrompt: '你是 QuickAsk。',
      temperature: 1.2,
      maxTokens: 2048,
      timeoutMs: 45_000
    })
    expect(normalizeInference({ temperature: -1 }).temperature).toBe(0)
    expect(normalizeInference({ temperature: 9 }).temperature).toBe(2)
    expect(normalizeInference({ temperature: 'hot' }).temperature).toBeNull()
    expect(normalizeInference({ maxTokens: 0 }).maxTokens).toBe(1)
    expect(normalizeInference({ maxTokens: 99_999 }).maxTokens).toBe(32_768)
    expect(normalizeInference({ maxTokens: 1.9 }).maxTokens).toBe(1)
    expect(normalizeInference({ maxTokens: 'many' }).maxTokens).toBeNull()
    expect(normalizeInference({ timeoutMs: 1 }).timeoutMs).toBe(5000)
    expect(normalizeInference({ timeoutMs: 999_999 }).timeoutMs).toBe(300_000)
    expect(normalizeInference({ systemPrompt: '中'.repeat(9000) }).systemPrompt).toHaveLength(8000)
  })

  it('normalizes data retention and export path safely', () => {
    expect(normalizeData(undefined)).toEqual(DEFAULT_DATA)
    expect(normalizeData({ retentionDays: 0 })).toEqual({
      retentionDays: 1,
      lastExportPath: null
    })
    expect(normalizeData({ retentionDays: 5000 }).retentionDays).toBe(3650)
    expect(normalizeData({ retentionDays: Number.NaN }).retentionDays).toBeNull()
    expect(normalizeData({ retentionDays: null }).retentionDays).toBeNull()
    expect(normalizeData({ lastExportPath: '   ' }).lastExportPath).toBeNull()
    expect(normalizeData({ lastExportPath: '/tmp/export.json' }).lastExportPath).toBe(
      '/tmp/export.json'
    )
    expect(normalizeData({ lastExportPath: 42 }).lastExportPath).toBeNull()
  })

  it('allows system fonts only and clamps the base font size', () => {
    expect(isAllowedFontFamily(DEFAULT_FONT_FAMILY)).toBe(true)
    expect(isAllowedFontFamily('LXGW WenKai')).toBe(true)
    expect(isAllowedFontFamily('Comic Sans MS')).toBe(false)
    expect(isAllowedFontFamily('Noto Sans CJK SC; background: red')).toBe(false)
    expect(normalizeAppearance({ fontFamily: 'Comic Sans MS' }).fontFamily).toBe(
      DEFAULT_FONT_FAMILY
    )
    expect(normalizeAppearance({ fontFamily: 'LXGW WenKai' }).fontFamily).toBe('LXGW WenKai')
    expect(normalizeAppearance({ fontSize: 8 }).fontSize).toBe(12)
    expect(normalizeAppearance({ fontSize: 40 }).fontSize).toBe(18)
    expect(normalizeAppearance({ fontSize: 15.6 }).fontSize).toBe(16)
    expect(normalizeAppearance({ fontSize: Number.NaN }).fontSize).toBe(14)
    expect(normalizeAppearance({ fontFamily: 'X'.repeat(500) }).fontFamily).toBe(
      DEFAULT_FONT_FAMILY
    )
  })

  it('maps fontSize 14 to the current CSS variables and shifts every token', () => {
    expect(fontSizeVariables(14)).toEqual({
      '--fs-body': '14px',
      '--fs-input': '15px',
      '--fs-title': '13px',
      '--fs-title-lg': '14px',
      '--fs-secondary': '12px',
      '--fs-time': '11px',
      '--fs-code': '13px'
    })
    expect(fontSizeVariables(16)).toMatchObject({
      '--fs-body': '16px',
      '--fs-input': '17px',
      '--fs-title': '15px',
      '--fs-title-lg': '16px',
      '--fs-secondary': '14px',
      '--fs-time': '13px',
      '--fs-code': '15px'
    })
    expect(fontSizeVariables(99)['--fs-body']).toBe('18px')
    expect(fontSizeVariables('nope')['--fs-body']).toBe('14px')
  })
})

describe('onboarding requirement', () => {
  const remote: OnboardingProfileInfo = {
    baseUrl: 'https://api.example.com/v1',
    hasApiKey: false,
    isDefault: true
  }

  it('requires onboarding when no profile exists', () => {
    expect(computeOnboardingState([])).toEqual({ required: true, reason: 'no_profile' })
  })

  it('requires onboarding when no default profile is selected', () => {
    expect(computeOnboardingState([{ ...remote, isDefault: false }])).toEqual({
      required: true,
      reason: 'incomplete'
    })
  })

  it('requires a key for non-loopback providers', () => {
    expect(computeOnboardingState([remote])).toEqual({ required: true, reason: 'no_key' })
    expect(computeOnboardingState([{ ...remote, hasApiKey: true }])).toEqual({
      required: false,
      reason: null
    })
  })

  it('allows empty keys only for loopback providers', () => {
    for (const baseUrl of [
      'http://127.0.0.1:11434/v1',
      'http://localhost:8080/v1',
      'http://[::1]:1234/v1'
    ]) {
      expect(isLoopbackBaseUrl(baseUrl)).toBe(true)
      expect(computeOnboardingState([{ ...remote, baseUrl }])).toEqual({
        required: false,
        reason: null
      })
    }
    expect(isLoopbackBaseUrl('https://api.example.com')).toBe(false)
    expect(isLoopbackBaseUrl('not a url')).toBe(false)
  })
})

describe('onboarding profile name derivation', () => {
  it('uses known provider names for presets', () => {
    expect(deriveProfileName('https://api.deepseek.com')).toBe('DeepSeek')
    expect(deriveProfileName('https://api.deepseek.com/v1')).toBe('DeepSeek')
    expect(deriveProfileName('https://api.openai.com/v1')).toBe('OpenAI')
    expect(deriveProfileName('http://127.0.0.1:11434/v1')).toBe('Ollama 本地')
  })

  it('falls back to the hostname for custom endpoints', () => {
    expect(deriveProfileName('http://127.0.0.1:40775/v1')).toBe('127.0.0.1')
    expect(deriveProfileName('https://llm.example.com/v1')).toBe('llm.example.com')
  })

  it('falls back to 自定义 when the URL is empty or invalid', () => {
    expect(deriveProfileName('')).toBe('自定义')
    expect(deriveProfileName('   ')).toBe('自定义')
    expect(deriveProfileName('not a url')).toBe('自定义')
  })
})

describe('bar width geometry', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 }

  it.each([560, 680, 900])('keeps anchor and content widths at %ipx', (width) => {
    const layout = computeLayout({
      mode: 'S1',
      barAnchor: { x: 620, y: 130 },
      barWidth: width,
      barLines: 1,
      panelH: 120,
      workArea,
      scaleFactor: 1
    })
    expect(layout.barRect.width).toBe(width)
    expect(layout.windowBounds.width).toBe(width + GUTTER.left + GUTTER.right)
    expect(layout.anchor).toEqual({ x: 620, y: 130 })
  })

  it('clamps the anchor when the wider bar would leave the work area', () => {
    const layout = computeLayout({
      mode: 'S1',
      barAnchor: { x: 1000, y: 130 },
      barWidth: 900,
      barLines: 1,
      panelH: 120,
      workArea,
      scaleFactor: 1
    })
    expect(layout.anchor.x).toBe(1920 - 24 - 900)
    expect(layout.windowBounds.x + layout.barRect.x).toBe(layout.anchor.x)
  })
})

describe('SettingsService appearance/model persistence', () => {
  it('normalizes writes, notifies listeners and rejects secret keys', () => {
    const service = new SettingsService(dbService())
    const changes: Array<{ key: string; value: unknown }> = []
    const off = service.onChange((key, value) => changes.push({ key, value }))

    service.updateAppearance({ opacity: 120, barWidth: 699, theme: 'light' })
    expect(service.getAppearance()).toEqual({
      ...DEFAULT_APPEARANCE,
      theme: 'light',
      opacity: 100,
      barWidth: 700
    })
    expect(changes.at(-1)?.key).toBe('appearance')

    service.set('model', { profileId: 'p-1' })
    expect(service.getModelSettings()).toEqual({ profileId: 'p-1' })

    service.setOnboardingComplete(true)
    expect(service.getOnboardingComplete()).toBe(true)

    expect(() => service.set('provider.api_key', 'sk-nope')).toThrow(SettingsError)
    expect(() => service.set('someToken', 'nope')).toThrow(SettingsError)
    off()
  })

  it('persists and bundles the new groups with normalization', () => {
    const service = new SettingsService(dbService())

    service.updateShortcut({ accelerator: 'Control+Shift+Space' })
    expect(service.getShortcut()).toEqual({ accelerator: 'Control+Shift+Space' })
    service.updateShortcut({ accelerator: 'barekey' })
    expect(service.getShortcut()).toEqual(DEFAULT_SHORTCUT)

    service.updateBehavior({ streamingHideDelayMs: 100, contextRounds: 999, hideOnBlur: false })
    expect(service.getBehavior()).toEqual({
      ...DEFAULT_BEHAVIOR,
      streamingHideDelayMs: 500,
      contextRounds: 50,
      hideOnBlur: false
    })

    service.updateInference({ systemPrompt: 'system', temperature: 9, maxTokens: 0, timeoutMs: 1 })
    expect(service.getInference()).toEqual({
      systemPrompt: 'system',
      temperature: 2,
      maxTokens: 1,
      timeoutMs: 5000
    })

    service.updateData({ retentionDays: 5000, lastExportPath: '  /tmp/a.json  ' })
    expect(service.getData()).toEqual({
      retentionDays: 3650,
      lastExportPath: '/tmp/a.json'
    })

    service.updateAppearance({ fontFamily: 'LXGW WenKai', fontSize: 18 })
    expect(service.getAppearance().fontFamily).toBe('LXGW WenKai')
    expect(service.getAppearance().fontSize).toBe(18)

    const bundle = service.getSettingsBundle()
    expect(bundle.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(bundle.shortcut).toEqual(DEFAULT_SHORTCUT)
    expect(bundle.behavior.contextRounds).toBe(50)
    expect(bundle.inference.systemPrompt).toBe('system')
    expect(bundle.data.retentionDays).toBe(3650)
    expect(bundle.appearance.fontSize).toBe(18)
    expect('model' in bundle).toBe(false)
    expect('onboardingComplete' in bundle).toBe(false)
  })
})

describe('blur status reporting', () => {
  it('is honest about disabled compositor/effect combinations', () => {
    expect(blurStatusFromSignals({ compositor: true, effectEnabled: false })).toMatchObject({
      available: false,
      compositor: true,
      effectEnabled: false
    })
    expect(
      blurStatusFromSignals({ compositor: true, effectEnabled: false }).reason
    ).toContain('KWin 模糊效果未开启')
    expect(blurStatusFromSignals({ compositor: false, effectEnabled: true })).toMatchObject({
      available: false
    })
    expect(blurStatusFromSignals({ compositor: true, effectEnabled: null }).available).toBe(false)
    expect(blurStatusFromSignals({ compositor: true, effectEnabled: true })).toEqual({
      available: true,
      reason: null,
      compositor: true,
      effectEnabled: true
    })
  })
})
