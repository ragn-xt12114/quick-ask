import { writeFileSync } from 'node:fs'
import { IPC, type SessionsExportRequest, type SessionsExportResult } from '../../shared/channels'
import { fail, ok, requestSchemas, type IpcResult } from '../../shared/ipc'
import type { AppServices } from '../services/app-services'
import type { SessionState } from '../session/state'
import { registerHandler, type IpcRouter } from '../ipc/register'
import {
  defaultExportFilename,
  sanitizeExportFilename,
  sanitizeTitle,
  serializeSessionsToJson,
  serializeSessionsToMarkdown,
  type ExportSessionInput
} from './serializers'

export interface ExportDialog {
  showSaveDialog(
    window: unknown,
    options: { title: string; defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }
  ): Promise<{ canceled: boolean; filePath?: string }>
}

export interface ExportFs {
  writeFileSync(path: string, content: string): void
}

export interface ExportHandlerDeps {
  dialog: ExportDialog
  fs?: ExportFs
}

export function collectExportSessions(
  services: AppServices,
  state: SessionState | null,
  scope: 'current' | 'all'
): ExportSessionInput[] {
  const db = services.db
  if (!db) throw new Error('Database unavailable')
  if (scope === 'current') {
    const currentId = state?.getCurrentSessionId() ?? null
    if (!currentId) return []
    const session = db.getSession(currentId)
    if (!session) return []
    return [{ session, messages: db.getMessages(currentId) }]
  }
  const summaries = db.listSessions({ limit: 1000, offset: 0 })
  return summaries.flatMap((summary) => {
    const session = db.getSession(summary.id)
    if (!session) return []
    return [{ session, messages: db.getMessages(summary.id) }]
  })
}

export function registerExportHandlers(
  router: IpcRouter,
  getServices: () => AppServices | null,
  getState: () => SessionState | null = () => null,
  deps: ExportHandlerDeps | null = null
): void {
  registerHandler<SessionsExportRequest, SessionsExportResult>(
    router,
    IPC.SESSIONS_EXPORT,
    requestSchemas[IPC.SESSIONS_EXPORT],
    async (payload, context): Promise<IpcResult<SessionsExportResult>> => {
      try {
        const services = getServices()
        if (!services?.db) return fail('INTERNAL', 'Database unavailable')
        const sessions = collectExportSessions(services, getState(), payload.scope)
        const now = Date.now()
        const content =
          payload.format === 'json'
            ? serializeSessionsToJson(sessions, now)
            : serializeSessionsToMarkdown(sessions, now)
        const firstTitle =
          sessions.length === 1 ? sanitizeTitle(sessions[0]!.session.title) : null
        const suggested =
          sessions.length === 1 && firstTitle
            ? sanitizeExportFilename(firstTitle, payload.format)
            : defaultExportFilename(payload.scope, payload.format, now)
        const dialog = deps?.dialog
        if (!dialog) return fail('NOT_IMPLEMENTED', 'Export dialog is unavailable')
        const chosen = await dialog.showSaveDialog(context.window, {
          title: '导出会话',
          defaultPath: suggested,
          filters:
            payload.format === 'json'
              ? [{ name: 'JSON', extensions: ['json'] }]
              : [{ name: 'Markdown', extensions: ['md'] }]
        })
        if (chosen.canceled || !chosen.filePath) {
          return fail('ABORTED', 'Export cancelled')
        }
        const writer = deps?.fs ?? { writeFileSync: (path, text) => writeFileSync(path, text) }
        writer.writeFileSync(chosen.filePath, content)
        try {
          services.settings?.updateData({ lastExportPath: chosen.filePath })
        } catch {
          return fail('INTERNAL', 'Internal error')
        }
        return ok({
          path: chosen.filePath,
          count: sessions.length,
          bytes: Buffer.byteLength(content, 'utf8')
        })
      } catch {
        return fail('INTERNAL', 'Internal error')
      }
    }
  )
}
