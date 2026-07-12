/**
 * Dense-vector similarity index for "find similar past tickets".
 *
 * Why vectors and not keywords:
 *   Keyword matching (the old path) only fires on literal token overlap, so a
 *   new ticket "payment fails / reconciliation mismatch" never matches an old
 *   "duplicate charge / settlement error" ticket. A dense embedding places
 *   semantically similar tickets near each other in vector space regardless of
 *   wording, which is exactly the recall we want for support triage.
 *
 * Responsibilities:
 *   - buildIndex(): one-shot bulk embed of up to MAX_INDEX_ISSUES tickets
 *     (title + description + comments) via the (separately configured)
 *     embedding endpoint, stored in IndexedDB keyed by issue key.
 *   - vectorSearch(): cosine-scan the local index for a query vector — no
 *     server round-trip beyond the single embed() call the caller already made.
 *   - clearIndex(): wipe the local index (e.g. after switching embedding model).
 *
 * The chat/embedding models are intentionally independent: you can chat on Kimi
 * and embed on Zhipu embedding-3. All vectors MUST come from the same model
 * and dimension, or cosine scores become meaningless.
 */

import { ApiClient, simplifyIssue } from './api-client.js';
import { LlmClient } from './llm-client.js';
import {
  getAllEmbeddings, setEmbedding, clearEmbeddings, countEmbeddings
} from '../shared/db.js';
import {
  MAX_INDEX_ISSUES, INDEX_MAX_ISSUES_HARD_CAP, INDEX_PAGE_SIZE, EMBED_TEXT_MAX_CHARS,
  VECTOR_TOP_K, VECTOR_MIN_SCORE, EMBEDDING_SCHEMA_VERSION,
  INDEX_JQL_LOWER_BOUND
} from '../shared/constants.js';
import { quoteJql } from '../shared/utils.js';

const DAY_MS = 86400000;

/**
 * Resolve the `updated >=` lower bound for an index query.
 * Honours an optional look-back window and/or an incremental-sync marker.
 * Returns an ISO date (YYYY-MM-DD). When nothing is given we fall back to a
 * far-past date so the query still carries a restriction (Jira Cloud forbids
 * unbounded JQL — a pure `ORDER BY` with no clause is rejected).
 * @param {{ lookbackDays?: number, sinceMs?: number }} [opts]
 */
function resolveUpdatedSince({ lookbackDays = 0, sinceMs = 0 } = {}) {
  const bounds = [];
  if (Number(lookbackDays) > 0) bounds.push(Date.now() - Number(lookbackDays) * DAY_MS);
  if (Number(sinceMs) > 0) bounds.push(Number(sinceMs));
  if (bounds.length === 0) return INDEX_JQL_LOWER_BOUND;
  return new Date(Math.max(...bounds)).toISOString().slice(0, 10);
}

