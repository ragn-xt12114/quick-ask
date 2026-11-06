import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import net, { type AddressInfo } from 'node:net'
import {
  createProviderClient,
  ProviderClientError,
  resolveProxyForUrl,
  shouldBypassProxy,
  type ProviderStreamProfile,
  type StreamChatResult
} from '../../src/main/provider/client'

const root = process.cwd()
const evidenceDir = join(root, '.omo', 'evidence')
const mockServer = join(root, 'tools', 'mock-sse-server.mjs')
const connectProxy = join(root, 'tools', 'connect-proxy.mjs')
const socksProxy = join(root, 'tools', 'socks5-proxy.mjs')

mkdirSync(evidenceDir, { recursive: true })

const children: ChildProcessWithoutNullStreams[] = []
const servers: Server[] = []

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function logPath(name: string): string {
  return join(evidenceDir, name)
}

function resetLog(name: string): string {
  const path = logPath(name)
  rmSync(path, { force: true })
  return path
}

function readLog(name: string): string {
  try {
    return readFileSync(logPath(name), 'utf8')
  } catch {
    return ''
  }
}

function countPosts(text: string): number {
  return (text.match(/^POST \/v1\/chat\/completions/gm) ?? []).length
}

interface StartedProcess {
  child: ChildProcessWithoutNullStreams
  port: number
  stdout: () => string
  stop: () => Promise<void>
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  child.kill('SIGTERM')
  await Promise.race([closed, sleep(1500)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([closed, sleep(1000)])
  }
}

async function startProcess(
  command: string,
  args: string[],
  readyPattern: RegExp,
  label: string
): Promise<StartedProcess> {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe']
  }) as unknown as ChildProcessWithoutNullStreams
  children.push(child)

  let stdout = ''
  let stderr = ''

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not start; stdout=${stdout} stderr=${stderr}`))
    }, 10_000)

    const onData = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8')
      const match = readyPattern.exec(stdout)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (!readyPattern.test(stdout)) {
        clearTimeout(timer)
        reject(new Error(`${label} exited early (${code}); stderr=${stderr}`))
      }
    })
  })

  return {
    child,
    port,
    stdout: () => stdout,
    stop: () => stopChild(child)
  }
}

interface MockOptions {
  mode: string
  host?: string
  chunks?: number
  delay?: number
  log: string
}

async function startMock(options: MockOptions): Promise<StartedProcess & { baseUrl: string }> {
  const host = options.host ?? '127.0.0.1'
  const log = resetLog(options.log)
  const args = [
    mockServer,
    '--host',
    host,
    '--port',
    '0',
    '--mode',
    options.mode,
    '--log',
    log
  ]
  if (options.chunks !== undefined) args.push('--chunks', String(options.chunks))
  if (options.delay !== undefined) args.push('--delay', String(options.delay))

  const started = await startProcess(
    process.execPath,
    args,
    /mock-sse-server listening on http:\/\/[^:\s]+:(\d+)/,
    `mock-sse-server(${options.mode})`
  )
  return { ...started, baseUrl: `http://${host}:${started.port}` }
}

async function startProxy(logName: string): Promise<StartedProcess & { url: string }> {
  const log = resetLog(logName)
  const started = await startProcess(
    process.execPath,
    [connectProxy, '--port', '0', '--log', log],
    /connect-proxy listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'connect-proxy'
  )
  return { ...started, url: `http://127.0.0.1:${started.port}` }
}

async function startSocksProxy(
  logName: string,
  auth?: string
): Promise<StartedProcess & { url: string; log: string }> {
  const log = resetLog(logName)
  const args = [socksProxy, '--port', '0', '--log', log]
  if (auth) args.push('--auth', auth)
  const started = await startProcess(
    process.execPath,
    args,
    /socks5-proxy listening on socks5:\/\/127\.0\.0\.1:(\d+)/,
    'socks5-proxy'
  )
  return { ...started, url: `socks5://127.0.0.1:${started.port}`, log }
}

