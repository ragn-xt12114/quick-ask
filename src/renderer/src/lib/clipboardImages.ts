/**
 * Clipboard image selection for paste events.
 *
 * Kept free of DOM-only types so the de-duplication rule can be unit tested in
 * a plain Node environment.
 */

export interface ClipboardFileItem {
  readonly kind: string
  readonly type: string
  getAsFile(): File | null
}

export interface ClipboardDataLike {
  readonly items?: ArrayLike<ClipboardFileItem>
  readonly files?: ArrayLike<File>
}

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'])

export function isAcceptedImageType(type: string): boolean {
  return ACCEPTED_TYPES.has(type.toLowerCase())
}

/**
 * Images offered by a paste event, in clipboard order.
 *
 * Chromium exposes the same clipboard payload through two views: `items`
 * (authoritative during paste) and `files` (a compatibility view). It builds a
 * separate `File` object for each view, so their `lastModified` values can
 * differ by a few milliseconds. Collecting both would attach one screenshot
 * twice, so `items` wins whenever it yields an accepted image; `files` is only
 * a fallback for synthetic DataTransfer objects or engines that leave `items`
 * empty.
 *
 * There is deliberately no name/size/type de-duplication: two genuinely
 * different pasted images may share those fields.
 */
export function collectClipboardImages(data: ClipboardDataLike): File[] {
  const fromItems: File[] = []
  const items = data.items ? Array.from(data.items) : []
  for (const item of items) {
    if (item.kind !== 'file' || !isAcceptedImageType(item.type)) continue
    const file = item.getAsFile()
    if (file && isAcceptedImageType(file.type)) fromItems.push(file)
  }
  if (fromItems.length > 0) return fromItems

  const fromFiles: File[] = []
  const files = data.files ? Array.from(data.files) : []
  for (const file of files) {
    if (isAcceptedImageType(file.type)) fromFiles.push(file)
  }
  return fromFiles
}
