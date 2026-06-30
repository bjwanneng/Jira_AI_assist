// Host permission helpers for runtime-configured LLM endpoints.
//
// MV3 service workers cannot fetch cross-origin URLs unless the host is in
// host_permissions OR granted via optional_host_permissions at runtime.
// Since users may use any LLM provider (Volcengine ARK, DeepSeek, Qwen,
// OpenAI, local Ollama, etc.), we declare optional_host_permissions for
// all http(s) hosts and request permission for the specific LLM host when
// the user saves their settings.

/**
 * Extract the host permission origin from a base URL.
 * Returns a pattern like "https://ark.cn-beijing.volces.com/" or null.
 * @param {string} baseUrl
 * @returns {string|null}
 */
export function hostPermissionOrigin(baseUrl) {
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl.trim().replace(/\/$/, ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}/`;
  } catch {
    return null;
  }
}

/**
 * Check whether the extension currently has host permission for the given URL.
 * Works in both service worker and extension page contexts.
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
export async function hasHostPermission(baseUrl) {
  const origin = hostPermissionOrigin(baseUrl);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/**
 * Request host permission for an LLM endpoint. Must be called from a user
 * gesture (e.g. a click handler in an extension page like options or chat).
 * Service workers cannot call this — Chrome requires a user gesture.
 * @param {string} baseUrl
 * @returns {Promise<{granted: boolean, origin: string|null, error?: string}>}
 */
export async function requestHostPermission(baseUrl) {
  const origin = hostPermissionOrigin(baseUrl);
  if (!origin) {
    return { granted: false, origin: null, error: 'Invalid URL' };
  }
  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    return { granted, origin };
  } catch (err) {
    return { granted: false, origin, error: err.message };
  }
}

/**
 * Remove host permission for an endpoint that's no longer in use.
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
export async function removeHostPermission(baseUrl) {
  const origin = hostPermissionOrigin(baseUrl);
  if (!origin) return false;
  try {
    return await chrome.permissions.remove({ origins: [origin] });
  } catch {
    return false;
  }
}

/**
 * Detect whether an error message indicates a missing host permission.
 * Used by the chat UI to show an "Authorize now" button.
 * @param {string} errorMsg
 * @returns {boolean}
 */
export function isHostPermissionError(errorMsg) {
  if (!errorMsg) return false;
  return /Host permission missing/i.test(errorMsg);
}

/**
 * Extract the base URL from a "Host permission missing for X" error message.
 * Returns null if the message doesn't match.
 * @param {string} errorMsg
 * @returns {string|null}
 */
export function extractUrlFromPermissionError(errorMsg) {
  if (!errorMsg) return null;
  const m = String(errorMsg).match(/Host permission missing for (\S+)/);
  return m ? m[1] : null;
}
