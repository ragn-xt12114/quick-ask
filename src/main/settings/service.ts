/**
 * Non-secret settings service.
 *
 * Keys that look like credentials are rejected outright; secrets belong in
 * SecretStore, never in the `settings` table. Appearance/model/onboarding
 * values are normalized before they are persisted so a hand-edited DB cannot
 * smuggle an invalid enum, out-of-range opacity or an unsnapped bar width.
 */

import type { JsonValue } from '../../shared/channels'
import {
  SETTINGS_KEYS,
  SETTINGS_SCHEMA_VERSION,
  normalizeAppearance,
  normalizeBehavior,
  normalizeData,
  normalizeInference,
  normalizeModelSettings,
  normalizeShortcut,
  normalizeStartup,
  normalizeWindowSettings,
  type AppearanceSettings,
  type BehaviorSettings,
  type DataSettings,
  type InferenceSettings,
  type ModelSettingsRef,
  type NormalizedSettings,
  type SettingsBundle,
  type ShortcutSettings,
  type StartupSettings,
  type WindowSettings
} from '../../shared/settings'
import type { DbService } from '../db/service'

export type SettingsErrorCode = 'INVALID_ARGUMENT'

export class SettingsError extends Error {
  readonly code: SettingsErrorCode

  constructor(message: string) {
    super(message)
    this.name = 'SettingsError'
    this.code = 'INVALID_ARGUMENT'
  }
}

const SECRET_KEY_PATTERN = /key|token|secret|password/i

export type SettingsChangeListener = (key: string, value: JsonValue) => void

export class SettingsService {
  private readonly listeners = new Set<SettingsChangeListener>()

  constructor(private readonly db: DbService) {}

  getAll(): Record<string, JsonValue> {
    return this.db.settings.getAll()
  }

  get(key: string): JsonValue | undefined {
    this.assertKey(key)
    return this.db.settings.get(key)
  }

  set(key: string, value: JsonValue): boolean {
    this.assertKey(key)
    const normalized = this.normalizeValue(key, value)
    this.db.settings.set(key, normalized)
    for (const listener of this.listeners) {
      try {
        listener(key, normalized)
      } catch {
        // A listener must never break persistence.
      }
    }
    return true
  }

  onChange(listener: SettingsChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAppearance(): AppearanceSettings {
    return normalizeAppearance(this.db.settings.get(SETTINGS_KEYS.appearance))
  }

  updateAppearance(patch: Partial<AppearanceSettings>): AppearanceSettings {
    const next = normalizeAppearance({ ...this.getAppearance(), ...patch })
    this.set(SETTINGS_KEYS.appearance, next as unknown as JsonValue)
    return next
  }

  getShortcut(): ShortcutSettings {
    return normalizeShortcut(this.db.settings.get(SETTINGS_KEYS.shortcut))
  }

  updateShortcut(patch: Partial<ShortcutSettings>): ShortcutSettings {
    const next = normalizeShortcut({ ...this.getShortcut(), ...patch })
    this.set(SETTINGS_KEYS.shortcut, next as unknown as JsonValue)
    return next
  }

  getBehavior(): BehaviorSettings {
    return normalizeBehavior(this.db.settings.get(SETTINGS_KEYS.behavior))
  }

  updateBehavior(patch: Partial<BehaviorSettings>): BehaviorSettings {
    const next = normalizeBehavior({ ...this.getBehavior(), ...patch })
    this.set(SETTINGS_KEYS.behavior, next as unknown as JsonValue)
    return next
  }

  getInference(): InferenceSettings {
    return normalizeInference(this.db.settings.get(SETTINGS_KEYS.inference))
  }

  updateInference(patch: Partial<InferenceSettings>): InferenceSettings {
    const next = normalizeInference({ ...this.getInference(), ...patch })
    this.set(SETTINGS_KEYS.inference, next as unknown as JsonValue)
    return next
  }

  getData(): DataSettings {
    return normalizeData(this.db.settings.get(SETTINGS_KEYS.data))
  }

  updateData(patch: Partial<DataSettings>): DataSettings {
    const next = normalizeData({ ...this.getData(), ...patch })
    this.set(SETTINGS_KEYS.data, next as unknown as JsonValue)
    return next
  }

  getWindow(): WindowSettings {
    return normalizeWindowSettings(this.db.settings.get(SETTINGS_KEYS.window))
  }

  updateWindow(patch: Partial<WindowSettings>): WindowSettings {
    const next = normalizeWindowSettings({ ...this.getWindow(), ...patch })
    this.set(SETTINGS_KEYS.window, next as unknown as JsonValue)
    return next
  }

  getStartup(): StartupSettings {
    return normalizeStartup(this.db.settings.get(SETTINGS_KEYS.startup))
  }

  updateStartup(patch: Partial<StartupSettings>): StartupSettings {
    const next = normalizeStartup({ ...this.getStartup(), ...patch })
    this.set(SETTINGS_KEYS.startup, next as unknown as JsonValue)
    return next
  }

  getSettingsBundle(): SettingsBundle {
    return {
      appearance: this.getAppearance(),
      shortcut: this.getShortcut(),
      behavior: this.getBehavior(),
      inference: this.getInference(),
      data: this.getData(),
      window: this.getWindow(),
      startup: this.getStartup(),
      schemaVersion: SETTINGS_SCHEMA_VERSION
    }
  }

  getNormalizedSettings(): NormalizedSettings {
    return {
      ...this.getSettingsBundle(),
      model: this.getModelSettings(),
      onboardingComplete: this.getOnboardingComplete()
    }
  }

  getModelSettings(): ModelSettingsRef {
    return normalizeModelSettings(this.db.settings.get(SETTINGS_KEYS.model))
  }

  getOnboardingComplete(): boolean {
    return this.db.settings.get(SETTINGS_KEYS.onboardingComplete) === true
  }

  setOnboardingComplete(complete: boolean): void {
    this.set(SETTINGS_KEYS.onboardingComplete, complete)
  }

  private normalizeValue(key: string, value: JsonValue): JsonValue {
    switch (key) {
      case SETTINGS_KEYS.appearance:
        return normalizeAppearance(value) as unknown as JsonValue
      case SETTINGS_KEYS.model:
        return normalizeModelSettings(value) as unknown as JsonValue
      case SETTINGS_KEYS.shortcut:
        return normalizeShortcut(value) as unknown as JsonValue
      case SETTINGS_KEYS.behavior:
        return normalizeBehavior(value) as unknown as JsonValue
      case SETTINGS_KEYS.inference:
        return normalizeInference(value) as unknown as JsonValue
      case SETTINGS_KEYS.data:
        return normalizeData(value) as unknown as JsonValue
      case SETTINGS_KEYS.window:
        return normalizeWindowSettings(value) as unknown as JsonValue
      case SETTINGS_KEYS.startup:
        return normalizeStartup(value) as unknown as JsonValue
      case SETTINGS_KEYS.onboardingComplete:
        return value === true
      default:
        return value
    }
  }

  private assertKey(key: string): void {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new SettingsError('settings key is required')
    }
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new SettingsError('secret-looking settings keys are not allowed')
    }
  }
}
