/**
 * Recursively extract plain text from Atlassian Document Format (ADF).
 * @param {object} node
 * @returns {string}
 */
export function extractTextFromADF(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) {
    return node.content.map(extractTextFromADF).join('');
  }
  return '';
}

/**
 * Extract plain text from a Jira description field (ADF or string).
 * @param {object|string} description
 * @returns {string}
 */
export function extractDescriptionText(description) {
  if (!description) return '';
  if (typeof description === 'string') return description;
  return extractTextFromADF(description);
}

/**
 * Extract plain text from a Jira comment body.
 * @param {object} comment
 * @returns {string}
 */
export function extractCommentText(comment) {
  if (!comment || !comment.body) return '';
  return extractTextFromADF(comment.body);
}

/**
 * Strip HTML tags from a string.
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Rough token estimation: ~4 characters per token for English/Chinese mixed text.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text to a target token count.
 * @param {string} text
 * @param {number} maxTokens
 * @returns {string}
 */
export function truncateToTokens(text, maxTokens) {
  if (!text) return '';
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars - 3) + '...';
}

/**
 * Escape HTML special characters.
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Format a Jira issue into a compact text summary.
 * @param {object} issue
 * @returns {string}
 */
export function formatIssue(issue) {
  const fields = issue.fields || {};
  const status = fields.status?.name || 'Unknown';
  const type = fields.issuetype?.name || 'Unknown';
  const priority = fields.priority?.name || 'Unknown';
  return `[${issue.key}] ${fields.summary} (${type}, ${status}, ${priority})`;
}

/**
 * Format a Jira comment for prompt inclusion.
 * @param {object} comment
 * @returns {string}
 */
export function formatComment(comment) {
  const author = comment.author?.displayName || 'Unknown';
  const date = comment.created ? new Date(comment.created).toISOString().split('T')[0] : '';
  const body = extractCommentText(comment);
  return `${author} (${date}): ${body}`;
}

/**
 * Build JQL-safe quoted string.
 * @param {string} value
 * @returns {string}
 */
export function quoteJql(value) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Build a JQL `text ~` clause for a search term, choosing the right shape
 * based on whether the term is a single word or a multi-word phrase.
 *
 *   - Single word ("STA"):      `text ~ "STA*"`    (prefix wildcard — matches
 *                              "STA", "STA-123", "STA_report", etc.)
 *   - Multi-word ("setup violation"): `text ~ "\"setup violation\""`  (exact
 *                              phrase match — without this, Jira would treat
 *                              the words as an AND/OR clause and miss the
 *                              compound meaning)
 *
 * Backslashes and double quotes are escaped per JQL rules.
 *
 * @param {string} term
 * @returns {string}
 */
export function buildJqlTextClause(term) {
  const s = String(term || '');
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  if (/\s/.test(s)) {
    // Multi-word: phrase match. Inner escaped quotes signal phrase to Jira.
    return `text ~ "\\"${escaped}\\""`;
  }
  return `text ~ "${escaped}*"`;
}

/**
 * Build a CQL text-match clause that searches BOTH title and body.
 *
 * Confluence's CQL exposes `title ~` and `text ~` as separate fields.
 * Searching both gives higher recall than `text ~` alone, and title matches
 * are inherently more precise (a page titled "TRNG Physical Implementation"
 * is a stronger hit than one that mentions TRNG in passing).
 *
 * Single-word terms get a prefix wildcard (`title ~ "auth*"` matches
 * "authentication", "authorize"). Multi-word terms get an exact phrase match.
 *
 * @param {string} term
 * @returns {string} — `(title ~ "..." OR text ~ "...")`
 */
export function buildCqlTextClause(term) {
  const s = String(term || '');
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  if (/\s/.test(s)) {
    const phrase = `"\\"${escaped}\\""`;
    return `(title ~ ${phrase} OR text ~ ${phrase})`;
  }
  return `(title ~ "${escaped}*" OR text ~ "${escaped}*")`;
}

/**
 * Validate that a URL string is safe to use as an HTML href.
 * Only http: and https: protocols are allowed.
 * @param {string} url
 * @returns {string|null} the normalized URL, or null if unsafe
 */
export function safeLinkUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Extract main text content from raw HTML.
 * Strips scripts, styles, and non-content elements, then collapses whitespace.
 * Used by the service worker (no DOM access).
 * @param {string} html
 * @returns {{ title: string, text: string }}
 */
export function extractTextFromHtml(html) {
  if (!html) return { title: '', text: '' };

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';

  // Remove non-content sections
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // Try to isolate <main>, <article>, or <body>
  const mainMatch = cleaned.match(/<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
  if (mainMatch) cleaned = mainMatch[1];
  else {
    const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) cleaned = bodyMatch[1];
  }

  // Convert block-level tags to newlines, then strip remaining tags
  cleaned = cleaned
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text: cleaned };
}

