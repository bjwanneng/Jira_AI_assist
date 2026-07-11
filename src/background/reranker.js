/**
 * LLM-as-reranker for the hybrid-search pipeline.
 *
 * Mirrors Rovo's rerank step: after RRF produces a top-20 candidate pool, a
 * single LLM call scores each candidate against the source ticket / query and
 * returns top-N with one-line reasons. The rerank call is the highest-leverage
 * step — it's where "retrieved" becomes "relevant".
 *
 * Input shape (candidates):
 *   [{ key, summary, status, priority, _tier, _rrfScore }]
 *
 * Output shape:
 *   [{ key, score (0-100), reason (string), _rrfScore (carried through) }]
 *   sorted by score desc, capped at topN (default 5).
 *
 * Fallback: if the LLM call fails, returns the top-N candidates by RRF score
 * with empty reasons — search still works, just without the "why this matches"
 * annotations.
 */

import { MAX_RERANK_CANDIDATES, MAX_RERANKED_RESULTS } from '../shared/constants.js';
import { parseLlmJson } from '../shared/llm-json.js';

const RERANKER_SYSTEM_PROMPT = `You rank Jira tickets by similarity to a source ticket.
Compare error codes, reproduction paths, root cause categories, environments — be terse.
Return ONLY a JSON array (no prose, no markdown fence):
[
  { "key": "PROJ-123", "score": 87, "reason": "same NullPointerException in PaymentService" },
  ...
]
Score 0-100. Sort the array by score descending. Every candidate must appear exactly once.
Reason must be a single short line (<= 80 chars).`;

function buildRerankerUserPrompt(sourceBlock, candidates) {
  const lines = candidates.map((c, i) => {
    const f = c.fields || {};
    const summary = f.summary || c.summary || '(no summary)';
    const status = f.status?.name || c.status || '?';
    const priority = f.priority?.name || c.priority || '?';
    const tier = c._tier ?? '-';
    return `${i + 1}. ${c.key} — ${summary} [status=${status}, priority=${priority}, tier=${tier}]`;
  });
  return `Source:
${sourceBlock}

Candidates (top ${candidates.length}):
${lines.join('\n')}

Return the JSON array now.`;
}

/**
 * Render a source-summary block for the reranker prompt. Works for both
 * ticket-summary shape and query-expansion shape — we just need *some*
 * context for the model to score against.
 *
 * @param {object} source - { summary?: {...}, query?: string }
 * @returns {string}
 */
function renderSourceBlock(source) {
  if (!source) return '(no source context)';
  if (source.summary) {
    const s = source.summary;
    return [
      `Source ticket: ${source.issueKey || '?'}`,
      s.phenomenon && `Phenomenon: ${s.phenomenon}`,
      s.errorCodes?.length && `Error codes: ${s.errorCodes.join(', ')}`,
      s.environment && `Environment: ${s.environment}`,
      s.rootCauseCategory && `Root cause: ${s.rootCauseCategory}`,
      s.searchKeywords?.length && `Keywords: ${s.searchKeywords.join(', ')}`
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (source.query) {
    return [
      `Source query: ${source.query}`,
      source.expansion?.primaryTerms?.length && `Primary terms: ${source.expansion.primaryTerms.join(', ')}`,
      source.expansion?.synonyms?.length && `Synonyms: ${source.expansion.synonyms.join(', ')}`
    ]
      .filter(Boolean)
      .join('\n');
  }
  return '(no source context)';
}

/**
 * Convert the LLM's parsed array into a {key → {score, reason}} map. Tolerates
 * missing fields, non-array shapes, and duplicate keys (last wins).
 */
function buildScoreMap(parsed) {
  const map = new Map();
  if (!Array.isArray(parsed)) return map;
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || !entry.key) continue;
    const score = Number.isFinite(entry.score) ? Math.max(0, Math.min(100, entry.score)) : 0;
    const reason =
      typeof entry.reason === 'string' ? entry.reason.slice(0, 120) : '';
    map.set(String(entry.key), { score, reason });
  }
  return map;
}

/**
 * Rerank candidates via a single LLM call.
 *
 * @param {object} source - { summary, issueKey } OR { query, expansion }
 * @param {Array} candidates - issues from RRF (each with _rrfScore, _tier)
 * @param {object} llm - LlmClient instance
 * @param {{ topN?: number }} [opts]
 * @returns {Promise<Array<{key, score, reason, _rrfScore, _tier, fields?}>>}
 */
export async function rerankCandidates(source, candidates, llm, opts = {}) {
  const topN = opts.topN ?? MAX_RERANKED_RESULTS;
  const allCandidates = candidates || [];

  if (allCandidates.length === 0) return [];
  if (allCandidates.length === 1) {
    return [{ ...allCandidates[0], score: 100, reason: 'only candidate' }];
  }

  // No LLM available — degrade to score-only ranking.
  if (!llm) {
    return allCandidates
      .slice()
      .sort((a, b) => (b._rrfScore || 0) - (a._rrfScore || 0))
      .slice(0, topN)
      .map((c) => ({
        key: c.key, score: 0, reason: '',
        _rrfScore: c._rrfScore, _tier: c._tier, fields: c.fields
      }));
  }

  // Process in batches to handle large candidate pools without truncation.
  // Each batch is small enough for one LLM call (~20 candidates × 50 tokens).
  // All batches run in parallel, results are merged at the end.
  const BATCH_SIZE = 20;
  const batches = [];
  for (let i = 0; i < allCandidates.length; i += BATCH_SIZE) {
    batches.push(allCandidates.slice(i, i + BATCH_SIZE));
  }

  console.log('[reranker] %d candidates in %d batches (batch=%d)', allCandidates.length, batches.length, BATCH_SIZE);

  const batchResults = await Promise.all(
    batches.map(async (batch, batchIdx) => {
      try {
        const response = await llm.chatCheap([
          { role: 'system', content: RERANKER_SYSTEM_PROMPT },
          { role: 'user', content: buildRerankerUserPrompt(renderSourceBlock(source), batch) }
        ]);
        const scoreMap = buildScoreMap(parseLlmJson(response?.content || ''));
        return batch.map((c) => {
          const entry = scoreMap.get(c.key) || { score: 0, reason: '' };
          return {
            key: c.key, score: entry.score, reason: entry.reason,
            _rrfScore: c._rrfScore, _tier: c._tier, fields: c.fields
          };
        });
      } catch (err) {
        console.warn('[reranker] batch %d failed (%d candidates): %s', batchIdx, batch.length, err?.message || err);
        // Return batch with score 0 so they still appear in results
        return batch.map((c) => ({
          key: c.key, score: 0, reason: '',
          _rrfScore: c._rrfScore, _tier: c._tier, fields: c.fields
        }));
      }
    })
  );

  // Merge all batch results, sort by score desc then RRF score desc
  const scored = batchResults.flat();
  scored.sort((a, b) => b.score - a.score || (b._rrfScore || 0) - (a._rrfScore || 0));
  return scored.slice(0, topN);
}
