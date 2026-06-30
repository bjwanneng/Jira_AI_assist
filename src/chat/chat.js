import { MESSAGE_TYPES } from '../shared/message-types.js';
import { escapeHtml } from '../shared/utils.js';
import { renderMarkdown } from '../shared/markdown.js';
import { ContextState } from '../shared/context-state.js';
import {
  listConversations, createConversation, getConversation,
  updateConversation, appendMessage, deleteConversation,
  clearAllConversations, getActiveConversationId, setActiveConversationId
} from './conversation-store.js';
import { requestHostPermission, isHostPermissionError, extractUrlFromPermissionError } from '../shared/permissions.js';

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const newChatBtn = document.getElementById('new-chat');
const contextDisplay = document.getElementById('context-display');
const contextClearBtn = document.getElementById('context-clear');
const historyList = document.getElementById('history-list');
const clearHistoryBtn = document.getElementById('clear-history');
const currentTitle = document.getElementById('current-title');
const srcJira = document.getElementById('src-jira');
const srcConfluence = document.getElementById('src-confluence');
const srcSlack = document.getElementById('src-slack');

const contextState = new ContextState('global');

let isLoading = false;
let activeConversationId = null;

// ---------- Conversation management ----------

async function startNewConversation() {
  // Read current source flags from the UI before creating.
  const sourceFlags = collectSourceFlags();
  const conv = await createConversation('New conversation', { sourceFlags });
  activeConversationId = conv.id;
  await contextState.clear();
  await setActiveConversationId(conv.id);
  messagesEl.innerHTML = '';
  currentTitle.textContent = conv.title;
  renderHistory();
  refreshContextDisplay();
  addAssistantMessage('New conversation started. How can I help?');
}

function collectSourceFlags() {
  return {
    jira: srcJira.checked,
    confluence: srcConfluence.checked,
    slack: srcSlack.checked
  };
}

function applySourceFlags(flags) {
  const f = flags || { jira: true, confluence: true, slack: true };
  srcJira.checked = !!f.jira;
  srcConfluence.checked = !!f.confluence;
  srcSlack.checked = !!f.slack;
}

// Persist source flags back to the active conversation whenever the user
// toggles them.
async function persistConversationMeta() {
  if (!activeConversationId) return;
  await updateConversation(activeConversationId, {
    sourceFlags: collectSourceFlags()
  });
}

[srcJira, srcConfluence, srcSlack].forEach(el => {
  el.addEventListener('change', persistConversationMeta);
});

async function clearBackendConversations() {
  try {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.CLEAR_ALL_CONVERSATIONS });
  } catch (err) {
    console.warn('Failed to clear backend conversations:', err.message);
  }
}

async function switchConversation(id) {
  const conv = await getConversation(id);
  if (!conv) return;
  activeConversationId = id;
  await setActiveConversationId(id);

  // Restore messages
  messagesEl.innerHTML = '';
  for (const msg of conv.messages) {
    if (msg.role === 'user') addUserMessage(msg.content);
    else if (msg.role === 'assistant') addAssistantMessage(msg.content);
    else if (msg.role === 'error') addErrorMessage(msg.content);
    else if (msg.role === 'thinking') addThinkingMessage(msg.content);
    else if (msg.role === 'tool') addToolMessage(msg.toolName, msg.summary);
  }

  // Restore context
  if (conv.context) {
    await contextState.set(conv.context.product, conv.context.config, conv.context.customer, conv.context.locked);
  }
  // Restore source flags
  applySourceFlags(conv.sourceFlags);
  currentTitle.textContent = conv.title;
  refreshContextDisplay();
  renderHistory();
}

async function renderHistory() {
  const conversations = await listConversations();
  if (conversations.length === 0) {
    historyList.innerHTML = '<p class="history-empty">No conversations yet.</p>';
    return;
  }

  historyList.innerHTML = conversations.map(c => `
    <button class="history-item ${c.id === activeConversationId ? 'active' : ''}" data-id="${c.id}">
      <div class="history-item-title">${escapeHtml(c.title || 'New conversation')}</div>
      <div class="history-item-meta">${new Date(c.updatedAt).toLocaleDateString()} ${new Date(c.updatedAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</div>
    </button>
  `).join('');

  historyList.querySelectorAll('.history-item').forEach(btn => {
    btn.addEventListener('click', () => switchConversation(btn.dataset.id));
  });
}

