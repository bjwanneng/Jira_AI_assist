import { extractDescriptionText, extractCommentText, formatComment, truncateToTokens, estimateTokens } from '../shared/utils.js';
import { MAX_COMMENTS } from '../shared/constants.js';

export const TOOLS = [
  {
    name: 'read_url',
    description: 'Fetch and extract the main text content of a web URL. For Jira/Confluence URLs the tool uses authenticated APIs; for other sites it performs a direct fetch, which may require the user to grant host permission for that site.',
    parameters: {
      url: { type: 'string', description: 'The full URL to read, e.g. "https://example.com/doc" or "https://site.atlassian.net/browse/PROJ-123"' }
    }
  },
  {
    name: 'get_issue',
    description: 'Fetch full details of a specific Jira issue including description, comments, labels, and linked issues.',
    parameters: {
      issueKey: { type: 'string', description: 'Jira issue key, e.g. PROJ-123' }
    }
  },
  {
    name: 'search_jira',
    description: 'Search Jira issues using natural language or JQL. Uses fuzzy matching: pass keywords or a question; the system strips stopwords and applies prefix wildcards so "auth" matches "authentication". Optionally narrow by project / status / issueType.',
    parameters: {
      query: { type: 'string', description: 'Natural language query or raw JQL. Examples: "BEU interrupt", "memory leak", or jql: "project = PROJ AND status = Open"' },
      project: { type: 'string', description: 'Optional project key, e.g. "PROJ". Uppercased automatically.' },
      status: { type: 'string', description: 'Optional status name, e.g. "Open", "In Progress", "Resolved"' },
      issueType: { type: 'string', description: 'Optional issue type, e.g. "Bug", "Support", "Story", "Task"' },
      maxResults: { type: 'number', description: 'Optional cap, default 10' }
    }
  },
  {
    name: 'search_confluence',
    description: 'Search Confluence pages for internal documentation. Returns titles + excerpts.',
    parameters: {
      query: { type: 'string', description: 'Keywords or question to search in Confluence' },
      space: { type: 'string', description: 'Optional Confluence space key, e.g. "ENG"' },
      maxResults: { type: 'number', description: 'Optional cap, default 5' }
    }
  },
  {
    name: 'search_slack',
    description: 'Search Slack messages across all channels the user can access. Returns matching messages with channel name, permalink, and timestamp. Use this when looking for discussions, decisions, or context shared in Slack.',
    parameters: {
      query: { type: 'string', description: 'Search query — Slack supports modifiers like from:user, in:#channel, has:link. Plain text does substring match.' },
      count: { type: 'number', description: 'Optional max messages, default 10' }
    }
  },
  {
    name: 'read_slack_channel',
    description: 'Fetch recent messages from a Slack channel, or all replies in a thread.',
    parameters: {
      channel: { type: 'string', description: 'Channel name (e.g. "engineering") or channel ID' },
      limit: { type: 'number', description: 'Optional max messages, default 50' },
      threadTs: { type: 'string', description: 'Optional thread timestamp. If provided, returns replies in that thread instead of channel history.' }
    }
  },
  {
    name: 'search_drive',
    description: 'Search Google Drive files by name or full-text content. Returns matching files (Docs, Sheets, PDFs, plain text). Use this when the user references a Google Doc, design spec, or internal doc stored in Drive.',
    parameters: {
      query: { type: 'string', description: 'Search query — matches file name or full content' },
      maxResults: { type: 'number', description: 'Optional cap, default 10' }
    }
  },
  {
    name: 'read_drive_file',
    description: 'Read the plain-text content of a Google Drive file. Supports Google Docs, Sheets, Slides, plain text, and PDFs (extracted text).',
    parameters: {
      fileId: { type: 'string', description: 'The Drive file ID returned by search_drive' }
    }
  },
  {
    name: 'find_similar_issues',
    description: 'Find Jira issues similar to the current ticket by combining the ticket\'s IP/core hints and summary keywords. Use this when the user asks "find similar tickets", "related issues", or "anyone else hit this problem". Returns top 5 similar tickets.',
    parameters: {
      issueKey: { type: 'string', description: 'Optional issue key. If omitted, uses the current conversation issue.' }
    }
  },
  {
    name: 'analyze_ticket_patterns',
    description: 'Analyze a batch of Jira tickets (30-40) to identify common patterns, systemic issues, and recurring root causes across multiple tickets. Use this when the user asks about broad trends ("what common issues are in EHT P870 tickets?", "what patterns do you see in S5CSD timing tickets?", "summarize recurring problems"). This is a cross-ticket clustering analysis — NOT for finding a few specific similar tickets (use find_similar_issues for that). Returns 3-7 thematic patterns with affected tickets, quantitative evidence, root causes, and recommendations.',
    parameters: {
      issueKey: { type: 'string', description: 'Optional source ticket key. If provided, analyzes tickets related to this one.' },
      query: { type: 'string', description: 'Optional free-form search query to gather tickets for analysis (e.g. "EHT P870 timing violations", "S5CSD SDC bugs"). Use this when there is no single source ticket.' },
      project: { type: 'string', description: 'Optional project key to narrow the search scope, e.g. "S5CSD"' },
      maxTickets: { type: 'number', description: 'Optional cap on tickets to analyze, default 40. Higher = broader patterns but slower.' }
    }
  },
  {
    name: 'set_context',
    description: 'Set or change the current product/config/customer context for the conversation. After this call, subsequent answer reasoning will assume this context. Use when user explicitly says "let\'s focus on U74 W3K" or when you detect a context switch.',
    parameters: {
      product: { type: 'string', description: 'Product name, e.g. "U74", "E76"' },
      config: { type: 'string', description: 'Config code, e.g. "W3K", "FA7", "X3"' },
      customer: { type: 'string', description: 'Customer name or "general". Default "general".' },
      lock: { type: 'boolean', description: 'If true, prevent auto-detection from changing the context. Default true.' }
    }
  },
  {
    name: 'summarize_context',
    description: 'Summarize the current Jira issue and any related context.',
    parameters: {}
  },
  {
    name: 'suggest_reply',
    description: 'Draft a customer-facing reply based on the current issue context.',
    parameters: {
      tone: { type: 'string', description: 'Optional tone, e.g. "formal", "friendly", "technical"' },
      language: { type: 'string', description: 'Optional language code, e.g. "en", "zh". Defaults to ticket language.' }
    }
  }
];

