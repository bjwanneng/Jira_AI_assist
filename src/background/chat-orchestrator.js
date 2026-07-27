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

/**
 * Cap the size of a tool result before feeding it back into the model context.
 *
 * Information-preservation policy: NEVER drop an entire issue just to fit a
 * char budget — that loses recall silently. Instead, progressively compact:
 *   1. Full JSON (drop only verbose JQL/channel metadata)
 *   2. Per-issue field trim (keep key/summary/score/reason; drop status/priority/updated)
 *   3. Compact line format (~120 chars/issue vs ~300 in JSON) — preserves ALL issues
 *   4. Per-issue summary truncation (cap each summary at 120 chars; issues list intact)
 *
 * Only the final brute slice on non-issue payloads is allowed.
 */
function compactToolResult(result, maxChars = 24000) {
  if (result && typeof result === 'object' && Array.isArray(result.issues)) {
    const compact = { ...result };
    if (compact.jql) compact.jql = `(JQL omitted - ${compact.subQueryCount || '?'} sub-queries)`;
    delete compact.channels;
    delete compact.subQueryFocuses;

    // Tier 1: full JSON, only metadata stripped
    let str;
    try { str = JSON.stringify(compact, null, 2); } catch { str = String(compact); }
    if (str.length <= maxChars) return str;

    // Tier 2: trim verbose per-issue fields, keep all issues
    const issuesSlim = compact.issues.map((it) => ({
      key: it.key,
      summary: it.summary,
      score: it.score,
      reason: it.reason
    }));
    const tier2 = JSON.stringify({
      query: compact.query,
      total: compact.total,
      issues: issuesSlim,
      subQueryCount: compact.subQueryCount,
      vectorEnabled: compact.vectorEnabled,
      vectorRecall: compact.vectorRecall,
      searchMode: compact.searchMode
    }, null, 2);
    if (tier2.length <= maxChars) return tier2;

    // Tier 3: compact line format — preserve every issue, ~120 chars each
    const lines = [
      `Query: ${compact.query || '?'}`,
      `Total: ${compact.total ?? compact.issues.length} | Mode: ${compact.searchMode || '?'} | Vector hits: ${compact.vectorRecall ?? '?'}`,
      ''
    ];
    for (let i = 0; i < compact.issues.length; i++) {
      const it = compact.issues[i];
      const score = (typeof it.score === 'number') ? ` (s=${it.score})` : '';
      const reason = it.reason ? ` — ${it.reason}` : '';
      const summary = String(it.summary || '(no summary)').slice(0, 140);
      // ~120-200 chars per line; for 50 issues this fits easily in 24k
      lines.push(`${i + 1}. [${it.key}]${score} ${summary}${reason}`.slice(0, 240));
    }
    const tier3 = lines.join('\n');
    if (tier3.length <= maxChars) return tier3;

    // Tier 4: hard cap each line so the FULL list still fits. This is the
    // last resort — we keep all issues, just trim verbose summaries/reasons.
    const perLine = Math.max(80, Math.floor((maxChars - lines[0].length - lines[1].length - 20) / compact.issues.length));
    const trimmedLines = lines.slice(0, 2);
    for (let i = 0; i < compact.issues.length; i++) {
      const it = compact.issues[i];
      const score = (typeof it.score === 'number') ? ` (s=${it.score})` : '';
      const summary = String(it.summary || '').slice(0, Math.max(40, perLine - it.key.length - score.length - 16));
      trimmedLines.push(`${i + 1}. [${it.key}]${score} ${summary}`);
    }
    return trimmedLines.join('\n');
  }

  let str;
  try {
    str = JSON.stringify(result, null, 2);
  } catch {
    str = String(result);
  }
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + `\n... [tool result truncated; ${str.length - maxChars} extra chars omitted] ...`;
}

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
    if (!f.jira && ['get_issue', 'search_jira', 'find_similar_issues', 'analyze_ticket_patterns'].includes(toolName)) return false;
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
    // Wall-clock cap on the entire handle() call. Per-round check below
    // returns a clean fallback if exceeded — bounds total user wait time
    // regardless of which retry path the orchestrator is in.
    const MAX_HANDLE_MS = 180000; // 3 minutes
    const handleStartTime = Date.now();
    // Auto-continue accumulator: when finish_reason='length' (max_tokens hit
    // mid-answer) the model's response is truncated. We push the partial to
    // history, ask for continuation, and concatenate the next response. Cap
    // prevents unbounded growth if the model genuinely can't fit in N rounds.
    // 2 is intentional — reasoning models tend to re-emitting CoT on each
    // continuation rather than picking up where they left off, so more
    // retries rarely help and burn minutes of user time.
    const MAX_AUTO_CONTINUES = 2;
    // Separate budget for the "truncated tool call" retry path. Previously
    // this shared PATHOLOGICAL_SAFETY_NET (100), which meant a model that
    // kept emitting partial JSON could loop up to 100 times — each iteration
    // taking 30s-2min on a reasoning model. Cap it tightly.
    const MAX_TRUNCATED_RETRIES = 2;
    let continueCount = 0;
    let truncatedRetryCount = 0;
    let pendingPartial = '';
    // Mark the position in conversationHistory where the auto-continue
    // sequence (partial + "continue" prompts) started, so we can collapse
    // those entries into one clean assistant message on finalization.
    let continueStartIdx = -1;

    // Tool loop: LLM may call tools, we execute and feed back, repeat until
    // the model returns a final answer with no tool calls.
    while (rounds < PATHOLOGICAL_SAFETY_NET) {
      // Wall-clock cap. If the orchestrator has been running too long (slow
      // reasoning model looping on truncated tool calls, stuck tool, etc.),
      // bail out with a clean message so the user isn't staring at
      // "Thinking..." forever.
      if (Date.now() - handleStartTime > MAX_HANDLE_MS) {
        console.warn('[orchestrator] handle() exceeded %dms wall clock, bailing out', MAX_HANDLE_MS);
        const wallMsg = `This query is taking too long (${Math.round(MAX_HANDLE_MS / 1000)}s cap). Try a more focused question, or check that your LLM endpoint is responsive (Settings → LLM → Test LLM Connection).`;
        this.conversationHistory.push({ role: 'assistant', content: wallMsg });
        await this.persist();
        return { content: wallMsg, toolCalls };
      }

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
      let contentBuf = '';
      let contentReasoningSent = 0;
      // Default max_tokens when none is configured: 16384. Reasoning models
      // (doubao-seed, GLM, DeepSeek-R1) put CoT in reasoning_content which
      // shares the max_tokens budget with content. 8192 was tight enough that
      // a long reasoning block could eat the entire budget before the tool
      // call JSON was emitted, truncating the response mid-tag and stalling
      // the orchestrator. 16384 leaves comfortable room for CoT + JSON.
      const configuredMax = Number(this.config.llmMaxTokens) || 0;
      const streamOpts = configuredMax > 0 ? {} : { maxTokens: 16384 };
      let response;
      try {
        response = await this.llm.chatStream(messages, streamOpts, (delta) => {
          // Native reasoning_content stream (GLM, DeepSeek-R1, QwQ, ...)
          if (delta.reasoning && onDelta) {
            if (!roundStarted) {
              roundStarted = true;
              onDelta({ kind: 'reasoning_start', round, text: delta.reasoning });
            } else {
              onDelta({ kind: 'reasoning_delta', round, text: delta.reasoning });
            }
          }
          // Content-based reasoning (non-reasoning models using <reasoning> tag
          // convention per the system prompt). Without this, the user sees a
          // static "Thinking..." placeholder for minutes while the model
          // generates its chain-of-thought inside the content stream.
          if (delta.content && onDelta && !delta.reasoning) {
            contentBuf += delta.content;
            const m = contentBuf.match(/<reasoning>([\s\S]*?)(?:<\/reasoning>|$)/);
            if (m) {
              const text = m[1];
              if (text.length > contentReasoningSent) {
                const chunk = text.slice(contentReasoningSent);
                if (!roundStarted) {
                  roundStarted = true;
                  onDelta({ kind: 'reasoning_start', round, text: chunk });
                } else {
                  onDelta({ kind: 'reasoning_delta', round, text: chunk });
                }
                contentReasoningSent = text.length;
              }
            }
          }
        });
      } catch (streamErr) {
        // chatStream threw (timeout, network, host permission, etc.). Don't
        // just propagate — surface the streamed reasoning (if any) plus a
        // readable error so the user keeps the visible thinking context and
        // sees what went wrong, instead of an opaque bubble.
        console.error('[orchestrator] chatStream threw on round %d:', rounds + 1, streamErr?.message || streamErr);
        const partialReasoning = contentBuf && /<reasoning>/.test(contentBuf)
          ? (contentBuf.match(/<reasoning>([\s\S]*?)(?:<\/reasoning>|$)/)?.[1] || '').trim()
          : '';
        if (partialReasoning) {
          toolCalls.push({
            name: 'reasoning',
            args: {},
            result: { thought: partialReasoning, round, _displayOnly: true, _streamed: roundStarted }
          });
        }
        const userMsg = `The LLM call failed mid-stream (${streamErr?.message || 'unknown error'}). The reasoning above was partially captured. Please retry, or check Settings → LLM host permission and network.`;
        this.conversationHistory.push({ role: 'assistant', content: userMsg });
        await this.persist();
        return { content: userMsg, toolCalls };
      }
      const content = response.content || '';
      // Reasoning models (GLM-4.5/4.6, DeepSeek-R1, QwQ, ...) put their
      // chain-of-thought in `reasoning_content`, NOT in `content`. Non-reasoning
      // models that follow the system prompt use the <reasoning>...</reasoning>
      // tag convention. Try the native field first, fall back to the tag.
      const reasoning = response.reasoning_content || parseReasoning(content);

      // Surface the reasoning to toolCalls EARLY (before any bail-out / retry
      // path) so the UI correctly tracks the streamed reasoning card via the
      // _streamed flag even when we return from a bail-out path.
      if (reasoning) {
        toolCalls.push({
          name: 'reasoning',
          args: {},
          result: { thought: reasoning, round, _displayOnly: true, _streamed: roundStarted }
        });
      }

      const preliminaryContent = pendingPartial + content;
      const truncated = response.finish_reason === 'length';

      // Reasoning-truncation bail-out. Trigger on CONTENT SIGNATURE ALONE
      // (open <reasoning> tag with no close and no JSON attempt) — do NOT
      // require finish_reason='length', because some SSE endpoints omit
      // finish_reason or send it as null on truncated responses, which would
      // bypass this bail-out and let the orchestrator loop on retries.
      // Auto-continuing here just makes the model re-reason and re-truncate —
      // a multi-minute "Thinking..." stall. Finalize now with a clean message;
      // the streamed reasoning card is already on screen.
      const hasUnclosedReasoning = /<reasoning>/.test(preliminaryContent) && !/<\/reasoning>/.test(preliminaryContent);
      // Only match explicit tool-call markers — a loose "name": pattern can
      // false-positive on reasoning prose and suppress this bail-out.
      const hasJsonAttempt = /```json|"tool_calls"/.test(preliminaryContent);
      if (hasUnclosedReasoning && !hasJsonAttempt) {
        console.warn('[orchestrator] response has unclosed <reasoning> with no JSON attempt (finish_reason=%s) — bailing out instead of looping',
          response.finish_reason);
        // Collapse any prior auto-continue sequence so history stays clean.
        if (continueStartIdx >= 0 && continueStartIdx < this.conversationHistory.length) {
          this.conversationHistory.splice(continueStartIdx);
        }
        const bailMsg = 'I ran out of token budget while thinking through this query, before reaching a tool call. Please try a more focused question, or raise the **Max tokens** setting (Settings → LLM).';
        // Push ONE clean assistant turn: human-facing text only (unclosed
        // <reasoning> tag stripped) so future rounds don't see raw meta tags,
        // and the model doesn't see two consecutive assistant messages.
        const visiblePart = stripMeta(preliminaryContent);
        this.conversationHistory.push({ role: 'assistant', content: visiblePart ? `${visiblePart}\n\n${bailMsg}` : bailMsg });
        await this.persist();
        return { content: bailMsg, toolCalls, reasoning };
      }

      // ============================================================
      // AUTO-CONTINUE on max_tokens truncation
      // ============================================================
      // finish_reason='length' means the model hit max_tokens mid-generation.
      // If we don't act, the user sees a half-answer and has to type "please
      // continue" manually. Detect this and auto-prompt continuation.
      //
      // We only auto-continue when:
      //   - finish_reason === 'length' (not 'stop', not 'tool_calls')
      //   - no tool call JSON in the content (tool truncation has its own path)
      //   - under the MAX_AUTO_CONTINUES cap
      if (truncated && continueCount < MAX_AUTO_CONTINUES && !parseToolCalls(preliminaryContent)) {
        continueCount++;
        console.warn('[orchestrator] response truncated (finish_reason=length), auto-continuing (%d/%d)',
          continueCount, MAX_AUTO_CONTINUES);
        // Mark this position so we can collapse the partial+continue sequence
        // into one clean assistant turn on finalization.
        if (continueStartIdx < 0) continueStartIdx = this.conversationHistory.length;
        // Save partial so the next iteration's content merges onto it.
        pendingPartial = preliminaryContent;
        // Push the partial as the assistant turn (so the model sees what it
        // already wrote), then ask for the rest.
        this.conversationHistory.push({ role: 'assistant', content });
        this.conversationHistory.push({
          role: 'user',
          content: 'Continue. Output ONLY the remaining text — no <reasoning> block, no explanation, just the rest of the response.'
        });
        rounds++;
        await this.persist();
        continue;
      }

      // If we get here with a non-truncated response after a previous continue,
      // finalize the merged content. Also collapse the partial+continue
      // entries in history so future turns see one clean assistant message.
      const mergedContent = pendingPartial + content;
      if (continueStartIdx >= 0 && continueStartIdx < this.conversationHistory.length) {
        // Remove the [partial, continue, partial, continue, ...] sequence and
        // let the downstream code push the final merged answer.
        this.conversationHistory.splice(continueStartIdx);
        continueStartIdx = -1;
      }
      pendingPartial = '';

      // Use mergedContent for all downstream parsing/display.
      const effectiveContent = mergedContent;

      // (Reasoning was already pushed to toolCalls above, before the bail-out
      // and auto-continue checks, so the UI tracks the streamed reasoning card
      // correctly on every return path.)

      const requestedTools = parseToolCalls(effectiveContent);
      if (!requestedTools) {
        // Check if this looks like a TRUNCATED tool call attempt (model meant
        // to call a tool but the JSON got cut off by max_tokens).
        if (looksLikeTruncatedToolCall(effectiveContent) && truncatedRetryCount < MAX_TRUNCATED_RETRIES) {
          truncatedRetryCount++;
          console.warn('[orchestrator] detected truncated tool call, asking model to retry one-at-a-time (%d/%d)',
            truncatedRetryCount, MAX_TRUNCATED_RETRIES);
          // Push the truncated attempt so the model sees its own context, then
          // ask it to retry with a SINGLE tool call.
          this.conversationHistory.push({ role: 'assistant', content: effectiveContent });
          this.conversationHistory.push({
            role: 'user',
            content: 'Previous JSON was truncated. SKIP ALL REASONING. Output ONLY the tool call JSON block, nothing else:\n```json\n{"tool_calls": [{"name": "TOOL_NAME", "arguments": {"key": "value"}}]}\n```'
          });
          rounds++;
          continue;
        }

        // No tool calls - this is the final answer. Strip reasoning + JSON meta.
        let cleanAnswer = stripMeta(effectiveContent) || effectiveContent;
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
        return { content: cleanAnswer, toolCalls, reasoning, sources: collectedSources, autoContinued: continueCount > 0 ? continueCount : undefined };
      }

      // Execute each requested tool
      this.conversationHistory.push({ role: 'assistant', content: effectiveContent });

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
          // Wrap tool execution with a timeout so a slow/hung tool (e.g.
          // embedding endpoint unreachable) doesn't freeze the chat forever.
          const TOOL_TIMEOUT_MS = 120000; // 2 min per tool call
          const result = await Promise.race([
            this.executor.execute(call.name, call.arguments || {}),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Tool ${call.name} timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)
            )
          ]);
          toolEntry.result = result;
          // Collect citable sources from this tool result.
          const srcs = extractSources(call.name, call.arguments || {}, result, this.config.jiraBaseUrl);
          collectedSources.push(...srcs);
          this.conversationHistory.push({
            role: 'user',
            content: `Tool ${call.name} result: ${compactToolResult(result)}`
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
      { role: 'system', content: buildSystemPrompt({ ...this.config, sourceFlags: this.sourceFlags }) },
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
