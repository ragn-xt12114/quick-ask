import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { DEVELOPMENT_CSP, PRODUCTION_CSP } from './src/shared/csp'

/**
 * Inject the CSP meta tag into `src/renderer/index.html` at build time.
 * Dev (Vite serve) gets HMR-only relaxations; the built artifact always gets
 * the production policy.
 */
function cspPlugin(): Plugin {
  let isDev = false

  return {
    name: 'quickask-csp',
    configResolved(config) {
      isDev = config.command === 'serve'
    },
    transformIndexHtml(html) {
      const csp = isDev ? DEVELOPMENT_CSP : PRODUCTION_CSP
      const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`
      return html.replace('<head>', `<head>\n    ${meta}`)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'keyring-worker': resolve('src/main/secrets/keyring-worker.ts')
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), cspPlugin()]
  }
})
