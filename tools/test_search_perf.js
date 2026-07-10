// Search pipeline performance test.
//
// Tests each stage of the search_jira pipeline against the real Jira API:
//   1. Field discovery (Organizations custom field id)
//   2. JQL channel construction + parallel execution timing
//   3. Per-channel hit count and overlap analysis
//   4. RRF fusion result (unique candidate count)
//   5. Embedding API latency (if configured)
//
// Creds are read from tools/.jira_test.json (same as test_build_search.js).
//
// Usage:  node tools/test_search_perf.js
//         node tools/test_search_perf.js "EHT PD tickets"
//         node tools/test_search_perf.js "EHT PD tickets" S5CSD

const fs = require('fs');
const path = require('path');

const cfgPath = path.join(__dirname, '.jira_test.json');
if (!fs.existsSync(cfgPath)) {
  console.error('Missing ' + cfgPath + '\nCopy tools/.jira_test.example.json -> tools/.jira_test.json and fill in Jira credentials.');
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const { jiraBaseUrl, jiraEmail, jiraApiToken } = cfg;
if (!jiraBaseUrl || !jiraApiToken) {
  console.error('jiraBaseUrl and jiraApiToken are required in .jira_test.json');
  process.exit(2);
}

// Embedding config (optional - for vector search timing)
const embedBaseUrl = cfg.embedBaseUrl || '';
const embedApiKey = cfg.embedApiKey || '';
const embedModel = cfg.embedModel || '';
const hasEmbed = embedBaseUrl && embedApiKey && embedModel;

// The extension uses Basic auth (email:token) for all Jira requests.
// Even scoped tokens work with Basic auth when paired with the correct email.
const auth = 'Basic ' + Buffer.from((jiraEmail || 'admin') + ':' + jiraApiToken).toString('base64');
const base = jiraBaseUrl.replace(/\/$/, '');
const query = process.argv[2] || 'EHT PD tickets';
const project = process.argv[3] || '';
const MAX_RESULTS = 100;

// --- PD sub-domains for multi-query decomposition (mirrors query-expander) ---
const SUB_QUERIES = [
  { focus: 'timing',    primaryTerms: ['timing', 'STA', 'setup', 'hold', 'slack'],    synonyms: ['violation', 'TNS', 'WNS', 'critical path', 'clock skew'] },
  { focus: 'SDC',       primaryTerms: ['SDC', 'constraint', 'create_clock'],           synonyms: ['set_max_delay', 'false_path', 'multicycle', 'CDC bound'] },
  { focus: 'DFT',       primaryTerms: ['DFT', 'MBIST', 'ATPG', 'scan'],                synonyms: ['Tessent', 'BIST', 'formality', 'MBIF'] },
  { focus: 'UPF',       primaryTerms: ['UPF', 'power domain', 'level shifter'],         synonyms: ['isolation', 'power intent', 'VCLP', 'pg lib'] },
  { focus: 'synthesis', primaryTerms: ['synthesis', 'ICG', 'empty module'],            synonyms: ['unconstrained', 'hierarchy', 'register D pin', 'obfuscation'] },
  { focus: 'routing',   primaryTerms: ['routing', 'congestion', 'DRC'],                synonyms: ['LVS', 'via', 'antenna', 'metal layer'] }
];
const MANDATORY_TERMS = query.match(/EHT|AMD|ESWIN|Bytedance/i) ? [query.match(/EHT|AMD|ESWIN|Bytedance/i)[0]] : [];

function buildTextClause(term) {
  const escaped = term.replace(/"/g, '\\"');
  if (/\s/.test(term)) return `text ~ "${escaped}"`;
  return `text ~ "${escaped}*"`;
}

async function discoverOrgField() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/rest/api/3/field`, { headers: { Authorization: auth } });
    if (!res.ok) { console.log('  field discovery failed:', res.status); return null; }
    const fields = await res.json();
    const orgField = (fields || []).find(f => f.name && /organization/i.test(f.name) && /^customfield_/.test(f.id));
    console.log(`  Organizations field: ${orgField?.id || 'NOT FOUND'} (${Date.now() - t0}ms)`);
    return orgField?.id || null;
  } catch (err) {
    console.log('  field discovery error:', err.message);
    return null;
  }
}

async function runJql(jql, maxResults) {
  const t0 = Date.now();
  const url = `${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=0&maxResults=${maxResults}&fields=summary,status,created,updated`;
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  const elapsed = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: `${res.status}`, body: text.slice(0, 200), elapsed, issues: [], total: 0 };
  }
  const data = await res.json();
  return { issues: data.issues || [], total: data.total || 0, elapsed };
}

async function testEmbedLatency() {
  if (!hasEmbed) { console.log('  Embedding not configured, skipping'); return; }
  const t0 = Date.now();
  try {
    const body = { model: embedModel, input: [query], encoding_format: 'float' };
    const res = await fetch(`${embedBaseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${embedApiKey}` },
      body: JSON.stringify(body)
    });
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.log(`  Embed API error: ${res.status} (${elapsed}ms) ${text.slice(0, 200)}`);
      return;
    }
    const data = await res.json();
    const vec = data.data?.[0]?.embedding || [];
    console.log(`  Embed OK: ${vec.length} dims (${elapsed}ms)`);
  } catch (err) {
    console.log(`  Embed error: ${err.message} (${Date.now() - t0}ms)`);
  }
}

async function main() {
  console.log('=== Search Pipeline Performance Test ===');
  console.log(`Query: "${query}"`);
  console.log(`Project: ${project || '(none)'}`);
  console.log(`Max results: ${MAX_RESULTS}`);
  console.log(`Mandatory terms: ${MANDATORY_TERMS.length ? MANDATORY_TERMS.join(', ') : '(none)'}`);
  console.log();

  // 1. Field discovery
  console.log('[1] Field Discovery');
  const orgFieldId = await discoverOrgField();

  // 2. Build JQL channels
  console.log('\n[2] JQL Channel Construction');
  const baseFilter = project ? ` AND project = ${project.toUpperCase()}` : '';
  const orgFilter = (orgFieldId && MANDATORY_TERMS.length)
    ? ` AND "${orgFieldId}" in (${MANDATORY_TERMS.map(t => `"${t}"`).join(',')})`
    : '';
  const textFilter = MANDATORY_TERMS.length
    ? ' AND ' + MANDATORY_TERMS.map(t => buildTextClause(t)).join(' AND ')
    : '';

  const SORT_ORDERS = ['updated DESC', 'created DESC'];
  const channels = [];
  let sortIdx = 0;
  for (const sq of SUB_QUERIES) {
    const primaryOr = `(${sq.primaryTerms.map(buildTextClause).join(' OR ')})`;
    const synonymOr = `(${sq.synonyms.map(buildTextClause).join(' OR ')})`;
    const push = (tier, jqlBase) => {
      const sort = SORT_ORDERS[sortIdx % 2]; sortIdx++;
      channels.push({ tier, focus: sq.focus, jql: `${jqlBase}${baseFilter} ORDER BY ${sort}` });
    };
    if (orgFilter) {
      push(1, `${primaryOr}${orgFilter}`);
      push(2, `${synonymOr}${orgFilter}`);
    }
    if (textFilter) {
      push(3, `${primaryOr}${textFilter}`);
      push(4, `${synonymOr}${textFilter}`);
    }
    push(5, `${primaryOr}${baseFilter}`);
    push(6, `${synonymOr}${baseFilter}`);
  }
  console.log(`  Total channels: ${channels.length}`);

  // 3. Execute channels in parallel
  console.log('\n[3] Parallel JQL Execution');
  const tExecStart = Date.now();
  const results = await Promise.all(
    channels.map(async (c) => {
      const res = await runJql(c.jql, MAX_RESULTS);
      return { ...c, ...res };
    })
  );
  const tExecTotal = Date.now() - tExecStart;
  console.log(`  Total wall time: ${tExecTotal}ms (parallel)`);

  // Per-channel stats
  console.log('\n  Channel breakdown:');
  for (const r of results) {
    const status = r.error ? `ERROR ${r.error}` : `${r.issues.length}/${r.total} returned`;
    console.log(`    tier ${r.tier} [${r.focus}] ${r.elapsed}ms - ${status}${r.body ? ' ' + r.body : ''}`);
  }

  // 4. Overlap analysis
  console.log('\n[4] Coverage Analysis');
  const allKeys = new Map(); // key -> { tiers, focus areas }
  for (const r of results) {
    if (r.error) continue;
    for (const it of r.issues) {
      if (!allKeys.has(it.key)) allKeys.set(it.key, { tiers: new Set(), focuses: new Set() });
      allKeys.get(it.key).tiers.add(r.tier);
      allKeys.get(it.key).focuses.add(r.focus);
    }
  }
  console.log(`  Unique tickets found: ${allKeys.size}`);

  // Which tickets appear only in created DESC (old tickets)?
  const createdOnlyKeys = [];
  for (const [key, info] of allKeys) {
    // Check if this key appears in any updated DESC channel
    const inUpdated = results.some(r => !r.error && r.jql.includes('updated DESC') && r.issues.some(it => it.key === key));
    const inCreated = results.some(r => !r.error && r.jql.includes('created DESC') && r.issues.some(it => it.key === key));
    if (inCreated && !inUpdated) createdOnlyKeys.push(key);
  }
  console.log(`  Tickets only found via created DESC (would be missed without it): ${createdOnlyKeys.length}`);
  if (createdOnlyKeys.length > 0 && createdOnlyKeys.length <= 20) {
    console.log(`    ${createdOnlyKeys.join(', ')}`);
  }

  // Org-field-only tickets (found via org field, not text search)
  const orgOnlyKeys = [];
  for (const [key, info] of allKeys) {
    const inOrg = info.tiers.has(1) || info.tiers.has(2);
    const inText = info.tiers.has(3) || info.tiers.has(4);
    const inNoFilter = info.tiers.has(5) || info.tiers.has(6);
    if (inOrg && !inText) orgOnlyKeys.push(key);
  }
  console.log(`  Tickets found via Organizations field only (would be missed by text search): ${orgOnlyKeys.length}`);

  // 5. Embedding latency
  console.log('\n[5] Embedding API Latency');
  await testEmbedLatency();

  // Summary
  console.log('\n=== Summary ===');
  console.log(`  Channels executed: ${channels.length}`);
  console.log(`  Parallel wall time: ${tExecTotal}ms`);
  console.log(`  Unique tickets: ${allKeys.size}`);
  console.log(`  Old tickets rescued by created DESC: ${createdOnlyKeys.length}`);
  console.log(`  Tickets rescued by org field: ${orgOnlyKeys.length}`);

  if (allKeys.size < 20 && MANDATORY_TERMS.length > 0) {
    console.log('\n  WARNING: Low coverage. Check if:');
    console.log('    - Organizations field id is correct');
    console.log('    - Sub-query terms match the actual ticket vocabulary');
    console.log('    - maxResults is large enough to capture all matching tickets');
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