/**
 * Decode common HTML entities.
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Jira issue key pattern: PROJECT-NUMBER, e.g. PROJ-123, S5CSD-18939.
 * Project key must start with an uppercase letter, followed by uppercase
 * letters/digits/underscores. Allows single-char project keys (e.g. S-1).
 */
export const ISSUE_KEY_PATTERN = /\b([A-Z][A-Z0-9_]*-\d+)\b/g;

/**
 * Find all Jira issue keys in a string.
 * @param {string} text
 * @returns {string[]}
 */
export function findIssueKeys(text) {
  if (!text) return [];
  const matches = text.match(ISSUE_KEY_PATTERN);
  return matches || [];
}

/**
 * Find the last Jira issue key in a string.
 * Issue keys typically appear at the end of Jira URL paths, so "last" is
 * usually the "current" issue.
 * @param {string} text
 * @returns {string|null}
 */
export function findLastIssueKey(text) {
  const keys = findIssueKeys(text);
  return keys.length > 0 ? keys[keys.length - 1] : null;
}

/**
 * Detect Jira issue key in a string (returns first match or null).
 * @param {string} text
 * @returns {string|null}
 */
export function detectIssueKey(text) {
  if (!text) return null;
  const match = text.match(ISSUE_KEY_PATTERN);
  return match ? match[0] : null;
}

/**
 * Parse a URL to detect Atlassian resources.
 *
 * Handles the major Jira URL families:
 *   - /browse/PROJ-123                              (classic issue view)
 *   - /issues/PROJ-123                              (legacy)
 *   - /jira/software/projects/PROJ/issues/PROJ-123  (Jira Software)
 *   - /jira/servicedesk/projects/.../queues/.../S5CSD-18939  (Service Desk)
 *   - /jira/core/projects/.../issues/PROJ-123       (Jira Core/Work)
 *   - /projects/PROJ/issues/PROJ-123                (legacy project view)
 *   - ?selectedIssue=PROJ-123                       (board/backlog views)
 *
 * And Confluence:
 *   - /wiki/spaces/SPACE/pages/123456/Title
 *   - /wiki/spaces/SPACE/blog/2024/01/01/123456/Title
 *   - ?pageId=123456
 *
 * @param {string} url
 * @returns {{ type: 'jira-issue'|'confluence-page'|'jira-site'|'confluence-site'|'unknown', issueKey?: string, pageId?: string, site?: string }}
 */
export function parseAtlassianUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    if (!host.endsWith('atlassian.net') && !host.endsWith('jira.com') && !host.endsWith('atlassian.com')) {
      return { type: 'unknown' };
    }

    const path = u.pathname;
    const isConfluenceHost = host.startsWith('confluence.') || host.includes('.confluence.');
    const isConfluencePath = path.startsWith('/wiki') || path.includes('/confluence');

    // --- Confluence page ---
    // Match /wiki/.../pages/123456 or /wiki/.../blog/YYYY/MM/DD/123456
    const confPageMatch = path.match(/\/wiki\/(?:[^/]+\/)*(?:pages|blog)\/(?:\d+\/)*(\d+)/);
    if (confPageMatch) {
      return { type: 'confluence-page', pageId: confPageMatch[1], site: host };
    }

    // Confluence page via query param: ?pageId=123456 or ?targetPageId=123456
    const pageIdParam = u.searchParams.get('pageId') || u.searchParams.get('targetPageId');
    if (pageIdParam && /^\d+$/.test(pageIdParam) && (isConfluencePath || isConfluenceHost)) {
      return { type: 'confluence-page', pageId: pageIdParam, site: host };
    }

    if (isConfluencePath || isConfluenceHost) {
      return { type: 'confluence-site', site: host };
    }

    // --- Jira issue ---
    // 1. Query param: selectedIssue=PROJ-123 (board/backlog views)
    const selected = u.searchParams.get('selectedIssue');
    if (selected && /^[A-Z][A-Z0-9_]*-\d+$/.test(selected)) {
      return { type: 'jira-issue', issueKey: selected, site: host };
    }

    // 2. Any other query param whose value looks like an issue key
    //    (covers ?searchString=PROJ-123, ?issueKey=PROJ-123, etc.)
    for (const value of u.searchParams.values()) {
      if (/^[A-Z][A-Z0-9_]*-\d+$/.test(value)) {
        return { type: 'jira-issue', issueKey: value, site: host };
      }
    }

    // 3. Path-based: take the last issue-key-looking segment.
    //    Covers /browse/PROJ-123, /issues/PROJ-123, /jira/.../issues/PROJ-123,
    //    /jira/servicedesk/.../queues/custom/249/S5CSD-18939, etc.
    const lastIssueKey = findLastIssueKey(path);
    if (lastIssueKey) {
      return { type: 'jira-issue', issueKey: lastIssueKey, site: host };
    }

    return { type: 'jira-site', site: host };
  } catch {
    return { type: 'unknown' };
  }
}
