import { MESSAGE_TYPES } from '../shared/message-types.js';
import { escapeHtml, normalizeErrMsg } from '../shared/utils.js';
import { renderMarkdown } from '../shared/markdown.js';
import {
  requestHostPermission,
  extractUrlFromPermissionError
} from '../shared/permissions.js';

const generateBtn = document.getElementById('weekly-generate');
const copyBtn = document.getElementById('weekly-copy');
const output = document.getElementById('weekly-output');
const permissionBar = document.getElementById('weekly-permission');
const permissionText = permissionBar.querySelector('.weekly-permission-text');
const authorizeBtn = document.getElementById('weekly-authorize');

// The LLM host URL extracted from the most recent "Host permission missing"
// warning, so the Authorize button knows which origin to request.
let pendingHostUrl = null;

generateBtn.addEventListener('click', () => runGenerate());

authorizeBtn.addEventListener('click', async () => {
  if (!pendingHostUrl) return;
  authorizeBtn.disabled = true;
  try {
    const result = await requestHostPermission(pendingHostUrl);
    if (result.granted) {
      hidePermissionBar();
      await runGenerate();
    } else {
      permissionText.textContent =
        'Permission denied. Click "Authorize LLM Host" again to retry, or open Settings to verify the LLM base URL.';
    }
  } finally {
    authorizeBtn.disabled = false;
  }
});

copyBtn.addEventListener('click', async () => {
  const md = output.dataset.markdown;
  if (!md) return;
  try {
    await navigator.clipboard.writeText(md);
    const prev = copyBtn.textContent;
    copyBtn.textContent = 'Copied ✓';
    setTimeout(() => { copyBtn.textContent = prev; }, 1500);
  } catch {
    copyBtn.textContent = 'Copy failed';
    setTimeout(() => { copyBtn.textContent = 'Copy as Markdown'; }, 1500);
  }
});

async function runGenerate() {
  generateBtn.disabled = true;
  copyBtn.disabled = true;
  hidePermissionBar();
  output.innerHTML =
    '<div class="weekly-empty">Loading open tickets and summarizing...</div>';

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.WEEKLY_SUMMARY,
      payload: {}
    });
  } catch (err) {
    const msg = normalizeErrMsg(err?.message ?? err, 'Failed to reach background service.');
    output.innerHTML = `<div class="weekly-error">⚠️ ${escapeHtml(msg)}</div>`;
    generateBtn.disabled = false;
    return;
  }

  if (!response?.success) {
    const msg = normalizeErrMsg(response?.error?.message || response?.error, 'Failed to generate weekly summary.');
    output.innerHTML = `<div class="weekly-error">⚠️ ${escapeHtml(msg)}</div>`;
    maybeShowPermissionBar(msg);
    generateBtn.disabled = false;
    return;
  }

  renderReport(response.data);
  generateBtn.disabled = false;
}

function renderReport(data) {
  if (!data) {
    output.innerHTML = '<p class="weekly-empty">No data returned.</p>';
    return;
  }
  const warningsHtml = (data.warnings && data.warnings.length)
    ? `<div class="weekly-warnings">${data.warnings.map(w => `<div>⚠ ${escapeHtml(w)}</div>`).join('')}</div>`
    : '';
  output.dataset.markdown = data.markdown || '';
  output.innerHTML = warningsHtml + '<div class="weekly-markdown">' + renderMarkdown(data.markdown || '') + '</div>';

  // Surface an Authorize button if any warning indicates missing host permission.
  for (const w of data.warnings || []) {
    if (maybeShowPermissionBar(w)) break;
  }

  copyBtn.disabled = !data.markdown;
}

function maybeShowPermissionBar(warningText) {
  const url = extractUrlFromPermissionError(warningText);
  if (!url) return false;
  pendingHostUrl = url;
  permissionText.textContent =
    `Host permission missing for ${url}. Chrome needs you to authorize this host once. ` +
    `Click "Authorize LLM Host" — a Chrome prompt will appear, click "Allow".`;
  permissionBar.classList.remove('hidden');
  return true;
}

function hidePermissionBar() {
  permissionBar.classList.add('hidden');
  pendingHostUrl = null;
}