export function buildSystemPrompt(config = {}) {
  // Filter tools by source flags. When a source is disabled for this
  // conversation, its tools are omitted entirely so the LLM doesn't try
  // to call them.
  const flags = config.sourceFlags || { jira: true, confluence: true, slack: true };
  const isToolEnabled = (name) => {
    if (!flags.jira && ['get_issue', 'search_jira', 'find_similar_issues', 'analyze_ticket_patterns'].includes(name)) return false;
    if (!flags.confluence && ['search_confluence'].includes(name)) return false;
    if (!flags.slack && ['search_slack', 'read_slack_channel'].includes(name)) return false;
    return true;
  };

  const visibleTools = TOOLS.filter(t => isToolEnabled(t.name));
  const toolDescriptions = visibleTools.map(t => {
    const params = Object.entries(t.parameters)
      .map(([k, v]) => `    - ${k}: ${v.type} - ${v.description}`)
      .join('\n');
    return `- ${t.name}: ${t.description}\n${params}`;
  }).join('\n\n');

  const siteUrl = (config.jiraBaseUrl || '').replace(/\/$/, '');
  const siteLine = siteUrl ? `Jira site URL: ${siteUrl} (use this for building issue links: \`${siteUrl}/browse/PROJ-123\`)` : '';

  const enabledSources = Object.entries(flags).filter(([, v]) => v).map(([k]) => k).join(', ');

  return `You are a technical support analyst assistant with access to Jira, Confluence, Slack, Google Drive, and the web. Your job is to help the user understand customer tickets, find related context, read web pages, and draft replies.

${siteLine}

Enabled sources for this conversation: ${enabledSources || 'none'}.

You have access to the following tools:
${toolDescriptions}

How to use tools:
- When the user pastes a URL (any https://... link), call \`read_url\` to fetch its content first.
- When the user mentions a Jira issue key like \`PROJ-123\`, call \`get_issue\` to load it.
- When the user asks to "summarize this ticket" but hasn't given a key, ask which one.
- When you need to search Jira or Confluence, use the corresponding search tool. Pass natural language as \`query\`; the system auto-tokenizes and applies prefix wildcards. Don't convert to JQL yourself unless the user explicitly asked for JQL.
- When the user asks about "similar tickets", "related issues", or "anyone else hit this", call \`find_similar_issues\`. It runs a cascade of Jira queries (same project + component, same project, cross-project) using OR-ed text tokens from the ticket's summary and IP hints — high recall by design.
- When the user asks about BROAD TRENDS or RECURRING PATTERNS across many tickets — e.g. "what common issues appear in EHT P870 tickets?", "what patterns do you see in S5CSD timing bugs?", "summarize recurring problems in this project" — call \`analyze_ticket_patterns\`. It pulls 30-40 tickets and groups them into thematic patterns with root causes, quantitative evidence, and recommendations. Do NOT use it for "find tickets similar to this one" — that's \`find_similar_issues\`.
- After loading context, you can call \`suggest_reply\` or \`summarize_context\` if helpful, or just answer directly.

Before calling a tool, ALWAYS do a brief reasoning step first. Two ways to do this:

(A) Reasoning before a tool call. Use this exact format:
\`\`\`
<reasoning>
What the user is really asking for, what I know, what's missing, and which tool + keywords to use.
- Intent: ...
- Known facts: ...
- Missing info: ...
- Search keywords I'll extract: word1, word2, word3
- Plan: call search_jira with these keywords, then read top results
</reasoning>

\`\`\`json
{"tool_calls": [{"name": "search_jira", "arguments": {"query": "word1 word2 word3"}}]}
\`\`\`
(B) Final answer when no more tools are needed. Use:
\`\`\`
<reasoning>
Brief synthesis of what I learned from the tools and how I'll structure the answer.
</reasoning>

[Final markdown answer here, following the Output format guidelines]
\`\`\`

You can mix both: reasoning + tool calls in one response, then later reasoning + final answer.

When you need to use a tool, the JSON object must come AFTER the \`<reasoning>\` block, and there should be nothing else outside the two blocks.

You can request multiple tools in one response by adding more entries to the \`tool_calls\` array, but **keep it to at most 2 tool calls per response**. If you batch more, the JSON may get truncated by the token limit and the call will fail. Prefer sequential single-tool calls over large batches.

When you DO batch, keep the JSON minimal — no comments, no extra whitespace, short argument values. If the previous response was truncated, switch to ONE tool call at a time.

Output format guidelines (follow strictly for the FINAL answer):
- Use markdown with clear structure: a 1-2 sentence TL;DR at the top, then sections.
- For lists of issues/tickets, use a markdown **table** with columns: Key | Summary | Status | Priority | Updated.
- Always include the issue key as a clickable link: \`[PROJ-123](https://SITE.atlassian.net/browse/PROJ-123)\` when you know the site URL.
- Bold the most relevant findings so the user can scan quickly.
- For technical explanations, use short paragraphs and bullet points; avoid walls of text.
- For suggested replies to customers, put them in a quoted block (\`> ...\`) so they're easy to copy.
- If you list multiple suggestions or options, number them.
- Cite source: after a factual claim, append \`([PROJ-123](url))\` so the user can verify.
- The system automatically appends a "## Sources" section at the end with clickable links derived from the tools you called. You don't need to write it yourself, but DO cite inline (\`([PROJ-123](url))\`) next to factual claims.
- Use headings (\`##\`, \`###\`) to separate sections when the answer has multiple parts.

Rules:
- Use the same language as the user's last message.
- Be concise and grounded in the data. Do not hallucinate.
- For suggested replies, be polite, professional, and address the customer's actual question.
- If you cannot find relevant information, say so clearly and ask for clarification.
- Do not make up issue keys, URLs, or facts.
- Quote specific snippets from tool results when citing facts.
- If a tool call fails, do not retry it with the same arguments. Either try a different query, or answer based on what you have.
- Prefer batching independent tool calls in one response (multiple entries in \`tool_calls\`) to save round-trips.
- When searching, prefer extracting 2-5 specific technical keywords over copying the whole user question verbatim.

Current date: ${new Date().toISOString().split('T')[0]}`;
}

