# Jira AI Assistant — An Open-Source Rovo Chat Alternative

A Chrome extension that brings Atlassian Rovo Chat–style AI search and assistance to your Jira workflow — **without a backend**. All processing happens in your browser; credentials live in `chrome.storage.local` and never leave your machine except when calling the LLM endpoint you configure.

Built around a **4-layer hybrid retrieval pipeline** (BM25 + LLM query expansion + linked-issue graph + RRF fusion + LLM rerank) so "find similar tickets" returns actually relevant results, not just recently-updated ones.

---

## Why this exists

Atlassian's Rovo Chat delivers accurate similar-ticket search by combining keyword retrieval, vector search, rerank models, and deep Jira metadata. Replicating that in a side project traditionally requires a backend with embeddings, a vector database, and a private rerank model.

This extension achieves ~80% of Rovo's search quality **with zero backend** by substituting:

| Rovo Chat (native) | This extension (no-backend) |
|---|---|
| BM25 + vector search | Jira `text ~` (BM25-approx) + **LLM query expansion** for the semantic channel |
| Private rerank model (bge-reranker-large) | **LLM-as-reranker** — one cheap LLM call scores top-20 candidates with reasons |
| Pre-indexed structured summaries | **LLM summarizer** extracts `{现象, errorCodes, environment, rootCauseCategory, searchKeywords, synonyms}` per ticket, cached in IndexedDB |
| Metadata hard-filter + linked-issue graph | Same — `issuelinks` walk + `component`/`project` hard filter |

---

## Key features