/** Build `project in (...)` / `status in (...)` clauses from comma strings. */
function scopeClauses({ projects = '', statuses = '' } = {}) {
  const clauses = [];
  const proj = String(projects || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (proj.length) clauses.push(`project in (${proj.map(quoteJql).join(',')})`);
  const st = String(statuses || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (st.length) clauses.push(`status in (${st.map(quoteJql).join(',')})`);
  return clauses;
}

/** JQL for a full (re)build, respecting the user's scope settings. */
export function buildIndexJql({ lookbackDays = 0, projects = '', statuses = '' } = {}) {
  const clauses = [
    `updated >= "${resolveUpdatedSince({ lookbackDays })}"`,
    ...scopeClauses({ projects, statuses })
  ];
  return clauses.join(' AND ') + ' ORDER BY updated DESC';
}

/** JQL for an incremental sync (also honours scope, plus the sync marker). */
export function syncIndexJql({ lookbackDays = 0, sinceMs = 0, projects = '', statuses = '' } = {}) {
  const clauses = [
    `updated >= "${resolveUpdatedSince({ lookbackDays, sinceMs })}"`,
    ...scopeClauses({ projects, statuses })
  ];
  return clauses.join(' AND ') + ' ORDER BY updated ASC';
}

/**
 * Count how many tickets fall inside the current build scope, WITHOUT
 * embedding anything — so the user can size the index before committing to a
 * costly build. Uses the exact same scope (lookback / projects / statuses) as
 * buildIndex, minus the ORDER BY (irrelevant for a count).
 * @param {object} config - merged settings (STORAGE_KEYS)
 * @returns {Promise<{count:number, capped:boolean, approximate:boolean, jql:string, indexed:number}>}
 */
export async function countScope(config, { exact = false } = {}) {
  const api = new ApiClient(config);
  const jql = buildIndexJql({
    lookbackDays: config.indexLookbackDays,
    projects: config.indexProjects,
    statuses: config.indexStatuses
  }).replace(/\s+ORDER BY[\s\S]*$/i, '');
  const since = resolveUpdatedSince({ lookbackDays: config.indexLookbackDays });
  const res = await api.countJira(jql, { exact });
  const indexed = await countEmbeddings().catch(() => 0);
  return { ...res, jql, since, indexed };
}

const EMBED_BATCH = 20; // texts per embed() call during bulk build

// Epoch-ms timestamp of the last successful incremental sync. Stored in
// chrome.storage.local (a single scalar) so syncNewIssues knows the
// `updated >=` cutoff without re-reading the whole vector store.
const LAST_SYNC_KEY = 'indexLastSyncAt';

async function getLastSyncAt() {
  try {
    const r = await chrome.storage.local.get(LAST_SYNC_KEY);
    return Number(r[LAST_SYNC_KEY]) || 0;
  } catch {
    return 0;
  }
}

async function setLastSyncAt(ts) {
  try {
    await chrome.storage.local.set({ [LAST_SYNC_KEY]: ts });
  } catch {
    /* non-fatal */
  }
}

/**
 * Cosine similarity between two equal-length vectors.
 * Returns -1..1 (0 for orthogonal). Normalizes internally so un-normalized
 * vectors are safe.
 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Build the plain-text blob we embed for a ticket. Title-weighted: the summary
 * is repeated so the model weights it more heavily than body prose.
 * @param {object} simplified - output of simplifyIssue()
 */
export function issueToEmbedText(simplified, maxChars = EMBED_TEXT_MAX_CHARS) {
  const parts = [
    `Title: ${simplified.summary || ''}`,
    `Title: ${simplified.summary || ''}`, // repeated for weight
    simplified.description || '',
    (simplified.comments || []).join('\n')
  ];
  const text = parts.filter(Boolean).join('\n').slice(0, maxChars);
  return text;
}

function metaFromSimplified(simplified) {
  return {
    summary: simplified.summary || '',
    status: simplified.status || '',
    issueType: simplified.issueType || '',
    priority: simplified.priority || '',
    updated: simplified.updated || null
  };
}

/**
 * Embed one raw Jira issue and store its vector + renderable metadata.
 * Idempotent (keyed by issue key). Returns true on success, false on skip/failure.
 * @param {ApiClient} api
 * @param {LlmClient} llm
 * @param {object} rawIssue - raw Jira issue (with fields)
 */
export async function embedOneIssue(api, llm, rawIssue) {
  const key = rawIssue?.key;
  if (!key) return false;
  try {
    const simplified = simplifyIssue(rawIssue);
    const text = issueToEmbedText(simplified);
    if (!text.trim()) return false;
    const [vec] = await llm.embed(text);
    if (!Array.isArray(vec) || vec.length === 0) return false;
    await setEmbedding({
      key,
      vec,
      text,
      dims: vec.length,
      model: llm.embedModel,
      meta: metaFromSimplified(simplified),
      schemaVersion: EMBEDDING_SCHEMA_VERSION,
      indexedAt: Date.now()
    });
    invalidateEmbeddingsCache();
    return true;
  } catch (err) {
    console.warn(`[indexer] embed failed for ${key}:`, err.message);
    return false;
  }
}

/**
 * Bulk-build (or rebuild) the local similarity index.
 *
 * Fetches tickets ordered by most-recently-updated, embeds them in batches via
 * the embedding endpoint, and stores vectors in IndexedDB. Existing vectors for
 * the same key are overwritten (idempotent), so calling this again refreshes
 * changed tickets without duplication.
 *
 * @param {object} config - full extension config (must include embedding keys)
 * @param {{ onProgress?: (p: object) => void }} [opts]
 * @returns {Promise<{ indexed: number, skipped: number, seen: number, model: string, dims: number }>}
 */
export async function buildIndex(config, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const api = new ApiClient(config);
  const llm = new LlmClient(config);

  if (!llm.isEmbeddingEnabled) {
    throw new Error(
      'Embedding not configured. Open extension settings → "Vector Search (Embedding)" ' +
      'and fill in the Base URL, API key, and model (e.g. Zhipu embedding-3).'
    );
  }

  // Bounded, user-scoped query. Jira Cloud rejects unbounded JQL (pure
  // ORDER BY with no restriction), so we always carry an `updated >=` bound
  // (far-past when no look-back is set) plus any project/status filters.
  const maxIssues = Math.min(Number(config.indexMaxIssues) || MAX_INDEX_ISSUES, INDEX_MAX_ISSUES_HARD_CAP);
  const jql = buildIndexJql({
    lookbackDays: config.indexLookbackDays,
    projects: config.indexProjects,
    statuses: config.indexStatuses
  });
  let startAt = 0;
  let seen = 0;
  let indexed = 0;
  let skipped = 0;
  let dims = 0;

  onProgress({ phase: 'start', seen: 0, indexed: 0 });

  while (seen < maxIssues) {
    const res = await api.searchJira(jql, INDEX_PAGE_SIZE, startAt);
    const issues = res.issues || [];
    if (issues.length === 0) break;

    // Batch embed for throughput. If the provider returns fewer vectors than
    // inputs (Ark multimodal only supports single-input), fall back to
    // per-issue embedding one at a time.
    const batch = issues.slice(0, maxIssues - seen);
    const texts = batch.map((iss) => issueToEmbedText(simplifyIssue(iss)));
    let vectors = null;
    try {
      vectors = await llm.embed(texts);
      // Verify we got one vector per input — if not, fall through to sequential
      if (!Array.isArray(vectors) || vectors.length < texts.length) {
        console.warn('[indexer] batch embed returned %d/%d vectors, falling back to sequential', vectors?.length || 0, texts.length);
        vectors = null;
      }
    } catch (batchErr) {
      console.warn('[indexer] batch embed failed, falling back to per-issue:', batchErr.message);
    }

    if (!vectors) {
      // Sequential embed: one text at a time (Ark multimodal requires this)
      for (let i = 0; i < batch.length; i++) {
        try {
          const [v] = await llm.embed(texts[i]);
          if (Array.isArray(v) && v.length) {
            await storeVector(llm, batch[i], v, texts[i]);
            indexed++; dims = dims || v.length;
          } else {
            skipped++;
          }
        } catch {
          skipped++;
        }
        // Progress update every 10 tickets during sequential embed
        if ((indexed + skipped) % 10 === 0) {
          onProgress({ phase: 'progress', seen: seen + indexed + skipped, indexed, skipped });
        }
      }
      seen += batch.length;
      startAt += batch.length;
      onProgress({ phase: 'progress', seen, indexed, skipped });
      if (batch.length < INDEX_PAGE_SIZE) break;
      continue;
    }

    for (let i = 0; i < batch.length; i++) {
      const v = vectors[i];
      if (Array.isArray(v) && v.length) {
        await storeVector(llm, batch[i], v, texts[i]);
        indexed++;
        dims = dims || v.length;
      } else {
        skipped++;
      }
    }

    seen += batch.length;
    startAt += batch.length;
    onProgress({ phase: 'progress', seen, indexed, skipped });

    if (batch.length < INDEX_PAGE_SIZE) break;
  }

  onProgress({ phase: 'done', seen, indexed, skipped });
  // Stamp "now" as the baseline so the next incremental sync only picks up
  // tickets changed after this full build.
  await setLastSyncAt(Date.now());
  return { indexed, skipped, seen, model: llm.embedModel, dims };
}

/**
 * Incremental refresh: embed only the tickets updated since the last sync so
 * the local vector store stays fresh as the Jira backlog keeps growing.
 *
 * - Idempotent (keyed by issue key) — re-running just refreshes changed
 *   tickets, never duplicates.
 * - No-op until a full buildIndex() has run at least once (count === 0).
 * - On the very first call after a build (no sync marker yet) it just stamps
 *   "now" and returns, leaving the baseline build untouched.
 *
 * @param {object} config - full extension config (must include embedding keys)
 * @param {{ onProgress?: (p: object) => void }} [opts]
 * @returns {Promise<{ synced: number, skipped: number, reason?: string }>}
 */
export async function syncNewIssues(config, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const llm = new LlmClient(config);
  if (!llm.isEmbeddingEnabled) return { synced: 0, skipped: 0, reason: 'embed-disabled' };

  const count = await countEmbeddings();
  if (count === 0) return { synced: 0, skipped: 0, reason: 'not-built' };

  const since = await getLastSyncAt();
  if (since === 0) {
    // Baseline build owns the initial load; stamp now so the next sync
    // only picks up future changes.
    await setLastSyncAt(Date.now());
    return { synced: 0, skipped: 0, reason: 'no-marker' };
  }

  const api = new ApiClient(config);
  const maxIssues = Math.min(Number(config.indexMaxIssues) || MAX_INDEX_ISSUES, INDEX_MAX_ISSUES_HARD_CAP);
  // Same scope as a full build (project/status filters + look-back), plus the
  // incremental marker so we only pick up tickets changed since the last sync.
  const jql = syncIndexJql({
    lookbackDays: config.indexLookbackDays,
    sinceMs: since,
    projects: config.indexProjects,
    statuses: config.indexStatuses
  });

  let startAt = 0;
  let synced = 0;
  let skipped = 0;
  let maxUpdated = since;

  onProgress({ phase: 'sync-start', synced: 0, skipped: 0 });
  while (synced + skipped < maxIssues) {
    const res = await api.searchJira(jql, INDEX_PAGE_SIZE, startAt);
    const issues = res.issues || [];
    if (issues.length === 0) break;

    const batch = issues.slice(0, maxIssues - synced - skipped);
    const texts = batch.map((iss) => issueToEmbedText(simplifyIssue(iss)));

    // Batch embed for throughput (same as buildIndex). Fall back to per-issue
    // embedding if the batch call fails so one bad ticket doesn't block sync.
    let vectors = null;
    try {
      vectors = await llm.embed(texts);
    } catch (batchErr) {
      console.warn('[indexer] sync batch embed failed, falling back to per-issue:', batchErr.message);
      for (let i = 0; i < batch.length; i++) {
        try {
          const [v] = await llm.embed(texts[i]);
          if (Array.isArray(v) && v.length) {
            await storeVector(llm, batch[i], v, texts[i]);
            synced++;
            const u = Date.parse(batch[i]?.fields?.updated);
            if (u) maxUpdated = Math.max(maxUpdated, u);
          } else {
            skipped++;
          }
        } catch {
          skipped++;
        }
      }
      startAt += batch.length;
      onProgress({ phase: 'sync-progress', synced, skipped });
      if (batch.length < INDEX_PAGE_SIZE) break;
      continue;
    }

    for (let i = 0; i < batch.length; i++) {
      const v = vectors[i];
      if (Array.isArray(v) && v.length) {
        await storeVector(llm, batch[i], v, texts[i]);
        synced++;
        const u = Date.parse(batch[i]?.fields?.updated);
        if (u) maxUpdated = Math.max(maxUpdated, u);
      } else {
        skipped++;
      }
    }

    startAt += batch.length;
    onProgress({ phase: 'sync-progress', synced, skipped });
    if (batch.length < INDEX_PAGE_SIZE) break;
  }

  await setLastSyncAt(maxUpdated || Date.now());
  onProgress({ phase: 'sync-done', synced, skipped });
  return { synced, skipped };
}

async function storeVector(llm, rawIssue, vec, text) {
  const simplified = simplifyIssue(rawIssue);
  await setEmbedding({
    key: rawIssue.key,
    vec,
    text,
    dims: vec.length,
    model: llm.embedModel,
    meta: metaFromSimplified(simplified),
    schemaVersion: EMBEDDING_SCHEMA_VERSION,
    indexedAt: Date.now()
  });
  invalidateEmbeddingsCache();
}

// In-memory cache of all embeddings, so vectorSearch doesn't reload the
// full index from IndexedDB on every call. Invalidated by any write to the
// embeddings store (storeVector, embedOneIssue, clearIndex).
let _embeddingsCache = null;

function invalidateEmbeddingsCache() {
  _embeddingsCache = null;
}

async function getEmbeddingsCached() {
  if (_embeddingsCache) return _embeddingsCache;
  _embeddingsCache = await getAllEmbeddings();
  return _embeddingsCache;
}

/**
 * Scan the local vector index for the nearest neighbors of `queryVec`.
 * Pure cosine over the in-memory copy of the index (no JQL, no extra network
 * beyond the embed() call the caller already made for the query ticket).
 *
 * @param {number[]} queryVec
 * @param {{ topK?: number, minScore?: number, excludeKey?: string, queryModel?: string }} [opts]
 * @returns {Promise<Array<{ key: string, score: number, meta: object, text: string }>>}
 */
export async function vectorSearch(queryVec, opts = {}) {
  const topK = opts.topK ?? VECTOR_TOP_K;
  const minScore = opts.minScore ?? VECTOR_MIN_SCORE;
  const excludeKey = opts.excludeKey || null;
  const queryModel = opts.queryModel || null;
  if (!Array.isArray(queryVec) || queryVec.length === 0) return [];

  const all = await getEmbeddingsCached();
  if (all.length === 0) return [];

  const scored = [];
  for (const rec of all) {
    if (!rec?.vec || rec.vec.length !== queryVec.length) continue;
    // Exclude the source ticket itself (e.g. when searching for similar issues).
    if (excludeKey && rec.key === excludeKey) continue;
    // Skip vectors from a different embedding model - cosine scores across
    // models are meaningless even when dimensions happen to match.
    if (queryModel && rec.model && rec.model !== queryModel) continue;
    // Skip stale-schema records so old vectors don't pollute results after
    // a schemaVersion bump.
    if (rec.schemaVersion !== EMBEDDING_SCHEMA_VERSION) continue;
    const score = cosine(queryVec, rec.vec);
    if (score >= minScore) {
      scored.push({ key: rec.key, score, meta: rec.meta || {}, text: rec.text || '' });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Local index size — used to decide whether to prompt the user to build it.
 */
export async function indexCount() {
  return countEmbeddings();
}

/**
 * Wipe the local similarity index (e.g. after changing the embedding model,
 * which invalidates all existing vectors).
 */
export async function clearIndex() {
  await clearEmbeddings();
  invalidateEmbeddingsCache();
}

/**
 * Lazily build the index if it's empty and embeddings are configured.
 * Fire-and-forget: does NOT block the caller (used as a background refresh
 * so the next similar-ticket search benefits). Failures are silent.
 * @param {object} config
 */
export function ensureIndex(config, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  (async () => {
    try {
      const llm = new LlmClient(config);
      if (!llm.isEmbeddingEnabled) return;
      const count = await countEmbeddings();
      if (count > 0) return; // already built
      await buildIndex(config, { onProgress });
    } catch (err) {
      console.warn('[indexer] ensureIndex skipped:', err.message);
    }
  })();
}