function profile(baseUrl: string, apiKey?: string): ProviderStreamProfile {
  return { baseUrl, model: 'mock-model', apiKey: apiKey ?? null }
}

async function runStream(
  baseUrl: string,
  options: {
    requestId: string
    apiKey?: string
    env?: Record<string, string | undefined>
    timeouts?: { headersMs?: number; idleMs?: number; totalMs?: number; connectMs?: number }
    onDelta?: (content: string) => void
    profile?: Partial<ProviderStreamProfile>
  }
): Promise<{ result: StreamChatResult; deltas: string[] }> {
  const deltas: string[] = []
  const client = createProviderClient({
    env: options.env ?? {},
    version: '0.0.0-test',
    timeouts: {
      connectMs: options.timeouts?.connectMs ?? 2000,
      headersMs: options.timeouts?.headersMs ?? 5000,
      idleMs: options.timeouts?.idleMs ?? 5000,
      totalMs: options.timeouts?.totalMs ?? 15_000
    }
  })
  const result = await client.streamChat({
    profile: { ...profile(baseUrl, options.apiKey), ...options.profile },
    messages: [{ role: 'user', content: 'hello' }],
    requestId: options.requestId,
    onDelta: (content) => {
      deltas.push(content)
      options.onDelta?.(content)
    }
  })
  return { result, deltas }
}

async function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ server: Server; port: number; url: string }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { server, port, url: `http://127.0.0.1:${port}` }
}

async function startAuthConnectProxy(
  logName: string,
  expectedAuthorization: string
): Promise<{
  url: string
  log: string
  observed: string[]
  stop: () => Promise<void>
}> {
  const log = resetLog(logName)
  const observed: string[] = []
  const server = createServer((_req, res) => {
    res.writeHead(405)
    res.end()
  })
  server.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
    const header = req.headers['proxy-authorization']
    const state = header === expectedAuthorization ? 'ok' : 'missing'
    observed.push(state)
    appendFileSync(log, `CONNECT ${req.url ?? ''} auth=${state}\n`)
    if (state !== 'ok') {
      clientSocket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n'
      )
      return
    }
    const target = req.url ?? ''
    const sep = target.lastIndexOf(':')
    const host = target.slice(0, sep)
    const port = Number(target.slice(sep + 1))
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    log,
    observed,
    stop: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

const evidence: {
  fixtures: Array<Record<string, unknown>>
  abort: Record<string, unknown> | null
  rateLimit: Record<string, unknown> | null
  redirect: Record<string, unknown> | null
  proxy: Record<string, unknown> | null
  proxy33a: Array<Record<string, unknown>>
  timeouts: Array<Record<string, unknown>>
} = {
  fixtures: [],
  abort: null,
  rateLimit: null,
  redirect: null,
  proxy: null,
  proxy33a: [],
  timeouts: []
}

afterAll(async () => {
  for (const child of children) await stopChild(child)
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  writeFileSync(
    logPath('task-15-summary.json'),
    `${JSON.stringify(
      {
        task: 15,
        generatedAt: new Date().toISOString(),
        ...evidence
      },
      null,
      2
    )}\n`
  )

  const proxyDir = join(root, '.omo', 'evidence', 'm2', 'proxy')
  mkdirSync(proxyDir, { recursive: true })
  for (const file of readdirSync(evidenceDir)) {
    if (file.startsWith('task-33a-') && !file.endsWith('.json')) {
      copyFileSync(join(evidenceDir, file), join(proxyDir, file))
    }
  }
  writeFileSync(
    join(proxyDir, 'task-33a-proxy-matrix.json'),
    `${JSON.stringify(
      {
        task: '33a',
        generatedAt: new Date().toISOString(),
        cases: evidence.proxy33a
      },
      null,
      2
    )}\n`
  )
})

