'use strict';

/*
 * QuickAsk M0 spike — G9 minimal Electron-main SSE client.
 *
 * This is a throwaway probe, NOT production code (Task 15 implements the
 * provider client). It deliberately uses the same primitives the production
 * client will use: global fetch (Node/undici), TextDecoder('utf-8',
 * {fatal:false}), a strict SSE parser and AbortController.
 *
 * Run:
 *   source scripts/env.sh
 *   ./node_modules/.bin/electron spike/sse.cjs --url <url> --out <json>
 *       [--abort-after-chunks N] [--proxy http://127.0.0.1:PORT] [--impl net|node]
 *
 * Exit codes: 0 success or expected abort, 2 protocol error, 3 rate_limit,
 * 4 network/other error. There is NO automatic retry anywhere.
 */

const { app, net, session } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const SUMMARY_MAX = 300;

const rawArgs = process.argv.slice(1);
function argValue(name) {
  const i = rawArgs.indexOf(name);
  return i >= 0 ? rawArgs[i + 1] : undefined;
}
function hasFlag(name) {
  return rawArgs.includes(name);
}

const URL_ARG = argValue('--url');
const OUT_ARG = argValue('--out');
const ABORT_AFTER_CHUNKS = Number(argValue('--abort-after-chunks') || 0);
const PROXY = argValue('--proxy');
const IMPL = argValue('--impl') || (PROXY ? 'net' : 'node');
const TOTAL_TIMEOUT_MS = Number(argValue('--timeout-ms') || 30000);
const LABEL = argValue('--label') || '';

if (!URL_ARG) {
  process.stderr.write('sse.cjs: --url is required\n');
  process.exit(2);
}

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('no-pings');
if (hasFlag('--ignore-cert')) app.commandLine.appendSwitch('ignore-certificate-errors');
app.setPath('userData', path.join(ROOT, '.cache', 'spike-userdata-sse'));
if (process.platform === 'linux' && process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function redact(value) {
  let text = typeof value === 'string' ? value : String(value);
  text = text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***');
  text = text.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***');
  text = text.replace(/([?&](?:api_key|key|token)=)[^&\s]+/gi, '$1***');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, SUMMARY_MAX);
}

function mapNetworkCode(error) {
  const code = (error && error.cause && error.cause.code) || (error && error.code) || '';
  const message = String((error && error.message) || error);
  if (code === 'ECONNREFUSED' || /ERR_CONNECTION_REFUSED/i.test(message)) return 'network_refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /ERR_NAME_NOT_RESOLVED/i.test(message)) return 'network_dns';
  if (/CERT|TLS|SSL/i.test(code) || /ERR_CERT|ERR_SSL/i.test(message)) return 'network_tls';
  if (/proxy/i.test(message) || /ERR_TUNNEL/i.test(message)) return 'proxy';
  return 'network';
}

function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 422) return 'bad_request';
  if (status >= 500) return 'server';
  if (status >= 300 && status < 400) return 'redirect';
  return 'protocol';
}

