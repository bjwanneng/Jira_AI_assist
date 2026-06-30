/**
 * Cross-ticket pattern detection.
 *
 * This is the "cluster analysis" step that Rovo Chat performs but our previous
 * `find_similar_issues` / `search_jira` tools did not. Those tools answer
 * "which 5 tickets are most similar to this one?" — a retrieval + ranking task.
 * This module answers "what common patterns / systemic issues appear across
 * these 40 tickets?" — a clustering +归纳 task.
 *
 * Flow:
 *   1. Caller collects 30-40 related tickets (wide recall, no rerank).
 *   2. This module truncates each ticket's description + comments to fit a
 *      single LLM context window, then asks the LLM to group them into
 *      3-7 thematic patterns with: root cause, affected releases, quantitative
 *      evidence, and an actionable recommendation.
 *   3. Returns a structured { patterns: [...] } object.
 *
 * Token budget: 40 tickets × ~300 tokens each (key + summary + status +
 * truncated description + 2-3 truncated comments) ≈ 12k input tokens. Feasible
 * with modern 128k-context models. If the model is smaller, the truncation
 * caps keep each ticket compact.
 *
 * LLM failure → returns { patterns: [], error }. Caller surfaces the error;
 * the user can retry or fall back to find_similar_issues for narrower scope.
 */

import {
  MAX_CLUSTER_PATTERNS,
  CLUSTER_DESCRIPTION_TOKENS,
  CLUSTER_COMMENT_TOKENS,
  CLUSTER_MAX_COMMENTS
} from '../shared/constants.js';
import {
  extractDescriptionText,
  extractCommentText,
  truncateToTokens
} from '../shared/utils.js';
import { parseLlmJson } from '../shared/llm-json.js';

const CLUSTER_SYSTEM_PROMPT = `You are a technical support analyst who identifies systemic patterns across a batch of Jira tickets.

Read ALL tickets below and group them into 3 to ${MAX_CLUSTER_PATTERNS} common patterns. A pattern is a shared root cause, recurring theme, or systemic issue that spans MULTIPLE tickets. Examples of good patterns:
  - "Process node portability issues (N12 implementation gaps)"
  - "SDC constraints shipped with bugs across multiple releases"
  - "DFT collateral delivery gaps (MBIST/Tessent)"
  - "Obfuscated RTL breaks PD methodology"
  - "Documentation contradictions between guides"

For each pattern, extract:
  - name: short descriptive name
  - summary: 1-2 sentence description of the pattern and its impact
  - severity: "high" | "medium" | "low" (based on ticket count + business impact)
  - affectedReleases: array of version strings mentioned in the tickets (e.g. ["v2p1", "v5p0"])
  - tickets: array of { key, detail } — each ticket's specific contribution to the pattern
  - quantitativeEvidence: array of specific numbers/measurements found (e.g. ["clk2q = 450ps out of 500ps", "tile area 8X vs expected 4.6X"])
  - rootCause: the underlying root cause if discernible, or "undetermined"
  - recommendation: one actionable suggestion for the engineering team

If a few tickets don't fit any pattern, group them into a final pattern named "Other Issues".

Return ONLY a JSON object (no prose, no markdown fence):
{
  "patterns": [
    {
      "name": "...",
      "summary": "...",
      "severity": "high",
      "affectedReleases": ["v2p1"],
      "tickets": [{ "key": "PROJ-123", "detail": "what this ticket shows" }],
      "quantitativeEvidence": ["..."],
      "rootCause": "...",
      "recommendation": "..."
    }
  ]
}

Sort patterns by severity (high first), then by ticket count (most first).`;

/**
 * Render a single ticket as a compact text block for the cluster prompt.
 * Truncates description and comments to keep the total input under budget.
 *
 * @param {object} issue - raw Jira issue
 * @returns {string}
 */
