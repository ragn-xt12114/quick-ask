import type { QuickAskApi } from '../../shared/api'

declare global {
  interface Window {
    quickask: QuickAskApi
  }
}

export {}
