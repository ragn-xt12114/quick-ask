import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import type { WindowManager } from '../../src/main/window/manager'
import type { WindowState } from '../../src/shared/channels'

interface FakeTray {
  listeners: Map<string, () => void>
  tooltip: string | null
  menu: MenuItemConstructorOptions[] | null
  destroyed: boolean
}

const { trayInstances } = vi.hoisted(() => ({
  trayInstances: [] as FakeTray[]
}))

vi.mock('electron', () => {
  class MockTray implements FakeTray {
    readonly listeners = new Map<string, () => void>()
    tooltip: string | null = null
    menu: MenuItemConstructorOptions[] | null = null
    destroyed = false

    constructor(readonly icon: unknown) {
      trayInstances.push(this)
    }

    on(event: string, listener: () => void): void {
      this.listeners.set(event, listener)
    }

    setToolTip(value: string): void {
      this.tooltip = value
    }

    setContextMenu(menu: MenuItemConstructorOptions[]): void {
      this.menu = menu
    }

    destroy(): void {
      this.destroyed = true
    }
  }

  return {
    app: {
      isPackaged: false,
      getAppPath: () => process.cwd()
    },
    Menu: {
      buildFromTemplate: (template: MenuItemConstructorOptions[]) => template
    },
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 32, height: 32 })
      })
    },
    Tray: MockTray
  }
})

import { TrayController } from '../../src/main/tray/controller'

interface FakeManager {
  visible: boolean
  mode: string
  listeners: ((state: WindowState) => void)[]
  getState(): WindowState
  onStateChange(listener: (state: WindowState) => void): () => void
  setMode: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  openSettings: ReturnType<typeof vi.fn>
}

function fakeManager(): FakeManager {
  const manager: FakeManager = {
    visible: false,
    mode: 'S0',
    listeners: [],
    getState() {
      return {
        mode: (manager.mode as WindowState['mode']) ?? 'S0',
        visible: manager.visible
      } as WindowState
    },
    onStateChange(listener) {
      manager.listeners.push(listener)
      return () => undefined
    },
    setMode: vi.fn(async (mode: string) => {
      manager.mode = mode
      manager.visible = true
      for (const listener of manager.listeners) listener(manager.getState())
      return { mode }
    }),
    hide: vi.fn(() => {
      manager.mode = 'S0'
      manager.visible = false
      for (const listener of manager.listeners) listener(manager.getState())
      return manager.getState()
    }),
    openSettings: vi.fn(async () => ({ open: true }))
  }
  return manager
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('TrayController', () => {
  beforeEach(() => {
    trayInstances.length = 0
  })

  it('creates a 32x32 tray with the QuickAsk tooltip and a five-item menu', () => {
    const manager = fakeManager()
    const controller = new TrayController({
      manager: manager as unknown as WindowManager,
      emitNewSession: () => undefined,
      quit: () => undefined,
      logger: () => undefined
    })

    controller.create()

    const tray = trayInstances[0]!
    expect(tray.tooltip).toBe('QuickAsk')
    expect(tray.menu).toHaveLength(5)
    expect(tray.menu?.map((item) => item.label)).toEqual([
      '显示',
      '新建会话',
      '历史',
      '设置',
      '退出'
    ])
    expect(tray.listeners.has('click')).toBe(true)
    expect(tray.listeners.has('double-click')).toBe(false)
  })

  it('left click toggles S1 and rebuilds the menu label from manager state', async () => {
    const manager = fakeManager()
    const controller = new TrayController({
      manager: manager as unknown as WindowManager,
      emitNewSession: () => undefined,
      quit: () => undefined,
      logger: () => undefined
    })
    controller.create()
    const tray = trayInstances[0]!

    tray.listeners.get('click')!()
    await flush()

    expect(manager.setMode).toHaveBeenCalledWith('S1')
    expect(tray.menu?.[0]?.label).toBe('隐藏')

    tray.listeners.get('click')!()
    await flush()

    expect(manager.hide).toHaveBeenCalledTimes(1)
    expect(tray.menu?.[0]?.label).toBe('显示')
  })

  it('menu 退出 invokes the real quit callback', async () => {
    const manager = fakeManager()
    const quit = vi.fn()
    const controller = new TrayController({
      manager: manager as unknown as WindowManager,
      emitNewSession: () => undefined,
      quit,
      logger: () => undefined
    })
    controller.create()
    const tray = trayInstances[0]!

    const quitItem = tray.menu!.find((item) => item.id === 'quit')!
    ;(quitItem.click as unknown as () => void)()
    await flush()

    expect(quit).toHaveBeenCalledTimes(1)
    expect(manager.hide).not.toHaveBeenCalled()
  })

  it('menu 新建会话 shows S1 before emitting the new-session event', async () => {
    const manager = fakeManager()
    const calls: string[] = []
    const controller = new TrayController({
      manager: manager as unknown as WindowManager,
      emitNewSession: () => calls.push('emit'),
      quit: () => undefined,
      logger: () => undefined
    })
    manager.setMode.mockImplementation(async (mode: string) => {
      calls.push(`show:${mode}`)
      manager.visible = true
      manager.mode = mode
      return { mode }
    })
    controller.create()
    const tray = trayInstances[0]!

    const newItem = tray.menu!.find((item) => item.id === 'new-session')!
    ;(newItem.click as unknown as () => void)()
    await flush()

    expect(calls).toEqual(['show:S1', 'emit'])
  })

  it('destroy() destroys the tray and unsubscribes state updates', () => {
    const manager = fakeManager()
    const controller = new TrayController({
      manager: manager as unknown as WindowManager,
      emitNewSession: () => undefined,
      quit: () => undefined,
      logger: () => undefined
    })
    controller.create()
    const tray = trayInstances[0]!

    controller.destroy()

    expect(tray.destroyed).toBe(true)
    expect(manager.listeners).toHaveLength(1)
  })
})
