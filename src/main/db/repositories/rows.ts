import type { DbRow } from '../driver'

export function asString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return ''
}

export function asNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return Number(value ?? 0)
}

export function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return asString(value)
}

export function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const number = asNumber(value)
  return Number.isFinite(number) ? number : null
}

export function asBoolean(value: unknown): boolean {
  return asNumber(value) !== 0
}

export function optionalRow(row: DbRow | undefined): DbRow | null {
  return row ?? null
}
