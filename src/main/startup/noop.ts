/**
 * Startup backend for platforms without a login mechanism. It reports the
 * unsupported state honestly and never writes anything.
 */

import type { StartupState } from '../../shared/channels'
import type { StartupService } from './types'

export const STARTUP_UNSUPPORTED_REASON = '当前平台不支持登录自启动'

export class NoopStartupService implements StartupService {
  getState(error: string | null = null): StartupState {
    return {
      autostart: false,
      watchdog: false,
      desktopPath: 'N/A',
      desktopExists: false,
      error: error ?? STARTUP_UNSUPPORTED_REASON
    }
  }

  setState(_patch: { autostart?: boolean; watchdog?: boolean } = {}): StartupState {
    return this.getState(STARTUP_UNSUPPORTED_REASON)
  }

  reconcile(): StartupState {
    return this.getState(STARTUP_UNSUPPORTED_REASON)
  }
}
