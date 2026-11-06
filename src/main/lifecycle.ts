import { getLogger } from './logging'
import { redactSummary } from './secrets/redact'

export interface DbCheckpointResult {
  ok: boolean
  busy?: number
  log?: number
  checkpointed?: number
  error?: string
}

export interface LifecycleWindowLike {
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown
}

export interface LifecycleWebContentsLike {
  on(
    event: 'render-process-gone',
    listener: (event: unknown, details: RenderProcessGoneDetails) => void
  ): unknown
}

export interface RenderProcessGoneDetails {
  reason: string
  exitCode: number
}

export interface ChildProcessGoneDetails {
  type?: string
  reason?: string
  exitCode?: number
  serviceName?: string
}

export interface QuitHook {
  (): void | Promise<void>
}

export interface LifecycleOptions {
  hideMain(): void
  checkpointDb(): DbCheckpointResult
  /**
   * Reload the crashed main renderer after a short delay. Streaming and
   * persistence keep running in this (main) process while the renderer is
   * gone; the reloaded renderer rehydrates from bootstrap/chat:get-active.
   */
  reloadRenderer?(): void
  destroyTray(): void
  unregisterHotkeys(): void
  closeServices(): void
  destroyWindows?(): void
  exit(code: number): void
  logger?: (line: string) => void
  hookTimeoutMs?: number
  forceExitTimeoutMs?: number
  /** Delay before reloading after render-process-gone (default 500ms). */
  rendererReloadDelayMs?: number
}

const DEFAULT_TIMEOUT_MS = 3000

