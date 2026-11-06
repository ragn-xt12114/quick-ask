'use strict';

/*
 * QuickAsk M0 G6 IME spike preload (sandbox-safe).
 *
 * Runs with contextIsolation:true, sandbox:true, nodeIntegration:false.
 * Only ipcRenderer is used; nothing is exposed to the page.
 *
 * Responsibilities
 *   - forward keydown/keyup/compositionstart/compositionupdate/compositionend/
 *     input events plus the input bounding rect to the main process;
 *   - implement the real-composer IME guard semantics for the spike:
 *       Enter while composing       -> do nothing (IME commits locally)
 *       Enter while not composing   -> ipcRenderer.send('ime:send', value)
 *       Escape while composing      -> do nothing (IME cancels composition)
 *       Escape while not composing  -> ipcRenderer.send('ime:escape')
 *       Tab / Ctrl+N / Ctrl+H / Ctrl+, / Ctrl+Shift+V
 *                                   -> log ignored while composing, otherwise
 *                                      log triggered (no real action needed)
 *
 * The Chinese assertion is driven by real xdotool keystrokes through fcitx5;
 * this preload never writes the input value itself.
 */

const { ipcRenderer } = require('electron');

let composing = false;

function inputEl() {
  return document.getElementById('composer');
}

function rectSnapshot(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
  };
}

function snapshot() {
  const el = inputEl();
  return {
    value: el ? el.value : '',
    composing,
    input_rect_css: rectSnapshot(el),
    input_focused: !!el && document.activeElement === el,
  };
}

function setState(text) {
  const badge = document.getElementById('state');
  if (badge) badge.textContent = text;
}

function setStatus(text) {
  const status = document.getElementById('status');
  if (status) status.textContent = text;
}

function sendEvent(name, ev, extra) {
  const payload = {
    event: name,
    key: ev && ev.key !== undefined ? ev.key : null,
    keyCode: ev && ev.keyCode !== undefined ? ev.keyCode : null,
    isComposing: ev && ev.isComposing !== undefined ? !!ev.isComposing : composing,
    inputType: ev && ev.inputType !== undefined ? ev.inputType : null,
    data: ev && ev.data !== undefined ? ev.data : null,
    value: inputEl() ? inputEl().value : null,
    timestamp: ev && ev.timeStamp !== undefined ? ev.timeStamp : Date.now(),
    ...snapshot(),
    ...(extra || {}),
  };
  try {
    ipcRenderer.send('ime:event', payload);
  } catch {
    /* renderer is tearing down */
  }
}

function isComposingKey(ev) {
  return composing || !!ev.isComposing || ev.keyCode === 229;
}

function shortcutName(ev) {
  const key = typeof ev.key === 'string' ? ev.key.toLowerCase() : '';
  const code = typeof ev.code === 'string' ? ev.code : '';
  const ctrl = !!ev.ctrlKey;
  const shift = !!ev.shiftKey;
  const alt = !!ev.altKey;

  if (ev.key === 'Tab') return 'Tab';
  if (ctrl && !shift && !alt && key === 'n') return 'Ctrl+N';
  if (ctrl && !shift && !alt && key === 'h') return 'Ctrl+H';
  if (ctrl && !shift && !alt && (key === ',' || code === 'Comma')) return 'Ctrl+,';
  if (ctrl && shift && !alt && key === 'v') return 'Ctrl+Shift+V';
  return null;
}

window.addEventListener('DOMContentLoaded', () => {
  const el = inputEl();
  if (!el) return;

  // Focus once the document is ready; the driver still activates the X11
  // window explicitly and verifies X focus before typing.
  el.focus();
  try {
    ipcRenderer.send('ime:rect', {
      input_rect_css: rectSnapshot(el),
      value: el.value,
      composing,
      input_focused: document.activeElement === el,
    });
  } catch {
    /* ignore */
  }
  setState('ready');
  setStatus('G6 fcitx5 IME spike — focused, waiting for keystrokes');

  document.addEventListener('compositionstart', (ev) => {
    composing = true;
    setState('composing');
    sendEvent('compositionstart', ev);
  });

  document.addEventListener('compositionupdate', (ev) => {
    setState('composing');
    sendEvent('compositionupdate', ev);
  });

  document.addEventListener('compositionend', (ev) => {
    // Update the tracking flag before the event snapshot so main sees the
    // authoritative end state, and keep ev.isComposing in the event field.
    composing = false;
    setState('idle');
    sendEvent('compositionend', ev);
  });

  document.addEventListener('input', (ev) => {
    setState(composing ? 'composing' : 'input');
    sendEvent('input', ev, {
      inputType: ev.inputType || null,
      data: ev.data !== undefined ? ev.data : null,
    });
  });

  document.addEventListener('keydown', (ev) => {
    const composingAtKey = isComposingKey(ev);
    sendEvent('keydown', ev, { composing_at_key: composingAtKey });

    if (ev.key === 'Enter' || ev.keyCode === 13) {
      if (composingAtKey) {
        // Do nothing: let the IME commit the composition locally. Do not
        // preventDefault so Chromium/fcitx5 keeps its normal commit path.
        setStatus('Enter during composition ignored (IME commit)');
        return;
      }
      const value = el.value;
      setStatus(`sending: ${JSON.stringify(value)}`);
      try {
        ipcRenderer.send('ime:send', value);
      } catch {
        /* ignore */
      }
      return;
    }

    if (ev.key === 'Escape' || ev.keyCode === 27) {
      if (composingAtKey) {
        // Do nothing: the IME consumes Escape and cancels its composition.
        setStatus('Escape during composition ignored (IME cancel)');
        return;
      }
      setStatus('escape -> hide');
      try {
        ipcRenderer.send('ime:escape');
      } catch {
        /* ignore */
      }
      return;
    }

    const name = shortcutName(ev);
    if (!name) return;
    if (composingAtKey) {
      setStatus(`shortcut ${name} ignored while composing`);
      try {
        ipcRenderer.send('ime:shortcut', { name, composing: true });
      } catch {
        /* ignore */
      }
      // A real composer ignores the shortcut while the IME owns the key
      // sequence. Suppress the browser default too, otherwise e.g.
      // Ctrl+Shift+V would paste the clipboard into the composition even
      // though the app "did nothing".
      ev.preventDefault();
      return;
    }
    setStatus(`shortcut ${name} triggered`);
    try {
      ipcRenderer.send('ime:shortcut', { name, composing: false });
    } catch {
      /* ignore */
    }
    // No real action is implemented in the spike; suppressing the browser
    // default keeps the harness from navigating/pasting unexpectedly.
    ev.preventDefault();
  });

  document.addEventListener('keyup', (ev) => {
    sendEvent('keyup', ev, { composing_at_key: isComposingKey(ev) });
  });
});