describe('ProviderClient SSE fixtures against the real mock server', () => {
  it(
    'parses normal/utf8-split/multiline/no-done/malformed/json-200/error/usage/reasoning/comment',
    async () => {
      const modes: Array<{
        mode: string
        chunks?: number
        delay?: number
        check: (result: StreamChatResult, deltas: string[]) => void
      }> = [
        {
          mode: 'normal',
          chunks: 3,
          delay: 5,
          check: (result, deltas) => {
            expect(result.status).toBe('complete')
            expect(result.content).toBe('chunk 1chunk 2chunk 3')
            expect(deltas).toEqual(['chunk 1', 'chunk 2', 'chunk 3'])
            expect(result.sawDone).toBe(true)
          }
        },
        {
          mode: 'utf8-split',
          delay: 5,
          check: (result) => {
            expect(result.status).toBe('complete')
            expect(result.content).toBe('你好，世界')
            expect(result.content).not.toContain('\uFFFD')
            expect(result.sawDone).toBe(true)
          }
        },
        {
          mode: 'multiline',
          delay: 5,
          check: (result) => {
            expect(result.status).toBe('complete')
            expect(result.content).toBe('multiline')
            expect(result.sawDone).toBe(true)
          }
        },
        {
          mode: 'no-done',
          chunks: 3,
          delay: 5,
          check: (result) => {
            expect(result.status).toBe('complete')
            expect(result.content).toBe('chunk 1chunk 2chunk 3')
            expect(result.sawDone).toBe(false)
          }
        },
        {
          mode: 'malformed',
          delay: 5,
          check: (result) => {
            expect(result.status).toBe('error')
            expect(result.error?.code).toBe('protocol')
            expect(result.error?.detail.length ?? 0).toBeLessThanOrEqual(300)
          }
        },
        {
          mode: 'json-200',
          check: (result) => {
            expect(result.status).toBe('error')
            expect(result.error?.code).toBe('protocol')
            expect(result.error?.detail).toContain('mock upstream returned JSON')
            expect(result.error?.detail.length ?? 0).toBeLessThanOrEqual(300)
          }
        },
        {
          mode: 'error',
          chunks: 1,
          delay: 5,
          check: (result) => {
            expect(result.status).toBe('error')
            expect(result.error?.code).toBe('protocol')
            expect(result.content).toBe('chunk 1')
          }
        },
        {
          mode: 'usage',
          delay: 5,
          check: (result) => {
            expect(result.status).toBe('complete')
            expect(result.content).toBe('hello')
            expect(result.finishReason).toBe('stop')
            expect(result.usage?.total_tokens).toBe(6)
            expect(result.sawDone).toBe(true)
          }
        },
        {
          mode: 'reasoning',
          delay: 5,
          check: (result) => {
            expect(result.status).toBe('complete')
            expect(result.content).toBe('answer')
            expect(result.reasoningChunks).toBe(3)
            expect(result.sawDone).toBe(true)
          }
        },
        {
          mode: 'comment',
          delay: 5,
          check: (result) => {
            expect(result.status).toBe('complete')
            expect(result.content).toBe('comment safe')
            expect(result.comments).toBeGreaterThan(0)
            expect(result.sawDone).toBe(true)
          }
        }
      ]

      for (const entry of modes) {
        const mock = await startMock({
          mode: entry.mode,
          chunks: entry.chunks,
          delay: entry.delay,
          log: `task-15-fixture-${entry.mode}.log`
        })
        try {
          const { result, deltas } = await runStream(mock.baseUrl, {
            requestId: `fixture-${entry.mode}`
          })
          entry.check(result, deltas)

          const log = readLog(`task-15-fixture-${entry.mode}.log`)
          expect(countPosts(log)).toBe(1)

          evidence.fixtures.push({
            mode: entry.mode,
            status: result.status,
            code: result.error?.code ?? null,
            detail: result.error?.detail ?? null,
            content: result.content,
            deltas,
            sawDone: result.sawDone,
            finishReason: result.finishReason,
            usage: result.usage,
            reasoningChunks: result.reasoningChunks,
            comments: result.comments,
            httpStatus: result.httpStatus,
            elapsedMs: result.elapsedMs,
            requests: countPosts(log)
          })
        } finally {
          await mock.stop()
        }
      }

      writeFileSync(
        logPath('task-15-fixtures.json'),
        `${JSON.stringify(evidence.fixtures, null, 2)}\n`
      )
    },
    120_000
  )
})

