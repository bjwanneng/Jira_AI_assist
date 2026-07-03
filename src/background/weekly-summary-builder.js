/**
 * Weekly Summary Report builder.
 *
 * Pulls all open tickets assigned to the current user (status in
 * "Waiting for Customer" / "Waiting for Support"), groups them by Jira
 * Service Management Organizations, batch-summarizes each ticket's latest
 * progress in a single LLM call, and renders a fixed-template markdown
 * report.
 *
 * Output shape (returned to the chat UI):
 *   {
 *     markdown: string,         // full report with [S5CSD-XXX](url) links
 *     tickets:  Array<{key, summary, status, org, url, progress}>,
 *     orgs:     string[],       // ordered list of organizations seen
 *     warnings: string[]        // soft failures (LLM down, missing org field, etc.)
 *   }
 */

import { ApiClient } from './api-client.js';
import { LlmClient } from './llm-client.js';
import { extractDescriptionText, extractCommentText, truncateToTokens } from '../shared/utils.js';
import { parseLlmJson } from '../shared/llm-json.js';

const OPEN_STATUSES = ['Waiting for Customer', 'Waiting for Support'];

// Fixed org display order. Tickets whose org isn't in this list fall into
// "Misc" at the end.
const ORG_ORDER = [
  'Bytedance', 'AMD', 'EHT', 'ESWIN', 'Lanxin', 'Lisuan',
  'Semiotics', 'Siliconwaves'
];
const MISC_ORG = 'Misc';

const MAX_COMMENTS_PER_TICKET = 5;
const COMMENT_TOKENS = 120;
const DESC_TOKENS = 400;

/**
 * Build the weekly summary report.
 * @param {object} config  loaded extension config
 * @returns {Promise<object>}
 */
export async function buildWeeklySummary(config) {
  const warnings = [];
  const api = new ApiClient(config);

  let issues;
  try {
    issues = await api.searchMyOpenIssues(OPEN_STATUSES, 100);
  } catch (err) {
    throw new Error(`Failed to fetch open tickets: ${err.message}`);
  }

  if (!issues || issues.length === 0) {
    return {
      markdown: buildEmptyReport(),
      tickets: [],
      orgs: [],
      warnings: ['No open tickets assigned to you.']
    };
  }

  // --- Group by Organizations ---
  const orgFieldId = await api.findOrganizationsFieldId();
  if (!orgFieldId) {
    warnings.push('Organizations field not found — all tickets grouped under "Misc".');
  }
  const grouped = groupByOrg(issues, orgFieldId);

  // --- Batch LLM summarize ---
  const llm = new LlmClient(config);
  let progressMap = {};
  try {
    progressMap = await batchSummarize(llm, issues);
  } catch (err) {
    warnings.push(`LLM summary failed (${err.message}) — using ticket summaries as fallback.`);
    progressMap = {};
  }

  // --- Build ticket records ---
  const baseUrl = (config.jiraBaseUrl || '').replace(/\/$/, '');
  const tickets = issues.map(issue => {
    const fields = issue.fields || {};
    const orgName = pickOrgName(fields[orgFieldId]);
    return {
      key: issue.key,
      summary: fields.summary || '(no summary)',
      status: fields.status?.name || 'Unknown',
      org: orgName,
      url: `${baseUrl}/browse/${issue.key}`,
      progress: progressMap[issue.key] || ''
    };
  });

  // --- Assemble markdown ---
  const orderedOrgs = orderOrgs(grouped.keys());
  const markdown = renderReport(tickets, orderedOrgs);

  return { markdown, tickets, orgs: orderedOrgs, warnings };
}

/**
 * Group issue keys by organization name.
 * @returns {Map<string, string[]>}
 */
function groupByOrg(issues, orgFieldId) {
  const map = new Map();
  for (const issue of issues) {
    const orgName = pickOrgName(issue.fields?.[orgFieldId]);
    if (!map.has(orgName)) map.set(orgName, []);
    map.get(orgName).push(issue.key);
  }
  return map;
}

