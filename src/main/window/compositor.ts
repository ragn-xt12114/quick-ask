/**
 * Live compositor/blur monitor (plan B.5, Task 23).
 *
 * Every probe is asynchronous (`execFile` with a timeout) so a slow KWin/DBus
 * never blocks the Electron main thread. The monitor only reads state; it
 * never writes KWin settings and never pretends CSS can blur the desktop.
 */

import { execFile, execFileSync } from 'node:child_process'
import {
  appearanceRuntimeChanged,
  compositorSnapshotFromSignals,
  type CompositorSnapshot
} from '../../shared/appearance-runtime'
import {
  normalizeAnimationDurationFactor,
  parseAnimationDurationFactor
} from '../../shared/motion'
import { parseConfigBoolean } from '../settings/blur'
import { queryCompositing } from './x11'

const DEFAULT_INTERVAL_MS = 1750
const COMMAND_TIMEOUT_MS = 1500

function runCommand(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: COMMAND_TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: { ...process.env, DISPLAY: process.env['DISPLAY'] ?? ':0' }
      },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        resolve(stdout ?? '')
      }
    )
  })
}

async function detectCompositor(): Promise<boolean | null> {
  const helper = await queryCompositing()
  if (helper.ok) return helper.compositing

  const dbus = await runCommand('qdbus6', [
    'org.kde.KWin',
    '/Compositor',
    'org.kde.kwin.Compositing.active'
  ])
  return parseConfigBoolean(dbus)
}

async function detectBlurEffect(): Promise<boolean | null> {
  const dbus = await runCommand('qdbus6', [
    'org.kde.KWin',
    '/Effects',
    'org.kde.kwin.Effects.isEffectLoaded',
    'blur'
  ])
  const loaded = parseConfigBoolean(dbus)
  if (loaded !== null) return loaded

  const config = await runCommand('kreadconfig6', [
    '--file',
    'kwinrc',
    '--group',
    'Plugins',
    '--key',
    'blurEnabled'
  ])
  return parseConfigBoolean(config)
}

function animationDurationFactorOverride(): number | null {
  const raw = process.env['QUICKASK_ANIMATION_DURATION_FACTOR']
  if (raw === undefined) return null
  const parsed = parseAnimationDurationFactor(raw)
  return parsed === null ? null : normalizeAnimationDurationFactor(parsed)
}

async function detectAnimationDurationFactor(): Promise<number> {
  const override = animationDurationFactorOverride()
  if (override !== null) return override
  const output = await runCommand('kreadconfig6', [
    '--file',
    'kdeglobals',
    '--group',
    'KDE',
    '--key',
    'AnimationDurationFactor'
  ])
  return normalizeAnimationDurationFactor(output)
}

export function readAnimationDurationFactorSync(): number {
  const override = animationDurationFactorOverride()
  if (override !== null) return override
  try {
    const output = execFileSync(
      'kreadconfig6',
      ['--file', 'kdeglobals', '--group', 'KDE', '--key', 'AnimationDurationFactor'],
      { encoding: 'utf8', timeout: 1500 }
    )
    return normalizeAnimationDurationFactor(output)
  } catch {
    return normalizeAnimationDurationFactor(null)
  }
}

export async function queryCompositorSnapshot(): Promise<CompositorSnapshot> {
  const [compositor, blurEffect, animationDurationFactor] = await Promise.all([
    detectCompositor(),
    detectBlurEffect(),
    detectAnimationDurationFactor()
  ])
  return compositorSnapshotFromSignals({
    compositor,
    blurEffect,
    animationDurationFactor
  })
}

export interface CompositorMonitorOptions {
  onState: (state: CompositorSnapshot) => void
  intervalMs?: number
  query?: () => Promise<CompositorSnapshot>
}

export class CompositorMonitor {
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  private inFlight = false
  private lastState: CompositorSnapshot | null = null

  constructor(private readonly options: CompositorMonitorOptions) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.poll()
    const interval = Math.max(250, this.options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.timer = setInterval(() => {
      void this.poll()
    }, interval)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  getState(): CompositorSnapshot | null {
    return this.lastState
  }

  async poll(): Promise<CompositorSnapshot | null> {
    if (this.stopped || this.inFlight) return this.lastState
    this.inFlight = true
    try {
      const state = await (this.options.query ?? queryCompositorSnapshot)()
      if (this.stopped) return this.lastState
      if (appearanceRuntimeChanged(this.lastState, state)) {
        this.lastState = state
        try {
          this.options.onState(state)
        } catch {
          // A listener failure must not kill the polling loop.
        }
      }
      return state
    } finally {
      this.inFlight = false
    }
  }
}