function createSseParser(onEvent, onComment) {
  let line = '';
  let pendingCR = false;
  let dataLines = [];
  let first = true;
  let stopped = false;

  function dispatch() {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (onEvent(data) === false) stopped = true;
  }

  function handleLine(value) {
    if (value === '') {
      dispatch();
      return;
    }
    if (value.startsWith(':')) {
      onComment(value);
      return;
    }
    const idx = value.indexOf(':');
    let field;
    let fieldValue;
    if (idx === -1) {
      field = value;
      fieldValue = '';
    } else {
      field = value.slice(0, idx);
      fieldValue = value.slice(idx + 1);
      if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
    }
    if (field === 'data') dataLines.push(fieldValue);
    // event:, id:, retry: are intentionally ignored (not needed by this API).
  }

  function endLine() {
    const value = line;
    line = '';
    handleLine(value);
  }

  return {
    feed(text) {
      if (stopped) return;
      let input = text;
      if (first && input.length > 0) {
        first = false;
        if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
      }
      for (let i = 0; i < input.length; i += 1) {
        const ch = input[i];
        if (pendingCR) {
          pendingCR = false;
          endLine();
          if (stopped) return;
          if (ch === '\n') continue;
        }
        if (ch === '\r') {
          pendingCR = true;
        } else if (ch === '\n') {
          endLine();
          if (stopped) return;
        } else {
          line += ch;
        }
      }
    },
    end() {
      if (stopped) return;
      if (pendingCR) {
        pendingCR = false;
        endLine();
        if (stopped) return;
      }
      if (line.length > 0) endLine();
      // A final event without the terminating blank line is discarded on EOF
      // (SSE spec). Our fixtures always send the blank line.
      if (!stopped && dataLines.length > 0) {
        onComment(`: incomplete-event-discarded(${dataLines.length} data lines)`);
        dataLines = [];
      }
    },
    get stopped() {
      return stopped;
    }
  };
}

