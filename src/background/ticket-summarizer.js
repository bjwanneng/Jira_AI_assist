/**
 * Structured ticket summarization for hybrid search.
 *
 * Mirrors Rovo's "data preprocessing" step: extract a fixed schema from each
 * Jira ticket before retrieval so the search pipeline can (a) build precise
 * JQL from `searchKeywords`, (b) issue a semantic-ish query from `synonyms`,
 * and (c) feed a compact comparison block to the reranker.
 *
 * Output schema:
 *   {
 *     phenomenon:        string   // 核心故障现象 — what's breaking
 *     errorCodes:        string[] // error codes / log fragments / register names
 *     environment:        string   // 受影响环境 — iOS/build/version
 *     rootCauseCategory: string   // 根因分类 — e.g. "race condition", "config mismatch"
 *     searchKeywords:    string[] // BM25-channel tokens (precise, low-recall)
 *     synonyms:          string[] // semantic-channel tokens (synonyms, paraphrases)
 *   }
 *
 * LLM failure → returns null, caller falls back to raw summary tokens.
 */

import { getSummary, setSummary } from '../shared/db.js';
import { SUMMARY_SCHEMA_VERSION, MAX_COMMENTS } from '../shared/constants.js';
import {
  extractDescriptionText,
  extractCommentText,
  truncateToTokens
} from '../shared/utils.js';
import { IssueExtractor } from '../content/issue-extractor.js';
import { parseLlmJson } from '../shared/llm-json.js';

const SUMMARIZER_SYSTEM_PROMPT = `You extract structured features from a Jira ticket for similarity search.
Return ONLY a JSON object with this exact shape (no prose, no markdown fence needed):
{
  "phenomenon": "one-line description of the core symptom",
  "errorCodes": ["ERR_502", "NullPointerException", ...],
  "environment": "OS / app version / hardware context if any",
  "rootCauseCategory": "race condition | config mismatch | null pointer | timeout | permission | other",
  "searchKeywords": ["precise tokens to search by, e.g. module names, error codes, register names"],
  "synonyms": ["synonyms or paraphrases that broaden recall, e.g. 'crash' if phenomenon says 'segfault'"]
}
If a field is unknown, use empty string or empty array. Keep each field terse.`;

/**
 * Build the LLM prompt body from a Jira issue.
 * @param {object} issue - raw Jira issue
 * @returns {string}
 */
function buildUserPrompt(issue) {
  const fields = issue.fields || {};
  const summary = fields.summary || '';
  const description = truncateToTokens(extractDescriptionText(fields.description), 800);
  const comments = (fields.comment?.comments || [])
    .slice(-MAX_COMMENTS)
    .map(extractCommentText)
    .filter(Boolean)
    .map((c) => truncateToTokens(c, 200))
    .join('\n---\n');

  const hints = IssueExtractor.extractIpHints(fields);
  const hintLine = [
    hints.coreName && `coreName=${hints.coreName}`,
    hints.productLine && `productLine=${hints.productLine}`,
    hints.keywords?.length && `ruleKeywords=${hints.keywords.join(', ')}`
  ]
    .filter(Boolean)
    .join('\n');

  return `Ticket: ${issue.key}
Summary: ${summary}

Description:
${description || '(empty)'}

Recent comments:
${comments || '(none)'}

Rule-based hints (use these in searchKeywords if relevant):
${hintLine || '(none)'}

Return the JSON now.`;
}

/**
 * Sanitize and merge LLM output with rule-based hints.
 * @param {object} parsed
 * @param {object} hints - output of IssueExtractor.extractIpHints
 * @returns {object}
 */
function normalizeSummary(parsed, hints) {
  if (!parsed || typeof parsed !== 'object') return null;

  const asStringArr = (v) => {
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => (typeof x === 'string' ? x.trim() : String(x)))
      .filter((s) => s.length >= 2 && s.length <= 64);
  };

  // Merge LLM keywords with rule-based IP hints (dedup, cap at 10).
  const kws = new Set([
    ...(parsed.searchKeywords || []),
    ...(hints?.keywords || []),
    hints?.coreName,
    hints?.productLine
  ].filter(Boolean));
  const searchKeywords = Array.from(kws).slice(0, 10);

  return {
    phenomenon: typeof parsed.phenomenon === 'string' ? parsed.phenomenon.slice(0, 200) : '',
    errorCodes: asStringArr(parsed.errorCodes),
    environment: typeof parsed.environment === 'string' ? parsed.environment.slice(0, 100) : '',
    rootCauseCategory:
      typeof parsed.rootCauseCategory === 'string' ? parsed.rootCauseCategory.slice(0, 60) : '',
    searchKeywords,
    synonyms: asStringArr(parsed.synonyms)
  };
}

/**
 * Run the summarizer on one ticket. Always returns a usable summary object
 * (possibly empty) — never throws. Caller decides whether to skip rerank
 * when fields are sparse.
 *
 * @param {object} issue - raw Jira issue
 * @param {object} llm - LlmClient instance
 * @returns {Promise<object|null>} normalized summary, or null on failure
 */
export async function summarizeTicket(issue, llm) {
  if (!llm || !issue?.key) return null;

  try {
    const response = await llm.chatCheap([
      { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(issue) }
    ]);
    const parsed = parseLlmJson(response?.content || '');
    const hints = IssueExtractor.extractIpHints(issue.fields || {});
    const normalized = normalizeSummary(parsed, hints);
    if (!normalized) return null;
    await setSummary(issue.key, normalized, SUMMARY_SCHEMA_VERSION);
    return normalized;
  } catch (err) {
    console.warn('[summarizer] failed for', issue.key, err.message);
    return null;
  }
}

/**
 * Get the cached summary for an issue, or summarize it now and cache the result.
 * Returns null if both cache miss and summarization fail.
 *
 * @param {object} issue - raw Jira issue
 * @param {object} llm - LlmClient instance
 * @returns {Promise<object|null>}
 */
export async function getOrSummarize(issue, llm) {
  if (!issue?.key) return null;

  const cached = await getSummary(issue.key, SUMMARY_SCHEMA_VERSION);
  if (cached?.summary) return cached.summary;

  return summarizeTicket(issue, llm);
}