function renderTicketBlock(issue) {
  const fields = issue.fields || {};
  const key = issue.key || '?';
  const summary = fields.summary || '(no summary)';
  const status = fields.status?.name || '?';
  const priority = fields.priority?.name || '-';
  const issueType = fields.issuetype?.name || '-';
  const created = fields.created ? fields.created.split('T')[0] : '';
  const updated = fields.updated ? fields.updated.split('T')[0] : '';

  const description = truncateToTokens(
    extractDescriptionText(fields.description),
    CLUSTER_DESCRIPTION_TOKENS
  );

  const comments = (fields.comment?.comments || [])
    .slice(-CLUSTER_MAX_COMMENTS)
    .map(extractCommentText)
    .filter(Boolean)
    .map((c) => truncateToTokens(c, CLUSTER_COMMENT_TOKENS));

  const lines = [
    `### ${key}`,
    `Summary: ${summary}`,
    `Status: ${status} | Type: ${issueType} | Priority: ${priority} | Created: ${created} | Updated: ${updated}`
  ];
  if (fields.labels?.length) lines.push(`Labels: ${fields.labels.join(', ')}`);
  if (fields.components?.length) lines.push(`Components: ${fields.components.map(c => c.name).join(', ')}`);
  if (description) lines.push(`Description: ${description}`);
  if (comments.length > 0) {
    lines.push('Recent comments:');
    for (const c of comments) lines.push(`  - ${c}`);
  }
  return lines.join('\n');
}

/**
 * Sanitize the LLM's parsed pattern output. Tolerates missing fields, wrong
 * types, and non-array shapes. Caps patterns at MAX_CLUSTER_PATTERNS.
 *
 * @param {object} parsed
 * @returns {{ patterns: Array }}
 */
function normalizePatterns(parsed) {
  if (!parsed || typeof parsed !== 'object') return { patterns: [] };
  const raw = Array.isArray(parsed.patterns) ? parsed.patterns : [];
  const validSeverity = (s) => ['high', 'medium', 'low'].includes(s) ? s : 'medium';

  const asStrArr = (v) => {
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => (typeof x === 'string' ? x.trim() : String(x)))
      .filter((s) => s.length >= 1 && s.length <= 200);
  };

  const asTicketArr = (v) => {
    if (!Array.isArray(v)) return [];
    return v
      .map((t) => {
        if (!t || typeof t !== 'object') return null;
        const key = typeof t.key === 'string' ? t.key.trim() : '';
        if (!key) return null;
        const detail = typeof t.detail === 'string' ? t.detail.slice(0, 200) : '';
        return { key, detail };
      })
      .filter(Boolean);
  };

  const patterns = raw
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      return {
        name: typeof p.name === 'string' ? p.name.slice(0, 120) : 'Unnamed Pattern',
        summary: typeof p.summary === 'string' ? p.summary.slice(0, 400) : '',
        severity: validSeverity(p.severity),
        affectedReleases: asStrArr(p.affectedReleases).slice(0, 12),
        tickets: asTicketArr(p.tickets).slice(0, 20),
        quantitativeEvidence: asStrArr(p.quantitativeEvidence).slice(0, 12),
        rootCause: typeof p.rootCause === 'string' ? p.rootCause.slice(0, 300) : 'undetermined',
        recommendation: typeof p.recommendation === 'string' ? p.recommendation.slice(0, 400) : ''
      };
    })
    .filter(Boolean);

  return { patterns: patterns.slice(0, MAX_CLUSTER_PATTERNS) };
}

/**
 * Analyze a batch of Jira tickets for common patterns.
 *
 * @param {Array} issues - raw Jira issues (wide-recall, 30-40 tickets)
 * @param {object} llm - LlmClient instance
 * @param {{ contextLabel?: string }} [opts] - optional context label for the prompt (e.g. "EHT P870 timing tickets")
 * @returns {Promise<{ patterns: Array, ticketCount: number, error?: string }>}
 */
export async function analyzeTicketPatterns(issues, llm, opts = {}) {
  if (!llm) return { patterns: [], ticketCount: 0, error: 'LLM not configured' };
  if (!Array.isArray(issues) || issues.length === 0) {
    return { patterns: [], ticketCount: 0, error: 'No tickets to analyze' };
  }

  const ticketBlocks = issues.map(renderTicketBlock).join('\n\n---\n\n');
  const contextLabel = opts.contextLabel || `${issues.length} tickets`;

  const userPrompt = `Analyze the following ${contextLabel} and identify common patterns.

Tickets:
${ticketBlocks}

Return the JSON now.`;

  try {
    const response = await llm.chat([
      { role: 'system', content: CLUSTER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ]);
    const normalized = normalizePatterns(parseLlmJson(response?.content || ''));
    return {
      patterns: normalized.patterns,
      ticketCount: issues.length
    };
  } catch (err) {
    console.warn('[cluster-analyzer] LLM call failed:', err.message);
    return {
      patterns: [],
      ticketCount: issues.length,
      error: err.message
    };
  }
}