// ---------- Context display ----------

async function refreshContextDisplay() {
  await contextState.load();
  contextDisplay.textContent = contextState.toDisplayString();
}

contextClearBtn.addEventListener('click', async () => {
  await contextState.clear();
  refreshContextDisplay();
  if (activeConversationId) {
    await updateConversation(activeConversationId, { context: contextState.get() });
  }
});

// ---------- Send ----------

async function onSend() {
  const text = inputEl.value.trim();
  if (!text || isLoading) return;

  // Ensure there's an active conversation
  if (!activeConversationId) {
    const conv = await createConversation(text.slice(0, 40) + (text.length > 40 ? '...' : ''));
    activeConversationId = conv.id;
    currentTitle.textContent = conv.title;
  }

  addUserMessage(text);
  await appendMessage(activeConversationId, { role: 'user', content: text });
  inputEl.value = '';
  inputEl.style.height = 'auto';
  setLoading(true, 'Thinking...');
  // Show a thinking placeholder in the message stream so the user sees the
  // assistant is working on their question — replaced by the first real
  // thinking card once the response arrives.
  const placeholder = addThinkingPlaceholder();
  renderHistory();

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CHAT_MESSAGE,
      payload: {
        message: text,
        issueKey: null,
        pageUrl: location.href,
        conversationId: activeConversationId,
        sourceFlags: collectSourceFlags()
      }
    });

    if (response?.success) {
      const data = response.data || {};
      let firstReasoning = true;
      if (Array.isArray(data.toolCalls)) {
        for (const tool of data.toolCalls) {
          if (tool.name === 'reasoning') {
            const thought = tool.result?.thought;
            const round = tool.result?.round;
            if (firstReasoning && placeholder) {
              // Replace the placeholder with the first real thinking card.
              placeholder.replaceWith(buildThinkingElement(thought, round));
              firstReasoning = false;
            } else {
              addThinkingMessage(thought, round);
            }
            await appendMessage(activeConversationId, { role: 'thinking', content: thought });
            continue;
          }
          if (tool.name === 'set_context') {
            refreshContextDisplay();
          }
          const summary = summarizeTool(tool.name, tool.args, tool.result);
          addToolMessage(tool.name, summary);
          await appendMessage(activeConversationId, { role: 'tool', toolName: tool.name, summary });
        }
      }
      // If the model produced no reasoning at all, drop the placeholder —
      // we don't want an empty "Thinking..." card lingering above the answer.
      if (firstReasoning && placeholder) {
        placeholder.remove();
      }
      // Render rich source cards (with rerank score + reason) before the
      // final answer streams in. Mirrors how Rovo surfaces its top hits.
      if (Array.isArray(data.sources) && data.sources.length > 0) {
        addSourcesCards(data.sources);
      }
      if (data.content) {
        addAssistantMessage(data.content);
        await appendMessage(activeConversationId, { role: 'assistant', content: data.content });
      } else if (!data.toolCalls?.length) {
        addAssistantMessage('(no response)');
      }
      // Sync context state back to the conversation
      const ctx = contextState.get();
      await updateConversation(activeConversationId, { context: ctx });
      refreshContextDisplay();
      renderHistory();
    } else {
      const errObj = response?.error || {};
      const errMsg = errObj.message || response?.error || 'Unknown error';
      if (errObj.code === 'HOST_PERMISSION_MISSING' || isHostPermissionError(errMsg)) {
        const url = errObj.llmBaseUrl || extractUrlFromPermissionError(errMsg);
        addHostPermissionError(errMsg, url);
        await appendMessage(activeConversationId, { role: 'error', content: errMsg });
      } else {
        addErrorMessage(errMsg);
        await appendMessage(activeConversationId, { role: 'error', content: errMsg });
      }
    }
  } catch (err) {
    if (err?.code === 'HOST_PERMISSION_MISSING' || isHostPermissionError(err?.message)) {
      const url = err?.llmBaseUrl || extractUrlFromPermissionError(err?.message);
      addHostPermissionError(err.message, url);
      await appendMessage(activeConversationId, { role: 'error', content: err.message });
    } else {
      addErrorMessage(err.message || 'Failed to reach background service.');
      await appendMessage(activeConversationId, { role: 'error', content: err.message });
    }
  } finally {
    // Safety net: if the placeholder never got replaced by a real thinking
    // card (error path, or model produced no reasoning), remove it so it
    // doesn't linger above the answer / error message.
    if (placeholder && placeholder.isConnected) {
      placeholder.remove();
    }
    setLoading(false);
  }
}

