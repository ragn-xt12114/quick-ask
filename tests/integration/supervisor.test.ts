import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SUPERVISOR = resolve('scripts/quickask-supervisor.sh')
const tempDirs: string[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3000).catch(
        () => undefined
      )
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await delay(25)
  }
  throw new Error('condition not met before timeout')
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quickask-supervisor-'))
  tempDirs.push(dir)
  return dir
}

function writeFakeApp(dir: string): string {
  const path = join(dir, 'fake-app.sh')
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -u
state="${'${FAKE_APP_STATE:?}'}"
pidfile="${'${FAKE_APP_PIDFILE:?}'}"
count=0
if [[ -f "$state" ]]; then count="$(cat "$state")"; fi
count=$((count + 1))
printf '%s' "$count" >"$state"
printf '%s\\n' "$$" >>"$pidfile"
if [[ "$count" -eq 1 ]]; then exit 42; fi
exec sleep 30
`,
    'utf8'
  )
  chmodSync(path, 0o755)
  return path
}

function startSupervisor(
  dir: string,
  app: string,
  overrides: Record<string, string> = {}
): ChildProcess {
  const child = spawn('bash', [SUPERVISOR], {
    env: {
      ...process.env,
      QUICKASK_APP_BIN: app,
      QUICKASK_SUPERVISOR_RUNTIME_DIR: join(dir, 'runtime'),
      QUICKASK_SUPERVISOR_LOG: join(dir, 'runtime', 'supervisor.log'),
      QUICKASK_SUPERVISOR_STOP: join(dir, 'runtime', 'stop'),
      QUICKASK_SUPERVISOR_RESTART_DELAY: '0.1',
      FAKE_APP_STATE: join(dir, 'state'),
      FAKE_APP_PIDFILE: join(dir, 'pids'),
      ...overrides
    },
    stdio: 'ignore'
  })
  children.push(child)
  return child
}

function pids(file: string): string[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

describe('quickask supervisor script', () => {
  it('restarts a crashing child after 1s, keeps one child and rejects duplicates', async () => {
    const dir = tempDir()
    const app = writeFakeApp(dir)
    const supervisor = startSupervisor(dir, app)
    const pidFile = join(dir, 'pids')

    await waitFor(() => pids(pidFile).length >= 2, 8000)
    const [first, second] = pids(pidFile)
    expect(first).not.toBe(second)
    expect(() => process.kill(Number(first), 0)).toThrow()
    expect(() => process.kill(Number(second), 0)).not.toThrow()

    const duplicate = startSupervisor(dir, app)
    await waitFor(
      () => duplicate.exitCode !== null || duplicate.signalCode !== null,
      3000
    )
    expect(duplicate.exitCode).toBe(0)
    expect(pids(pidFile)).toHaveLength(2)

    supervisor.kill('SIGTERM')
    await waitFor(
      () => supervisor.exitCode !== null || supervisor.signalCode !== null,
      5000
    )
    expect(supervisor.exitCode).toBe(0)
    await waitFor(() => {
      try {
        process.kill(Number(second), 0)
        return false
      } catch {
        return true
      }
    }, 5000)
    expect(readFileSync(join(dir, 'runtime', 'supervisor.log'), 'utf8')).toContain(
      'restarting'
    )
  }, 20_000)

  it('does not restart when the STOP file exists', async () => {
    const dir = tempDir()
    const app = writeFakeApp(dir)
    const stopFile = join(dir, 'runtime', 'stop')
    const supervisor = startSupervisor(dir, app, {
      QUICKASK_SUPERVISOR_RESTART_DELAY: '1'
    })
    const pidFile = join(dir, 'pids')

    await waitFor(() => pids(pidFile).length === 1, 5000)
    writeFileSync(stopFile, 'stop\n')
    await waitFor(
      () => supervisor.exitCode !== null || supervisor.signalCode !== null,
      5000
    )
    expect(pids(pidFile)).toHaveLength(1)
    expect(readFileSync(join(dir, 'runtime', 'supervisor.log'), 'utf8')).toContain(
      'stop file present'
    )
  }, 15_000)
})
