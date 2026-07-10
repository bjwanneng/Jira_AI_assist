// Search pipeline performance test - JQL construction validation.
//
// Since the scoped token (ATATT3xF...) requires Chrome's Connect Session auth,
// this script validates JQL correctness and pipeline structure without
// hitting the Jira API. It outputs the exact JQL queries that the extension
// would generate, so you can paste them into Jira's advanced search UI to
// verify coverage.
//
// Usage:  node tools/test_search_perf.js "EHT PD tickets" S5CSD
//         node tools/test_search_perf.js "EHT PD tickets" S5CSD --embed

const fs = require('fs');
const path = require('path');

const cfgPath = path.join(__dirname, '.jira_test.json');
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
const query = process.argv[2] || 'EHT PD tickets';
const project = process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : '';
const testEmbed = process.argv.includes('--embed');

// --- PD sub-domains for multi-query decomposition ---
const SUB_QUERIES = [
  { focus: 'timing',    primaryTerms: ['timing', 'STA', 'setup', 'hold', 'slack'],    synonyms: ['violation', 'TNS', 'WNS', 'critical path', 'clock skew'] },
  { focus: 'SDC',       primaryTerms: ['SDC', 'constraint', 'create_clock'],           synonyms: ['set_max_delay', 'false_path', 'multicycle', 'CDC bound'] },
  { focus: 'DFT',       primaryTerms: ['DFT', 'MBIST', 'ATPG', 'scan'],                synonyms: ['Tessent', 'BIST', 'formality', 'MBIF'] },
  { focus: 'UPF',       primaryTerms: ['UPF', 'power domain', 'level shifter'],         synonyms: ['isolation', 'power intent', 'VCLP', 'pg lib'] },
  { focus: 'synthesis', primaryTerms: ['synthesis', 'ICG', 'empty module'],            synonyms: ['unconstrained', 'hierarchy', 'register D pin', 'obfuscation'] },
  { focus: 'routing',   primaryTerms: ['routing', 'congestion', 'DRC'],                synonyms: ['LVS', 'via', 'antenna', 'metal layer'] }
];

// Detect customer name generically (any uppercase abbreviation that's not a known tech term)
const TECH_TERMS = new Set(['PD','STA','CDC','DFT','SDC','UPF','TRNG','APR','CTS','IR','EM','RTL','SOC','IP','MMIO','ICG','BIST','ATPG','DRC','LVS','TNS','WNS','ECO','P&R']);
function detectCustomer(q) {
  const words = q.split(/\s+/);
  return words.filter(w => w.length >= 2 && w === w.toUpperCase() && !TECH_TERMS.has(w.toUpperCase()) && /^[A-Z][A-Z0-9]+$/.test(w));
}
const MANDATORY_TERMS = detectCustomer(query);

function buildTextClause(term) {
  const escaped = term.replace(/"/g, '\\"');
  if (/\s/.test(term)) return `text ~ "${escaped}"`;
  return `text ~ "${escaped}*"`;
}

console.log('=== Search Pipeline JQL Validation ===');
console.log(`Query: "${query}"`);
console.log(`Project: ${project || '(none)'}`);
console.log(`Detected customer names (mandatoryTerms): ${MANDATORY_TERMS.length ? MANDATORY_TERMS.join(', ') : '(none)'}`);
console.log();

// Build JQL channels (mirrors tool-executor.js logic)
const baseFilter = project ? ` AND project = ${project.toUpperCase()}` : '';
const orgFilter = MANDATORY_TERMS.length ? ` AND "customfield_10400" in (${MANDATORY_TERMS.map(t => `"${t}"`).join(',')})` : '';
const textFilter = MANDATORY_TERMS.length ? ' AND ' + MANDATORY_TERMS.map(t => buildTextClause(t)).join(' AND ') : '';

const SORT_ORDERS = ['updated DESC', 'created ASC'];
const channels = [];
let sortIdx = 0;
for (const sq of SUB_QUERIES) {
  const primaryOr = `(${sq.primaryTerms.map(buildTextClause).join(' OR ')})`;
  const synonymOr = `(${sq.synonyms.map(buildTextClause).join(' OR ')})`;
  const push = (tier, jqlBase) => {
    const sort = SORT_ORDERS[sortIdx % 2]; sortIdx++;
    channels.push({ tier, focus: sq.focus, jql: `${jqlBase}${baseFilter} ORDER BY ${sort}` });
  };
  // Variant A: Organizations field filter (tier 1/2)
  if (orgFilter) {
    push(1, `${primaryOr}${orgFilter}`);
    push(2, `${synonymOr}${orgFilter}`);
  }
  // Variant B: text-search for customer name (tier 3/4)
  if (textFilter) {
    push(3, `${primaryOr}${textFilter}`);
    push(4, `${synonymOr}${textFilter}`);
  }
  // Variant C: no customer filter (tier 5/6)
  push(5, `${primaryOr}${baseFilter}`);
  push(6, `${synonymOr}${baseFilter}`);
}

console.log(`Total channels: ${channels.length}`);
console.log();

// Print all JQL queries grouped by sub-query
console.log('=== Generated JQL Queries ===');
console.log('(Copy-paste these into Jira Advanced Search to verify coverage)\n');

let currentFocus = '';
for (const c of channels) {
  if (c.focus !== currentFocus) {
    currentFocus = c.focus;
    console.log(`\n--- ${currentFocus.toUpperCase()} ---`);
  }
  const sortLabel = c.jql.includes('created DESC') ? '[created DESC]' : '[updated DESC]';
  const variant = c.tier <= 2 ? 'ORG-FIELD' : c.tier <= 4 ? 'TEXT-FILTER' : 'NO-FILTER';
  console.log(`  tier ${c.tier} (${variant} ${sortLabel}):`);
  console.log(`    ${c.jql}`);
}

// Summary stats
console.log('\n=== Pipeline Summary ===');
console.log(`  Sub-queries: ${SUB_QUERIES.length}`);
console.log(`  JQL channels: ${channels.length}`);
console.log(`  Customer variants: ${orgFilter ? '3 (org-field + text + no-filter)' : '1 (no-filter only)'}`);
console.log(`  Sort orders: alternating updated DESC / created DESC`);
console.log(`  maxResults per channel: 100`);
console.log(`  Estimated total Jira API calls: ${channels.length} (parallel)`);
console.log(`  Estimated unique candidates (after dedup): 50-200+`);

// Embed test
if (testEmbed && cfg.embedBaseUrl && cfg.embedApiKey) {
  console.log('\n=== Embedding API Test ===');
  const embedModel = cfg.embedModel || 'doubao-embedding-vision-251215';
  console.log(`  Model: ${embedModel}`);
  console.log(`  Endpoint: ${cfg.embedBaseUrl}/embeddings/multimodal`);
  console.log(`  Note: doubao-embedding-vision uses /embeddings/multimodal, not /embeddings`);
  console.log(`  Note: Ark requires Endpoint ID (ep-xxxx), not public model name`);
}

// Output Jira search URL for manual testing
const jiraUrl = cfg.jiraBaseUrl || 'https://YOUR-SITE.atlassian.net';
console.log(`\n=== Manual Verification ===`);
console.log(`Open: ${jiraUrl}/issues/?jql=`);
console.log(`Paste any JQL above to test in Jira's UI.`);
console.log(`\nExample - try the broadest query first:`);
console.log(`  ${channels.find(c => c.tier === 5)?.jql || 'project = ' + (project || 'S5CSD') + ' ORDER BY created DESC'}`);
