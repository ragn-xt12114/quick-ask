import { shell } from 'electron'
import { IPC, type LinksOpenExternalResult } from '../../../shared/channels'
import { ok, requestSchemas, type IpcResult } from '../../../shared/ipc'
import { registerHandler, type IpcRouter } from '../register'

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function registerLinkHandlers(router: IpcRouter): void {
  registerHandler<{ url: string }, LinksOpenExternalResult>(
    router,
    IPC.LINKS_OPEN_EXTERNAL,
    requestSchemas[IPC.LINKS_OPEN_EXTERNAL],
    async (payload): Promise<IpcResult<LinksOpenExternalResult>> => {
      if (!isHttpUrl(payload.url)) return ok({ opened: false })
      try {
        await shell.openExternal(payload.url)
        return ok({ opened: true })
      } catch {
        return ok({ opened: false })
      }
    }
  )
}