function pickOrgName(orgFieldValue) {
  if (!orgFieldValue) return MISC_ORG;
  if (Array.isArray(orgFieldValue) && orgFieldValue.length > 0) {
    return orgFieldValue[0]?.name || MISC_ORG;
  }
  if (typeof orgFieldValue === 'object') {
    return orgFieldValue.name || MISC_ORG;
  }
  if (typeof orgFieldValue === 'string') return orgFieldValue;
  return MISC_ORG;
}

function orderOrgs(seenOrgs) {
  const seen = new Set(seenOrgs);
  const ordered = ORG_ORDER.filter(o => seen.has(o));
  const extras = Array.from(seen).filter(o => !ORG_ORDER.includes(o)).sort();
  if (seen.has(MISC_ORG)) {
    return [...ordered, ...extras.filter(o => o !== MISC_ORG), MISC_ORG];
  }
  return [...ordered, ...extras];
}

/**
 * Single LLM call: feed all tickets' summary + recent comments, get back a
 * { "S5CSD-12345": "one-line progress" } map.
 */
async function batchSummarize(llm, issues) {
  const blocks = [];
  for (const issue of issues) {
    const fields = issue.fields || {};
    const desc = truncateToTokens(extractDescriptionText(fields.description), DESC_TOKENS);
    const comments = (fields.comment?.comments || [])
      .slice(-MAX_COMMENTS_PER_TICKET)
      .map(extractCommentText)
      .filter(Boolean)
      .map(c => truncateToTokens(c, COMMENT_TOKENS))
      .join('\n  - ');
    blocks.push(
      `TICKET ${issue.key}\n` +
      `Summary: ${fields.summary || ''}\n` +
      `Status: ${fields.status?.name || ''}\n` +
      `Description: ${desc || '(empty)'}\n` +
      `Recent comments:\n  - ${comments || '(none)'}`
    );
  }

  const system = `You are summarizing Jira support tickets for a weekly status report.
For each ticket, produce ONE concise sentence (<=20 words) describing the current progress / latest status.
Return ONLY a JSON object mapping ticket key to its one-line status. No prose, no markdown fence.
Example: {"S5CSD-12345": "Replied with BEU hierarchy; customer verifying."}`;

  const user = `Summarize each ticket below:\n\n${blocks.join('\n\n')}`;

  const msg = await llm.chatCheap([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ], { temperature: 0.2 });

  const parsed = parseLlmJson(msg.content || '');
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed;
  }
  return {};
}

function renderReport(tickets, orderedOrgs) {
  const lines = [];
  lines.push(buildReportTitle());
  lines.push('');
  lines.push('Flags:');
  lines.push('N/A');
  lines.push('Need internal check');
  lines.push('');

  for (const org of orderedOrgs) {
    lines.push(`${org}:`);
    const orgTickets = tickets.filter(t => t.org === org);
    if (orgTickets.length === 0) {
      lines.push('(none)');
      lines.push('');
      continue;
    }
    for (const t of orgTickets) {
      const progress = t.progress ? ` status: ${t.progress}` : '';
      lines.push(`[${t.key}](${t.url}): ${t.summary}${progress}`);
    }
    lines.push('');
  }

  lines.push('Next Week\'s Plan');
  lines.push('1. Continue on active tickets support.');

  return lines.join('\n');
}

function buildEmptyReport() {
  return [
    buildReportTitle(),
    '',
    'Flags:',
    'N/A',
    'Need internal check',
    '',
    'No open tickets assigned to you.',
    '',
    'Next Week\'s Plan',
    '1. Continue on active tickets support.'
  ].join('\n');
}

/**
 * Title format: "weekly Summary report-WW26 Wanneng 2026-07-02"
 * Week number is ISO 8601 (week starts Monday). Date is local YYYY-MM-DD.
 */
function buildReportTitle() {
  const now = new Date();
  const ww = isoWeek(now);
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `weekly Summary report-WW${ww} Wanneng ${yyyy}-${mm}-${dd}`;
}

/**
 * ISO 8601 week number. Week 1 is the week containing the first Thursday
 * of the year (equivalently, the week with year's Jan 4).
 */
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // nearest Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