async function readLimitedText(response, limit = MAX_BODY_BYTES) {
  const reader = response.body ? response.body.getReader() : null;
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error(`response body exceeds ${limit} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

async function run() {
  const events = [];
  const emit = (obj) => {
    events.push(obj);
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...obj })}\n`);
  };

  const startedAt = Date.now();
  const metrics = {
    label: LABEL,
    url: URL_ARG,
    impl: IMPL,
    proxy: PROXY || null,
    request_start_ms: startedAt,
    abort_after_chunks: ABORT_AFTER_CHUNKS > 0 ? ABORT_AFTER_CHUNKS : null,
    http_status: null,
    content_type: null,
    headers_ms: null,
    first_byte_ms: null,
    first_content_ms: null,
    end_ms: null,
    elapsed_ms: null,
    bytes_received: 0,
    sse_events: 0,
    comments: 0,
    content_chunks: 0,
    reasoning_chunks: 0,
    content: '',
    content_utf8_replacement_count: 0,
    saw_done: false,
    clean_close: false,
    aborted: false,
    abort_elapsed_ms: null,
    chunks_after_abort: 0,
    finish_reason: null,
    usage: null,
    protocol_error: null,
    network_error: null,
    events_count: 0
  };

  let abortRequested = false;
  let abortAt = 0;
  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    abortRequested = true;
    abortAt = Date.now();
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  }, TOTAL_TIMEOUT_MS);

  const handleContent = (text) => {
    if (abortRequested) {
      metrics.chunks_after_abort += 1;
      return;
    }
    metrics.content_chunks += 1;
    metrics.content += text;
    if (metrics.first_content_ms === null) {
      metrics.first_content_ms = Date.now() - startedAt;
    }
    emit({ ev: 'chunk', index: metrics.content_chunks, len: text.length });
  };

  const parser = createSseParser(
    (data) => {
      metrics.sse_events += 1;
      const trimmed = data.trim();
      if (trimmed === '[DONE]') {
        metrics.saw_done = true;
        emit({ ev: 'done' });
        return true;
      }
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        metrics.protocol_error = {
          code: 'protocol',
          reason: 'malformed_json',
          summary: redact(data),
          status: metrics.http_status
        };
        emit({ ev: 'protocol_error', code: 'protocol', reason: 'malformed_json' });
        return false;
      }
      if (payload && payload.error) {
        metrics.protocol_error = {
          code: 'protocol',
          reason: 'sse_error_object',
          summary: redact(JSON.stringify(payload.error)),
          status: metrics.http_status
        };
        emit({ ev: 'protocol_error', code: 'protocol', reason: 'sse_error_object' });
        return false;
      }
      const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
      const delta = choice && choice.delta ? choice.delta : null;
      if (delta && typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        metrics.reasoning_chunks += 1;
        emit({ ev: 'reasoning', index: metrics.reasoning_chunks });
      }
      if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
        handleContent(delta.content);
        if (
          ABORT_AFTER_CHUNKS > 0 &&
          metrics.content_chunks >= ABORT_AFTER_CHUNKS &&
          !abortRequested
        ) {
          abortRequested = true;
          abortAt = Date.now();
          metrics.aborted = true;
          metrics.abort_elapsed_ms = abortAt - startedAt;
          emit({ ev: 'abort_requested', after_chunks: metrics.content_chunks });
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
          return false;
        }
      }
      if (choice && typeof choice.finish_reason === 'string') {
        metrics.finish_reason = choice.finish_reason;
      }
      if (payload && payload.usage) {
        metrics.usage = payload.usage;
      }
      return true;
    },
    (comment) => {
      metrics.comments += 1;
      emit({ ev: 'comment', text: redact(comment) });
    }
  );

  let response;
  const fetchImpl = IMPL === 'net' ? net.fetch : fetch;

  try {
    if (PROXY) {
      await session.defaultSession.setProxy({
        proxyRules: PROXY,
        proxyBypassRules: '<-loopback>'
      });
      emit({ ev: 'proxy_configured', proxy: PROXY });
    }

    response = await fetchImpl(URL_ARG, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Accept-Encoding': 'identity',
        'User-Agent': 'QuickAsk-M0-SSE-Spike/0.0.0'
      },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'spike' }],
        stream: true
      }),
      signal: controller.signal
    });

    metrics.http_status = response.status;
    metrics.content_type = response.headers.get('content-type') || '';
    metrics.headers_ms = Date.now() - startedAt;
    emit({ ev: 'headers', status: metrics.http_status, content_type: metrics.content_type });

    if (response.status === 429) {
      let body = '';
      try {
        body = await readLimitedText(response, SUMMARY_MAX * 4);
      } catch {
        /* ignore */
      }
      metrics.protocol_error = {
        code: 'rate_limit',
        reason: 'http_429',
        summary: redact(body || 'rate limited'),
        status: 429
      };
      metrics.end_ms = Date.now();
      metrics.elapsed_ms = metrics.end_ms - startedAt;
      emit({ ev: 'rate_limit', status: 429 });
      return finish(3);
    }

    if (response.status < 200 || response.status >= 300) {
      let body = '';
      try {
        body = await readLimitedText(response, SUMMARY_MAX * 4);
      } catch {
        /* ignore */
      }
      metrics.protocol_error = {
        code: httpErrorCode(response.status),
        reason: `http_${response.status}`,
        summary: redact(body || `HTTP ${response.status}`),
        status: response.status
      };
      metrics.end_ms = Date.now();
      metrics.elapsed_ms = metrics.end_ms - startedAt;
      emit({ ev: 'http_error', status: response.status, code: metrics.protocol_error.code });
      return finish(2);
    }

    if (!/text\/event-stream/i.test(metrics.content_type)) {
      let body = '';
      try {
        body = await readLimitedText(response, MAX_BODY_BYTES);
      } catch (error) {
        body = error.message;
      }
      metrics.protocol_error = {
        code: 'protocol',
        reason: 'non_sse_2xx',
        summary: redact(body || '(empty body)'),
        status: response.status
      };
      metrics.end_ms = Date.now();
      metrics.elapsed_ms = metrics.end_ms - startedAt;
      emit({ ev: 'non_sse_2xx', status: response.status, summary_len: metrics.protocol_error.summary.length });
      return finish(2);
    }

    if (!response.body) {
      metrics.protocol_error = {
        code: 'protocol',
        reason: 'empty_body',
        summary: 'response has no body',
        status: response.status
      };
      metrics.end_ms = Date.now();
      metrics.elapsed_ms = metrics.end_ms - startedAt;
      emit({ ev: 'protocol_error', code: 'protocol', reason: 'empty_body' });
      return finish(2);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let clean = true;

    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (abortRequested) {
          emit({ ev: 'read_ended_by_abort' });
        } else {
          clean = false;
          metrics.protocol_error = {
            code: mapNetworkCode(error),
            reason: 'body_read_failed',
            summary: redact(error.message),
            status: metrics.http_status
          };
          emit({ ev: 'body_read_error', message: redact(error.message) });
        }
        break;
      }
      if (chunk.done) break;
      metrics.bytes_received += chunk.value.byteLength;
      if (metrics.first_byte_ms === null) {
        metrics.first_byte_ms = Date.now() - startedAt;
        emit({ ev: 'first_byte', bytes: chunk.value.byteLength });
      }
      if (metrics.bytes_received > MAX_BODY_BYTES) {
        abortRequested = true;
        metrics.aborted = true;
        metrics.protocol_error = {
          code: 'protocol',
          reason: 'response_too_large',
          summary: `response exceeded ${MAX_BODY_BYTES} bytes`,
          status: metrics.http_status
        };
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
        emit({ ev: 'protocol_error', code: 'protocol', reason: 'response_too_large' });
        break;
      }
      parser.feed(decoder.decode(chunk.value, { stream: true }));
      if (parser.stopped) break;
      if (abortRequested) break;
    }

    if (abortRequested) {
      metrics.aborted = true;
      try {
        await response.body.cancel();
      } catch (error) {
        emit({ ev: 'body_cancel_error', message: error.message });
      }
      emit({ ev: 'abort_complete', elapsed_ms: metrics.abort_elapsed_ms });
    } else if (clean) {
      parser.end();
      const tail = decoder.decode();
      if (tail) parser.feed(tail);
      metrics.clean_close = !metrics.protocol_error;
    }
  } catch (error) {
    if (abortRequested) {
      if (timedOut) {
        metrics.protocol_error = {
          code: 'timeout_total',
          reason: 'total_timeout',
          summary: `request exceeded ${TOTAL_TIMEOUT_MS} ms`,
          status: metrics.http_status
        };
      } else {
        metrics.aborted = true;
      }
      emit({ ev: 'fetch_ended_by_abort', message: redact(error.message) });
    } else {
      const code = mapNetworkCode(error);
      metrics.network_error = code;
      metrics.protocol_error = {
        code,
        reason: 'fetch_failed',
        summary: redact(error.message),
        status: metrics.http_status
      };
      emit({ ev: 'network_error', code, message: redact(error.message) });
    }
  } finally {
    clearTimeout(timer);
  }

  metrics.end_ms = Date.now();
  metrics.elapsed_ms = metrics.end_ms - startedAt;
  metrics.content_utf8_replacement_count = (metrics.content.match(/\uFFFD/g) || []).length;
  metrics.events_count = events.length;

  let exitCode = 0;
  if (metrics.protocol_error) {
    exitCode = metrics.protocol_error.code === 'rate_limit' ? 3 : metrics.protocol_error.code === 'protocol' ? 2 : 4;
  } else if (metrics.aborted) {
    exitCode = 0;
  }
  emit({ ev: 'finish', exit_code: exitCode, aborted: metrics.aborted, protocol_error: metrics.protocol_error });
  return finish(exitCode);

  function finish(code) {
    metrics.events_count = events.length;
    writeOutput(metrics);
    // Let stdout drain before exiting the Electron main process.
    return sleep(50).then(() => app.exit(code));
  }
}

function writeOutput(metrics) {
  if (!OUT_ARG) return;
  fs.mkdirSync(path.dirname(OUT_ARG), { recursive: true });
  const tmp = `${OUT_ARG}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(metrics, null, 2)}\n`);
  fs.renameSync(tmp, OUT_ARG);
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (error) {
    process.stderr.write(`sse.cjs FATAL ${error && error.stack ? error.stack : error}\n`);
    try {
      writeOutput({
        fatal: String(error && error.message ? error.message : error),
        stack: error && error.stack ? error.stack : null
      });
    } catch {
      /* ignore */
    }
    await sleep(50);
    app.exit(2);
  }
});
