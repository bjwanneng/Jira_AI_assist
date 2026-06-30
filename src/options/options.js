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
      if (key === STORAGE_KEYS.LLM_MAX_TOKENS || key === STORAGE_KEYS.LLM_TEMPERATURE) {
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

loadSettings();

// Show the actual extension ID in the Google Drive setup instructions.
const extIdEl = document.getElementById('extension-id');
if (extIdEl && chrome.runtime?.id) {
  extIdEl.textContent = chrome.runtime.id;
}
