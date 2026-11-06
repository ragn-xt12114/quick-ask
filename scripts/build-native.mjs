import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const platform = process.platform
if (platform !== 'linux') {
  console.log(`[build:native] skipped on ${platform}: the X11 helper is Linux-only`)
  process.exit(0)
}
const script = resolve('native/build.sh')
const result = spawnSync('bash', [script], { stdio: 'inherit' })
if (result.error) {
  console.error(`[build:native] failed to start bash: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
