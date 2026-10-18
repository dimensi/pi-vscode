import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { toErrorMessage } from "./bridge/utils.ts";
import { runPiRpcPrompt } from "./chat.ts";
import { createPiEnvironment, ensurePiBinary } from "./pi.ts";
import { buildOpenWithFileContext } from "./terminal.ts";

/**
 * Claude-подобный чат с pi во secondary sidebar: webview-вьюха, стриминг через
 * RPC-режим pi, мост (выделения/диагностика) доступен внутри сессии.
 */

export function createSidebarChatProvider(options: {
  extensionUri: vscode.Uri;
  getBridgeConfig(): { url: string; token: string } | undefined;
}): vscode.WebviewViewProvider {
  let cancellation: vscode.CancellationTokenSource | undefined;
  let busy = false;

  return {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = { enableScripts: true };
      const nonce = randomUUID().replaceAll("-", "");
      webviewView.webview.html = getChatHtml(nonce);

      const post = (message: unknown) => {
        void webviewView.webview.postMessage(message);
      };

      webviewView.webview.onDidReceiveMessage(async (raw) => {
        const message = raw as { type?: string; text?: unknown };
        if (message.type === "stop") {
          cancellation?.cancel();
          return;
        }
        if (message.type !== "prompt" || typeof message.text !== "string") return;
        const text = message.text.trim();
        if (!text || busy) return;

        const piPath = await ensurePiBinary();
        if (!piPath) {
          post({ type: "done", error: "Pi binary not found." });
          return;
        }

        busy = true;
        cancellation = new vscode.CancellationTokenSource();
        post({ type: "busy", busy: true });

        const contextLines = buildOpenWithFileContext();
        const fullMessage = [...contextLines, text].join("\n\n");
        try {
          const result = await runPiRpcPrompt({
            piPath,
            message: fullMessage,
            token: cancellation.token,
            onDelta: (delta) => post({ type: "delta", text: delta }),
            extensionUri: options.extensionUri,
            bridgeConfig: options.getBridgeConfig(),
          });
          post({
            type: "done",
            error: result.hadOutput ? undefined : "Pi did not return any text.",
          });
        } catch (error) {
          const cancelled = cancellation.token.isCancellationRequested;
          post({ type: "done", error: cancelled ? undefined : toErrorMessage(error) });
        } finally {
          busy = false;
          post({ type: "busy", busy: false });
        }
      });
    },
  };
}

function getChatHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    display: flex; flex-direction: column;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground); background: var(--vscode-sideBar-background);
  }
  #toolbar { display: flex; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  #toolbar button {
    padding: 2px 8px; cursor: pointer; font-size: 11px; border-radius: 3px; border: none;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  }
  #toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #stop { display: none; background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: #fff; }
  #log { flex: 1; overflow-y: auto; padding: 8px; }
  .msg { margin-bottom: 10px; }
  .msg .role { font-size: 10px; opacity: 0.55; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 2px; }
  .msg .body { white-space: pre-wrap; word-wrap: break-word; overflow-wrap: anywhere; line-height: 1.45; }
  .msg.user .body {
    background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 6px; padding: 6px 8px;
  }
  .msg .body pre {
    background: var(--vscode-textCodeBlock-background); padding: 6px 8px; border-radius: 6px;
    overflow-x: auto; white-space: pre; margin: 4px 0;
  }
  .msg .body code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
  .msg .error { color: var(--vscode-errorForeground); }
  #busy { display: none; padding: 2px 10px 6px; opacity: 0.6; font-size: 12px; font-style: italic; }
  #input-bar { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border, transparent); }
  #input {
    flex: 1; resize: none; min-height: 44px; max-height: 160px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px;
    font: inherit; padding: 6px 8px; outline: none;
  }
  #send {
    align-self: flex-end; padding: 5px 12px; cursor: pointer; border: none; border-radius: 4px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  #send:hover { background: var(--vscode-button-hoverBackground); }
  #send:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
  <div id="toolbar">
    <button id="clear" title="Clear conversation">New chat</button>
    <button id="stop" title="Stop generation">Stop</button>
  </div>
  <div id="log"></div>
  <div id="busy">pi is thinking…</div>
  <div id="input-bar">
    <textarea id="input" placeholder="Ask pi… (Enter to send, Shift+Enter for newline)"></textarea>
    <button id="send">Send</button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const stop = document.getElementById('stop');
  const busyEl = document.getElementById('busy');
  let assistantBody = null;
  let assistantRaw = '';

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function renderMarkdown(raw) {
    const parts = raw.split('\`\`\`');
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\\n');
        const code = nl === -1 ? '' : part.slice(nl + 1);
        return '<pre><code>' + escapeHtml(code.replace(/\\n$/, '')) + '</code></pre>';
      }
      return escapeHtml(part)
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>')
        .replace(/\\n/g, '<br>');
    }).join('');
  }

  function nearBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  }
  function scrollDown(force) {
    if (force || nearBottom()) log.scrollTop = log.scrollHeight;
  }

  function addUser(text) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = '<div class="role">you</div><div class="body"></div>';
    el.querySelector('.body').textContent = text;
    log.appendChild(el);
    scrollDown(true);
  }

  function beginAssistant() {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = '<div class="role">pi</div><div class="body"></div>';
    log.appendChild(el);
    assistantBody = el.querySelector('.body');
    assistantRaw = '';
  }

  function setError(text) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = '<div class="role">error</div><div class="body error"></div>';
    el.querySelector('.body').textContent = text;
    log.appendChild(el);
    scrollDown(true);
  }

  function setBusy(b) {
    busyEl.style.display = b ? 'block' : 'none';
    stop.style.display = b ? 'inline-block' : 'none';
    send.disabled = b;
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addUser(text);
    vscode.postMessage({ type: 'prompt', text });
  }

  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  stop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  document.getElementById('clear').addEventListener('click', () => { log.innerHTML = ''; });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'delta') {
      if (!assistantBody) beginAssistant();
      assistantRaw += m.text;
      assistantBody.innerHTML = renderMarkdown(assistantRaw);
      scrollDown(false);
    } else if (m.type === 'done') {
      if (m.error) setError(m.error);
      else if (!assistantBody) beginAssistant(); // keep parity for empty replies
      assistantBody = null;
      assistantRaw = '';
      setBusy(false);
    } else if (m.type === 'busy') {
      setBusy(m.busy);
      if (m.busy) scrollDown(true);
    }
  });

  input.focus();
</script>
</body>
</html>`;
}
