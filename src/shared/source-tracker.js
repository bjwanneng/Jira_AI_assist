// Source tracker — extracts citable source references from tool call results
// so the chat UI can append a reliable "Sources" section to the final answer.
//
// We don't rely on the LLM to cite sources (it forgets / hallucinates URLs).
// Instead, every tool execution records structured source entries, and the
// orchestrator collects them across the whole conversation turn.

import { escapeHtml } from './utils.js';

/**
 * Extract source entries from a tool result.
 *
 * @param {string} toolName
 * @param {object} args - the tool arguments
 * @param {object} result - the tool result
 * @param {string} [jiraBaseUrl] - for building clickable Jira links
 * @returns {Array<{kind: string, key?: string, title?: string, url?: string, detail?: string}>}
 */
export function extractSources(toolName, args, result, jiraBaseUrl = '') {
  if (!result || result.error) return [];

  const sources = [];
  const site = (jiraBaseUrl || '').replace(/\/$/, '');

  const addIssue = (key, extra = {}) => {
    if (!key) return;
    sources.push({
      kind: 'jira',
      key,
      title: extra.title,
      url: site ? `${site}/browse/${key}` : null,
      detail: extra.detail,
      reason: extra.reason || '',
      score: typeof extra.score === 'number' ? extra.score : null,
      priority: extra.priority || ''
    });
  };
  const addPage = (title, url, excerpt = '') => {
    if (!title && !url) return;
    sources.push({ kind: 'confluence', title, url, detail: excerpt ? excerpt.slice(0, 120) : '' });
  };
  const addSlack = (channel, permalink, text = '') => {
    if (!permalink && !channel) return;
    sources.push({ kind: 'slack', title: `#${channel || 'channel'}`, url: permalink, detail: text ? text.slice(0, 120) : '' });
  };
  const addDrive = (name, url) => {
    if (!name && !url) return;
    sources.push({ kind: 'drive', title: name, url });
  };

  switch (toolName) {
    case 'get_issue':
    case 'read_url':
      // read_url may return a jira-issue kind
      if (result.key) {
        addIssue(result.key, { title: result.summary, detail: result.status });
      } else if (result.kind === 'jira-issue' && args?.url) {
        // derived from URL — extract key from title
        const m = (result.title || '').match(/^([A-Z][A-Z0-9_]*-\d+)/);
        if (m) addIssue(m[1], { title: result.title });
      } else if (result.kind === 'confluence-page') {
        addPage(result.title, args?.url);
      }
      break;

    case 'search_jira':
    case 'find_similar_issues':
      for (const it of (result.issues || []).slice(0, 5)) {
        // Carry through rerank score + reason so the UI can show "why this
        // matches" alongside the standard issue card. Falls through unchanged
        // for non-reranked results (score/reason are absent).
        addIssue(it.key, {
          title: it.summary,
          detail: it.status,
          reason: it.reason || '',
          score: typeof it.score === 'number' ? it.score : null,
          priority: it.priority || ''
        });
      }
      break;

    case 'search_confluence':
      for (const p of (result.pages || []).slice(0, 3)) {
        addPage(p.title, p.url, p.excerpt);
      }
      break;

    case 'search_slack':
      for (const m of (result.messages || []).slice(0, 3)) {
        addSlack(m.channel, m.permalink, m.text);
      }
      break;

    case 'search_drive':
      for (const f of (result.files || []).slice(0, 3)) {
        addDrive(f.name, f.url);
      }
      break;

    case 'read_drive_file':
      addDrive(result.name, result.url);
      break;

    default:
      break;
  }

  return sources;
}

/**
 * Dedupe sources by a stable key (kind + key/title + url).
 * @param {Array} sources
 * @returns {Array}
 */
export function dedupeSources(sources) {
  const seen = new Map();
  for (const s of sources) {
    const k = [s.kind, s.key || '', s.title || '', s.url || ''].join('|');
    if (!seen.has(k)) seen.set(k, s);
  }
  return Array.from(seen.values());
}

/**
 * Build a "## Sources" markdown block from collected sources.
 * Returns empty string if no sources.
 *
 * @param {Array} sources
 * @returns {string}
 */
export function renderSourcesBlock(sources) {
  const deduped = dedupeSources(sources || []);
  if (deduped.length === 0) return '';

  const lines = ['\n\n## Sources'];
  for (const s of deduped) {
    const parts = [];
    if (s.kind === 'jira' && s.key) {
      if (s.url) {
        parts.push(`- **[${s.key}](${s.url})**`);
      } else {
        parts.push(`- **${s.key}**`);
      }
      if (s.title) parts.push(` — ${s.title}`);
      if (s.detail) parts.push(` \`${s.detail}\``);
      if (s.reason) parts.push(`  \n  _${s.reason}_`);
    } else if (s.url) {
      const label = s.title || s.url;
      parts.push(`- [${label}](${s.url})`);
    } else if (s.title) {
      parts.push(`- ${s.title}`);
    } else {
      continue;
    }
    lines.push(parts.join(''));
  }
  return lines.join('\n');
}

/**
 * Escape helper re-exported for convenience (not used internally; kept for
 * callers that render sources as HTML).
 */
export { escapeHtml };
