import { LlmClient } from './llm-client.js';
import { ToolExecutor } from './tool-executor.js';
import { ApiClient, simplifyIssue, simplifySearchResults, simplifyConfluenceResults } from './api-client.js';
import { buildSystemPrompt, buildInitialContext, parseToolCalls, parseReasoning, stripMeta, looksLikeTruncatedToolCall } from './prompt-builder.js';
import { ContextState } from '../shared/context-state.js';
import { extractSources } from '../shared/source-tracker.js';

// No hard cap on tool rounds — the LLM decides when to stop. The conversation
// continues until the model returns a final answer without tool calls. User
// can always hit "New" to reset.
// PATHOLOGICAL_SAFETY_NET is only a backstop against a stuck model that keeps
// calling tools forever; it's intentionally very high so it never triggers
// in normal use.
const PATHOLOGICAL_SAFETY_NET = 100;

// MV3 service workers are killed by Chrome after ~30s of idleness, wiping
// in-memory state. Persist conversation history + loaded context to
// chrome.storage.local so the assistant "remembers" across restarts.
const HISTORY_KEY_PREFIX = 'chatHistory:';
const CONTEXT_KEY_PREFIX = 'chatContext:';
const MAX_HISTORY_MESSAGES = 60; // soft cap to prevent unbounded growth

export class ChatOrchestrator {
  constructor(config, scopeKey = 'global') {
    this.config = config;
    this.scopeKey = scopeKey;
    this.llm = new LlmClient(config);
    this.api = new ApiClient(config);
    this.contextState = new ContextState(scopeKey);
    this.executor = new ToolExecutor(config, this.contextState, this.llm);
    this.conversationHistory = [];
    this.restored = false;
    // Per-conversation settings — set via setConversationMeta before handle().
    this.sourceFlags = { jira: true, confluence: true, slack: true };
  }

  /**
   * Set per-conversation settings (source flags).
   * Called by the service worker before handle() based on conversation metadata.
   * @param {{sourceFlags?: object}} meta
   */
  setConversationMeta(meta = {}) {
    if (meta.sourceFlags) this.sourceFlags = { ...this.sourceFlags, ...meta.sourceFlags };
  }

  /**
   * Check whether a tool is allowed under the current source flags.
   */
  isToolAllowed(toolName) {
    const f = this.sourceFlags;
    if (!f.jira && ['get_issue', 'search_jira', 'find_similar_issues'].includes(toolName)) return false;
    if (!f.confluence && ['search_confluence'].includes(toolName)) return false;
    if (!f.slack && ['search_slack', 'read_slack_channel'].includes(toolName)) return false;
    return true;
  }

  get historyStorageKey() {
    return `${HISTORY_KEY_PREFIX}${this.scopeKey}`;
  }

  get contextStorageKey() {
    return `${CONTEXT_KEY_PREFIX}${this.scopeKey}`;
  }

  async ensureRestored() {
    if (this.restored) return;
    try {
      const stored = await chrome.storage.local.get([this.historyStorageKey, this.contextStorageKey]);
      if (stored[this.historyStorageKey]) {
        this.conversationHistory = stored[this.historyStorageKey];
      }
      if (stored[this.contextStorageKey]) {
        const ctx = stored[this.contextStorageKey];
        if (ctx.currentIssue) this.executor.cache.set('currentIssue', ctx.currentIssue);
        if (ctx.relatedIssues) this.executor.cache.set('relatedIssues', ctx.relatedIssues);
        if (ctx.confluencePages) this.executor.cache.set('confluencePages', ctx.confluencePages);
      }
      // Also restore the product/config/customer context state tied to this scope.
      await this.contextState.load();
    } catch (err) {
      console.warn('Failed to restore conversation:', err.message);
    }
    this.restored = true;
  }

  async persist() {
    try {
      // Trim oldest messages if history is too long
      const trimmed = this.conversationHistory.length > MAX_HISTORY_MESSAGES
        ? this.conversationHistory.slice(-MAX_HISTORY_MESSAGES)
        : this.conversationHistory;

      const context = {
        currentIssue: this.executor.cache.get('currentIssue') || null,
        relatedIssues: this.executor.cache.get('relatedIssues') || [],
        confluencePages: this.executor.cache.get('confluencePages') || []
      };

      await chrome.storage.local.set({
        [this.historyStorageKey]: trimmed,
        [this.contextStorageKey]: context
      });
    } catch (err) {
      console.warn('Failed to persist conversation:', err.message);
    }
  }

