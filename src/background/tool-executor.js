import { ApiClient, simplifyIssue, simplifySearchResults, simplifyConfluenceResults, SlackClient, simplifySlackMessages, simplifySlackFiles, DriveClient, simplifyDriveFiles } from './api-client.js';
import { extractTextFromHtml, parseAtlassianUrl, detectIssueKey, truncateToTokens, buildJqlTextClause } from '../shared/utils.js';
import { reciprocalRankFusion } from '../shared/rrf.js';
import { MAX_RERANK_CANDIDATES, MAX_RERANKED_RESULTS, RRF_K } from '../shared/constants.js';
import { getOrSummarize } from './ticket-summarizer.js';
import { getOrExpand } from './query-expander.js';
import { rerankCandidates } from './reranker.js';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'and', 'or', 'not', 'no', 'but', 'if', 'then', 'else', 'of', 'to',
  'in', 'on', 'at', 'by', 'for', 'with', 'about', 'as', 'into', 'like',
  'this', 'that', 'these', 'those', 'it', 'they', 'he', 'she', 'we',
  'you', 'i', 'me', 'my', 'our', 'their', 'his', 'her',
  'how', 'what', 'when', 'where', 'why', 'who', 'which',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will',
  'have', 'has', 'had', 'get', 'got', 'find', 'show', 'tell',
  'from', 'up', 'down', 'out', 'over', 'under', 'again',
  'all', 'any', 'some', 'one', 'two', 'three',
  'issue', 'ticket', 'bug', 'task', 'story',  // generic jira words
  'please', 'help', 'need', 'want', 'try'
]);

/**
 * Build a fuzzy JQL from a natural-language query.
 *
 * Strategy:
 * 1. Tokenize, lowercase, strip punctuation
 * 2. Drop stop words and very short tokens
 * 3. For each surviving token, build a `text ~ "tok*"` clause — the trailing
 *    `*` is a prefix wildcard so "auth" matches "authentication", "authorize",
 *    etc. (Jira's `~` operator is already fuzzy, the wildcard makes it
 *    more permissive)
 * 4. OR the clauses together so the result includes any issue that mentions
 *    any of the keywords
 * 5. AND in optional filters (project, status, issueType)
 *
 * @param {string} query
 * @param {{project?: string, status?: string, issueType?: string}} filters
 * @returns {string}
 */
function buildFuzzyJql(query, filters = {}) {
  const tokens = (query || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));

  const clauses = [];

  if (tokens.length === 0) {
    // Fallback: search the raw query as a phrase
    clauses.push(`text ~ "${escapeJqlString(query)}"`);
  } else {
    // Each token becomes a text clause (prefix wildcard for single words,
    // phrase match for multi-word). OR them together for high recall.
    const tokenClauses = tokens.map(t => buildJqlTextClause(t)).join(' OR ');
    clauses.push(`(${tokenClauses})`);
  }

  if (filters.project) {
    clauses.push(`project = ${escapeJqlIdent(filters.project.toUpperCase())}`);
  }
  if (filters.status) {
    clauses.push(`status = "${escapeJqlString(filters.status)}"`);
  }
  if (filters.issueType) {
    clauses.push(`issuetype = "${escapeJqlString(filters.issueType)}"`);
  }

  return clauses.join(' AND ') + ' ORDER BY updated DESC';
}

function escapeJqlString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeJqlIdent(s) {
  // For identifiers like project keys — only allow [A-Z0-9_]
  return String(s).replace(/[^A-Z0-9_]/gi, '');
}

export class ToolExecutor {
  constructor(config, contextState = null, llm = null) {
    this.api = new ApiClient(config);
    this.slack = new SlackClient(config.slackToken);
    this.driveToken = config.driveToken || null;
    this.contextState = contextState;
    this.llm = llm;
    this.config = config;
    this.cache = new Map();
  }

