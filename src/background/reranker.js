/**
 * LLM-as-reranker for the hybrid-search pipeline.
 *
 * Mirrors Rovo's rerank step: after RRF produces a top-N candidate pool, a
 * single LLM call scores each candidate against the source ticket / query and
 * returns top-N with one-line reasons. The rerank call is the highest-leverage
 * step — it's where "retrieved" becomes "relevant".
 *
 * Input shape (candidates):
 *   [{ key, fields: { summary, description, comments, status, priority }, _tier, _rrfScore }]
 *
 * Output shape:
 *   [{ key, score (0-100), reason (string), _rrfScore (carried through) }]
 *   sorted by score desc, capped at topN (default 30).
 *
 * Fallback: if the LLM call fails, returns the top-N candidates by RRF score
 * with empty reasons — search still works, just without the "why this matches"
 * annotations.
 */

import { MAX_RERANK_CANDIDATES, MAX_RERANKED_RESULTS } from '../shared/constants.js';
import { parseLlmJson } from '../shared/llm-json.js';
import { extractDescriptionText, extractCommentText } from '../shared/utils.js';

const RERANKER_SYSTEM_PROMPT = `You rank Jira tickets by relevance to a source query/ticket.
Score each candidate 0-100 based on:
  - Title/summary match to the query domain (highest weight)
  - Description body content (medium weight — many PD tickets describe the
    issue in the body without using PD keywords in the title)
  - Recent comments (lower weight — but a comment may reveal the true topic)
Compare error codes, reproduction paths, root cause categories, environments.
Be terse but DO read the description/comments before scoring — a ticket whose
title looks unrelated may be highly relevant based on its body.

Return ONLY a JSON array (no prose, no markdown fence):
[
  { "key": "PROJ-123", "score": 87, "reason": "same NullPointerException in PaymentService" },
  ...
]
Score 0-100. Sort the array by score descending. Every candidate must appear exactly once.
Reason must be a single short line (<= 80 chars).`;

/**
 * Build a compact per-candidate context block. Each line includes summary +
 * description excerpt + the most recent comment, so the LLM can spot tickets
 * whose relevance lives in the body rather than the title.
 *
 * Budget per candidate ~ 320 chars (vs ~80 for summary-only). With BATCH_SIZE=10
 * that's ~3.2k chars per batch — well within cheap-model context.
 */
function buildCandidateLine(c, idx) {
  const f = c.fields || {};
  const summary = (f.summary || c.summary || '(no summary)').slice(0, 140);
  const tier = c._tier ?? '-';
  const vecScore = typeof c._vecScore === 'number' && c._vecScore > 0
    ? ` v=${c._vecScore.toFixed(2)}`
    : '';

  // Description excerpt: strip ADF, collapse whitespace, take first 200 chars
  let descExcerpt = '';
  if (f.description) {
    const desc = extractDescriptionText(f.description)
      .replace(/\s+/g, ' ')
      .trim();
    if (desc) descExcerpt = desc.slice(0, 180);
  }

  // Most recent meaningful comment (skip if none)
  let commentExcerpt = '';
  const comments = f.comment?.comments;
  if (Array.isArray(comments) && comments.length > 0) {
    const last = comments[comments.length - 1];
    const body = extractCommentText(last).replace(/\s+/g, ' ').trim();
    if (body) commentExcerpt = body.slice(0, 120);
  }

  const parts = [
    `${idx + 1}. [${c.key}]${vecScore} t${tier}`,
    `S: ${summary}`
  ];
  if (descExcerpt) parts.push(`D: ${descExcerpt}`);
  if (commentExcerpt) parts.push(`C: ${commentExcerpt}`);
  return parts.join(' | ');
}

function buildRerankerUserPrompt(sourceBlock, candidates) {
  const lines = candidates.map((c, i) => buildCandidateLine(c, i));
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
  // BATCH_SIZE=10 because each candidate now carries summary + description
  // excerpt + comment (~320 chars) — 10 × 320 = 3.2k chars per batch, leaving
  // ample headroom in the cheap model's context window.
  const BATCH_SIZE = 10;
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

  // Drop score=0 entries (failed-batch / LLM-omitted) ONLY when there are
  // enough positive-score entries to fill topN. If most batches failed we
  // keep the 0-score ones so the user still sees results ranked by RRF.
  const positiveCount = scored.filter((s) => s.score > 0).length;
  let pool = scored;
  if (positiveCount >= topN) {
    pool = scored.filter((s) => s.score > 0);
  }
  return pool.slice(0, topN);
}
