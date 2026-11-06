import { describe, expect, it } from 'vitest'
import {
  collectClipboardImages,
  type ClipboardDataLike,
  type ClipboardFileItem
} from '../../src/renderer/src/lib/clipboardImages'

function file(name: string, type: string, lastModified: number, body = 'pixels'): File {
  return new File([body], name, { type, lastModified })
}

function itemOf(image: File): ClipboardFileItem {
  return { kind: 'file', type: image.type, getAsFile: () => image }
}

function textItem(): ClipboardFileItem {
  return { kind: 'string', type: 'text/plain', getAsFile: () => null }
}

function clipboard(overrides: Partial<ClipboardDataLike>): ClipboardDataLike {
  return { items: [], files: [], ...overrides }
}

describe('collectClipboardImages', () => {
  it('keeps one image when items and files carry the same payload with different lastModified', () => {
    // Real X11/Chromium paste: two File instances for the same bitmap, 7ms apart.
    const fromItems = file('image.png', 'image/png', 1_793_923_577_943)
    const fromFiles = file('image.png', 'image/png', 1_793_923_577_936)

    const result = collectClipboardImages(
      clipboard({ items: [itemOf(fromItems)], files: [fromFiles] })
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toBe(fromItems)
  })

  it('falls back to files when items yields no accepted image', () => {
    const screenshot = file('screenshot.png', 'image/png', 42)
    const result = collectClipboardImages(
      clipboard({ items: [textItem()], files: [screenshot] })
    )

    expect(result).toEqual([screenshot])
  })

  it('keeps two genuinely different images even when name, size and type match', () => {
    const first = file('image.png', 'image/png', 1, 'first')
    const second = file('image.png', 'image/png', 2, 'second')

    const result = collectClipboardImages(
      clipboard({ items: [itemOf(first), itemOf(second)], files: [first, second] })
    )

    expect(result).toHaveLength(2)
    expect(result[0]).toBe(first)
    expect(result[1]).toBe(second)
  })

  it('drops non-image and unsupported image payloads', () => {
    const text = file('notes.txt', 'text/plain', 1)
    const svg = file('vector.svg', 'image/svg+xml', 2)

    const result = collectClipboardImages(
      clipboard({ items: [itemOf(text), itemOf(svg)], files: [text, svg] })
    )

    expect(result).toEqual([])
  })
})
