import { JIRA_FIELDS, MAX_RELATED_ISSUES, MAX_CONFLUENCE_RESULTS, ATLASSIAN_API_BASE, MAX_RERANK_CANDIDATES, RRF_K } from '../shared/constants.js';
import { extractDescriptionText, extractCommentText, formatIssue, formatComment, quoteJql, buildJqlTextClause, buildCqlTextClause } from '../shared/utils.js';
import { IssueExtractor } from '../content/issue-extractor.js';
import { reciprocalRankFusion } from '../shared/rrf.js';

/**
 * Hard timeout for every network call in this client. Without this, a fetch
 * that is accepted by a corporate gateway but never answered (connection stall)
 * would hang `await` forever — which in the orchestrator freezes the whole
 * query on the "thinking" bubble. An AbortController turns that into a clean
 * throw after FETCH_TIMEOUT_MS so the caller can fall back / surface an error.
 */
export const FETCH_TIMEOUT_MS = 30000;

export async function fetchWithTimeout(url, options = {}, ms = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    // Use globalThis.fetch so the wrapper never recurses on itself.
    return await globalThis.fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      const label = typeof url === 'string' ? url : 'request';
      throw new Error(`Network request timed out after ${Math.round(ms / 1000)}s: ${label}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export class ApiClient {
  constructor(config) {
    this.config = config;
  }

  get siteName() {
    const match = (this.config.jiraBaseUrl || '').match(/https?:\/\/([^.]+)\.atlassian\.net/);
    return match ? match[1] : null;
  }

  /**
   * Scoped mode is opt-in: only used when the user explicitly provides a cloudId.
   * Token format alone is not a reliable signal because Atlassian appends an
   * identifier suffix (=XXXXXXXX) to both classic and scoped tokens.
   */
  get isScopedMode() {
    return Boolean(this.config.jiraCloudId);
  }

  get cloudId() {
    return this.config.jiraCloudId || '';
  }

  /**
   * Build the Jira REST API base URL.
   * Default (classic token): https://<site>.atlassian.net
   * Scoped mode (cloudId set): https://api.atlassian.com/ex/jira/<cloudId>
   */
  get jiraApiBase() {
    if (this.isScopedMode) {
      return `${ATLASSIAN_API_BASE}/ex/jira/${this.cloudId}`;
    }
    return (this.config.jiraBaseUrl || '').replace(/\/$/, '');
  }

  get confluenceApiBase() {
    if (this.isScopedMode) {
      return `${ATLASSIAN_API_BASE}/ex/confluence/${this.cloudId}`;
    }
    return (this.config.confluenceBaseUrl || this.config.jiraBaseUrl || '').replace(/\/$/, '');
  }

  get jiraHeaders() {
    const token = btoa(`${this.config.jiraEmail}:${this.config.jiraApiToken}`);
    return {
      'Authorization': `Basic ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
  }

  get confluenceHeaders() {
    const token = btoa(`${this.config.jiraEmail}:${this.config.confluenceApiToken || this.config.jiraApiToken}`);
    return {
      'Authorization': `Basic ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
  }

  /**
   * Auto-resolve cloudId from site URL via Atlassian's public tenant info endpoint.
   * Returns the cloudId string or null.
   */
  static async resolveCloudId(siteUrl) {
    try {
      const res = await fetchWithTimeout(`${siteUrl.replace(/\/$/, '')}/_edge/tenantinfo`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.cloudId || null;
    } catch {
      return null;
    }
  }

  async testJiraConnection() {
    const res = await fetchWithTimeout(`${this.jiraApiBase}/rest/api/3/myself`, { headers: this.jiraHeaders });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Jira connection failed: ${res.status} ${res.statusText}. ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async getIssue(issueKey) {
    const url = `${this.jiraApiBase}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${JIRA_FIELDS}&expand=renderedFields`;
    const res = await fetchWithTimeout(url, { headers: this.jiraHeaders });
    if (!res.ok) throw new Error(`Failed to fetch issue ${issueKey}: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async searchJira(jql, maxResults = MAX_RELATED_ISSUES, startAt = 0) {
    const fields = ['summary', 'status', 'issuetype', 'priority', 'created', 'updated'];
    const fieldsStr = fields.join(',');

    // Jira Cloud search reality (verified against Atlassian's own community
    // reports): the POST variant of /rest/api/3/search/jql (the "enhanced
    // search" endpoint) returns HTTP 400 "Invalid request payload" on a
    // number of Cloud instances and behind some corporate gateways, even with a
    // perfectly valid body. The GET variant of the SAME endpoint
    // (/rest/api/3/search/jql?jql=...) works reliably everywhere. So we lead
    // with GET and only fall back to POST for very long JQL that would exceed
    // URL length limits. The legacy /rest/api/2/search paths are gone (410).
    const attempts = [
      {
        method: 'GET',
        url: `${this.jiraApiBase}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}&fields=${encodeURIComponent(fieldsStr)}`,
        body: null,
        adapt: (data) => ({
          issues: (data.issues || data.values || []),
          total: data.total ?? (data.issues || data.values || []).length,
          _endpoint: 'GET /rest/api/3/search/jql'
        })
      },
      {
        method: 'POST',
        url: `${this.jiraApiBase}/rest/api/3/search/jql`,
        body: { jql, fields, maxResults, startAt },
        adapt: (data) => ({
          issues: (data.issues || data.values || []),
          total: data.total ?? (data.issues || data.values || []).length,
          _endpoint: 'POST /rest/api/3/search/jql'
        })
      }
    ];

    const errors = [];
    for (const attempt of attempts) {
      try {
        const res = await fetchWithTimeout(attempt.url, {
          method: attempt.method,
          headers: this.jiraHeaders,
          body: attempt.body ? JSON.stringify(attempt.body) : undefined
        });
        if (res.status === 404 || res.status === 405 || res.status === 410) {
          const text = await res.text().catch(() => '');
          errors.push(`${attempt.method} ${attempt.url.replace(this.jiraApiBase, '')} → ${res.status} ${text.slice(0, 200)}`);
          console.warn(`[Jira search] ${attempt._endpoint || attempt.method} returned ${res.status}: ${text.slice(0, 200)}`);
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          errors.push(`${attempt.method} ${attempt.url.replace(this.jiraApiBase, '')} → ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
          console.warn(`[Jira search] ${attempt._endpoint || attempt.method} returned ${res.status}: ${text.slice(0, 200)}`);
          continue;
        }
        const data = await res.json();
        console.info(`[Jira search] succeeded via ${attempt._endpoint || attempt.method}`);
        return attempt.adapt(data);
      } catch (err) {
        errors.push(`${attempt.method} → ${err.message}`);
        console.warn(`[Jira search] ${attempt._endpoint || attempt.method} threw: ${err.message}`);
      }
    }

    throw new Error(`All Jira search endpoints failed:\n${errors.join('\n')}`);
  }

  /**
   * Count how many issues match a JQL — WITHOUT pulling their fields.
   * Used by the "List" preview so the user can size the index before spending
   * embed calls.
   *
   * Strategy:
   *   1. POST /rest/api/3/search/approximate-count — one round-trip, instant.
   *      (Fast but POST-only; some corporate gateways block it, so we guard it.)
   *   2. Fallback: GET /rest/api/3/search/jql paginated with `nextPageToken`,
   *      requesting only ids, summing page sizes until `isLast`. This is the
   *      GET path proven to work behind gateways where POST is rejected.
   *
   * @param {string} jql - should NOT contain ORDER BY (irrelevant for count)
   * @param {{ exact?: boolean }} [opts]
   * @returns {Promise<{count:number, capped:boolean, approximate:boolean}>}
   */
  async countJira(jql, { exact = false } = {}) {
    // 1) Fast path: approximate-count (single request). NOTE: this endpoint
    // returns an *estimate* — Atlassian explicitly documents it as approximate
    // and it can be materially off for some JQL shapes. Use it for a quick
    // preview only; pass { exact:true } (or verify the JQL in Jira's own
    // search) when you need the true number.
    if (!exact) {
      try {
        const res = await fetchWithTimeout(`${this.jiraApiBase}/rest/api/3/search/approximate-count`, {
          method: 'POST',
          headers: this.jiraHeaders,
          body: JSON.stringify({ jql })
        });
        if (res.ok) {
          const data = await res.json();
          if (typeof data.count === 'number') {
            return { count: data.count, capped: false, approximate: true };
          }
        }
      } catch {
        /* gateway may block POST — fall through to GET pagination */
      }
    }

    // 2) Reliable path: paginate ids via the enhanced GET endpoint.
    // Exact count (no estimation). HARD_CAP is only a safety ceiling so a
    // pathological instance can't hang the UI — it is well above realistic
    // ticket volumes, so a normal count is never truncated.
    const PAGE = 100;
    const HARD_CAP = 60000;
    const MAX_PAGES = 600;
    let count = 0;
    let nextPageToken = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      let url = `${this.jiraApiBase}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${PAGE}&fields=id`;
      if (nextPageToken) url += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
      const res = await fetchWithTimeout(url, { headers: this.jiraHeaders });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Count query failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const issues = data.issues || data.values || [];
      count += issues.length;
      if (count >= HARD_CAP) return { count, capped: true, approximate: false };
      if (data.isLast || !data.nextPageToken || issues.length === 0) break;
      nextPageToken = data.nextPageToken;
    }
    return { count, capped: false, approximate: false };
  }

  /**
   * Discover the custom field id for "Organizations" (Jira Service Management).
   * Returns the id (e.g. "customfield_10002") or null if not found. Cached
   * on the instance to avoid repeated /field calls.
   */
  async findOrganizationsFieldId() {
    if (this._orgFieldCache !== undefined) return this._orgFieldCache;
    try {
      const res = await fetchWithTimeout(`${this.jiraApiBase}/rest/api/3/field`, { headers: this.jiraHeaders });
      if (!res.ok) { this._orgFieldCache = null; return null; }
      const fields = await res.json();
      const orgField = (fields || []).find(
        f => f.name && /organization/i.test(f.name) && /^customfield_/.test(f.id)
      );
      this._orgFieldCache = orgField?.id || null;
    } catch {
      this._orgFieldCache = null;
    }
    return this._orgFieldCache;
  }

  /**
   * Search issues assigned to the current user with the given statuses,
   * returning full issue records including Organizations (if available).
   * @param {string[]} statuses  e.g. ['Waiting for Customer', 'Waiting for Support']
   * @param {number} maxResults
   * @returns {Promise<object[]>} raw issue array
   */
  async searchMyOpenIssues(statuses, maxResults = 100) {
    const orgFieldId = await this.findOrganizationsFieldId();
    const fields = ['summary', 'status', 'issuetype', 'priority', 'created', 'updated',
      'comment', 'description', 'reporter', 'labels', 'components'];
    if (orgFieldId) fields.push(orgFieldId);
    const fieldsStr = fields.join(',');

    const statusList = statuses.map(s => `"${s.replace(/"/g, '\\"')}"`).join(', ');
    const jql = `assignee = currentUser() AND status in (${statusList}) ORDER BY updated DESC`;

    // Use searchJira but override fields to include our extras. Reuse the
    // endpoint cascade by calling the same logic inline.
    const attempts = [
      {
        method: 'GET',
        url: `${this.jiraApiBase}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${encodeURIComponent(fieldsStr)}`,
        body: null,
      },
      {
        method: 'POST',
        url: `${this.jiraApiBase}/rest/api/3/search/jql`,
        body: { jql, fields, maxResults },
      }
    ];
    for (const attempt of attempts) {
      try {
        const res = await fetchWithTimeout(attempt.url, {
          method: attempt.method,
          headers: this.jiraHeaders,
          body: attempt.body ? JSON.stringify(attempt.body) : undefined
        });
        if (res.status === 404 || res.status === 405 || res.status === 410) continue;
        if (!res.ok) continue;
        const data = await res.json();
        return data.issues || data.values || [];
      } catch {
        continue;
      }
    }
    throw new Error('All Jira search endpoints failed while fetching open issues.');
  }

  async searchConfluence(query, maxResults = MAX_CONFLUENCE_RESULTS, space = null) {
    if (!this.config.confluenceBaseUrl && !this.isScopedMode) return { results: [] };

    const parts = [`text ~ ${quoteJql(query)}`, `type = page`];
    if (space) {
      parts.push(`space = ${quoteJql(space.toUpperCase())}`);
    }
    const cql = parts.join(' AND ') + ' ORDER BY lastModified DESC';
    const url = `${this.confluenceApiBase}/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${maxResults}&expand=content.body.view`;
    const res = await fetchWithTimeout(url, { headers: this.confluenceHeaders });
    if (!res.ok) throw new Error(`Confluence search failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /**
   * Hybrid Confluence search using LLM-expanded terms.
   *
   * Mirrors the Jira hybrid pipeline: each term searches BOTH title and text
   * (title matches rank higher in Confluence's relevance scoring), OR-ed
   * together for wide recall. Falls back to the simple `text ~` search when
   * no expansion is provided.
   *
   * @param {string[]} terms - primaryTerms + synonyms from query-expander
   * @param {number} maxResults
   * @param {string|null} space
   * @returns {Promise<object>} raw Confluence search response
   */
  async searchConfluenceHybrid(terms, maxResults = MAX_CONFLUENCE_RESULTS, space = null) {
    if (!this.config.confluenceBaseUrl && !this.isScopedMode) return { results: [] };
    if (!Array.isArray(terms) || terms.length === 0) {
      return { results: [] };
    }

    const textOr = terms.map((t) => buildCqlTextClause(t)).join(' OR ');
    const parts = [`(${textOr})`, `type = page`];
    if (space) {
      parts.push(`space = ${quoteJql(space.toUpperCase())}`);
    }
    const cql = parts.join(' AND ') + ' ORDER BY lastModified DESC';
    const url = `${this.confluenceApiBase}/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${maxResults}&expand=content.body.view`;
    const res = await fetchWithTimeout(url, { headers: this.confluenceHeaders });
    if (!res.ok) throw new Error(`Confluence search failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async searchConfluenceForIssue(issue) {
    const fields = issue.fields || {};
    const summaryKeywords = fields.summary
      ? fields.summary.split(/\s+/).filter(w => w.length > 3).slice(0, 6).join(' ')
      : '';
    if (!summaryKeywords) return { results: [] };
    return this.searchConfluence(summaryKeywords, MAX_CONFLUENCE_RESULTS);
  }

  /**
   * Fetch all issues linked to the given issue via Jira's issuelinks field.
   * Walks outward + inward links, dedupes keys, and fetches each linked
   * issue's full record. Uses an optional in-memory cache (Map keyed by
   * `rawIssue:<key>`) to avoid refetching issues already seen in this
   * session.
   *
   * Channel C of the hybrid pipeline.
   *
   * @param {object} issue - raw Jira issue (must include fields.issuelinks)
   * @param {Map<string, object>} [cache] - optional rawIssue cache
   * @returns {Promise<object[]>} linked issues (raw shape)
   */
  async fetchLinkedIssues(issue, cache = null) {
    const links = issue?.fields?.issuelinks || [];
    const keys = new Set();
    for (const link of links) {
      const related = link.outwardIssue || link.inwardIssue;
      if (related?.key && related.key !== issue.key) {
        keys.add(related.key);
      }
    }
    if (keys.size === 0) return [];

    const results = await Promise.allSettled(
      Array.from(keys).map(async (k) => {
        const cacheKey = `rawIssue:${k}`;
        if (cache?.has(cacheKey)) return cache.get(cacheKey);
        try {
          const fetched = await this.getIssue(k);
          if (cache) cache.set(cacheKey, fetched);
          return fetched;
        } catch (err) {
          console.warn(`[hybrid] failed to fetch linked issue ${k}:`, err.message);
          return null;
        }
      })
    );
    return results
      .filter((r) => r.status === 'fulfilled' && r.value)
      .map((r) => r.value);
  }

  /**
   * Hybrid retrieval for similar-issue search.
   *
   * When `options.summary` is provided (LLM-extracted ticket summary):
   *   Channel A (tier 1): project + components + (text OR summary.searchKeywords)
   *   Channel B (tier 2): project + (text OR summary.synonyms)
   *   Channel C (tier 3): linked issues of the source ticket
   *   Channels are merged with Reciprocal Rank Fusion (k=60), top `maxResults`
   *   returned. Each issue carries `_rrfScore` and `_tier`.
   *
   * When `options.summary` is absent (LLM unavailable, or preloading the
   * cache): falls back to the legacy 3-tier cascade — same project + component,
   *   same project, cross-project — sorted by tier asc + updated desc.
   *   Returns top MAX_RELATED_ISSUES.
   *
   * @param {object} issue - raw Jira issue
   * @param {{summary?: object, maxResults?: number, includeCrossProject?: boolean, issueCache?: Map}} [options]
   * @returns {Promise<{issues: object[], tokens?: string[], queries?: string[], channels?: object}>}
   */
  async searchRelatedIssues(issue, options = {}) {
    const fields = issue.fields || {};
    const projectKey = issue.key.split('-')[0];
    const components = (fields.components || []).map(c => c.name);
    const excludeCurrent = `key != ${issue.key}`;
    const hints = IssueExtractor.extractIpHints(fields);

    // --- Legacy fallback: no LLM summary → tier cascade (old behavior) ---
    if (!options.summary) {
      return this._searchRelatedIssuesLegacy(issue, options);
    }

    const summary = options.summary;
    const maxResults = options.maxResults ?? MAX_RERANK_CANDIDATES;

    // Build keyword set: searchKeywords from LLM + IP hints + raw summary tokens.
    const kwSet = new Set([
      ...(summary.searchKeywords || []),
      ...(hints?.keywords || []),
      hints?.coreName,
      hints?.productLine
    ].filter(Boolean));
    const keywords = Array.from(kwSet).filter(k => k.length >= 3).slice(0, 8);
    const synonyms = (summary.synonyms || []).filter(s => s.length >= 3).slice(0, 6);

    const queries = [];

    // Channel A: project + components + keywords (BM25 precise channel)
    if (keywords.length > 0) {
      const textOr = keywords.map(t => buildJqlTextClause(t)).join(' OR ');
      const compClause = components.length > 0
        ? ` AND component in (${components.map(quoteJql).join(',')})`
        : '';
      queries.push({
        tier: 1,
        jql: `project = ${projectKey} AND ${excludeCurrent}${compClause} AND (${textOr}) ORDER BY updated DESC`
      });
    }

    // Channel B: project + synonyms (semantic-approx channel)
    if (synonyms.length > 0) {
      const textOr = synonyms.map(t => buildJqlTextClause(t)).join(' OR ');
      queries.push({
        tier: 2,
        jql: `project = ${projectKey} AND ${excludeCurrent} AND (${textOr}) ORDER BY updated DESC`
      });
    }

    if (queries.length === 0) {
      return { issues: [], reason: 'no_keywords', channels: {} };
    }

    // Run BM25 + semantic channels in parallel via Jira search.
    const settled = await Promise.allSettled(
      queries.map(async q => {
        const res = await this.searchJira(q.jql, maxResults);
        return { tier: q.tier, issues: res.issues || [] };
      })
    );

    const rankedLists = [];
    const tierByKey = new Map();
    for (const r of settled) {
      if (r.status !== 'fulfilled' || !r.value.issues.length) continue;
      rankedLists.push(r.value.issues);
      for (const it of r.value.issues) {
        if (!tierByKey.has(it.key)) tierByKey.set(it.key, r.value.tier);
      }
    }

    // Channel C: linked issues (linkage). Fetch via the optional rawIssue cache
    // so we don't refetch issues already seen this session.
    let linkedIssues = [];
    try {
      linkedIssues = await this.fetchLinkedIssues(issue, options.issueCache || null);
      if (linkedIssues.length > 0) {
        rankedLists.push(linkedIssues);
        for (const it of linkedIssues) {
          if (!tierByKey.has(it.key)) tierByKey.set(it.key, 3);
        }
      }
    } catch (err) {
      console.warn('[hybrid] linked-issues fetch failed:', err.message);
    }

    if (rankedLists.length === 0) {
      return { issues: [], reason: 'all_channels_empty', channels: {} };
    }

    // RRF merge: each list is already ranked (best first by Jira's ORDER BY).
    const fused = reciprocalRankFusion(rankedLists, { k: RRF_K, keyFn: (it) => it.key });
    const merged = fused.map((entry) => ({
      ...entry.item,
      _rrfScore: entry.score,
      _tier: tierByKey.get(entry.item.key) ?? 99
    }));

    return {
      issues: merged.slice(0, maxResults),
      tokens: keywords,
      synonyms,
      channels: {
        A: queries.find(q => q.tier === 1)?.jql || null,
        B: queries.find(q => q.tier === 2)?.jql || null,
        C: linkedIssues.length
      }
    };
  }

  /**
   * Legacy 3-tier cascade. Used when no LLM summary is available (LLM not
   * configured, summarize call failed, or chat-orchestrator preload path).
   *
   * Same project + component → same project → cross-project, OR-ed text
   * tokens from summary + IP hints. Sorted by tier asc, then updated desc.
   */
  async _searchRelatedIssuesLegacy(issue, options = {}) {
    const fields = issue.fields || {};
    const projectKey = issue.key.split('-')[0];
    const components = (fields.components || []).map(c => c.name);

    const summaryWords = fields.summary
      ? fields.summary.split(/\s+/).filter(w => w.length > 3 && /^[A-Za-z]/.test(w)).slice(0, 6)
      : [];
    const keywordSet = new Set(summaryWords);
    const hints = IssueExtractor.extractIpHints(fields);
    if (hints.coreName) keywordSet.add(hints.coreName);
    if (hints.productLine) keywordSet.add(hints.productLine);
    if (Array.isArray(hints.keywords)) {
      for (const kw of hints.keywords.slice(0, 5)) {
        if (kw.length >= 3) keywordSet.add(kw);
      }
    }
    const tokens = Array.from(keywordSet).filter(k => k.length >= 3).slice(0, 8);

    if (tokens.length === 0) {
      return { issues: [], reason: 'no_keywords' };
    }

    const textOr = tokens.map(t => buildJqlTextClause(t)).join(' OR ');
    const excludeCurrent = `key != ${issue.key}`;
    const includeCrossProject = options.includeCrossProject !== false;

    const queries = [];
    if (components.length > 0) {
      queries.push({
        tier: 1,
        jql: `project = ${projectKey} AND ${excludeCurrent} AND component in (${components.map(quoteJql).join(',')}) AND (${textOr}) ORDER BY updated DESC`
      });
    }
    queries.push({
      tier: 2,
      jql: `project = ${projectKey} AND ${excludeCurrent} AND (${textOr}) ORDER BY updated DESC`
    });
    if (includeCrossProject) {
      queries.push({
        tier: 3,
        jql: `${excludeCurrent} AND (${textOr}) ORDER BY updated DESC`
      });
    }

    const settled = await Promise.allSettled(
      queries.map(async q => {
        const res = await this.searchJira(q.jql, MAX_RELATED_ISSUES);
        return { tier: q.tier, issues: res.issues || [] };
      })
    );

    const byKey = new Map();
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue;
      for (const it of r.value.issues) {
        const existing = byKey.get(it.key);
        if (!existing || r.value.tier < existing._tier) {
          byKey.set(it.key, { ...it, _tier: r.value.tier });
        }
      }
    }

    const merged = Array.from(byKey.values());
    merged.sort((a, b) => {
      if (a._tier !== b._tier) return a._tier - b._tier;
      return new Date(b.fields?.updated || 0) - new Date(a.fields?.updated || 0);
    });

    return {
      issues: merged.slice(0, MAX_RELATED_ISSUES),
      tokens,
      queries: queries.map(q => q.jql)
    };
  }
}

/**
 * Lightweight Slack Web API client.
 * Requires a user or bot token (xoxp- or xoxb-). User tokens can search;
 * bot tokens cannot call search.* methods — they need channels:history etc.
 */
export class SlackClient {
  constructor(token) {
    this.token = token;
  }

  get headers() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/json'
    };
  }

  get isEnabled() {
    return Boolean(this.token);
  }

  /**
   * Search messages across all channels the user can access.
   * Slack free tier: only the latest 10k messages are searchable.
   * @param {string} query
   * @param {number} count
   */
  async searchMessages(query, count = 10) {
    const url = `https://slack.com/api/search.messages?query=${encodeURIComponent(query)}&count=${count}`;
    const res = await fetchWithTimeout(url, { headers: this.headers });
    if (!res.ok) throw new Error(`Slack search failed: ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error: ${data.error || 'unknown'}`);
    return data;
  }

  /**
   * Search files shared in Slack.
   */
  async searchFiles(query, count = 5) {
    const url = `https://slack.com/api/search.files?query=${encodeURIComponent(query)}&count=${count}`;
    const res = await fetchWithTimeout(url, { headers: this.headers });
    if (!res.ok) throw new Error(`Slack file search failed: ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error: ${data.error || 'unknown'}`);
    return data;
  }

  /**
   * Fetch recent messages from a channel (by name or ID).
   * @param {string} channel channel ID or name
   * @param {number} limit
   */
  async channelHistory(channel, limit = 50) {
    // Resolve channel name to ID if needed
    let channelId = channel;
    if (!/^[A-Z0-9]+$/.test(channel) || channel.length < 9) {
      const listRes = await fetchWithTimeout(`https://slack.com/api/conversations.list?limit=999`, { headers: this.headers });
      const list = await listRes.json();
      if (!list.ok) throw new Error(`Slack list failed: ${list.error}`);
      const found = list.channels?.find(c => c.name === channel.toLowerCase());
      if (!found) throw new Error(`Channel not found: ${channel}`);
      channelId = found.id;
    }

    const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channelId)}&limit=${limit}`;
    const res = await fetchWithTimeout(url, { headers: this.headers });
    if (!res.ok) throw new Error(`Slack history failed: ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error: ${data.error || 'unknown'}`);
    return data;
  }

  /**
   * Fetch all replies in a thread.
   * @param {string} channel
   * @param {string} ts
   */
  async threadReplies(channel, ts) {
    const url = `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(ts)}&limit=200`;
    const res = await fetchWithTimeout(url, { headers: this.headers });
    if (!res.ok) throw new Error(`Slack thread failed: ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error: ${data.error || 'unknown'}`);
    return data;
  }

  async testConnection() {
    const res = await fetchWithTimeout('https://slack.com/api/auth.test', { headers: this.headers });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack auth failed: ${data.error || 'unknown'}`);
    return data;
  }
}

