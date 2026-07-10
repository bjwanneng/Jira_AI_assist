import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../shared/constants.js';
import { MESSAGE_TYPES } from '../shared/message-types.js';
import { requestHostPermission, hasHostPermission } from '../shared/permissions.js';

const form = document.getElementById('settings-form');
const saveStatus = document.getElementById('save-status');
const jiraStatus = document.getElementById('jira-status');
const llmStatus = document.getElementById('llm-status');
const slackStatus = document.getElementById('slack-status');
const driveStatus = document.getElementById('drive-status');

const allKeys = Object.values(STORAGE_KEYS);

async function loadSettings() {
  const stored = await chrome.storage.local.get(allKeys);
  const settings = { ...DEFAULT_SETTINGS, ...stored };

  for (const key of allKeys) {
    const input = form.elements[key];
    if (input && settings[key] !== undefined) {
      input.value = settings[key];
    }
  }
}

function showStatus(element, message, isError = false) {
  element.textContent = message;
  element.className = 'status ' + (isError ? 'error' : 'success');
  setTimeout(() => {
    element.textContent = '';
    element.className = 'status';
  }, 8000);
}

function collectFormValues() {
  const formData = new FormData(form);
  const settings = {};

  for (const key of allKeys) {
    const value = formData.get(key);
    if (value !== null && value !== '') {
      if (key === STORAGE_KEYS.LLM_MAX_TOKENS || key === STORAGE_KEYS.LLM_TEMPERATURE ||
          key === STORAGE_KEYS.BUILD_MAX_ISSUES || key === STORAGE_KEYS.BUILD_LOOKBACK_DAYS) {
        settings[key] = Number(value);
      } else {
        settings[key] = value.trim();
      }
    } else {
      // Explicitly clear empty values so re-saving works
      settings[key] = '';
    }
  }

  if (!settings[STORAGE_KEYS.CONFLUENCE_API_TOKEN] && settings[STORAGE_KEYS.JIRA_API_TOKEN]) {
    settings[STORAGE_KEYS.CONFLUENCE_API_TOKEN] = settings[STORAGE_KEYS.JIRA_API_TOKEN];
  }
  if (!settings[STORAGE_KEYS.CONFLUENCE_BASE_URL] && settings[STORAGE_KEYS.JIRA_BASE_URL]) {
    settings[STORAGE_KEYS.CONFLUENCE_BASE_URL] = settings[STORAGE_KEYS.JIRA_BASE_URL];
  }

  return settings;
}

async function saveSettings() {
  const settings = collectFormValues();
  await chrome.storage.local.set(settings);
  return settings;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = await saveSettings();
  // Request host permission for the LLM endpoint if it's a custom domain
  if (settings[STORAGE_KEYS.LLM_BASE_URL]) {
    const origin = await ensureLlmHostPermission(settings[STORAGE_KEYS.LLM_BASE_URL]);
    if (origin === false) {
      showStatus(saveStatus, 'Settings saved, but host permission for the LLM endpoint was denied. Click "Test LLM Connection" to retry.', true);
      return;
    }
  }
  showStatus(saveStatus, 'Settings saved.');
});

/**
 * Request host permission for the LLM endpoint. Returns true if granted
 * (or already present), false if denied, null if no request was needed.
 */
async function ensureLlmHostPermission(llmBaseUrl) {
  const already = await hasHostPermission(llmBaseUrl);
  if (already) return null;
  const result = await requestHostPermission(llmBaseUrl);
  return result.granted;
}

document.getElementById('test-jira').addEventListener('click', async () => {
  jiraStatus.textContent = 'Saving and testing...';
  try {
    await saveSettings();
    const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.TEST_JIRA_CONNECTION });
    if (response && response.success) {
      showStatus(jiraStatus, `Connected: ${response.displayName || 'OK'}`);
    } else {
      showStatus(jiraStatus, response?.error || 'Connection failed', true);
    }
  } catch (err) {
    showStatus(jiraStatus, err.message || 'Connection failed', true);
  }
});