export class Lifecycle {
  private quitting = false
  private exited = false
  private readonly quitHooks: QuitHook[] = []
  private readonly attachedWindows = new WeakSet<LifecycleWindowLike>()
  private readonly attachedContents = new WeakSet<LifecycleWebContentsLike>()
  private readonly hookTimeoutMs: number
  private readonly forceExitTimeoutMs: number
  private readonly rendererReloadDelayMs: number
  private rendererReloadTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: LifecycleOptions) {
    this.hookTimeoutMs = options.hookTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.forceExitTimeoutMs = options.forceExitTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.rendererReloadDelayMs = options.rendererReloadDelayMs ?? 500
  }

  isQuitting(): boolean {
    return this.quitting
  }

  registerQuitHook(hook: QuitHook): () => void {
    this.quitHooks.push(hook)
    return () => {
      const index = this.quitHooks.indexOf(hook)
      if (index >= 0) this.quitHooks.splice(index, 1)
    }
  }

  attachMainWindow(window: LifecycleWindowLike): void {
    if (this.attachedWindows.has(window)) return
    this.attachedWindows.add(window)
    window.on('close', (event) => {
      if (this.quitting) return
      event.preventDefault()
      this.options.hideMain()
      this.event('lifecycle_close_hidden')
      this.options.logger?.('[lifecycle] close intercepted -> hide (app stays alive)')
    })
  }

  attachWebContents(contents: LifecycleWebContentsLike): void {
    if (this.attachedContents.has(contents)) return
    this.attachedContents.add(contents)
    contents.on('render-process-gone', (_event, details) => {
      this.logRenderProcessGone(details)
      this.scheduleRendererReload(details)
    })
  }

  /**
   * The main process never owns renderer state, so a renderer crash must not
   * interrupt an active stream. Reload after a short grace period; the new
   * renderer rehydrates through `app:bootstrap`, `chat:get-active` and
   * `sessions:state` (Task 19/21).
   */
  private scheduleRendererReload(details: RenderProcessGoneDetails): void {
    if (this.quitting || this.rendererReloadTimer !== null) return
    if (details.reason === 'clean-exit') return
    if (!this.options.reloadRenderer) return

    this.event('lifecycle_renderer_reload_scheduled', {
      delayMs: this.rendererReloadDelayMs,
      reason: redactSummary(details.reason, 80)
    })
    this.log(
      `[lifecycle] renderer reload scheduled in ${this.rendererReloadDelayMs}ms reason=${redactSummary(details.reason, 80)}`
    )

    this.rendererReloadTimer = setTimeout(() => {
      this.rendererReloadTimer = null
      if (this.quitting) return
      try {
        this.options.reloadRenderer?.()
        this.event('lifecycle_renderer_reloaded')
        this.log('[lifecycle] renderer reloaded')
      } catch (error) {
        this.event('lifecycle_renderer_reload_failed', {
          detail: this.describe(error)
        })
        this.log(`[lifecycle] renderer reload failed: ${this.describe(error)}`)
      }
    }, this.rendererReloadDelayMs)
    this.rendererReloadTimer.unref?.()
  }

  logRenderProcessGone(details: RenderProcessGoneDetails): void {
    this.event('lifecycle_render_process_gone', {
      reason: redactSummary(details.reason, 80),
      exitCode: details.exitCode
    })
    this.log(
      `[lifecycle] render-process-gone reason=${redactSummary(details.reason, 80)} exitCode=${details.exitCode}`
    )
  }

  logChildProcessGone(details: ChildProcessGoneDetails): void {
    const type = redactSummary(details.type ?? 'unknown', 40)
    const reason = redactSummary(details.reason ?? 'unknown', 80)
    const service = details.serviceName
      ? ` service=${redactSummary(details.serviceName, 40)}`
      : ''
    this.event('lifecycle_child_process_gone', {
      type,
      reason,
      exitCode: details.exitCode ?? -1,
      service: service.trim() || null
    })
    this.log(
      `[lifecycle] child-process-gone type=${type} reason=${reason} exitCode=${details.exitCode ?? -1}${service}`
    )
  }

  handleBeforeQuit(): void {
    if (this.quitting) return
    void this.quit('before-quit')
  }

  async quit(reason: string): Promise<void> {
    if (this.quitting) return
    this.quitting = true
    if (this.rendererReloadTimer !== null) {
      clearTimeout(this.rendererReloadTimer)
      this.rendererReloadTimer = null
    }
    this.event('lifecycle_quit_requested', { reason: redactSummary(reason, 80) })
    this.log(`[lifecycle] quit requested reason=${redactSummary(reason, 80)}`)

    const forceTimer = setTimeout(() => {
      this.event('lifecycle_force_exit')
      this.log('[lifecycle] quit timeout exceeded, forcing exit')
      this.exitOnce(0)
    }, this.forceExitTimeoutMs)
    forceTimer.unref?.()

    await this.runQuitHooks()

    try {
      const result = this.options.checkpointDb()
      this.event('lifecycle_db_checkpoint', { ...result })
      this.log(`[lifecycle] db checkpoint ${JSON.stringify(result)}`)
    } catch (error) {
      this.event('lifecycle_db_checkpoint_failed', { detail: this.describe(error) })
      this.log(`[lifecycle] db checkpoint failed: ${this.describe(error)}`)
    }

    this.runStep('destroy tray', () => this.options.destroyTray())
    this.runStep('unregister hotkeys', () => this.options.unregisterHotkeys())
    this.runStep('close services', () => this.options.closeServices())
    this.runStep('destroy windows', () => this.options.destroyWindows?.())

    clearTimeout(forceTimer)
    this.event('lifecycle_cleanup_complete')
    this.log('[lifecycle] cleanup complete, exit(0)')
    this.exitOnce(0)
  }

  private exitOnce(code: number): void {
    if (this.exited) return
    this.exited = true
    this.options.exit(code)
  }

  private async runQuitHooks(): Promise<void> {
    const hooks = this.quitHooks.splice(0, this.quitHooks.length)
    if (hooks.length === 0) return

    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.hookTimeoutMs)
      timer.unref?.()
    })
    const completed = Promise.allSettled(
      hooks.map((hook) => Promise.resolve().then(() => hook()))
    ).then(() => 'done' as const)

    const result = await Promise.race([completed, timeout])
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (result === 'timeout') {
      this.event('lifecycle_quit_hooks_timeout', { budgetMs: this.hookTimeoutMs })
      this.log(`[lifecycle] quit hooks exceeded ${this.hookTimeoutMs}ms budget`)
    }
  }

  private runStep(name: string, step: () => void): void {
    try {
      step()
      this.event('lifecycle_step', { step: name, ok: true })
      this.log(`[lifecycle] ${name} ok`)
    } catch (error) {
      this.event('lifecycle_step', { step: name, ok: false, detail: this.describe(error) })
      this.log(`[lifecycle] ${name} failed: ${this.describe(error)}`)
    }
  }

  private describe(error: unknown): string {
    return redactSummary(error instanceof Error ? error.message : String(error), 200)
  }

  private event(event: string, fields?: Record<string, unknown>): void {
    getLogger().info(event, fields)
  }

  private log(line: string): void {
    if (this.options.logger) this.options.logger(line)
    else getLogger().line('info', line)
  }
}
