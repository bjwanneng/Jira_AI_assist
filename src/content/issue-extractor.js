import { findLastIssueKey } from '../shared/utils.js';

export class IssueExtractor {
  static extract() {
    // 1. DOM attribute (Jira sets [data-issue-key] on issue pages)
    const attrEl = document.querySelector('[data-issue-key]');
    if (attrEl) return attrEl.dataset.issueKey;

    // 2. Query parameter selectedIssue (board/backlog views)
    const params = new URLSearchParams(location.search);
    const selected = params.get('selectedIssue');
    if (selected && /^[A-Z][A-Z0-9_]*-\d+$/.test(selected)) return selected;

    // 3. Any other query param whose value looks like an issue key
    for (const value of params.values()) {
      if (/^[A-Z][A-Z0-9_]*-\d+$/.test(value)) return value;
    }

    // 4. General path scan — covers all Jira URL families:
    //    /browse/PROJ-123
    //    /issues/PROJ-123
    //    /jira/software/projects/PROJ/issues/PROJ-123
    //    /jira/servicedesk/projects/.../queues/custom/249/S5CSD-18939
    //    /jira/core/projects/.../issues/PROJ-123
    //    /projects/PROJ/issues/PROJ-123
    //    Takes the last match — issue keys usually appear at the path end.
    const pathKey = findLastIssueKey(location.pathname);
    if (pathKey) return pathKey;

    // 5. Fallback: search any issue-key-like text in the page title
    const titleMatch = document.title.match(/\b([A-Z][A-Z0-9_]*-\d+)\b/);
    if (titleMatch) return titleMatch[1];

    return null;
  }

  /**
   * Extract IP / product-line hints from Jira issue fields.
   * Works with the simplified fields object used by the background script.
   *
   * @param {{summary?: string, description?: string, components?: Array<{name: string}>, labels?: string[]}} fields
   * @returns {{coreName: string|null, productLine: string|null, keywords: string[]}}
   */
  static extractIpHints(fields = {}) {
    const summary = fields.summary || '';
    const description = this.extractDescriptionText(fields.description);
    const components = (fields.components || []).map(c => c.name || c);
    const labels = fields.labels || [];
    const fullText = `${summary} ${description} ${components.join(' ')} ${labels.join(' ')}`;

    // 1. Product line: prefer "Core IP - XM Series" style components.
    let productLine = null;
    for (const comp of components) {
      const match = comp.match(/Core\s+IP\s+-\s+([A-Z]\w+)\s+Series/i);
      if (match) {
        productLine = match[1].toUpperCase();
        break;
      }
      const loose = comp.match(/\b([A-Z]\w+)\s+Series\b/);
      if (loose) {
        productLine = loose[1].toUpperCase();
        break;
      }
    }

    // 2. Core name: look for "X IP" or standalone capitalized proper nouns.
    let coreName = null;
    const ipMatch = fullText.match(/\b([A-Z][a-zA-Z0-9]+)\s+IP\b/);
    if (ipMatch) {
      coreName = ipMatch[1];
    }

    // 3. If no explicit "X IP", try known SiFive-style core names.
    if (!coreName) {
      const knownCores = /\b(Moray|U74|E76|S5|S7|P550|P450|X280|RV64|RV32)\b/;
      const m = fullText.match(knownCores);
      if (m) coreName = m[1];
    }

    // 4. Collect additional technical keywords (capitalized nouns, 3+ chars).
    const keywordSet = new Set();
    const tokenRegex = /\b[A-Z][a-zA-Z0-9]{2,}\b/g;
    let m;
    while ((m = tokenRegex.exec(fullText)) !== null) {
      const word = m[0];
      if (['The', 'This', 'That', 'Please', 'Thank', 'Best', 'Hi', 'Hello'].includes(word)) continue;
      if (word.length >= 3) keywordSet.add(word);
    }
    const keywords = Array.from(keywordSet).slice(0, 10);

    return {
      coreName,
      productLine,
      keywords
    };
  }

  static extractDescriptionText(description) {
    if (!description) return '';
    if (typeof description === 'string') return description;
    if (Array.isArray(description?.content)) {
      // Use the class name (not `this`) so the callback works inside .map()
      // where `this` would otherwise be lost.
      return description.content.map(IssueExtractor.extractDescriptionText).join('');
    }
    if (description.type === 'text') return description.text || '';
    return '';
  }
}