document.getElementById('test-llm').addEventListener('click', async () => {
  llmStatus.textContent = 'Saving and testing...';
  try {
    const settings = await saveSettings();
    // Ensure host permission before testing
    const granted = await ensureLlmHostPermission(settings[STORAGE_KEYS.LLM_BASE_URL]);
    if (granted === false) {
      showStatus(llmStatus, 'Host permission denied. The extension cannot reach the LLM endpoint without it. Click "Test" again and approve the permission prompt.', true);
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.TEST_LLM_CONNECTION });
    if (response && response.success) {
      showStatus(llmStatus, `Model ready: ${response.model || 'OK'}`);
    } else {
      const err = response?.error || 'Connection failed';
      if (/host permission/i.test(err)) {
        showStatus(llmStatus, `${err} Click "Test" again and approve the permission prompt.`, true);
      } else {
        showStatus(llmStatus, err, true);
      }
    }
  } catch (err) {
    showStatus(llmStatus, err.message || 'Connection failed', true);
  }
});

document.getElementById('test-slack').addEventListener('click', async () => {
  slackStatus.textContent = 'Saving and testing...';
  try {
    await saveSettings();
    const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.TEST_SLACK_CONNECTION });
    if (response && response.success) {
      showStatus(slackStatus, `Connected as ${response.user || response.team || 'OK'}`);
    } else {
      showStatus(slackStatus, response?.error || 'Connection failed', true);
    }
  } catch (err) {
    showStatus(slackStatus, err.message || 'Connection failed', true);
  }
});

document.getElementById('connect-drive').addEventListener('click', async () => {
  driveStatus.textContent = 'Opening Google consent...';
  try {
    const token = await new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive: true }, (t) => {
        if (chrome.runtime.lastError || !t) {
          resolve(null);
        } else {
          resolve(t);
        }
      });
    });
    if (!token) {
      showStatus(driveStatus, 'Google Drive authorization was cancelled or failed.', true);
      return;
    }
    await chrome.storage.local.set({ driveToken: token });

    // Validate the token
    const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      showStatus(driveStatus, `Token invalid: ${res.status}`, true);
      return;
    }
    const data = await res.json();
    const email = data.user?.emailAddress || 'OK';
    showStatus(driveStatus, `Connected: ${email}`);
  } catch (err) {
    showStatus(driveStatus, err.message || 'Failed to connect', true);
  }
});

// --- Vector Search (Embedding) section ---
const embedStatus = document.getElementById('embed-status');
const indexStatus = document.getElementById('index-status');
const indexProgress = document.getElementById('index-progress');

/**
 * Resolve the effective embedding base URL (falls back to the chat LLM's
 * base URL when the embedding section is left blank).
 */
function effectiveEmbedBaseUrl(settings) {
  return settings[STORAGE_KEYS.EMBEDDING_BASE_URL] || settings[STORAGE_KEYS.LLM_BASE_URL] || '';
}

async function ensureEmbedHostPermission(settings) {
  const url = effectiveEmbedBaseUrl(settings);
  if (!url) return null;
  const already = await hasHostPermission(url);
  if (already) return null;
  const result = await requestHostPermission(url);
  return result.granted;
}

document.getElementById('authorize-embed').addEventListener('click', async () => {
  const settings = await saveSettings();
  const url = effectiveEmbedBaseUrl(settings);
  if (!url) {
    showStatus(embedStatus, 'No embedding base URL set (and no LLM base URL to fall back to).', true);
    return;
  }
  const granted = await ensureEmbedHostPermission(settings);
  if (granted === false) {
    showStatus(embedStatus, 'Host permission denied. The extension cannot reach the embedding endpoint without it.', true);
  } else {
    showStatus(embedStatus, 'Host authorized.');
  }
});

document.getElementById('test-embed').addEventListener('click', async () => {
  embedStatus.textContent = 'Saving and testing...';
  try {
    const settings = await saveSettings();
    const granted = await ensureEmbedHostPermission(settings);
    if (granted === false) {
      showStatus(embedStatus, 'Host permission denied. Click "Authorize Embedding Host" and approve the prompt.', true);
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.TEST_EMBEDDING_CONNECTION });
    if (response && response.success) {
      showStatus(embedStatus, `Embedding ready: ${response.model || 'OK'}${response.dims ? ` (${response.dims} dim)` : ''}`);
    } else {
      const err = response?.error || 'Connection failed';
      if (/host permission/i.test(err)) {
        showStatus(embedStatus, `${err} Click "Authorize Embedding Host" and approve the prompt.`, true);
      } else {
        showStatus(embedStatus, err, true);
      }
    }
  } catch (err) {
    showStatus(embedStatus, err.message || 'Connection failed', true);
  }
});

