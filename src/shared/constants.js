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
  EMBEDDING_MODEL: 'embeddingModel',
  EMBEDDING_BASE_URL: 'embedBaseUrl',
  EMBEDDING_API_KEY: 'embedApiKey',
  EMBEDDING_DIMS: 'embedDims',
  EMBEDDING_API_STYLE: 'embedApiStyle',
  RECALL_STRATEGY: 'recallStrategy',
  BUILD_LOOKBACK_DAYS: 'indexLookbackDays',
  BUILD_MAX_ISSUES: 'indexMaxIssues',
  BUILD_PROJECTS: 'indexProjects',
  BUILD_STATUSES: 'indexStatuses'
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
  [STORAGE_KEYS.LLM_TEMPERATURE]: 0.3,
  [STORAGE_KEYS.EMBEDDING_MODEL]: 'text-embedding-3-small',
  [STORAGE_KEYS.EMBEDDING_DIMS]: 0,
  [STORAGE_KEYS.EMBEDDING_API_STYLE]: 'openai',
  [STORAGE_KEYS.RECALL_STRATEGY]: 'vector-primary',
  [STORAGE_KEYS.BUILD_LOOKBACK_DAYS]: 0,
  [STORAGE_KEYS.BUILD_MAX_ISSUES]: 2000,
  [STORAGE_KEYS.BUILD_PROJECTS]: 'S5CSD',
  [STORAGE_KEYS.BUILD_STATUSES]: ''
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
export const MAX_RERANK_CANDIDATES = 80;
export const MAX_RERANKED_RESULTS = 30;
export const RRF_K = 60;

// Cross-ticket pattern analysis (cluster-analyzer) tuning.
// Wide-recall retrieval pulls up to this many tickets; each is truncated and
// fed to a single LLM call that groups them into thematic patterns.
export const MAX_CLUSTER_CANDIDATES = 40;
export const MAX_CLUSTER_PATTERNS = 7;
export const CLUSTER_DESCRIPTION_TOKENS = 150;
export const CLUSTER_COMMENT_TOKENS = 80;
export const CLUSTER_MAX_COMMENTS = 3;
// Bump when summarizer/expander prompt schema changes — invalidates cached
// records with stale schemaVersion.
export const SUMMARY_SCHEMA_VERSION = 1;
export const QUERY_EXPANSION_SCHEMA_VERSION = 1;
export const EMBEDDING_SCHEMA_VERSION = 1;

export const ISSUE_KEY_REGEX = /([A-Z][A-Z0-9_]+-\d+)/g;

// Dense-vector similarity index (ticket-indexer) tuning.
export const MAX_INDEX_ISSUES = 2000; // fallback cap if config is missing
export const INDEX_MAX_ISSUES_HARD_CAP = 5000; // absolute ceiling on indexMaxIssues
export const INDEX_PAGE_SIZE = 100; // JQL page size when bulk-loading
// Jira Cloud forbids *unbounded* JQL (pure `ORDER BY` with no restriction).
// The full-build query must carry a search restriction, so we bound it by a
// far-past update date. The `ORDER BY updated DESC` + MAX_INDEX_ISSUES cap
// then pulls only the most recently updated tickets, which is what we want.
export const INDEX_JQL_LOWER_BOUND = '2000-01-01'; // updated >= this date
export const EMBED_TEXT_MAX_CHARS = 4000; // chars of ticket text sent to embed()
export const VECTOR_TOP_K = 50; // candidates pulled from the vector channel
export const VECTOR_MIN_SCORE = 0.10; // cosine threshold for vector recall (low for broad semantic coverage)
// Vector is the PRIMARY recall channel. If it returns fewer than this many
// neighbours we consider it too weak to stand on its own and fall back to (or
// fuse with) the legacy JQL/keyword channel.
export const VECTOR_MIN_RECALL = 5;

// find_similar_issues recall strategy (user-switchable in options):
//   'vector'         — dense-vector only; no JQL fallback at all
//   'vector-primary' — vector first, JQL fuses/falls back when vector is weak (default)
//   'jql'            — legacy JQL/keyword only; never use the vector store
export const RECALL_STRATEGY = {
  VECTOR: 'vector',
  VECTOR_PRIMARY: 'vector-primary',
  JQL: 'jql'
};

// Embedding API request style (user-switchable in options). Controls the
// endpoint path and the shape of `input`:
//   'openai'         — POST {base}/embeddings, input = string | string[]
//                        (OpenAI, Zhipu embedding-3, Ollama, ...)
//   'ark-multimodal' — POST {base}/embeddings/multimodal,
//                        input = [{ type:'text', text }]  (Volcengine Ark
//                        doubao-embedding-vision / multimodal models)
export const EMBEDDING_API_STYLE = {
  OPENAI: 'openai',
  ARK_MULTIMODAL: 'ark-multimodal'
};
