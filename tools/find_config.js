// Search for cloudId in extension LevelDB
const fs = require('fs');
const path = require('path');
const extDir = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Default', 'Local Extension Settings', 'jibbibomgpnodfpjdbeihppindlnpaec');
const files = fs.readdirSync(extDir).filter(f => f.endsWith('.ldb') || f.endsWith('.log'));
let combined = '';
for (const f of files) {
  combined += fs.readFileSync(path.join(extDir, f)).toString('utf8');
}
// Search for cloudId pattern (hex chars)
const cloudIdMatch = combined.match(/jiraCloudId[\x00-\xff]{0,5}([a-f0-9-]{36})/);
if (cloudIdMatch) {
  console.log('cloudId:', cloudIdMatch[1]);
} else {
  // Try generic hex UUID pattern
  const uuids = new Set();
  const matches = combined.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g) || [];
  for (const u of matches) uuids.add(u);
  console.log('UUIDs found:', [...uuids].slice(0, 10));

  // Also search for the scoped token suffix pattern (=XXXXXXXX)
  const scopedMatch = combined.match(/jiraApiToken[\x00-\xff]{0,200}(=[0-9A-Fa-f]{8})/);
  if (scopedMatch) console.log('Token suffix:', scopedMatch[1]);
}

// Also look for email
const emailMatches = combined.match(/[a-zA-Z0-9._%+-]+@sifive\.[a-zA-Z]+/g) || [];
console.log('SiFive emails:', [...new Set(emailMatches)].slice(0, 5));