describe('ProviderClient cancellation, 429, redirect and proxy', () => {
  it(
    'aborts after 5 chunks, closes the server socket ≤500ms and sends one request',
    async () => {
      const mock = await startMock({
        mode: 'slow',
        chunks: 100,
        delay: 100,
        log: 'task-15-abort.log'
      })
      try {
        const client = createProviderClient({
          env: {},
          version: '0.0.0-test',
          timeouts: { connectMs: 2000, headersMs: 5000, idleMs: 5000, totalMs: 20_000 }
        })
        const deltas: string[] = []
        let abortAt = 0
        const requestId = 'abort-request'

        const result = await client.streamChat({
          profile: profile(mock.baseUrl, 'sk-abort-secret'),
          messages: [{ role: 'user', content: 'slow' }],
          requestId,
          onDelta: (content) => {
            deltas.push(content)
            if (deltas.length === 5) {
              abortAt = Date.now()
              expect(client.abort(requestId)).toBe(true)
            }
          }
        })

        await sleep(300)
        const log = readLog('task-15-abort.log')
        const closeMatch = /client closed after (\d+) chunks at \+(\d+)ms/.exec(log)
        expect(closeMatch).not.toBeNull()
        const closeChunks = Number(closeMatch?.[1])
        const closeMs = Number(closeMatch?.[2])

        expect(result.status).toBe('aborted')
        expect(result.error?.code).toBe('aborted')
        expect(deltas).toHaveLength(5)
        expect(result.content).toBe(deltas.join(''))
        expect(closeChunks).toBe(5)
        expect(closeMs).toBeLessThanOrEqual(500)
        expect(countPosts(log)).toBe(1)
        expect(client.getActive()).toEqual([])
        expect(abortAt).toBeGreaterThan(0)

        evidence.abort = {
          status: result.status,
          code: result.error?.code ?? null,
          deltas: deltas.length,
          closeChunks,
          closeMs,
          requests: countPosts(log),
          activeAfter: client.getActive().length
        }
        writeFileSync(
          logPath('task-15-abort.json'),
          `${JSON.stringify(evidence.abort, null, 2)}\n`
        )
      } finally {
        await mock.stop()
      }
    },
    30_000
  )

  it(
    'maps 429 to rate_limit and never retries',
    async () => {
      const mock = await startMock({ mode: '429', log: 'task-15-429.log' })
      try {
        const { result } = await runStream(mock.baseUrl, {
          requestId: 'rate-limit-request',
          apiKey: 'sk-rate-limit-secret'
        })
        expect(result.status).toBe('error')
        expect(result.error?.code).toBe('rate_limit')
        expect(result.error?.detail.length ?? 0).toBeLessThanOrEqual(300)

        await sleep(2100)
        const log = readLog('task-15-429.log')
        expect(countPosts(log)).toBe(1)

        evidence.rateLimit = {
          code: result.error?.code ?? null,
          status: result.error?.status ?? null,
          requestsAfter2s: countPosts(log),
          detail: result.error?.detail ?? null
        }
        writeFileSync(
          logPath('task-15-429.json'),
          `${JSON.stringify(evidence.rateLimit, null, 2)}\n`
        )
      } finally {
        await mock.stop()
      }
    },
    30_000
  )

  it(
    'blocks a cross-origin 302 and never sends Authorization to the second origin',
    async () => {
      let firstRequests = 0
      let firstAuthPresent = false
      let secondRequests = 0
      let secondAuthHeaders = 0

      const second = await startHttpServer((req, res) => {
        secondRequests += 1
        if (req.headers.authorization) secondAuthHeaders += 1
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('should-not-be-reached')
      })

      const first = await startHttpServer((req, res) => {
        firstRequests += 1
        if (req.headers.authorization) firstAuthPresent = true
        res.writeHead(302, { Location: `${second.url}/steal` })
        res.end()
      })

      const { result } = await runStream(first.url, {
        requestId: 'redirect-request',
        apiKey: 'sk-redirect-secret'
      })
      await sleep(150)

      expect(result.status).toBe('error')
      expect(result.error?.code).toBe('redirect')
      expect(firstRequests).toBe(1)
      expect(firstAuthPresent).toBe(true)
      expect(secondRequests).toBe(0)
      expect(secondAuthHeaders).toBe(0)

      writeFileSync(
        logPath('task-15-redirect-first.log'),
        `first origin requests=${firstRequests} returned=302 auth_header_present=${firstAuthPresent}\n`
      )
      writeFileSync(
        logPath('task-15-redirect-second.log'),
        `second origin requests=${secondRequests} auth_headers=${secondAuthHeaders}\n`
      )

      evidence.redirect = {
        code: result.error?.code ?? null,
        firstRequests,
        firstAuthPresent,
        secondRequests,
        secondAuthHeaders
      }
      writeFileSync(
        logPath('task-15-redirect.json'),
        `${JSON.stringify(evidence.redirect, null, 2)}\n`
      )
    },
    20_000
  )

  it(
    'routes through a real local CONNECT proxy, honours NO_PROXY and bypasses loopback',
    async () => {
      const mock = await startMock({
        mode: 'normal',
        host: '127.0.0.2',
        chunks: 2,
        delay: 5,
        log: 'task-15-proxy-mock.log'
      })
      const proxy = await startProxy('task-15-proxy.log')
      const proxyBypass = await startProxy('task-15-proxy-bypass.log')

      try {
        const throughProxy = await runStream(mock.baseUrl, {
          requestId: 'proxy-request',
          env: {
            HTTP_PROXY: proxy.url,
            HTTPS_PROXY: proxy.url,
            ALL_PROXY: proxy.url,
            NO_PROXY: ''
          }
        })
        expect(throughProxy.result.status).toBe('complete')
        expect(throughProxy.result.content).toBe('chunk 1chunk 2')

        await sleep(200)
        const proxyLog = readLog('task-15-proxy.log')
        expect(proxyLog).toContain(`CONNECT 127.0.0.2:${mock.port}`)
        expect(proxyLog).toContain('tunnel open')
        expect(countPosts(readLog('task-15-proxy-mock.log'))).toBe(1)

        const bypassed = await runStream(mock.baseUrl, {
          requestId: 'proxy-bypass-request',
          env: {
            HTTP_PROXY: proxyBypass.url,
            NO_PROXY: '127.0.0.2'
          }
        })
        expect(bypassed.result.status).toBe('complete')
        await sleep(150)
        expect(readLog('task-15-proxy-bypass.log')).not.toContain('CONNECT')
        expect(countPosts(readLog('task-15-proxy-mock.log'))).toBe(2)

        const localMock = await startMock({
          mode: 'normal',
          chunks: 1,
          delay: 5,
          log: 'task-15-proxy-localhost-mock.log'
        })
        try {
          const direct = await runStream(localMock.baseUrl, {
            requestId: 'proxy-loopback-request',
            env: { HTTP_PROXY: proxyBypass.url, NO_PROXY: '' }
          })
          expect(direct.result.status).toBe('complete')
          await sleep(150)
          expect(readLog('task-15-proxy-bypass.log')).not.toContain('CONNECT')
          expect(countPosts(readLog('task-15-proxy-localhost-mock.log'))).toBe(1)
        } finally {
          await localMock.stop()
        }

        expect(shouldBypassProxy(new URL('http://127.0.0.1:1'), {})).toBe(true)
        expect(shouldBypassProxy(new URL('http://localhost:1'), {})).toBe(true)
        expect(
          shouldBypassProxy(new URL('http://127.0.0.2:1'), {
            NO_PROXY: '127.0.0.2'
          })
        ).toBe(true)

        const bypassLog = readLog('task-15-proxy-bypass.log')
        const bypassConnectLines = (bypassLog.match(/^CONNECT/gm) ?? []).length
        writeFileSync(
          logPath('task-15-proxy-bypass.log'),
          `proxy connect_lines=${bypassConnectLines} no_proxy_bypass=127.0.0.2 loopback_bypass=1\n`
        )

        evidence.proxy = {
          proxyUrl: proxy.url,
          connectObserved: proxyLog.includes(`CONNECT 127.0.0.2:${mock.port}`),
          tunnelObserved: proxyLog.includes('tunnel open'),
          proxyRequests: countPosts(readLog('task-15-proxy-mock.log')),
          noProxyBypassConnectLines: bypassConnectLines,
          loopbackBypassed: true
        }
        writeFileSync(
          logPath('task-15-proxy.json'),
          `${JSON.stringify(evidence.proxy, null, 2)}\n`
        )
      } finally {
        await proxy.stop()
        await proxyBypass.stop()
        await mock.stop()
      }
    },
    40_000
  )

  it('rejects SOCKS5 explicitly with a typed proxy error', async () => {
    try {
      resolveProxyForUrl(new URL('http://example.test'), {
        ALL_PROXY: 'socks5://127.0.0.1:1080'
      })
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderClientError)
      expect((error as ProviderClientError).code).toBe('proxy')
      expect((error as ProviderClientError).detail).toMatch(/SOCKS/)
    }
  })

  it(
    'applies direct/system/custom modes, SOCKS5 and proxy auth against real local proxies',
    async () => {
      const mock = await startMock({
        mode: 'normal',
        host: '127.0.0.2',
        chunks: 2,
        delay: 5,
        log: 'task-33a-mock.log'
      })
      const httpProxy = await startProxy('task-33a-http-proxy.log')
      const directProxy = await startProxy('task-33a-direct-proxy.log')
      const socks = await startSocksProxy('task-33a-socks.log')
      const authProxy = await startAuthConnectProxy(
        'task-33a-auth-proxy.log',
        `Basic ${Buffer.from('alice:s3cr3t-pass').toString('base64')}`
      )

      try {
        const direct = await runStream(mock.baseUrl, {
          requestId: 'task33a-direct',
          env: { HTTP_PROXY: directProxy.url, HTTPS_PROXY: directProxy.url },
          profile: { proxyMode: 'direct' }
        })
        expect(direct.result.status).toBe('complete')
        await sleep(100)
        expect(readLog('task-33a-direct-proxy.log')).not.toContain('CONNECT')
        evidence.proxy33a.push({
          mode: 'direct',
          status: direct.result.status,
          proxyConnectLines: 0
        })

        const system = await runStream(mock.baseUrl, {
          requestId: 'task33a-system',
          env: { http_proxy: httpProxy.url, no_proxy: '' },
          profile: { proxyMode: 'system' }
        })
        expect(system.result.status).toBe('complete')
        await sleep(100)
        expect(readLog('task-33a-http-proxy.log')).toContain(
          `CONNECT 127.0.0.2:${mock.port}`
        )
        evidence.proxy33a.push({
          mode: 'system',
          status: system.result.status,
          connectObserved: readLog('task-33a-http-proxy.log').includes('CONNECT')
        })

        const customHttp = await runStream(mock.baseUrl, {
          requestId: 'task33a-custom-http',
          env: { HTTP_PROXY: directProxy.url },
          profile: { proxyMode: 'custom', proxyUrl: httpProxy.url }
        })
        expect(customHttp.result.status).toBe('complete')
        await sleep(100)
        const httpConnectLines = (
          readLog('task-33a-http-proxy.log').match(/^CONNECT/gm) ?? []
        ).length
        expect(httpConnectLines).toBeGreaterThanOrEqual(2)
        evidence.proxy33a.push({
          mode: 'custom-http',
          status: customHttp.result.status,
          connectLines: httpConnectLines
        })

        const customSocks = await runStream(mock.baseUrl, {
          requestId: 'task33a-custom-socks',
          env: {},
          profile: { proxyMode: 'custom', proxyUrl: socks.url }
        })
        expect(customSocks.result.status).toBe('complete')
        await sleep(100)
        expect(readLog('task-33a-socks.log')).toContain(
          `SOCKS5 CONNECT 127.0.0.2:${mock.port}`
        )

        const socks5h = await runStream(mock.baseUrl, {
          requestId: 'task33a-custom-socks5h',
          env: {},
          profile: {
            proxyMode: 'custom',
            proxyUrl: socks.url.replace('socks5://', 'socks5h://')
          }
        })
        expect(socks5h.result.status).toBe('complete')
        evidence.proxy33a.push({
          mode: 'custom-socks5',
          status: customSocks.result.status,
          socksConnectObserved: true,
          socks5hStatus: socks5h.result.status
        })

        const logged: Array<Record<string, unknown>> = []
        const authClient = createProviderClient({
          env: {},
          version: '0.0.0-test',
          logger: {
            info: (event, fields) => logged.push({ event, ...fields }),
            warn: (event, fields) => logged.push({ event, ...fields })
          }
        })
        const authUrl = authProxy.url.replace(
          'http://',
          'http://alice:s3cr3t-pass@'
        )
        const authResult = await authClient.streamChat({
          profile: {
            baseUrl: mock.baseUrl,
            model: 'mock-model',
            proxyMode: 'custom',
            proxyUrl: authUrl
          },
          messages: [{ role: 'user', content: 'hello' }],
          requestId: 'task33a-auth'
        })
        expect(authResult.status).toBe('complete')
        await sleep(100)
        expect(authProxy.observed).toEqual(['ok'])
        expect(JSON.stringify(logged)).not.toContain('s3cr3t-pass')
        expect(JSON.stringify(logged)).not.toContain('alice')
        evidence.proxy33a.push({
          mode: 'custom-auth',
          status: authResult.status,
          proxyAuthObserved: authProxy.observed[0],
          passwordInLogs: JSON.stringify(logged).includes('s3cr3t-pass')
        })

        const invalidCases = [
          { label: 'empty', proxyUrl: '' },
          { label: 'unknown-scheme', proxyUrl: 'ftp://127.0.0.1:1' },
          { label: 'malformed', proxyUrl: 'not a url' }
        ]
        const invalidResults: Array<Record<string, unknown>> = []
        for (const entry of invalidCases) {
          const { result } = await runStream(mock.baseUrl, {
            requestId: `task33a-invalid-${entry.label}`,
            env: {},
            profile: { proxyMode: 'custom', proxyUrl: entry.proxyUrl }
          })
          expect(result.error?.code).toBe('proxy')
          invalidResults.push({ label: entry.label, code: result.error?.code })
        }
        evidence.proxy33a.push({ mode: 'invalid', results: invalidResults })

        const { result: failed } = await runStream('http://127.0.0.2:9', {
          requestId: 'task33a-proxy-failure',
          env: {},
          profile: { proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:1' },
          timeouts: { connectMs: 500 }
        })
        expect(failed.error?.code).toBe('proxy')
        evidence.proxy33a.push({
          mode: 'proxy-failure',
          code: failed.error?.code
        })

        const { result: noProxy } = await runStream(mock.baseUrl, {
          requestId: 'task33a-no-proxy',
          env: { HTTP_PROXY: directProxy.url, NO_PROXY: '127.0.0.2' },
          profile: { proxyMode: 'system' }
        })
        expect(noProxy.status).toBe('complete')
        evidence.proxy33a.push({ mode: 'no-proxy-bypass', status: noProxy.status })
      } finally {
        await Promise.all([
          mock.stop(),
          httpProxy.stop(),
          directProxy.stop(),
          socks.stop(),
          authProxy.stop()
        ])
      }
    },
    60_000
  )

  it('maps undici cause codes to the D.7 error taxonomy', async () => {
    const cases: Array<{ cause: string; expected: string }> = [
      { cause: 'ENOTFOUND', expected: 'network_dns' },
      { cause: 'ECONNREFUSED', expected: 'network_refused' },
      { cause: 'CERT_HAS_EXPIRED', expected: 'network_tls' },
      { cause: 'UND_ERR_CONNECT_TIMEOUT', expected: 'timeout_connect' },
      { cause: 'unexpected redirect', expected: 'redirect' }
    ]

    for (const entry of cases) {
      const client = createProviderClient({
        env: {},
        fetchImpl: async () => {
          const cause = Object.assign(new Error(entry.cause), { code: entry.cause })
          throw new TypeError('fetch failed', { cause })
        }
      })
      const result = await client.streamChat({
        profile: profile('http://127.0.0.1:1'),
        messages: [],
        requestId: `map-${entry.cause}`
      })
      expect(result.error?.code).toBe(entry.expected)
    }
  })

  it('maps a proxy connection failure to proxy when a proxy is configured', async () => {
    const client = createProviderClient({
      env: { HTTP_PROXY: 'http://127.0.0.1:1' },
      fetchImpl: async () => {
        const cause = Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED'
        })
        throw new TypeError('fetch failed', { cause })
      }
    })
    const result = await client.streamChat({
      profile: profile('http://127.0.0.2:1'),
      messages: [],
      requestId: 'map-proxy'
    })
    expect(result.error?.code).toBe('proxy')
  })
})

