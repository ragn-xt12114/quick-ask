/**
 * Clipboard image intake (F-02 extension).
 *
 * Everything pasted from the clipboard is normalised here before it crosses
 * IPC: screenshots keep their pixels, but a 4K PNG is re-encoded to a
 * ≤1568px JPEG so a single paste cannot blow the SVG/IPC/database budget.
 * The main process never decodes image bytes — it only forwards the data URL.
 */

import {
  MAX_CHAT_IMAGE_BYTES,
  type ChatImage,
  type ChatImageMime
} from '../../../shared/channels'
import { isAcceptedImageType } from './clipboardImages'

export { collectClipboardImages, isAcceptedImageType } from './clipboardImages'

/** Longest edge after downscaling. 1568px is the common vision-model tile cap. */
export const MAX_IMAGE_EDGE = 1568
const JPEG_QUALITY = 0.85

/** Decoded payload size of a base64 data URL, in bytes. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const base64 = dataUrl.slice(comma + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

export function mimeFromDataUrl(dataUrl: string): ChatImageMime {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,/.exec(dataUrl)
  return (match?.[1] as ChatImageMime | undefined) ?? 'image/jpeg'
}

async function loadSource(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      // Fall through to the <img> path (e.g. some BMP variants).
    }
  }

  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Convert a pasted image into a `ChatImage`. Throws with a user-facing Chinese
 * message when the format is unsupported or the re-encoded payload is still
 * larger than the IPC limit.
 */
export async function fileToChatImage(file: File): Promise<ChatImage> {
  if (!isAcceptedImageType(file.type)) {
    throw new Error('不支持的图片格式')
  }

  const source = await loadSource(file)
  const width = 'width' in source ? source.width : 0
  const height = 'height' in source ? source.height : 0
  if (width <= 0 || height <= 0) throw new Error('图片尺寸无法识别')

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height))
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法处理图片')

  // Screenshots may carry alpha; JPEG has none. Without a white matte the
  // transparent areas would be encoded as black.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, targetWidth, targetHeight)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source as CanvasImageSource, 0, 0, targetWidth, targetHeight)
  if ('close' in source) source.close()

  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  const bytes = dataUrlBytes(dataUrl)
  if (bytes > MAX_CHAT_IMAGE_BYTES) {
    throw new Error('图片太大，请先压缩')
  }

  return {
    dataUrl,
    mime: mimeFromDataUrl(dataUrl),
    width: targetWidth,
    height: targetHeight,
    bytes
  }
}
