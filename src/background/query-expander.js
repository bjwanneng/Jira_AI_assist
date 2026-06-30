/**
 * Free-form query expansion for `search_jira` (no source ticket).
 *
 * Mirrors Rovo's hybrid-search semantic channel: when there's no ticket to
 * summarize, we ask the LLM to expand the user's natural-language query into
 * a primary-terms list (precise) and a synonyms list (broad recall). These
 * feed the same two JQL channels that the ticket-summarizer's
 * `searchKeywords` / `synonyms` would.
 *
 * Output schema:
 *   { primaryTerms: string[], synonyms: string[] }
 *
 * Cached by SHA-256(query) in IndexedDB so repeat queries are free.
 */

import { getExpandedQuery, setExpandedQuery, hashQuery } from '../shared/db.js';
import { QUERY_EXPANSION_SCHEMA_VERSION } from '../shared/constants.js';
import { parseLlmJson } from '../shared/llm-json.js';

const EXPANDER_SYSTEM_PROMPT = `You expand a search query into two token lists for Jira full-text search.
Return ONLY a JSON object (no prose, no markdown fence):
{
  "primaryTerms": ["precise terms likely in the ticket, e.g. module names, error codes"],
  "synonyms": ["synonyms or paraphrases that broaden recall, e.g. 'crash' for 'segfault'"]
}
Keep each list under 8 items. Each term 2-32 chars. Skip stop words.`;

function normalizeExpansion(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const asStringArr = (v) => {
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => (typeof x === 'string' ? x.trim() : String(x)))
      .filter((s) => s.length >= 2 && s.length <= 32)
      .slice(0, 8);
  };
  return {
    primaryTerms: asStringArr(parsed.primaryTerms),
    synonyms: asStringArr(parsed.synonyms)
  };
}

/**
 * Expand a free-form query into { primaryTerms, synonyms }.
 * Returns null on failure.
 *
 * @param {string} query
 * @param {object} llm - LlmClient instance
 * @returns {Promise<object|null>}
 */
export async function expandQuery(query, llm) {
  if (!llm || !query) return null;

  try {
    const response = await llm.chatCheap([
      { role: 'system', content: EXPANDER_SYSTEM_PROMPT },
      { role: 'user', content: `Query: ${query}\n\nReturn the JSON now.` }
    ]);
    const normalized = normalizeExpansion(parseLlmJson(response?.content || ''));
    if (!normalized) return null;
    const hash = await hashQuery(query);
    await setExpandedQuery(hash, normalized, QUERY_EXPANSION_SCHEMA_VERSION);
    return normalized;
  } catch (err) {
    console.warn('[query-expander] failed for', query, err.message);
    return null;
  }
}

/**
 * Get the cached expansion for a query, or expand it now and cache the result.
 * Returns null if both cache miss and expansion fail.
 *
 * @param {string} query
 * @param {object} llm - LlmClient instance
 * @returns {Promise<object|null>}
 */
export async function getOrExpand(query, llm) {
  if (!query) return null;

  const hash = await hashQuery(query);
  const cached = await getExpandedQuery(hash, QUERY_EXPANSION_SCHEMA_VERSION);
  if (cached?.expansion) return cached.expansion;

  return expandQuery(query, llm);
}