async function authorizeLlmHost(url, btn) {
  if (!url) return;
  btn.disabled = true;
  btn.textContent = 'Waiting for Chrome prompt...';
  try {
    const result = await requestHostPermission(url);
    if (result.granted) {
      btn.textContent = 'Authorized ✓ Retrying last message...';
      // Remove the error message and re-send the last user message
      const errorEl = btn.closest('.message');
      if (errorEl) errorEl.remove();
      // Resend
      const lastConv = await getConversation(activeConversationId);
      if (lastConv?.messages?.length) {
        // Pop the last user message back into the input and send
        const lastUser = [...lastConv.messages].reverse().find(m => m.role === 'user');
        if (lastUser) {
          // Remove it from history so we don't duplicate
          // (the onSend will re-append)
          await appendMessage(activeConversationId, { role: 'user', content: lastUser.content });
          // Just re-trigger send with the same text
          inputEl.value = lastUser.content;
          await onSend();
        }
      }
    } else {
      btn.textContent = 'Permission denied. Click to retry.';
      btn.disabled = false;
    }
  } catch (err) {
    btn.textContent = 'Failed: ' + err.message;
    btn.disabled = false;
  }
}

function addHostPermissionError(text, url) {
  const el = document.createElement('div');
  el.className = 'message error host-permission-error';
  const btnHtml = url
    ? `<button class="authorize-btn">Authorize LLM Host</button>`
    : '';
  el.innerHTML = `
    <div class="bubble">
      <div>🔒 ${escapeHtml(text)}</div>
      ${btnHtml}
    </div>
  `;
  messagesEl.appendChild(el);
  scrollToBottom();
  if (url) {
    const btn = el.querySelector('.authorize-btn');
    btn.addEventListener('click', () => authorizeLlmHost(url, btn));
  }
}

// ---------- Rendering ----------

function escapeForHtml(text) {
  return escapeHtml(text);
}