  async execute(toolName, args) {
    switch (toolName) {
      case 'read_url':
        return this.readUrl(args.url);
      case 'get_issue':
        return this.getIssue(args.issueKey);
      case 'search_jira':
        return this.searchJira(args);
      case 'search_confluence':
        return this.searchConfluence(args.query ? args : { query: args });
      case 'search_slack':
        return this.searchSlack(args);
      case 'read_slack_channel':
        return this.readSlackChannel(args);
      case 'search_drive':
        return this.searchDrive(args);
      case 'read_drive_file':
        return this.readDriveFile(args);
      case 'find_similar_issues':
        return this.findSimilarIssues(args);
      case 'set_context':
        return this.setContext(args);
      case 'summarize_context':
        return this.summarizeContext();
      case 'suggest_reply':
        return this.suggestReply(args.tone, args.language);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async setContext(args) {
    if (!this.contextState) {
      return { error: 'Context state not available' };
    }
    const lock = args.lock !== false;
    await this.contextState.set(args.product, args.config, args.customer || 'general', lock);
    return {
      context: this.contextState.get(),
      display: this.contextState.toDisplayString()
    };
  }

  async ensureDriveClient() {
    let token = this.driveToken;
    if (!token) {
      token = await DriveClient.getAuthToken(false);
      if (token) {
        this.driveToken = token;
        // Cache in storage so we don't re-prompt every worker restart
        await chrome.storage.local.set({ driveToken: token });
      } else {
        // Try interactive only on first call; subsequent silent failures should
        // tell the user to connect via the options page.
        return null;
      }
    }
    return new DriveClient(token);
  }

  async searchDrive(args) {
    const query = args.query || (typeof args === 'string' ? args : '');
    if (!query) return { error: 'Missing query parameter' };
    const drive = await this.ensureDriveClient();
    if (!drive) {
      return { error: 'Google Drive not connected. Open extension settings and click "Connect Google Drive".' };
    }
    try {
      const result = await drive.searchFiles(query, args.maxResults || 10);
      return {
        query,
        files: simplifyDriveFiles(result)
      };
    } catch (err) {
      // If token expired, drop the cached one so the next call re-auths
      this.driveToken = null;
      await chrome.storage.local.remove('driveToken');
      return { error: err.message };
    }
  }

  async readDriveFile(args) {
    const fileId = args.fileId;
    if (!fileId) return { error: 'Missing fileId parameter' };
    const drive = await this.ensureDriveClient();
    if (!drive) {
      return { error: 'Google Drive not connected. Open extension settings and click "Connect Google Drive".' };
    }
    try {
      const file = await drive.readFile(fileId);
      return {
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        url: file.webViewLink,
        content: file.content
      };
    } catch (err) {
      this.driveToken = null;
      await chrome.storage.local.remove('driveToken');
      return { error: err.message };
    }
  }

  async searchSlack(args) {
    if (!this.slack.isEnabled) {
      return { error: 'Slack not configured. Add a Slack token in extension settings.' };
    }
    const query = args.query || (typeof args === 'string' ? args : '');
    if (!query) return { error: 'Missing query parameter' };
    const count = args.count || 10;
    try {
      const messagesRes = await this.slack.searchMessages(query, count);
      const simplified = simplifySlackMessages(messagesRes);
      return {
        query,
        messages: simplified,
        total: messagesRes.messages?.total || simplified.length,
        pagination: messagesRes.messages?.pagination ? {
          total: messagesRes.messages.pagination.total_count,
          page: messagesRes.messages.pagination.page,
          pageCount: messagesRes.messages.pagination.page_count
        } : null
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  async readSlackChannel(args) {
    if (!this.slack.isEnabled) {
      return { error: 'Slack not configured. Add a Slack token in extension settings.' };
    }
    const { channel, limit, threadTs } = args;
    if (!channel) return { error: 'Missing channel parameter' };
    try {
      if (threadTs) {
        const data = await this.slack.threadReplies(channel, threadTs);
        return {
          channel,
          threadTs,
          messages: (data.messages || []).map(m => ({
            text: (m.text || '').slice(0, 1000),
            user: m.user,
            timestamp: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : null,
            threadTs: m.thread_ts
          }))
        };
      }
      const data = await this.slack.channelHistory(channel, limit || 50);
      return {
        channel,
        messages: (data.messages || []).map(m => ({
          text: (m.text || '').slice(0, 1000),
          user: m.user,
          timestamp: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : null,
          threadTs: m.thread_ts
        }))
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  async readUrl(url) {
    if (!url || typeof url !== 'string') {
      return { error: 'Missing url parameter' };
    }

    const parsed = parseAtlassianUrl(url);

    if (parsed.type === 'jira-issue') {
      const issue = await this.getIssue(parsed.issueKey);
      // Promote to currentIssue so subsequent find_similar_issues /
      // summarize_context / suggest_reply calls work without the LLM
      // having to pass the key explicitly.
      this.cache.set('currentIssue', issue);

      return {
        url,
        kind: 'jira-issue',
        title: `${issue.key}: ${issue.summary}`,
        content: this.formatIssueAsText(issue)
      };
    }

    if (parsed.type === 'confluence-page') {
      const page = await this.fetchConfluencePage(parsed.pageId);
      return {
        url,
        kind: 'confluence-page',
        title: page.title,
        content: page.text
      };
    }

    // Generic web page fetch
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'JiraAIAssistant/1.0 (Chrome Extension)' },
        redirect: 'follow',
        credentials: 'omit'
      });
      if (!res.ok) {
        return { url, error: `HTTP ${res.status} ${res.statusText}` };
      }
      const contentType = res.headers.get('content-type') || '';
      const raw = await res.text();

      if (contentType.includes('application/json')) {
        let json;
        try { json = JSON.parse(raw); } catch { json = { raw }; }
        return {
          url,
          kind: 'json',
          title: '',
          content: truncateToTokens(JSON.stringify(json, null, 2), 4000)
        };
      }

      const { title, text } = extractTextFromHtml(raw);
      return {
        url,
        kind: 'html',
        title,
        content: truncateToTokens(text, 6000)
      };
    } catch (err) {
      if (err.name === 'TypeError' && /fetch|failed|network|CORS/i.test(err.message)) {
        return {
          url,
          error: `Cannot fetch ${url}. The extension may not have host permission for this site, or the site blocked the request. Jira/Confluence/Slack/Google Drive URLs use authenticated APIs and do not need this permission.`
        };
      }
      return { url, error: err.message };
    }
  }

  async fetchConfluencePage(pageId) {
    const url = `${this.api.confluenceApiBase}/wiki/rest/api/content/${pageId}?expand=body.view,space,version`;
    const res = await fetch(url, { headers: this.api.confluenceHeaders });
    if (!res.ok) throw new Error(`Confluence fetch failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const bodyText = extractTextFromHtml(data.body?.view?.value || '').text;
    return {
      title: data.title || '',
      text: truncateToTokens(bodyText, 6000)
    };
  }

  formatIssueAsText(issue) {
    const lines = [
      `Key: ${issue.key}`,
      `Summary: ${issue.summary}`,
      `Status: ${issue.status} | Type: ${issue.issueType} | Priority: ${issue.priority}`,
      `Reporter: ${issue.reporter}`
    ];
    if (issue.labels?.length) lines.push(`Labels: ${issue.labels.join(', ')}`);
    if (issue.components?.length) lines.push(`Components: ${issue.components.join(', ')}`);
    if (issue.description) lines.push('', 'Description:', issue.description);
    if (issue.comments?.length) {
      lines.push('', 'Comments:');
      for (const c of issue.comments) lines.push(`- ${c}`);
    }
    if (issue.linkedIssues?.length) {
      lines.push('', 'Linked issues:');
      for (const l of issue.linkedIssues) lines.push(`- ${l.key} (${l.type}): ${l.summary}`);
    }
    return truncateToTokens(lines.join('\n'), 6000);
  }

  async getIssue(issueKey) {
    if (!issueKey) {
      return { error: 'Missing issueKey parameter' };
    }
    const cacheKey = `issue:${issueKey}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const issue = await this.api.getIssue(issueKey);
    const simplified = simplifyIssue(issue);
    this.cache.set(cacheKey, simplified);
    this.cache.set(`rawIssue:${issueKey}`, issue);
    return simplified;
  }

  async searchJira(args) {
    // Accept both string (legacy) and object (rich) input
    const query = typeof args === 'string' ? args : args?.query;
    const project = typeof args === 'object' ? args?.project : null;
    const status = typeof args === 'object' ? args?.status : null;
    const issueType = typeof args === 'object' ? args?.issueType : null;
    const maxResults = (typeof args === 'object' ? args?.maxResults : null) || 10;

    if (!query) return { error: 'Missing query parameter' };

    // If user passed a full JQL string, run it verbatim (no rerank).
    if (/(=|!=|~|!~|\bIN\b|\bNOT IN\b|\bAND\b|\bOR\b|\bORDER BY\b)/i.test(query)) {
      const result = await this.api.searchJira(query, maxResults);
      return {
        query,
        jql: query,
        issues: simplifySearchResults(result),
        total: result.total,
        endpoint: result._endpoint
      };
    }

    // Try LLM-expanded hybrid retrieval: Channel A (primaryTerms, BM25-precise)
    // + Channel B (synonyms, semantic-approx), merged with RRF and reranked.
    // Falls back to the legacy single-channel fuzzy JQL when LLM is unavailable
    // or expansion fails.
    const expansion = this.llm ? await getOrExpand(query, this.llm) : null;

    if (!expansion || (!expansion.primaryTerms?.length && !expansion.synonyms?.length)) {
      const jql = buildFuzzyJql(query, { project, status, issueType });
      const result = await this.api.searchJira(jql, maxResults);
      return {
        query,
        jql,
        issues: simplifySearchResults(result),
        total: result.total,
        endpoint: result._endpoint,
        reranked: false
      };
    }

    // Build the two JQL channels. Both apply the same hard filters (project,
    // status, issueType) so rerank candidates are pre-filtered.
    const filterClauses = [];
    if (project) filterClauses.push(`project = ${project.toUpperCase().replace(/[^A-Z0-9_]/gi, '')}`);
    if (status) filterClauses.push(`status = "${String(status).replace(/"/g, '\\"')}"`);
    if (issueType) filterClauses.push(`issuetype = "${String(issueType).replace(/"/g, '\\"')}"`);
    const filterStr = filterClauses.length ? ' AND ' + filterClauses.join(' AND ') : '';

    const channels = [];
    if (expansion.primaryTerms?.length) {
      const textOr = expansion.primaryTerms
        .map((t) => buildJqlTextClause(t))
        .join(' OR ');
      channels.push({
        tier: 1,
        jql: `(${textOr})${filterStr} ORDER BY updated DESC`
      });
    }
    if (expansion.synonyms?.length) {
      const textOr = expansion.synonyms
        .map((t) => buildJqlTextClause(t))
        .join(' OR ');
      channels.push({
        tier: 2,
        jql: `(${textOr})${filterStr} ORDER BY updated DESC`
      });
    }

    if (channels.length === 0) {
      const jql = buildFuzzyJql(query, { project, status, issueType });
      const result = await this.api.searchJira(jql, maxResults);
      return {
        query,
        jql,
        issues: simplifySearchResults(result),
        total: result.total,
        endpoint: result._endpoint,
        reranked: false
      };
    }

    // Run channels in parallel, tolerate failures.
    const settled = await Promise.allSettled(
      channels.map(async (c) => {
        const res = await this.api.searchJira(c.jql, MAX_RERANK_CANDIDATES);
        return { tier: c.tier, issues: res.issues || [] };
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

    if (rankedLists.length === 0) {
      return {
        query,
        jql: channels.map((c) => c.jql).join(' | '),
        issues: [],
        total: 0,
        reranked: false,
        reason: 'all_channels_empty'
      };
    }

    // RRF merge → top-20 candidates.
    const fused = reciprocalRankFusion(rankedLists, { k: RRF_K, keyFn: (it) => it.key });
    const candidates = fused.map((entry) => ({
      ...entry.item,
      _rrfScore: entry.score,
      _tier: tierByKey.get(entry.item.key) ?? 99
    })).slice(0, MAX_RERANK_CANDIDATES);

    // Rerank with LLM. Source = { query, expansion } so the reranker prompt
    // has the user's intent + extracted terms.
    const ranked = await rerankCandidates(
      { query, expansion },
      candidates,
      this.llm,
      { topN: Math.min(MAX_RERANKED_RESULTS, maxResults) }
    );

    const fieldByKey = new Map(candidates.map((it) => [it.key, it]));
    const simplified = ranked.map((r) => {
      const src = fieldByKey.get(r.key) || { fields: {} };
      const f = src.fields || {};
      return {
        key: r.key,
        summary: f.summary || '',
        status: f.status?.name || '',
        issueType: f.issuetype?.name || '',
        priority: f.priority?.name || '',
        updated: f.updated,
        score: r.score,
        reason: r.reason,
        _tier: r._tier
      };
    });

    return {
      query,
      jql: channels.map((c) => c.jql).join(' | '),
      issues: simplified,
      total: candidates.length,
      candidatesBeforeRerank: candidates.length,
      channels: channels.map((c) => ({ tier: c.tier, jql: c.jql })),
      reranked: Boolean(this.llm)
    };
  }

  async searchConfluence(args) {
    const query = typeof args === 'string' ? args : args?.query;
    const space = typeof args === 'object' ? args?.space : null;
    const maxResults = (typeof args === 'object' ? args?.maxResults : null) || 5;

    if (!query) return { error: 'Missing query parameter' };
    const result = await this.api.searchConfluence(query, maxResults, space);
    return {
      query,
      space: space || null,
      pages: simplifyConfluenceResults(result)
    };
  }

  async summarizeContext() {
    const currentIssue = this.cache.get('currentIssue');
    if (!currentIssue) {
      return { error: 'No current issue loaded. Provide a Jira issue key or URL instead.' };
    }

    return {
      issue: currentIssue,
      relatedIssues: this.cache.get('relatedIssues') || [],
      confluencePages: this.cache.get('confluencePages') || []
    };
  }

  async suggestReply(tone, language) {
    const currentIssue = this.cache.get('currentIssue');
    if (!currentIssue) {
      return { error: 'No current issue loaded. Provide a Jira issue key or URL instead.' };
    }

    return {
      issue: currentIssue,
      relatedIssues: this.cache.get('relatedIssues') || [],
      confluencePages: this.cache.get('confluencePages') || [],
      tone: tone || 'professional',
      language: language || 'auto'
    };
  }

  async findSimilarIssues(args) {
    const issueKey = args?.issueKey || this.cache.get('currentIssue')?.key;
    if (!issueKey) {
      return { error: 'No current issue loaded. Provide a Jira issue key or URL instead.' };
    }

    // Use cached raw issue if available; otherwise fetch and cache it
    let issue = this.cache.get(`rawIssue:${issueKey}`);

    if (!issue) {
      try {
        issue = await this.api.getIssue(issueKey);
        this.cache.set(`rawIssue:${issueKey}`, issue);
      } catch (err) {
        return { error: `Failed to load issue ${issueKey}: ${err.message}` };
      }
    }

    try {
      // Get LLM-extracted structured summary (cached in IndexedDB).
      // Falls back to null if LLM is unavailable — searchRelatedIssues then
      // takes the legacy tier-cascade path.
      const summary = this.llm ? await getOrSummarize(issue, this.llm) : null;

      const result = await this.api.searchRelatedIssues(issue, {
        summary,
        maxResults: MAX_RERANK_CANDIDATES,
        issueCache: this.cache
      });

      const candidates = result.issues || [];

      // Rerank with LLM. Falls back to RRF order if LLM unavailable or fails.
      const ranked = await rerankCandidates(
        summary ? { summary, issueKey: issue.key } : { issueKey: issue.key },
        candidates,
        this.llm,
        { topN: MAX_RERANKED_RESULTS }
      );

      // Build the user-facing issue list. Map rerank results back to full
      // issue fields so the existing simplifySearchResults shape carries
      // through, then attach the rerank score + reason.
      const fieldByKey = new Map(candidates.map((it) => [it.key, it]));
      const simplified = ranked.map((r) => {
        const src = fieldByKey.get(r.key) || { fields: {} };
        const f = src.fields || {};
        return {
          key: r.key,
          summary: f.summary || '',
          status: f.status?.name || '',
          issueType: f.issuetype?.name || '',
          priority: f.priority?.name || '',
          updated: f.updated,
          score: r.score,
          reason: r.reason,
          _tier: r._tier
        };
      });

      this.cache.set('relatedIssues', simplified);

      return {
        issueKey,
        issues: simplified,
        candidatesBeforeRerank: candidates.length,
        channels: result.channels || null,
        reranked: Boolean(this.llm)
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  setCurrentContext(issue, relatedIssues, confluencePages) {
    this.cache.set('currentIssue', issue);
    this.cache.set('relatedIssues', relatedIssues);
    this.cache.set('confluencePages', confluencePages);
  }
}
