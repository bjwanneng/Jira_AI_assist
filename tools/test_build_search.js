// Standalone connectivity + JQL validation for the Jira similarity-index build.
//
// This reproduces EXACTLY the GET request the extension's buildIndex() makes
// (bounded JQL + comma-string fields in the query), so a green run here means
// the in-browser "Build Similarity Index" search leg will succeed.
//
// Creds are read from a LOCAL file (tools/.jira_test.json) — never paste
// tokens into chat. The file is dot-prefixed; do NOT commit it.
//
// Usage:  node tools/test_build_search.js
const fs = require('fs');
const path = require('path');

const cfgPath = path.join(__dirname, '.jira_test.json');
if (!fs.existsSync(cfgPath)) {
  console.error('Missing ' + cfgPath + '\nCopy tools/.jira_test.example.json -> tools/.jira_test.json and fill in a READ-ONLY Jira API token.');
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const { jiraBaseUrl, jiraEmail, jiraApiToken } = cfg;
if (!jiraBaseUrl || !jiraEmail || !jiraApiToken) {
  console.error('jiraBaseUrl, jiraEmail, jiraApiToken are required in .jira_test.json');
  process.exit(2);
}

const auth = 'Basic ' + Buffer.from(jiraEmail + ':' + jiraApiToken).toString('base64');
// Mirrors ticket-indexer.buildIndex(): bounded by a far-past update date so
// Jira Cloud's "unbounded JQL not allowed" rule is satisfied.
const jql = 'updated >= "2000-01-01" ORDER BY updated DESC';
const fields = 'summary,status,issuetype,priority,created,updated';
const url = `${jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=0&maxResults=5&fields=${encodeURIComponent(fields)}`;

(async () => {
  console.log('GET', url, '\n');
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  const text = await res.text();
  console.log('HTTP', res.status, res.statusText);
  if (!res.ok) {
    console.error('BODY:', text.slice(0, 500));
    process.exit(1);
  }
  const data = JSON.parse(text);
  const issues = data.issues || [];
  console.log('OK — total accessible issues:', data.total, '| returned this page:', issues.length);
  for (const it of issues.slice(0, 5)) {
    console.log('   ', it.key, '—', (it.fields && it.fields.summary || '').slice(0, 60));
  }
  console.log('\nSearch leg PASSED. The in-browser "Build Similarity Index" should now succeed.');
})().catch((e) => { console.error('FETCH ERROR:', e.message); process.exit(1); });
