import { MESSAGE_TYPES } from '../shared/message-types.js';
import { escapeHtml } from '../shared/utils.js';
import { renderMarkdown } from '../shared/markdown.js';
import { requestHostPermission, isHostPermissionError, extractUrlFromPermissionError } from '../shared/permissions.js';

export class ChatUI {
  constructor(issueKey) {
    this.issueKey = issueKey;
    this.container = null;
    this.shadow = null;
    this.messagesEl = null;
    this.inputEl = null;
    this.sendBtn = null;
    this.isLoading = false;
    this.isOpen = false;
    // Streaming state shared between onSend() and the CHAT_DELTA listener.
    // Set when a CHAT_MESSAGE is dispatched, cleared in onSend's finally.
    this.activeStreamState = null;
    this._deltaListener = null;
  }

  mount(parent) {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.id = 'jira-ai-chat-host';
    this.shadow = this.container.attachShadow({ mode: 'open' });

    const wrapper = document.createElement('div');
    wrapper.className = 'chat-wrapper';
    wrapper.innerHTML = `
      <div class="chat-header">
        <span class="chat-title">🤖 Jira AI Assistant</span>
        <button class="chat-close" title="Close">×</button>
      </div>
      <div class="chat-messages"></div>
      <div class="chat-input-area">
        <div class="chat-context">
          <div>Current issue: <span class="issue-key">${escapeHtml(this.issueKey || 'none')}</span></div>
        </div>
        <div class="chat-input-row">
          <textarea class="chat-input" rows="1" placeholder="Ask about this ticket..."></textarea>
          <button class="chat-send" title="Send">➤</button>
        </div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = this.getStyles();

    this.shadow.appendChild(style);
    this.shadow.appendChild(wrapper);
    parent.appendChild(this.container);

    this.messagesEl = wrapper.querySelector('.chat-messages');
    this.inputEl = wrapper.querySelector('.chat-input');
    this.sendBtn = wrapper.querySelector('.chat-send');
    this.contextEl = wrapper.querySelector('.chat-context');

    wrapper.querySelector('.chat-close').addEventListener('click', () => this.hide());
    this.sendBtn.addEventListener('click', () => this.onSend());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.onSend();
      }
    });

    // Register the CHAT_DELTA listener once. We keep a reference so we could
    // remove it on unmount, but in practice the ChatUI lives as long as the
    // tab, so we leave it attached.
    this._deltaListener = (message, sender, sendResponse) => {
      if (message.type !== MESSAGE_TYPES.CHAT_DELTA) return false;
      this.handleStreamDelta(message.payload || {});
      return false;
    };
    chrome.runtime.onMessage.addListener(this._deltaListener);

    this.isOpen = true;
    this.addAssistantMessage('Hi! I can help summarize tickets, search related issues, check Confluence, or draft replies. What would you like to know?');
    this.loadContext();
  }

  /**
   * Incrementally render a reasoning chunk streamed from the LLM. The first
   * chunk of each round creates a new thinking card (replacing the placeholder
   * on round 1); subsequent chunks append to the current card's body and
   * re-render markdown so lists/code blocks format correctly as they arrive.
   */
  handleStreamDelta(payload) {
    if (!this.activeStreamState) return;
    if (payload.kind === 'reasoning_start') {
      this.activeStreamState.round = payload.round;
      this.activeStreamState.text = payload.text || '';
      const el = this.buildThinkingElement(this.activeStreamState.text, payload.round);
      if (this.activeStreamState.placeholder && this.activeStreamState.placeholder.isConnected) {
        this.activeStreamState.placeholder.replaceWith(el);
        this.activeStreamState.placeholder = null;
      } else {
        this.messagesEl.appendChild(el);
      }
      this.activeStreamState.currentEl = el;
      this.scrollToBottom();
    } else if (payload.kind === 'reasoning_delta') {
      if (!this.activeStreamState.currentEl) return;
      this.activeStreamState.text += payload.text || '';
      const body = this.activeStreamState.currentEl.querySelector('.thinking-body');
      if (body) {
        body.innerHTML = renderMarkdown(this.activeStreamState.text);
        this.scrollToBottom();
      }
    }
  }

  async loadContext() {
    // No-op: doc-link sidebar was removed with the local document library.
    // Kept as a hook in case future context needs preloading here.
  }

  show(parent) {
    if (!this.container) {
      this.mount(parent);
    } else {
      this.container.style.display = 'block';
      this.isOpen = true;
      this.loadContext();
    }
    this.inputEl?.focus();
  }

  hide() {
    if (this.container) {
      this.container.style.display = 'none';
      this.isOpen = false;
    }
  }

  toggle(parent) {
    if (this.isOpen) this.hide();
    else this.show(parent);
  }

  async onSend() {
    const text = this.inputEl.value.trim();
    if (!text || this.isLoading) return;

    this.addUserMessage(text);
    this.inputEl.value = '';
    this.setLoading(true);
    const placeholder = this.addThinkingPlaceholder();
    this.activeStreamState = { placeholder, currentEl: null, text: '', round: 0 };

    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.CHAT_MESSAGE,
        payload: {
          message: text,
          issueKey: this.issueKey,
          pageUrl: location.href
        }
      });

      if (response.success) {
        this.renderResponse(response.data, placeholder);
      } else {
        const errObj = response.error || {};
        const errMsg = errObj.message || response.error || 'Unknown error';
        if (errObj.code === 'HOST_PERMISSION_MISSING' || isHostPermissionError(errMsg)) {
          const url = errObj.llmBaseUrl || extractUrlFromPermissionError(errMsg);
          this.addHostPermissionError(errMsg, url);
        } else {
          this.addErrorMessage(errMsg);
        }
      }
    } catch (err) {
      if (err?.code === 'HOST_PERMISSION_MISSING' || isHostPermissionError(err?.message)) {
        const url = err?.llmBaseUrl || extractUrlFromPermissionError(err?.message);
        this.addHostPermissionError(err.message, url);
      } else {
        this.addErrorMessage(err.message || 'Failed to reach background service.');
      }
    } finally {
      if (placeholder && placeholder.isConnected) placeholder.remove();
      this.activeStreamState = null;
      this.setLoading(false);
    }
  }

  addHostPermissionError(text, url) {
    const el = document.createElement('div');
    el.className = 'message error host-permission-error';
    const btnHtml = url ? `<button class="authorize-btn">Authorize LLM Host</button>` : '';
    el.innerHTML = `
      <div class="bubble">
        <div>🔒 ${escapeHtml(text)}</div>
        ${btnHtml}
      </div>
    `;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
    if (url) {
      const btn = el.querySelector('.authorize-btn');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Waiting for Chrome prompt...';
        try {
          const result = await requestHostPermission(url);
          if (result.granted) {
            btn.textContent = 'Authorized ✓';
            el.remove();
          } else {
            btn.textContent = 'Permission denied. Click to retry.';
            btn.disabled = false;
          }
        } catch (e) {
          btn.textContent = 'Failed: ' + e.message;
          btn.disabled = false;
        }
      });
    }
  }

  renderResponse(data, placeholder) {
    let sawStreamedReasoning = false;
    if (data.toolCalls?.length) {
      for (const tool of data.toolCalls) {
        if (tool.name === 'reasoning') {
          const thought = tool.result?.thought;
          const round = tool.result?.round;
          const streamed = tool.result?._streamed;
          if (streamed) {
            // Already rendered incrementally via CHAT_DELTA — skip re-render.
            sawStreamedReasoning = true;
          } else if (placeholder && placeholder.isConnected) {
            placeholder.replaceWith(this.buildThinkingElement(thought, round));
          } else {
            this.addThinkingMessage(thought, round);
          }
          continue;
        }
        this.addToolMessage(tool.name, tool.args, tool.result);
      }
    }
    // Drop the placeholder if no streamed reasoning consumed it.
    if (!sawStreamedReasoning && placeholder && placeholder.isConnected) {
      placeholder.remove();
    }
    if (Array.isArray(data.sources) && data.sources.length > 0) {
      this.addSourcesCards(data.sources);
    }
    if (data.content) {
      this.addAssistantMessage(data.content);
    }
  }

  addThinkingMessage(text, round) {
    if (!text) return;
    const el = this.buildThinkingElement(text, round);
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  buildThinkingElement(text, round) {
    const el = document.createElement('div');
    el.className = 'message thinking';
    const roundBadge = typeof round === 'number' && round > 0
      ? `<span class="thinking-round">round ${escapeHtml(String(round))}</span>`
      : '';
    el.innerHTML = `
      <details class="thinking-card" open>
        <summary>
          <span class="thinking-summary-label">💭 Thinking</span>
          ${roundBadge}
        </summary>
        <div class="thinking-body">${renderMarkdown(text)}</div>
      </details>
    `;
    return el;
  }

  addThinkingPlaceholder() {
    const el = document.createElement('div');
    el.className = 'message thinking';
    el.innerHTML = `
      <details class="thinking-card thinking-placeholder" open>
        <summary>
          <span class="thinking-summary-label">💭 Thinking</span>
          <span class="thinking-dots"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></span>
        </summary>
        <div class="thinking-body thinking-body-placeholder">analyzing your request…</div>
      </details>
    `;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  addSourcesCards(sources) {
    if (!Array.isArray(sources) || sources.length === 0) return;
    const el = document.createElement('div');
    el.className = 'message sources';
    const cards = sources.map((s) => {
      const title = s.title || '';
      const detail = s.detail ? `<span class="source-card-status">${escapeHtml(s.detail)}</span>` : '';
      const score = typeof s.score === 'number' && s.score > 0
        ? `<span class="source-card-score">${escapeHtml(String(s.score))}</span>`
        : '';
      const reason = s.reason ? `<div class="source-card-reason">${escapeHtml(s.reason)}</div>` : '';
      const label = s.key
        ? `<span class="source-card-key">${escapeHtml(s.key)}</span>`
        : `<span class="source-card-key">${escapeHtml(s.title || s.url || '')}</span>`;
      const titleHtml = s.key && title
        ? `<span class="source-card-title">${escapeHtml(title)}</span>`
        : '';
      const href = s.url || '#';
      return `
        <a class="source-card" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">
          <div class="source-card-top">
            ${label}
            ${titleHtml}
            ${score}
            ${detail}
          </div>
          ${reason}
        </a>
      `;
    }).join('');
    el.innerHTML = `
      <div class="sources-card">
        <div class="sources-card-header">Sources</div>
        ${cards}
      </div>
    `;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  addUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'message user';
    el.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  addAssistantMessage(text) {
    const el = document.createElement('div');
    el.className = 'message assistant';
    el.innerHTML = `<div class="bubble">${renderMarkdown(text)}</div>`;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  addToolMessage(name, args, result) {
    const el = document.createElement('div');
    el.className = 'message tool';
    const summary = result?.summary || `Called ${name}`;
    el.innerHTML = `
      <div class="tool-card">
        <div class="tool-name">🔧 ${escapeHtml(name)}</div>
        <div class="tool-summary">${escapeHtml(summary)}</div>
      </div>
    `;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  addErrorMessage(text) {
    const el = document.createElement('div');
    el.className = 'message error';
    el.innerHTML = `<div class="bubble">⚠️ ${escapeHtml(text)}</div>`;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  setLoading(loading) {
    this.isLoading = loading;
    this.sendBtn.disabled = loading;
    if (loading) {
      const el = document.createElement('div');
      el.className = 'message assistant loading';
      el.id = 'jira-ai-loading';
      el.innerHTML = `<div class="bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
      this.messagesEl.appendChild(el);
      this.scrollToBottom();
    } else {
      this.shadow.getElementById('jira-ai-loading')?.remove();
    }
  }

  scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  getStyles() {
    return `
      .chat-wrapper {
        position: fixed;
        top: 64px;
        right: 20px;
        width: 380px;
        height: calc(100vh - 84px);
        background: #fff;
        border: 1px solid #dfe1e6;
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        font-size: 14px;
        color: #172b4d;
        z-index: 2147483646;
      }
      .chat-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        border-bottom: 1px solid #dfe1e6;
        background: #f4f5f7;
        border-radius: 8px 8px 0 0;
      }
      .chat-title { font-weight: 600; }
      .chat-close {
        background: none;
        border: none;
        font-size: 20px;
        cursor: pointer;
        color: #5e6c84;
      }
      .chat-messages {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .message { display: flex; }
      .message.user { justify-content: flex-end; }
      .message.assistant,
      .message.error,
      .message.tool { justify-content: flex-start; }
      .bubble {
        max-width: 90%;
        padding: 10px 14px;
        border-radius: 12px;
        line-height: 1.5;
        word-break: break-word;
      }
      .message.user .bubble { background: #0052cc; color: #fff; border-bottom-right-radius: 4px; }
      .message.assistant .bubble { background: #f4f5f7; border-bottom-left-radius: 4px; }
      .message.error .bubble { background: #ffebe6; color: #de350b; }
      .host-permission-error .bubble {
        display: flex;
        flex-direction: column;
        gap: 10px;
        align-items: flex-start;
      }
      .host-permission-error .authorize-btn {
        background: #0052cc;
        color: #fff;
        border: none;
        padding: 8px 14px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
      }
      .host-permission-error .authorize-btn:hover:not(:disabled) { background: #0747a6; }
      .host-permission-error .authorize-btn:disabled { background: #b3d4ff; cursor: not-allowed; }
      .tool-card {
        background: #f4f5f7;
        border-left: 3px solid #0052cc;
        padding: 8px 12px;
        border-radius: 4px;
        font-size: 12px;
        max-width: 90%;
      }
      .tool-name { font-weight: 600; color: #0052cc; margin-bottom: 4px; }
      .tool-summary { color: #5e6c84; }
      .message.sources { justify-content: flex-start; }
      .sources-card {
        max-width: 90%;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .sources-card-header {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #5e6c84;
        font-weight: 600;
      }
      .source-card {
        background: #f4f5f7;
        border: 1px solid #dfe1e6;
        border-left: 3px solid #4c9aff;
        border-radius: 6px;
        padding: 8px 10px;
        cursor: pointer;
        text-decoration: none;
        color: inherit;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .source-card:hover { background: #e9eaf0; border-left-color: #0747a6; }
      .source-card-top {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .source-card-key {
        font-weight: 600;
        color: #0052cc;
        font-size: 12px;
        font-family: monospace;
      }
      .source-card-title {
        font-size: 12px;
        color: #172b4d;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .source-card-score {
        font-size: 10px;
        background: #e3f2fd;
        color: #0747a6;
        padding: 1px 5px;
        border-radius: 8px;
        font-weight: 600;
      }
      .source-card-status {
        font-size: 10px;
        color: #5e6c84;
        background: #fff;
        padding: 1px 5px;
        border-radius: 8px;
        border: 1px solid #dfe1e6;
      }
      .source-card-reason {
        font-size: 11px;
        color: #44546a;
        font-style: italic;
        line-height: 1.4;
      }
      .message.thinking { justify-content: flex-start; }
      .thinking-card {
        max-width: 90%;
        background: #0f172a;
        border: 1px solid #1e293b;
        border-left: 3px solid #38bdf8;
        border-radius: 6px;
        font-size: 12px;
        overflow: hidden;
        color: #cbd5e1;
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12);
      }
      .thinking-card summary {
        padding: 7px 10px;
        cursor: pointer;
        font-weight: 600;
        color: #e0f2fe;
        user-select: none;
        list-style: none;
        display: flex;
        align-items: center;
        gap: 6px;
        background: #1e293b;
      }
      .thinking-card summary::-webkit-details-marker { display: none; }
      .thinking-card summary::before {
        content: "▸";
        font-size: 9px;
        color: #38bdf8;
        transition: transform 0.15s;
      }
      .thinking-card[open] summary::before { transform: rotate(90deg); }
      .thinking-card[open] summary { border-bottom: 1px solid #334155; }
      .thinking-summary-label { font-size: 12px; }
      .thinking-round {
        font-size: 10px;
        font-weight: 500;
        color: #38bdf8;
        background: rgba(56, 189, 248, 0.12);
        padding: 1px 6px;
        border-radius: 8px;
        border: 1px solid rgba(56, 189, 248, 0.25);
        font-family: monospace;
      }
      .thinking-body {
        padding: 8px 10px;
        color: #cbd5e1;
        line-height: 1.6;
        font-size: 11.5px;
        font-family: monospace;
        background: #0f172a;
        max-height: 220px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .thinking-body::-webkit-scrollbar { width: 5px; }
      .thinking-body::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
      .thinking-placeholder summary { cursor: default; }
      .thinking-placeholder .thinking-summary-label { color: #94a3b8; }
      .thinking-body-placeholder {
        color: #64748b;
        font-style: italic;
        font-family: inherit;
        font-size: 11px;
        padding: 10px 12px;
      }
      .thinking-dots {
        display: inline-flex;
        gap: 3px;
        align-items: center;
      }
      .thinking-dots .tdot {
        width: 4px;
        height: 4px;
        background: #38bdf8;
        border-radius: 50%;
        animation: thinking-bounce 1s infinite;
      }
      .thinking-dots .tdot:nth-child(2) { animation-delay: 0.15s; }
      .thinking-dots .tdot:nth-child(3) { animation-delay: 0.3s; }
      @keyframes thinking-bounce {
        0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
        40% { transform: translateY(-3px); opacity: 1; }
      }
      .chat-input-area {
        padding: 12px 16px;
        border-top: 1px solid #dfe1e6;
      }
      .chat-context {
        font-size: 11px;
        color: #5e6c84;
        margin-bottom: 8px;
      }
      .issue-key { font-weight: 600; }
      .chat-input-row {
        display: flex;
        gap: 8px;
      }
      .chat-input {
        flex: 1;
        resize: none;
        padding: 10px 12px;
        border: 1px solid #dfe1e6;
        border-radius: 4px;
        font-family: inherit;
        font-size: 14px;
        max-height: 120px;
      }
      .chat-input:focus { outline: none; border-color: #4c9aff; }
      .chat-send {
        background: #0052cc;
        color: #fff;
        border: none;
        border-radius: 4px;
        width: 40px;
        cursor: pointer;
      }
      .chat-send:disabled { background: #b3d4ff; cursor: not-allowed; }
      .loading .bubble {
        display: flex;
        gap: 4px;
        padding: 14px 12px;
      }
      .dot {
        width: 6px;
        height: 6px;
        background: #5e6c84;
        border-radius: 50%;
        animation: bounce 1s infinite;
      }
      .dot:nth-child(2) { animation-delay: 0.15s; }
      .dot:nth-child(3) { animation-delay: 0.3s; }
      @keyframes bounce {
        0%, 80%, 100% { transform: translateY(0); }
        40% { transform: translateY(-4px); }
      }
      pre {
        background: #f4f5f7;
        padding: 8px;
        border-radius: 4px;
        overflow-x: auto;
      }
      code { font-family: monospace; font-size: 12px; }
      li { margin-left: 16px; }
      table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
      th, td { border: 1px solid #dfe1e6; padding: 4px 8px; text-align: left; }
      th { background: #f4f5f7; }
      blockquote { margin: 6px 0; padding: 6px 10px; border-left: 3px solid #4c9aff; background: #f4f5f7; }
      a { color: #0052cc; }
    `;
  }
}
