export const DEFAULT_LLM_MODEL = 'gpt-4o';

export const STORAGE_KEYS = {
  JIRA_BASE_URL: 'jiraBaseUrl',
  JIRA_EMAIL: 'jiraEmail',
  JIRA_API_TOKEN: 'jiraApiToken',
  JIRA_CLOUD_ID: 'jiraCloudId',
  CONFLUENCE_BASE_URL: 'confluenceBaseUrl',
  CONFLUENCE_API_TOKEN: 'confluenceApiToken',
  SLACK_TOKEN: 'slackToken',
  DRIVE_ENABLED: 'driveEnabled',
  LLM_BASE_URL: 'llmBaseUrl',
  LLM_API_KEY: 'llmApiKey',
  LLM_MODEL: 'llmModel',
  LLM_CHEAP_MODEL: 'llmCheapModel',
  LLM_MAX_TOKENS: 'llmMaxTokens',
  LLM_TEMPERATURE: 'llmTemperature',
  EMBEDDING_MODEL: 'embeddingModel'
};

// Scoped API tokens end with `=XXXXXXXX` (8 hex chars) and must be called
// via https://api.atlassian.com/ex/jira/{cloudId}/... instead of the
// site URL directly.
export const SCOPED_TOKEN_REGEX = /=[0-9A-Fa-f]{8}$/;
export const ATLASSIAN_API_BASE = 'https://api.atlassian.com';

export const DEFAULT_SETTINGS = {
  [STORAGE_KEYS.LLM_MODEL]: DEFAULT_LLM_MODEL,
  [STORAGE_KEYS.LLM_CHEAP_MODEL]: '',
  [STORAGE_KEYS.LLM_MAX_TOKENS]: 0,
  [STORAGE_KEYS.LLM_TEMPERATURE]: 0.3
};

export const JIRA_FIELDS = [
  'summary',
  'description',
  'comment',
  'labels',
  'components',
  'reporter',
  'issuelinks',
  'created',
  'updated',
  'status',
  'issuetype',
  'priority'
].join(',');

export const MAX_RELATED_ISSUES = 8;
export const MAX_CONFLUENCE_RESULTS = 5;
export const MAX_COMMENTS = 20;
export const LLM_TIMEOUT_MS = 60000;

// Hybrid search + rerank pipeline tuning.
export const MAX_RERANK_CANDIDATES = 20;
export const MAX_RERANKED_RESULTS = 5;
export const RRF_K = 60;
// Bump when summarizer/expander prompt schema changes — invalidates cached
// records with stale schemaVersion.
export const SUMMARY_SCHEMA_VERSION = 1;
export const QUERY_EXPANSION_SCHEMA_VERSION = 1;

export const ISSUE_KEY_REGEX = /([A-Z][A-Z0-9_]+-\d+)/g;