export function buildToolResultMessage(toolName, result) {
  return {
    role: 'user',
    content: `Tool result for ${toolName}:\n${JSON.stringify(result, null, 2)}`
  };
}

export function buildInitialContext(issueKey, issue, relatedIssues, confluencePages) {
  const parts = [];
  if (issue) {
    parts.push(`Current issue: ${issue.key} - ${issue.summary}`);
    parts.push(`Status: ${issue.status}, Type: ${issue.issueType}, Priority: ${issue.priority}, Reporter: ${issue.reporter}`);
    parts.push(`Description:\n${issue.description}`);
    if (issue.comments.length > 0) {
      parts.push(`Comments:\n${issue.comments.slice(-MAX_COMMENTS).join('\n\n')}`);
    }
    if (issue.linkedIssues.length > 0) {
      parts.push(`Linked issues: ${issue.linkedIssues.map(l => `${l.key}: ${l.summary}`).join('; ')}`);
    }
  } else {
    parts.push(`No current issue loaded.`);
  }

  if (relatedIssues?.length) {
    parts.push(`Related Jira issues:\n${relatedIssues.map(i => `- ${i.key}: ${i.summary} (${i.status})`).join('\n')}`);
  }

  if (confluencePages?.length) {
    parts.push(`Related Confluence pages:\n${confluencePages.map(p => `- ${p.title}: ${p.excerpt}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

export function buildMessages(userMessage, issueKey, issue, relatedIssues, confluencePages, history = []) {
  const context = buildInitialContext(issueKey, issue, relatedIssues, confluencePages);
  const messages = [
    { role: 'system', content: buildSystemPrompt({}) },
    { role: 'user', content: `Context:\n${context}\n\nUser request: ${userMessage}` }
  ];

  // Append conversation history if any
  for (const h of history) {
    messages.push({ role: h.role, content: h.content });
  }

  return messages;
}

export function parseToolCalls(content) {
  if (!content) return null;

  // Try to find JSON block (preferred — comes after a <reasoning>...</reasoning>)
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/\{[\s\S]*?"tool_calls"[\s\S]*?\}/);
  if (!jsonMatch) return null;

  const jsonText = jsonMatch[1] || jsonMatch[0];
  try {
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
      return parsed.tool_calls;
    }
  } catch (err) {
    return null;
  }
  return null;
}

/**
 * Detect whether a model response looks like an ATTEMPTED tool call that got
 * truncated (or otherwise malformed) — i.e. the model clearly meant to make
 * a tool call, but the JSON is incomplete. When this returns true, the
 * orchestrator should NOT treat the content as a final answer; it should
 * prompt the model to retry with a smaller batch.
 *
 * Signals:
 *   - content contains "tool_calls" anywhere
 *   - OR content contains ```json but no closing ```
 *   - OR content starts with { but doesn't parse
 *   - OR content has a stray `"name":` / `"arguments":` fragment
 *
 * @param {string} content
 * @returns {boolean}
 */
export function looksLikeTruncatedToolCall(content) {
  if (!content) return false;
  const trimmed = content.trim();

  // Has unclosed ```json block
  const hasOpenFence = /```json/.test(trimmed);
  const hasCloseFence = /```json[\s\S]*?```/.test(trimmed);
  if (hasOpenFence && !hasCloseFence) return true;

  // Mentions tool_calls but parseToolCalls already returned null
  if (/tool_calls/.test(trimmed)) return true;

  // Stray tool-call fragment markers
  if (/"name"\s*:\s*"/.test(trimmed) && /"arguments"\s*:/.test(trimmed)) {
    // Looks like a tool call fragment — check if it's part of a valid object
    try {
      JSON.parse(trimmed);
      return false; // valid JSON
    } catch {
      return true;
    }
  }

  // Starts with { or [ but doesn't parse as valid JSON
  if (/^[{[]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return false;
    } catch {
      // could be a fragment like `}, {"name": ...`
      if (/"name"\s*:|tool_calls|"arguments"\s*:/.test(trimmed)) return true;
    }
  }

  return false;
}

/**
 * Extract the <reasoning>...</reasoning> block from a model response.
 * Returns the inner text, or null if absent.
 * @param {string} content
 * @returns {string|null}
 */
export function parseReasoning(content) {
  if (!content) return null;
  const m = content.match(/<reasoning>([\s\S]*?)<\/reasoning>/);
  if (!m) return null;
  return m[1].trim();
}

/**
 * Strip the <reasoning> block and the JSON tool-call block from a model response,
 * returning only the human-facing markdown.
 * @param {string} content
 * @returns {string}
 */
export function stripMeta(content) {
  if (!content) return '';
  return content
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '')
    .replace(/```json\s*\{[\s\S]*?"tool_calls"[\s\S]*?\}\s*```/g, '')
    .replace(/\{[\s\S]*?"tool_calls"[\s\S]*?\}/g, '')
    .replace(/^\s+|\s+$/g, '');
}