export function simplifySlackMessages(response) {
  const matches = response?.messages?.matches || [];
  return matches.map(m => ({
    text: (m.text || '').slice(0, 500),
    user: m.user,
    channel: m.channel?.name || m.channel?.id,
    permalink: m.permalink,
    timestamp: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : null
  }));
}

export function simplifySlackFiles(response) {
  const matches = response?.files?.matches || [];
  return matches.map(f => ({
    name: f.name,
    title: f.title,
    mimetype: f.mimetype,
    url: f.url_private || f.permalink,
    size: f.size
  }));
}

/**
 * Google Drive client using chrome.identity OAuth 2.0.
 * Requires the user to set up a Google Cloud OAuth Client ID of type
 * "Chrome Extension" and paste the client_id into manifest.json's oauth2 field.
 */
export class DriveClient {
  /**
   * Acquire (or refresh) an OAuth 2.0 access token via the Chrome Identity API.
   * @param {boolean} interactive — whether to show the Google consent UI
   * @returns {Promise<string|null>} access token, or null if not granted
   */
  static async getAuthToken(interactive = false) {
    return new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (chrome.runtime.lastError || !token) {
          resolve(null);
          return;
        }
        resolve(token);
      });
    });
  }

  static async removeCachedToken(token) {
    return new Promise((resolve) => {
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    });
  }

  constructor(token) {
    this.token = token;
  }

  get headers() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/json'
    };
  }

  /**
   * Search files in the user's Google Drive by name or full-text content.
   * @param {string} query — natural language query; converted to Drive Q syntax
   * @param {number} maxResults
   */
  async searchFiles(query, maxResults = 10) {
    // Drive Q syntax: name contains 'foo' or fullText contains 'foo'
    // We search both, joined with OR.
    const escaped = query.replace(/'/g, "\\'");
    const q = `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`;
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${maxResults}&fields=files(id,name,mimeType,modifiedTime,webViewLink)`;
    const res = await fetchWithTimeout(url, { headers: this.headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Drive search failed: ${res.status} ${res.statusText}. ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  /**
   * Read a file's plain-text content. Handles Google Docs, Sheets, and common types.
   * @param {string} fileId
   */
  async readFile(fileId) {
    const metaRes = await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,modifiedTime,webViewLink`, { headers: this.headers });
    if (!metaRes.ok) throw new Error(`Drive metadata failed: ${metaRes.status}`);
    const meta = await metaRes.json();

    const mimeType = meta.mimeType || '';
    let content = '';

    if (mimeType === 'application/vnd.google-apps.document') {
      // Google Docs: export as plain text
      const res = await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, { headers: this.headers });
      content = await res.text();
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      // Google Sheets: read a large fixed range. Very large sheets may still
      // be truncated; a full solution would page through the sheet.
      const res = await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/A1:ZZ10000`, { headers: this.headers });
      if (res.ok) {
        const data = await res.json();
        content = (data.values || []).map(row => row.join('\t')).join('\n');
      }
    } else if (mimeType === 'application/vnd.google-apps.presentation') {
      const res = await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, { headers: this.headers });
      content = await res.text();
    } else if (mimeType.startsWith('text/') || mimeType === 'application/json') {
      const res = await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: this.headers });
      content = await res.text();
    } else if (mimeType === 'application/pdf') {
      // PDF: export as plain text (limited but usually works)
      const res = await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, { headers: this.headers });
      content = await res.text();
    } else {
      content = `[Binary file: ${mimeType}. Content not extractable.]`;
    }

    return {
      ...meta,
      content: content.slice(0, 8000) // truncate to keep prompts manageable
    };
  }

  /**
   * Get the user's profile to validate the token.
   */
  async testConnection() {
    const res = await fetchWithTimeout('https://www.googleapis.com/drive/v3/about?fields=user', { headers: this.headers });
    if (!res.ok) throw new Error(`Drive connection failed: ${res.status}`);
    const data = await res.json();
    return data.user || {};
  }
}

export function simplifyDriveFiles(response) {
  return (response?.files || []).map(f => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    url: f.webViewLink
  }));
}

export function simplifyIssue(issue) {
  const fields = issue.fields || {};
  return {
    key: issue.key,
    summary: fields.summary || '',
    description: extractDescriptionText(fields.description),
    status: fields.status?.name || '',
    issueType: fields.issuetype?.name || '',
    priority: fields.priority?.name || '',
    reporter: fields.reporter?.displayName || '',
    labels: fields.labels || [],
    components: (fields.components || []).map(c => c.name),
    created: fields.created,
    updated: fields.updated,
    comments: (fields.comment?.comments || [])
      .slice(-10)
      .map(formatComment),
    linkedIssues: (fields.issuelinks || []).map(link => {
      const related = link.outwardIssue || link.inwardIssue;
      return related ? { key: related.key, type: link.type?.name || '', summary: related.fields?.summary || '' } : null;
    }).filter(Boolean)
  };
}

export function simplifySearchResults(response) {
  return (response.issues || []).map(issue => ({
    key: issue.key,
    summary: issue.fields?.summary || '',
    status: issue.fields?.status?.name || '',
    issueType: issue.fields?.issuetype?.name || '',
    priority: issue.fields?.priority?.name || '',
    updated: issue.fields?.updated
  }));
}

export function simplifyConfluenceResults(response) {
  return (response.results || []).map(r => ({
    title: r.content?.title || '',
    url: r.content?._links?.webui || '',
    excerpt: r.excerpt || r.content?.body?.view?.value || ''
  }));
}
