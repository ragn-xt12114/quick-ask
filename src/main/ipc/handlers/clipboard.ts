/**
 * Clipboard IPC handlers (Task 18 / F-09).
 *
 * Reading happens in the main process only. The result is capped to 1 MB so a
 * pathological clipboard can never bloat the IPC response; the renderer still
 * decides whether the text is short enough for the clipboard chip (1–2000
 * chars). A read failure returns an empty string instead of an error: the
 * composer must appear normally and never show a clipboard error.
 */

import { clipboard } from 'electron'
import {
  IPC,
  type ClipboardReadTextResult,
  type ClipboardWriteTextResult
} from '../../../shared/channels'
import { ok, requestSchemas, type IpcResult } from '../../../shared/ipc'
import { registerHandler, type IpcRouter } from '../register'

export const MAX_CLIPBOARD_TEXT_CHARS = 1_000_000

export function registerClipboardHandlers(router: IpcRouter): void {
  registerHandler<undefined, ClipboardReadTextResult>(
    router,
    IPC.CLIPBOARD_READ_TEXT,
    requestSchemas[IPC.CLIPBOARD_READ_TEXT],
    async (): Promise<IpcResult<ClipboardReadTextResult>> => {
      try {
        const text = await clipboard.readText()
        return ok({
          text: text.length > MAX_CLIPBOARD_TEXT_CHARS
            ? text.slice(0, MAX_CLIPBOARD_TEXT_CHARS)
            : text
        })
      } catch {
        return ok({ text: '' })
      }
    }
  )

  registerHandler<{ text: string }, ClipboardWriteTextResult>(
    router,
    IPC.CLIPBOARD_WRITE_TEXT,
    requestSchemas[IPC.CLIPBOARD_WRITE_TEXT],
    async (payload): Promise<IpcResult<ClipboardWriteTextResult>> => {
      try {
        await clipboard.writeText(payload.text)
        return ok({ written: true })
      } catch {
        return ok({ written: false })
      }
    }
  )
}