- **Hybrid search pipeline** — three parallel retrieval channels merged with Reciprocal Rank Fusion (k=60)
- **LLM rerank** — top-20 candidates → top-5 with `score` (0-100) and one-line `reason` per ticket
- **Structured ticket summarization** — LLM extracts fixed schema (phenomenon, error codes, environment, root cause, keywords, synonyms), persisted in IndexedDB across sessions
- **Free-form query expansion** — natural-language queries are expanded into `{primaryTerms, synonyms}` before JQL construction
- **Linked-issue graph** — walks `issuelinks` and pulls related tickets into the candidate pool (Rovo's "linkage" principle)
- **Clickable result cards** — rendered in the chat before the final answer streams, with score + reason + status + priority
- **Tool-calling loop** — LLM can call `search_jira`, `find_similar_issues`, `search_confluence`, `search_slack`, `search_drive`, `get_issue`, `read_url`, `suggest_reply`
- **Source-cited answers** — every factual claim links back to its Jira/Confluence/Slack source
- **Conversation history** — per-tab and per-conversation scope, persisted across service-worker restarts
- **Context state** — auto-detects product / config / customer from the conversation

---

## Architecture

```
User query / current ticket
        │
        ▼
┌─────────────────────────────────────────┐
│ 1. Structured Summary (LLM, cached)    │  ticket-summarizer.js
│    → {phenomenon, errorCodes,          │
│       environment, rootCause,          │
│       searchKeywords, synonyms}        │
└─────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────┐
│ 2. Hybrid Retrieval (parallel Jira API)│  hybrid-search (api-client.js)
│    Ch A: project + components +         │
│           keywords (BM25 precise)      │
│    Ch B: project + synonyms (semantic) │
│    Ch C: issuelinks of source ticket    │
│    Hard filter: project + components   │
└─────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────┐
│ 3. RRF Fusion (pure client-side)       │  shared/rrf.js
│    top-20 from merged ranked lists     │
└─────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────┐
│ 4. LLM Rerank (1 LLM call)              │  reranker.js
│    → top-5 with score + reason          │
└─────────────────────────────────────────┘
        │
        ▼
   Tool result returned to orchestrator
   → compressed (key/summary/reason only)
   → UI renders result cards before answer
   → LLM gets compressed list for final prose
```

For free-form `search_jira` (no source ticket), step 1 swaps to `query-expander.js` which produces `{primaryTerms, synonyms}` from the user's natural-language query (cached by SHA-256 hash).

---

## Installation

1. Clone or download this repo.
2. Open `chrome://extensions` in Chrome (or Edge).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project root directory.
5. The extension icon appears in your toolbar — click it to open the chat.

No build step. No backend. No accounts.

---

## Configuration

Open the extension's **Settings** page (via the toolbar icon → settings, or right-click the icon → Options).

### Required

- **Jira base URL** — e.g. `https://your-domain.atlassian.net`
- **Jira email** + **API token** — create a token at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
- **LLM base URL** — any OpenAI-compatible endpoint, e.g. `https://api.openai.com/v1`, `https://api.deepseek.com/v1`, `http://localhost:11434/v1` (Ollama)
- **LLM API key** — `sk-...`
- **LLM model** — e.g. `gpt-4o`, `deepseek-chat`, `llama3.1:70b`

### Recommended for search performance

- **Cheap LLM model** — a smaller/faster model (e.g. `gpt-4o-mini`) used for ticket summarization, query expansion, and reranking. Falls back to the main model if blank. This is the highest-leverage setting for cost/latency.

### Optional integrations

- **Confluence** — reuses the Jira token by default, or set a separate base URL/token
- **Slack** — `xoxp-...` (user token) or `xoxb-...` (bot token). Required scopes: `search:read`, `channels:history`, `groups:history`, `files:read`
- **Google Drive** — OAuth 2.0 (no static token). Follow the in-settings instructions to create a Chrome Extension OAuth Client ID at [console.cloud.google.com](https://console.cloud.google.com)

---

## Privacy

- **No backend** — the extension is a pure client. The only network calls are to Jira/Confluence/Slack/Drive APIs (with your credentials) and to your chosen LLM endpoint.
- **Credentials in `chrome.storage.local`** — never written to disk outside your browser profile, never sent anywhere except the host they belong to.
- **Conversation history & context** — also in `chrome.storage.local`, scoped per conversation.
- **Ticket summaries & query expansions** — cached in IndexedDB (`jira_ai_assist` database) for fast repeat searches. Clearable via DevTools → Application → IndexedDB → delete database.
- **No telemetry** — the extension does not phone home.

---

## How the search works (deep dive)

### Layer 1 — Structured preprocessing

Before retrieval, each source ticket is summarized by the cheap LLM into a fixed schema:

```json
{
  "phenomenon": "App crashes on checkout",
  "errorCodes": ["NullPointerException", "ERR_502"],
  "environment": "iOS 17.4 / App v3.2",
  "rootCauseCategory": "null pointer",
  "searchKeywords": ["PaymentService", "checkout"],
  "synonyms": ["crash", "freeze", "payment failure"]
}
```

This is the "translate tickets into AI-friendly structure" step from Rovo's playbook. The summary is persisted in IndexedDB with a `schemaVersion` field so prompt changes can invalidate stale caches.

### Layer 2 — Hybrid retrieval

Three Jira search queries run in parallel:

- **Channel A** (BM25-precise): `project = X AND component IN (...) AND (text ~ "kw1*" OR text ~ "kw2*")`
- **Channel B** (semantic-approx): `project = X AND (text ~ "syn1*" OR text ~ "syn2*")`
- **Channel C** (linkage): walk `issue.fields.issuelinks` and fetch each linked issue

Each channel returns up to 20 candidates ranked by `updated DESC`.

### Layer 3 — Reciprocal Rank Fusion

The three ranked lists are merged with the standard RRF formula (`k = 60`):

```
score(item) = Σ  1 / (k + rank_i)
              lists
```

Items appearing in multiple channels get a higher fused score. Top-20 after fusion proceed to rerank.

### Layer 4 — LLM rerank

A single LLM call sends the source ticket's structured summary + the top-20 candidates (key, summary, status, priority, tier only — no full body, to fit token budget). The LLM returns:

```json
[
  {"key": "PROJ-2", "score": 92, "reason": "same NullPointerException in PaymentService"},
  {"key": "PROJ-1", "score": 75, "reason": "similar component, different stack"}
]
```

Top-5 by score are returned to the orchestrator and rendered as clickable cards in the chat.

### Fallbacks

Every LLM-dependent step degrades gracefully:

- LLM not configured → `searchRelatedIssues` falls back to the legacy 3-tier cascade (same project + component → same project → cross-project)
- Summarizer throws → falls back to raw `summary` field tokens
- Expander throws → falls back to `buildFuzzyJql` whitespace tokenization
- Reranker throws → returns top-5 by RRF score without reasons

---

## Tech stack

- **Manifest V3** Chrome extension (service worker + content scripts)
- **Vanilla JS ES modules** — no bundler, no framework
- **IndexedDB** for structured caches (ticket summaries, query expansions)
- **`chrome.storage.local`** for config and conversation history
- **Shadow DOM** for the inline Jira page chat UI
- **OpenAI-compatible LLM API** (any provider)

---

## Project structure

```
manifest.json
.gitignore
README.md
src/
├── assets/icons/                     Extension icons
├── background/
│   ├── service-worker.js             Message router, config loader
│   ├── chat-orchestrator.js          Tool-calling loop, history persistence
│   ├── tool-executor.js              Tool dispatch (search_jira, find_similar, ...)
│   ├── api-client.js                 Jira/Confluence/Slack REST + hybrid search
│   ├── llm-client.js                 OpenAI-compatible client (chat + chatCheap)
│   ├── prompt-builder.js             System prompt, tool-call parser
│   ├── ticket-summarizer.js          Layer 1 — LLM structured extraction
│   ├── query-expander.js             Layer 1 (free-form) — LLM query expansion
│   ├── reranker.js                   Layer 4 — LLM-as-reranker
│   └── ...
├── chat/                              Standalone chat page (side panel)
│   ├── chat.html / chat.js / chat.css
│   └── conversation-store.js
├── content/                           Inline Jira page UI (Shadow DOM)
│   ├── chat-ui.js
│   ├── content-script.js
│   └── issue-extractor.js            DOM + field-based IP/product hints
├── options/                           Settings page
│   └── options.html / options.js / options.css
└── shared/
    ├── constants.js                  Storage keys, JIRA_FIELDS, RRF/rerank tuning
    ├── db.js                         IndexedDB wrapper
    ├── rrf.js                        Reciprocal Rank Fusion
    ├── llm-json.js                   Fenced JSON parser
    ├── source-tracker.js             Citable sources → UI cards
    ├── markdown.js                   Minimal markdown renderer
    ├── utils.js                      ADF/HTML text extraction, URL parsing
    └── ...
```

---

## License

MIT — see headers. Use it, fork it, ship it.

## Acknowledgments

Inspired by Atlassian Rovo Chat's hybrid search architecture. The 4-layer pipeline (preprocessing → hybrid retrieval → RRF fusion → rerank) is a direct adaptation of Rovo's public design principles to a no-backend Chrome extension context.
