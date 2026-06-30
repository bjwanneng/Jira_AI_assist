import { escapeHtml, safeLinkUrl } from './utils.js';

/**
 * Render a small subset of Markdown to safe HTML.
 * Supports: code blocks, inline code, bold, italic, tables, links,
 * blockquotes, headings, bullet lists and line breaks.
 *
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
  html = renderTables(html);
  html = html.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, linkText, url) => {
    const safe = safeLinkUrl(url);
    return safe ? `<a href="${safe}" target="_blank" rel="noopener">${linkText}</a>` : escapeHtml(linkText);
  });
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, prefix, url) => {
    const safe = safeLinkUrl(url);
    return safe ? `${prefix}<a href="${safe}" target="_blank" rel="noopener">${url}</a>` : `${prefix}${url}`;
  });
  html = html.replace(/(^|\n)&gt;\s?(.*)/g, '$1<blockquote>$2</blockquote>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/\n\n/g, '<br><br>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/<br>(<(?:ul|ol|blockquote|h[1-6]|table|pre))/g, '$1');
  html = html.replace(/(<\/(?:ul|ol|blockquote|h[1-6]|table|pre)>)<br>/g, '$1');
  return html;
}

function renderTables(html) {
  const tableRegex = /(?:^|\n)((?:\|[^\n]+\|)(?:\n\|[-: |]+\|)(?:\n\|[^\n]+\|)+)/g;
  return html.replace(tableRegex, (_, block) => {
    const rows = block.trim().split('\n');
    const parseRow = r => r.split('|').slice(1, -1).map(c => c.trim());
    const header = parseRow(rows[0]);
    const body = rows.slice(2).map(parseRow);
    const thead = `<tr>${header.map(h => `<th>${h}</th>`).join('')}</tr>`;
    const tbody = body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
  });
}
