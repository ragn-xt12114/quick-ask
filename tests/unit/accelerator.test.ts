import { describe, expect, it } from 'vitest'
import {
  acceleratorFromKeyInput,
  isModifierOnlyKey
} from '../../src/shared/accelerator'
import { isValidAccelerator } from '../../src/shared/settings'

describe('acceleratorFromKeyInput', () => {
  it('builds modifier + key accelerators in Electron order', () => {
    expect(
      acceleratorFromKeyInput({ key: ' ', code: 'Space', ctrlKey: true, altKey: true })
    ).toBe('Control+Alt+Space')
    expect(
      acceleratorFromKeyInput({ key: 'F9', ctrlKey: true, shiftKey: true })
    ).toBe('Control+Shift+F9')
    expect(acceleratorFromKeyInput({ key: ' ', code: 'Space', metaKey: true })).toBe(
      'Super+Space'
    )
    expect(
      acceleratorFromKeyInput({ key: 'k', ctrlKey: true, altKey: true, shiftKey: true })
    ).toBe('Control+Alt+Shift+K')
  })

  it('uppercases letters, supports Tab/arrows/F1-F24 and punctuation', () => {
    expect(acceleratorFromKeyInput({ key: 'a', ctrlKey: true })).toBe('Control+A')
    expect(acceleratorFromKeyInput({ key: 'Tab', ctrlKey: true })).toBe('Control+Tab')
    expect(acceleratorFromKeyInput({ key: 'ArrowUp', altKey: true })).toBe('Alt+Up')
    expect(acceleratorFromKeyInput({ key: 'ArrowLeft', ctrlKey: true })).toBe(
      'Control+Left'
    )
    expect(acceleratorFromKeyInput({ key: 'F24', shiftKey: true })).toBe('Shift+F24')
    expect(acceleratorFromKeyInput({ key: ',', ctrlKey: true })).toBe('Control+,')
  })

  it('returns null for modifier-only and unsupported keys', () => {
    expect(isModifierOnlyKey('Control')).toBe(true)
    expect(isModifierOnlyKey('Shift')).toBe(true)
    expect(isModifierOnlyKey('Meta')).toBe(true)
    for (const key of ['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'Unidentified']) {
      expect(acceleratorFromKeyInput({ key, ctrlKey: true })).toBeNull()
    }
    expect(acceleratorFromKeyInput({ key: 'Escape' })).toBeNull()
    expect(acceleratorFromKeyInput({ key: 'AudioVolumeUp', ctrlKey: true })).toBeNull()
  })

  it('emits keys without modifiers that the shared validator rejects', () => {
    const bare = acceleratorFromKeyInput({ key: 'F9' })
    expect(bare).toBe('F9')
    expect(isValidAccelerator(bare)).toBe(false)
    expect(isValidAccelerator(acceleratorFromKeyInput({ key: ' ', ctrlKey: true }))).toBe(true)
  })
})