  async handle({ message, issueKey, pageUrl }, onDelta) {
    await this.ensureRestored();

    // Load current context on first run
    if (!this.executor.cache.has('currentIssue') && issueKey) {
      await this.preloadContext(issueKey);
    }

    // Auto-detect product/config/customer from the user message
    await this.contextState.load();
    if (!this.contextState.get().locked) {
      await this.contextState.updateFromText(message);
    }

    const contextDisplay = this.contextState.toDisplayString();
    const userTurn = { role: 'user', content: message };
    this.conversationHistory.push(userTurn);

    const toolCalls = [];
    const collectedSources = [];
    let rounds = 0;

    // Tool loop: LLM may call tools, we execute and feed back, repeat until
    // the model returns a final answer with no tool calls.
    while (rounds < PATHOLOGICAL_SAFETY_NET) {
      const context = this.executor.cache.get('currentIssue');
      const related = this.executor.cache.get('relatedIssues') || [];
      const confluence = this.executor.cache.get('confluencePages') || [];
      const systemContext = buildInitialContext(issueKey, context, related, confluence);
      const ctxState = this.contextState.get();
      const ctxStateStr = `Current product context: product=${ctxState.product || 'auto-detect'}, config=${ctxState.config || 'auto-detect'}, customer=${ctxState.customer || 'general'}${ctxState.locked ? ' (locked)' : ''}`;

      const messages = [
        { role: 'system', content: buildSystemPrompt({ ...this.config, sourceFlags: this.sourceFlags }) },
        { role: 'system', content: `${ctxStateStr}\n\nAvailable context:\n${systemContext}` },
        ...this.conversationHistory
      ];

      // Compute this round's number BEFORE the LLM call so streaming deltas
      // can carry it. Count = existing reasoning entries + 1 (same as the
      // post-call computation below).
      const round = toolCalls.filter((t) => t.name === 'reasoning').length + 1;
      let roundStarted = false;
      const response = await this.llm.chatStream(messages, {}, (delta) => {
        if (delta.reasoning && onDelta) {
          if (!roundStarted) {
            roundStarted = true;
            onDelta({ kind: 'reasoning_start', round, text: delta.reasoning });
          } else {
            onDelta({ kind: 'reasoning_delta', round, text: delta.reasoning });
          }
        }
      });
      const content = response.content || '';
      // Reasoning models (GLM-4.5/4.6, DeepSeek-R1, QwQ, ...) put their
      // chain-of-thought in `reasoning_content`, NOT in `content`. Non-reasoning
      // models that follow the system prompt use the <reasoning>...</reasoning>
      // tag convention. Try the native field first, fall back to the tag.
      const reasoning = response.reasoning_content || parseReasoning(content);

      // Surface every round's thinking to the UI — don't dedup. In a multi-
      // round tool loop the user wants to see "plan search" → "review results"
      // → "synthesize answer" as separate cards, not just the first one.
      // The `_streamed` flag tells the UI the thinking was already rendered
      // incrementally via CHAT_DELTA — skip re-rendering it from the final
      // response to avoid a duplicate card.
      if (reasoning) {
        toolCalls.push({
          name: 'reasoning',
          args: {},
          result: { thought: reasoning, round, _displayOnly: true, _streamed: roundStarted }
        });
      }

      const requestedTools = parseToolCalls(content);
      if (!requestedTools) {
        // Check if this looks like a TRUNCATED tool call attempt (model meant
        // to call a tool but the JSON got cut off by max_tokens).
        if (looksLikeTruncatedToolCall(content) && rounds < PATHOLOGICAL_SAFETY_NET - 2) {
          console.warn('[orchestrator] detected truncated tool call, asking model to retry one-at-a-time');
          // Push the truncated attempt so the model sees its own context, then
          // ask it to retry with a SINGLE tool call.
          this.conversationHistory.push({ role: 'assistant', content });
          this.conversationHistory.push({
            role: 'user',
            content: 'Your previous tool call JSON was truncated (likely by max_tokens). Please make ONE tool call at a time now, with a minimal JSON. Do not batch multiple tool calls in a single response.'
          });
          rounds++;
          continue;
        }

        // No tool calls - this is the final answer. Strip reasoning + JSON meta.
        let cleanAnswer = stripMeta(content) || content;
        // If the "answer" is just JSON garbage, surface a clear message instead
        if (!cleanAnswer || looksLikeTruncatedToolCall(cleanAnswer)) {
          const fallback = 'I ran into trouble producing a clean response. Please try rephrasing your question, or ask me to summarize what I have so far.';
          this.conversationHistory.push({ role: 'assistant', content: fallback });
          await this.persist();
          return { content: fallback, toolCalls, reasoning };
        }
        // Sources are rendered as clickable cards by the chat UI (with rerank
        // score + reason). The legacy markdown Sources block is skipped to
        // avoid duplicating the source list in the same bubble.
        this.conversationHistory.push({ role: 'assistant', content: cleanAnswer });
        await this.persist();
        return { content: cleanAnswer, toolCalls, reasoning, sources: collectedSources };
      }

      // Execute each requested tool
      this.conversationHistory.push({ role: 'assistant', content });

      for (const call of requestedTools) {
        const toolEntry = { name: call.name, args: call.arguments || {} };
        // Block tools whose source is disabled in this conversation.
        if (!this.isToolAllowed(call.name)) {
          toolEntry.error = 'Source disabled in this conversation';
          toolEntry.result = { error: `Source for '${call.name}' is disabled. Tell the user to enable it via the source checkboxes if needed.` };
          this.conversationHistory.push({
            role: 'user',
            content: `Tool ${call.name} blocked: source disabled.`
          });
          toolCalls.push(toolEntry);
          continue;
        }
        try {
          const result = await this.executor.execute(call.name, call.arguments || {});
          toolEntry.result = result;
          // Collect citable sources from this tool result.
          const srcs = extractSources(call.name, call.arguments || {}, result, this.config.jiraBaseUrl);
          collectedSources.push(...srcs);
          this.conversationHistory.push({
            role: 'user',
            content: `Tool ${call.name} result: ${JSON.stringify(result, null, 2)}`
          });
        } catch (err) {
          toolEntry.error = err.message;
          this.conversationHistory.push({
            role: 'user',
            content: `Tool ${call.name} failed: ${err.message}`
          });
        }
        toolCalls.push(toolEntry);
      }

      rounds++;
      // Persist after each tool round so we don't lose progress if the worker dies
      await this.persist();
    }

    // Pathological safety net — model got stuck calling tools. Force a summary.
    this.conversationHistory.push({
      role: 'user',
      content: 'You have made a very large number of tool calls. Please give your best answer now based on everything you have gathered. If information is missing, say so explicitly.'
    });
    const context = this.executor.cache.get('currentIssue');
    const related = this.executor.cache.get('relatedIssues') || [];
    const confluence = this.executor.cache.get('confluencePages') || [];
    const systemContext = buildInitialContext(issueKey, context, related, confluence);
    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'system', content: `Available context:\n${systemContext}` },
      ...this.conversationHistory
    ];
    const finalResponse = await this.llm.chat(messages);
    const finalContent = finalResponse.content || 'I gathered information but could not produce a final summary.';
    this.conversationHistory.push({ role: 'assistant', content: finalContent });
    await this.persist();
    return { content: finalContent, toolCalls };
  }

  async preloadContext(issueKey) {
    try {
      const issue = await this.api.getIssue(issueKey);
      const simplified = simplifyIssue(issue);
      this.executor.cache.set('currentIssue', simplified);
      this.executor.cache.set('rawIssue', issue);

      const [relatedRes, confRes] = await Promise.allSettled([
        this.api.searchRelatedIssues(issue),
        this.api.searchConfluenceForIssue(issue)
      ]);

      const related = relatedRes.status === 'fulfilled' ? simplifySearchResults(relatedRes.value) : [];
      const confluence = confRes.status === 'fulfilled' ? simplifyConfluenceResults(confRes.value) : [];

      this.executor.cache.set('relatedIssues', related);
      this.executor.cache.set('confluencePages', confluence);
    } catch (err) {
      // Silently skip preload if it fails; tools can still be invoked explicitly
      console.warn('Preload failed:', err.message);
    }
  }

  async getContext() {
    await this.ensureRestored();
    const currentIssue = this.executor.cache.get('currentIssue');
    return {
      issueKey: currentIssue?.key || null,
      issueSummary: currentIssue?.summary || null,
      relatedIssues: this.executor.cache.get('relatedIssues') || [],
      confluencePages: this.executor.cache.get('confluencePages') || [],
      context: this.contextState.get()
    };
  }

  async reset() {
    this.conversationHistory = [];
    this.executor.cache.clear();
    try {
      await chrome.storage.local.remove([this.historyStorageKey, this.contextStorageKey]);
    } catch (err) {
      console.warn('Failed to clear persisted conversation:', err.message);
    }
  }
}
