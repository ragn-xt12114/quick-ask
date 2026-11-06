/**
 * KeyboardEvent → Electron accelerator conversion for the hotkey recorder.
 *
 * Pure and dependency-free so the renderer and Vitest share exactly the same
 * mapping. The recorder stays responsible for IME/Escape handling; this module
 * only turns a non-modifier key press into an accelerator candidate.
 */

export interface AcceleratorKeyInput {
  key: string
  code?: string
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}

const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Control',
  'Alt',
  'Shift',
  'Meta',
  'OS',
  'AltGraph',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Dead',
  'Compose',
  'Process',
  'Unidentified'
])

const NAMED_KEYS: Readonly<Record<string, string>> = {
  ' ': 'Space',
  Spacebar: 'Space',
  Tab: 'Tab',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Enter',
  Return: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  '+': 'Plus'
}

const PUNCTUATION: ReadonlySet<string> = new Set([
  ',',
  '.',
  '/',
  ';',
  "'",
  '[',
  ']',
  '\\',
  '-',
  '=',
  '`'
])

export function isModifierOnlyKey(key: string): boolean {
  return MODIFIER_KEYS.has(key)
}

function normalizedKey(input: AcceleratorKeyInput): string | null {
  if (input.key === ' ' || input.code === 'Space') return 'Space'
  const named = NAMED_KEYS[input.key]
  if (named !== undefined) return named

  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(input.key)) {
    return input.key.toUpperCase()
  }
  if (/^[a-z]$/i.test(input.key)) return input.key.toUpperCase()
  if (/^[0-9]$/.test(input.key)) return input.key
  if (PUNCTUATION.has(input.key)) return input.key
  return null
}

/**
 * Returns `null` for modifier-only keys and keys Electron cannot express.
 * Callers must additionally validate the result with `isValidAccelerator`
 * (a modifier is required) before registering it.
 */
export function acceleratorFromKeyInput(input: AcceleratorKeyInput): string | null {
  if (isModifierOnlyKey(input.key)) return null
  const key = normalizedKey(input)
  if (key === null) return null

  const modifiers: string[] = []
  if (input.ctrlKey) modifiers.push('Control')
  if (input.altKey) modifiers.push('Alt')
  if (input.shiftKey) modifiers.push('Shift')
  if (input.metaKey) modifiers.push('Super')
  return [...modifiers, key].join('+')
}