function addUserMessage(text) {
  const el = document.createElement('div');
  el.className = 'message user';
  el.innerHTML = `<div class="bubble">${escapeForHtml(text)}</div>`;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function addAssistantMessage(text) {
  const el = document.createElement('div');
  el.className = 'message assistant';
  el.innerHTML = `<div class="bubble">${renderMarkdown(text)}</div>`;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function addThinkingMessage(text, round) {
  if (!text) return;
  const el = buildThinkingElement(text, round);
  messagesEl.appendChild(el);
  scrollToBottom();
}

function buildThinkingElement(text, round) {
  const el = document.createElement('div');
  el.className = 'message thinking';
  const roundBadge = typeof round === 'number' && round > 0
    ? `<span class="thinking-round">round ${round}</span>`
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

function addThinkingPlaceholder() {
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
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function addToolMessage(name, summary) {
  if (name === 'reasoning') return;
  const el = document.createElement('div');
  el.className = 'message tool';
  el.innerHTML = `
    <div class="tool-card">
      <div class="tool-name">🔧 ${escapeForHtml(name)}</div>
      <div class="tool-summary">${escapeForHtml(summary || '')}</div>
    </div>
  `;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function addSourcesCards(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return;
  const el = document.createElement('div');
  el.className = 'message sources';
  const cards = sources.map((s) => {
    const title = s.title || '';
    const detail = s.detail ? `<span class="source-card-status">${escapeForHtml(s.detail)}</span>` : '';
    const score = typeof s.score === 'number' && s.score > 0
      ? `<span class="source-card-score">${escapeForHtml(String(s.score))}</span>`
      : '';
    const reason = s.reason ? `<div class="source-card-reason">${escapeForHtml(s.reason)}</div>` : '';
    const label = s.key
      ? `<span class="source-card-key">${escapeForHtml(s.key)}</span>`
      : `<span class="source-card-key">${escapeForHtml(s.title || s.url || '')}</span>`;
    const titleHtml = s.key && title
      ? `<span class="source-card-title">${escapeForHtml(title)}</span>`
      : '';
    const href = s.url || '#';
    return `
      <a class="source-card" href="${escapeForHtml(href)}" target="_blank" rel="noopener noreferrer">
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
  messagesEl.appendChild(el);
  scrollToBottom();
}

function addErrorMessage(text) {
  const el = document.createElement('div');
  el.className = 'message error';
  el.innerHTML = `<div class="bubble">⚠️ ${escapeForHtml(text)}</div>`;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function summarizeTool(name, args, result) {
  const argStr = args && Object.keys(args).length ? JSON.stringify(args) : '';
  if (result?.error) return `${argStr} → error: ${result.error}`;
  if (name === 'get_issue' && result?.key) return `${result.key}: ${result.summary}`;
  if (name === 'search_jira' && result?.issues) return `${argStr} → ${result.issues.length} issues`;
  if (name === 'search_confluence' && result?.pages) return `${argStr} → ${result.pages.length} pages`;
  if (name === 'search_slack' && result?.messages) return `${argStr} → ${result.messages.length} messages`;
  if (name === 'search_drive' && result?.files) return `${argStr} → ${result.files.length} files`;
  if (name === 'find_similar_issues' && result?.issues) return `${argStr} → ${result.issues.length} similar issues`;
  if (name === 'read_url') return `${result?.url || argStr} → ${result?.title || 'loaded'}`;
  if (name === 'set_context') return `→ ${result.display || 'updated'}`;
  return argStr ? `${argStr} → done` : 'done';
}

function setLoading(loading, text) {
  isLoading = loading;
  sendBtn.disabled = loading;
  if (loading) {
    loadingText.textContent = text || 'Thinking...';
    loadingEl.className = '';
  } else {
    loadingEl.className = 'loading-hidden';
  }
}

function scrollToBottom() {
  const main = document.querySelector('.chat-main');
  main.scrollTop = main.scrollHeight;
}

// ---------- Event listeners ----------

sendBtn.addEventListener('click', onSend);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSend();
  }
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
});

document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    if (isLoading) return;
    inputEl.value = chip.dataset.prompt;
    inputEl.dispatchEvent(new Event('input'));
    inputEl.focus();
  });
});

newChatBtn.addEventListener('click', startNewConversation);

clearHistoryBtn.addEventListener('click', async () => {
  if (!confirm('Delete ALL conversations? This cannot be undone.')) return;
  await clearBackendConversations();
  await clearAllConversations();
  activeConversationId = null;
  messagesEl.innerHTML = '';
  currentTitle.textContent = 'New conversation';
  await contextState.clear();
  refreshContextDisplay();
  renderHistory();
});

// ---------- Init ----------

async function init() {
  await refreshContextDisplay();
  await renderHistory();

  // Restore last active conversation if any
  const activeId = await getActiveConversationId();
  if (activeId) {
    await switchConversation(activeId);
  } else {
    addAssistantMessage(
      'Hi! I can read Jira tickets, search Confluence, Slack, and Google Drive.\n\n' +
      'Try pasting a Jira issue key like `PROJ-123`, a Confluence URL, or any web link directly in your message.'
    );
  }

  inputEl.dispatchEvent(new Event('input'));
}

init();