describe('ProviderClient timeout stages', () => {
  it(
    'maps a silent headers server to timeout_headers',
    async () => {
      let requests = 0
      const server = await startHttpServer(() => {
        requests += 1
      })
      const { result } = await runStream(server.url, {
        requestId: 'timeout-headers',
        timeouts: { connectMs: 1000, headersMs: 150, idleMs: 1000, totalMs: 5000 }
      })
      expect(result.error?.code).toBe('timeout_headers')
      expect(requests).toBe(1)
      evidence.timeouts.push({ stage: 'headers', code: result.error?.code, requests })
    },
    20_000
  )

  it(
    'maps a headers-only SSE response to timeout_idle',
    async () => {
      let requests = 0
      const server = await startHttpServer((request, res) => {
        void request
        requests += 1
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.flushHeaders()
      })
      const { result } = await runStream(server.url, {
        requestId: 'timeout-idle',
        timeouts: { connectMs: 1000, headersMs: 1000, idleMs: 150, totalMs: 5000 }
      })
      expect(result.error?.code).toBe('timeout_idle')
      expect(requests).toBe(1)
      evidence.timeouts.push({ stage: 'idle', code: result.error?.code, requests })
    },
    20_000
  )

  it(
    'maps an endless slow stream to timeout_total',
    async () => {
      let requests = 0
      const timer = { handle: null as ReturnType<typeof setInterval> | null }
      const server = await startHttpServer((request, res) => {
        void request
        requests += 1
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        timer.handle = setInterval(() => {
          if (!res.writableEnded) {
            res.write('data: {"choices":[{"index":0,"delta":{"content":"tick"}}]}\n\n')
          }
        }, 50)
        res.on('close', () => {
          if (timer.handle) clearInterval(timer.handle)
        })
      })
      const { result } = await runStream(server.url, {
        requestId: 'timeout-total',
        timeouts: { connectMs: 1000, headersMs: 1000, idleMs: 1000, totalMs: 250 }
      })
      if (timer.handle) clearInterval(timer.handle)
      expect(result.error?.code).toBe('timeout_total')
      expect(requests).toBe(1)
      evidence.timeouts.push({ stage: 'total', code: result.error?.code, requests })
    },
    20_000
  )

  it('writes the timeout evidence', () => {
    writeFileSync(
      logPath('task-15-timeouts.json'),
      `${JSON.stringify(evidence.timeouts, null, 2)}\n`
    )
    expect(evidence.timeouts).toHaveLength(3)
  })
})