document.getElementById('count-scope').addEventListener('click', async () => {
  indexStatus.textContent = 'Counting matching tickets...';
  indexProgress.style.display = 'none';
  try {
    // Persist the current scope inputs first so the background count uses the
    // exact filters the user sees on screen.
    await saveSettings();
    const exact = document.getElementById('count-exact')?.checked;
    const response = await chrome.runtime.sendMessage(
      { type: MESSAGE_TYPES.COUNT_INDEX_SCOPE, exact }
    );
    if (response && response.success) {
      const d = response.data || {};
      const n = d.capped ? `${d.count}+` : `${d.count}`;
      const approx = d.approximate ? '≈ (approximate — verify in Jira search)' : '(exact)';
      const already = typeof d.indexed === 'number' ? ` · already indexed: ${d.indexed}` : '';
      const jqlLine = d.jql ? `\nJQL: ${d.jql}` : '';
      showStatus(indexStatus, `In scope: ${n} ticket(s) ${approx}${already}.${jqlLine}`);
    } else {
      showStatus(indexStatus, response?.error || 'Count failed', true);
    }
  } catch (err) {
    showStatus(indexStatus, err.message || 'Count failed', true);
  }
});

document.getElementById('build-index').addEventListener('click', async () => {
  indexStatus.textContent = 'Building index...';
  indexProgress.style.display = 'block';
  indexProgress.value = 0;
  try {
    const settings = await saveSettings();
    const granted = await ensureEmbedHostPermission(settings);
    if (granted === false) {
      showStatus(indexStatus, 'Host permission denied for the embedding endpoint.', true);
      indexProgress.style.display = 'none';
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BUILD_EMBEDDING_INDEX });
    if (response && response.success) {
      const d = response.data || {};
      indexProgress.value = 100;
      showStatus(indexStatus, `Index built: ${d.indexed} tickets embedded${d.skipped ? `, ${d.skipped} skipped` : ''}.`);
    } else {
      showStatus(indexStatus, response?.error || 'Build failed', true);
      indexProgress.style.display = 'none';
    }
  } catch (err) {
    showStatus(indexStatus, err.message || 'Build failed', true);
    indexProgress.style.display = 'none';
  }
});

document.getElementById('sync-index').addEventListener('click', async () => {
  indexStatus.textContent = 'Syncing new tickets...';
  indexProgress.style.display = 'block';
  indexProgress.value = 0;
  try {
    const settings = await saveSettings();
    const granted = await ensureEmbedHostPermission(settings);
    if (granted === false) {
      showStatus(indexStatus, 'Host permission denied for the embedding endpoint.', true);
      indexProgress.style.display = 'none';
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SYNC_EMBEDDING_INDEX });
    if (response && response.success) {
      const d = response.data || {};
      indexProgress.value = 100;
      showStatus(indexStatus, `Sync done: ${d.synced} new ticket(s) embedded${d.skipped ? `, ${d.skipped} skipped` : ''}.`);
    } else {
      showStatus(indexStatus, response?.error || 'Sync failed', true);
      indexProgress.style.display = 'none';
    }
  } catch (err) {
    showStatus(indexStatus, err.message || 'Sync failed', true);
    indexProgress.style.display = 'none';
  }
});

document.getElementById('clear-index').addEventListener('click', async () => {
  indexStatus.textContent = 'Clearing index...';
  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.CLEAR_EMBEDDING_INDEX });
    if (response && response.success) {
      showStatus(indexStatus, `Index cleared (${response.count ?? 0} tickets removed).`);
    } else {
      showStatus(indexStatus, response?.error || 'Clear failed', true);
    }
  } catch (err) {
    showStatus(indexStatus, err.message || 'Clear failed', true);
  }
});

// Live progress from the background index build/sync (runs in the service
// worker and reports incrementally so the UI doesn't look frozen).
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MESSAGE_TYPES.EMBEDDING_INDEX_PROGRESS) {
    const p = message.payload || {};
    if (p.phase && p.phase.startsWith('sync')) {
      indexStatus.textContent = `Syncing... embedded ${p.synced || 0}, skipped ${p.skipped || 0}`;
      if (p.phase === 'sync-done') indexProgress.value = 100;
    } else if (typeof p.seen === 'number' && typeof p.indexed === 'number') {
      indexStatus.textContent = `Building... seen ${p.seen}, embedded ${p.indexed}`;
      if (p.seen > 0) {
        indexProgress.value = Math.min(100, Math.round((p.indexed / p.seen) * 100));
      }
    }
  }
});

loadSettings();

// Show the actual extension ID in the Google Drive setup instructions.
const extIdEl = document.getElementById('extension-id');
if (extIdEl && chrome.runtime?.id) {
  extIdEl.textContent = chrome.runtime.id;
}
