import { LLM_TIMEOUT_MS } from '../shared/constants.js';
import { hasHostPermission } from '../shared/permissions.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Coerce an embedding payload into a number[].
 * Handles both float arrays and base64-encoded float32 strings (some
 * endpoints ignore `encoding_format: "float"` and return base64).
 */
function toVector(e) {
  if (Array.isArray(e)) return e.map(Number);
  if (typeof e === 'string') {
    try {
      const bin = atob(e);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return Array.from(new Float32Array(bytes.buffer));
    } catch {
      return null;
    }
  }
  return null;
}

export class LlmClient {
  constructor(config) {
    this.config = config;
    this.baseUrl = (config.llmBaseUrl || '').replace(/\/$/, '');
    this.apiKey = config.llmApiKey;
    this.model = config.llmModel;
    // Optional smaller/faster model for the search pipeline (summarize, query
    // expansion, rerank). Falls back to the main model when not configured.
    this.cheapModel = config.llmCheapModel || null;
    // 0 or null = no limit (omit max_tokens from the request body so the model
    // uses its own default maximum context for completion).
    this.maxTokens = config.llmMaxTokens || 0;
    this.temperature = config.llmTemperature ?? 0.3;

    // --- Dense-vector embedding config (separate from the chat LLM) ---
    // Embeddings may come from a DIFFERENT provider than the chat model
    // (e.g. chat on Kimi, embeddings on Zhipu embedding-3). Defaults fall
    // back to the chat LLM's host/key so a single OpenAI-compatible account
    // still works without extra setup.
    this.embedBaseUrl = (config.embedBaseUrl || config.llmBaseUrl || '').replace(/\/$/, '');
    this.embedApiKey = config.embedApiKey || config.llmApiKey || '';
    this.embedModel = config.embeddingModel || 'text-embedding-3-small';
    this.embedDims = Number(config.embedDims) || 0;
    // 'openai' (default) or 'ark-multimodal' — controls the request path
    // and the shape of `input` (see embed()).
    this.embedApiStyle = config.embedApiStyle || 'openai';
  }

  get chatCompletionsUrl() {
    return `${this.baseUrl}/chat/completions`;
  }

  get embeddingsUrl() {
    // Volcengine Ark multimodal models live at /embeddings/multimodal
    // (the plain /embeddings path serves text-only models). OpenAI-compatible
    // providers use /embeddings.
    const suffix = this.embedApiStyle === 'ark-multimodal' ? '/embeddings/multimodal' : '/embeddings';
    return `${this.embedBaseUrl}${suffix}`;
  }

  /**
   * Whether a usable embedding endpoint is configured. Embeddings and chat
   * are independent: the chat model may be unset (legacy search) while
   * embeddings are ready, and vice-versa.
   */
  get isEmbeddingEnabled() {
    return Boolean(this.embedBaseUrl && this.embedApiKey && this.embedModel);
  }

  /**
   * Generate dense vectors for one or more texts.
   *
   * Two request styles are supported (selected via `embedApiStyle`):
   *   - 'openai' (default): POST {base}/embeddings with `input` as a
   *     string or string[] — works for OpenAI, Zhipu embedding-3, Ollama, ...
   *   - 'ark-multimodal': POST {base}/embeddings/multimodal with `input`
   *     as an array of content objects `[{ type:'text', text }]` — required
   *     by Volcengine Ark doubao-embedding-vision / multimodal models.
   *
   * Returns number[][] — one vector per input text, in order.
   *
   * @param {string|string[]} texts - single string or array
   * @returns {Promise<number[][]>}
   */
  async embed(texts) {
    if (!this.isEmbeddingEnabled) {
      throw new Error('Embedding not configured. Open extension settings and fill in the Vector Search (Embedding) section.');
    }
    const style = this.embedApiStyle === 'ark-multimodal' ? 'ark-multimodal' : 'openai';
    const rawTexts = Array.isArray(texts) ? texts : [texts];
    // Ark multimodal requires the content-object shape even for text-only
    // input; plain OpenAI-compatible endpoints want bare strings.
    const input = style === 'ark-multimodal'
      ? rawTexts.map((t) => ({ type: 'text', text: String(t) }))
      : rawTexts;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      const body = { model: this.embedModel, input };
      // Always ask for float vectors — some endpoints default to base64
      // strings, which our parser would mistake for "no vector".
      body.encoding_format = 'float';
      // Only send `dimensions` when explicitly set — most providers either
      // ignore it (fixed-dim models) or require it. text-embedding-3-* and
      // Zhipu embedding-3 honor it for dimensionality reduction.
      if (this.embedDims && this.embedDims > 0) {
        body.dimensions = this.embedDims;
      }
      // Retry on 429 (TPM/RPM rate limit) with exponential backoff. Provider
      // tells us when to slow down; respecting Retry-After when present.
      const MAX_RETRIES = 4;
      let res = null;
      let lastErr = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          res = await fetch(this.embeddingsUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.embedApiKey}`
            },
            body: JSON.stringify(body),
            signal: controller.signal
          });
        } catch (netErr) {
          lastErr = netErr;
          if (attempt < MAX_RETRIES) {
            await sleep(500 * Math.pow(2, attempt));
            continue;
          }
          throw netErr;
        }
        if (res.ok) break;
        // 429 → retry with backoff. Other 4xx/5xx → fail fast.
        if (res.status === 429 && attempt < MAX_RETRIES) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(30000, 1000 * Math.pow(2, attempt) + Math.random() * 500);
          console.warn(`[embed] 429 rate limit, retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          // Drain the body so the connection can be reused.
          await res.text().catch(() => {});
          await sleep(waitMs);
          continue;
        }
        const text = await res.text().catch(() => '');
        throw new Error(`Embedding API error ${res.status}: ${text.slice(0, 300)}`);
      }
      if (!res || !res.ok) {
        throw lastErr || new Error('Embedding API exhausted retries');
      }
      clearTimeout(timeoutId);
      const data = await res.json();

      // Normalize to number[][] across the response shapes providers use:
      //   OpenAI / Zhipu / Ark-text : { data: [ { embedding:[...] }, ... ] }
      //   Ark multimodal (object)    : { data: { embedding:[...] } }
      //   Ark envelope              : { code, message, data: [ ... ] }
      //   bare embedding           : { embedding:[...] }  |  [ 0.1, 0.2, ... ]
      let arr = null;
      if (Array.isArray(data?.data) && typeof data.data[0] === 'number') {
        arr = [{ embedding: data.data }];
      } else if (Array.isArray(data?.data)) {
        arr = data.data;
      } else if (data?.data && Array.isArray(data.data.embedding)) {
        arr = [{ embedding: data.data.embedding }];
      } else if (Array.isArray(data?.embeddings)) {
        arr = data.embeddings.map((e) => ({ embedding: e }));
      } else if (Array.isArray(data?.embedding)) {
        arr = [{ embedding: data.embedding }];
      } else if (Array.isArray(data) && typeof data[0] === 'number') {
        arr = [{ embedding: data }];
      }

      if (!arr) {
        throw new Error(
          'Embedding API returned an unexpected shape (no recognizable embedding). ' +
          'Raw response: ' + JSON.stringify(data).slice(0, 600)
        );
      }

      const vectors = arr.map((d) => toVector(d?.embedding)).filter(Array.isArray);
      if (vectors.length === 0) {
        throw new Error(
          'Embedding API returned 0 usable vectors. ' +
          'Raw response: ' + JSON.stringify(data).slice(0, 600)
        );
      }

      // Providers may return more vectors than requested (trim those).
      // If they return FEWER, retry one-by-one IN PARALLEL (some providers
      // like Ark multimodal only support single-input despite accepting
      // arrays). Per-issue requests fire with bounded concurrency to avoid
      // rate limits.
      if (vectors.length < input.length && input.length > 1) {
        console.warn(`[embed] Provider returned ${vectors.length}/${input.length} vectors, falling back to per-issue embed (parallel)`);
        const CONCURRENCY = 5;
        const seqVectors = new Array(input.length).fill(null);
        for (let i = 0; i < input.length; i += CONCURRENCY) {
          const slice = input.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            slice.map((singleInput) =>
              fetch(this.embeddingsUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.embedApiKey}` },
                body: JSON.stringify({ model: this.embedModel, input: [singleInput], encoding_format: 'float' })
              }).then(async (seqRes) => {
                if (!seqRes.ok) return null;
                const seqData = await seqRes.json();
                const seqArr = Array.isArray(seqData?.data)
                  ? seqData.data
                  : (seqData?.data?.embedding ? [{ embedding: seqData.data.embedding }] : []);
                const seqVec = seqArr.map((d) => toVector(d?.embedding)).filter(Array.isArray);
                return seqVec[0] || null;
              })
            )
          );
          results.forEach((r, j) => {
            if (r.status === 'fulfilled') seqVectors[i + j] = r.value;
          });
        }
        const valid = seqVectors.filter(Array.isArray);
        if (valid.length > 0) return seqVectors;
        throw new Error('Sequential embed fallback also failed.');
      }
      if (vectors.length < input.length) {
        throw new Error(
          `Embedding API returned ${vectors.length} vectors for ${input.length} input texts. ` +
          'Raw response: ' + JSON.stringify(data).slice(0, 600)
        );
      }
      return vectors.slice(0, input.length);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'TypeError' && /Failed to fetch/i.test(err.message)) {
        const hasPerm = await hasHostPermission(this.embedBaseUrl);
        if (!hasPerm) {
          const e = new Error(
            `Host permission missing for ${this.embedBaseUrl}.\n` +
            `Chrome needs you to authorize this host once. Open Settings → Vector Search and click "Authorize Embedding Host".`
          );
          e.code = 'HOST_PERMISSION_MISSING';
          e.embedBaseUrl = this.embedBaseUrl;
          throw e;
        }
        throw new Error(`Cannot reach embedding endpoint at ${this.embedBaseUrl} (host permission is granted). Check the URL, API key, and network.`);
      }
      throw err;
    }
  }

  async chat(messages, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    try {
      const body = {
        model: options.model || this.model,
        messages,
        temperature: options.temperature ?? this.temperature
      };

      // Only send max_tokens when explicitly set (>0). Most OpenAI-compatible
      // APIs treat a missing field as "use model default", which effectively
      // removes the limit.
      if (options.maxTokens && options.maxTokens > 0) {
        body.max_tokens = options.maxTokens;
      } else if (this.maxTokens && this.maxTokens > 0) {
        body.max_tokens = this.maxTokens;
      }

      if (options.tools?.length) {
        body.tools = options.tools;
        body.tool_choice = 'auto';
      }

      const res = await fetch(this.chatCompletionsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM API error ${res.status}: ${text}`);
      }

      const data = await res.json();
      const msg = data.choices?.[0]?.message || { role: 'assistant', content: '' };
      msg.finish_reason = data.choices?.[0]?.finish_reason || null;
      return msg;
    } catch (err) {
      clearTimeout(timeoutId);
      throw await this._wrapError(err);
    }
  }

  /**
   * Streaming variant of chat() for real-time thinking. Parses SSE chunks
   * from the OpenAI-compatible /chat/completions endpoint and invokes
   * onDelta({reasoning, content}) for each token.
   *
   * Reasoning models (GLM-4.5/4.6, DeepSeek-R1, QwQ, ...) emit thinking in
   * `delta.reasoning_content`; we stream that to the UI immediately. The
   * `content` field is accumulated and returned as the final message — the
   * final answer is NOT streamed (only the thinking is), matching the
   * user-facing UX choice.
   *
   * @param {Array} messages
   * @param {object} options
   * @param {(delta: {reasoning?: string, content?: string}) => void} onDelta
   * @returns {Promise<object>} full assistant message
   */
  async chatStream(messages, options = {}, onDelta) {
    const controller = new AbortController();

    // Use an IDLE timeout instead of a fixed total timeout. Reasoning models
    // (GLM-4.5/4.6, DeepSeek-R1, QwQ) can generate thinking for 2+ minutes;
    // a fixed 60s total timeout kills the stream mid-thought, leaving the
    // user staring at an incomplete "thinking" card. The idle timer resets
    // on every chunk, so as long as the model is actively producing tokens
    // the stream stays alive. A hard 5-minute ceiling prevents runaway.
    const IDLE_TIMEOUT_MS = 30000;
    const MAX_TOTAL_MS = 300000;
    let idleTimer = null;
    const totalTimer = setTimeout(() => controller.abort(), MAX_TOTAL_MS);
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
    };
    resetIdle();

    try {
      const body = {
        model: options.model || this.model,
        messages,
        temperature: options.temperature ?? this.temperature,
        stream: true
      };
      if (options.maxTokens && options.maxTokens > 0) {
        body.max_tokens = options.maxTokens;
      } else if (this.maxTokens && this.maxTokens > 0) {
        body.max_tokens = this.maxTokens;
      }
      if (options.tools?.length) {
        body.tools = options.tools;
        body.tool_choice = 'auto';
      }

      const res = await fetch(this.chatCompletionsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM API error ${res.status}: ${text}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let reasoningAcc = '';
      let contentAcc = '';
      let toolCallsAcc = [];
      let finishReason = null;

      while (true) {
        const { done, value } = await reader.read();
        resetIdle();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by double newlines. Process complete
        // events and keep any trailing partial in the buffer.
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const json = JSON.parse(payload);
              const choice = json.choices?.[0];
              const delta = choice?.delta;
              // Capture finish_reason from the final chunk. Values:
              //   stop    = model finished naturally
              //   length  = hit max_tokens mid-generation (truncated!)
              //   tool_calls = stopped to call a tool (normal)
              //   content_filter = blocked by safety filter
              if (choice?.finish_reason) {
                finishReason = choice.finish_reason;
              }
              if (!delta) continue;
              if (delta.reasoning_content) {
                reasoningAcc += delta.reasoning_content;
                if (onDelta) onDelta({ reasoning: delta.reasoning_content });
              }
              if (delta.content) {
                contentAcc += delta.content;
                if (onDelta) onDelta({ content: delta.content });
              }
              if (delta.tool_calls) {
                // Accumulate streamed tool-call args — appended to the final
                // message so the orchestrator's parseToolCalls(content) path
                // can still extract them. (Tool-call streaming is not
                // user-visible, but we need the data to call the tool.)
                toolCallsAcc = toolCallsAcc.concat(delta.tool_calls);
              }
            } catch (e) {
              // Partial JSON in the middle of a chunk boundary — ignore, the
              // next read will complete it.
            }
          }
        }
      }

      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      const msg = { role: 'assistant', content: contentAcc, finish_reason: finishReason };
      if (reasoningAcc) msg.reasoning_content = reasoningAcc;
      if (toolCallsAcc.length) msg.tool_calls = toolCallsAcc;
      return msg;
    } catch (err) {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      throw this._wrapError(err);
    }
  }

  /**
   * Normalize fetch errors (timeout, host permission, network) into messages
   * the chat UI can act on. Shared between chat() and chatStream().
   */
  async _wrapError(err) {
    if (err.name === 'AbortError') {
      return new Error('LLM request timed out after 60 seconds.');
    }
    // Chrome's fetch() throws a TypeError "Failed to fetch" for a wide range
    // of network/DNS/CORS/permission/certificate failures. Check host
    // permission first since that's the most common cause for remote LLM
    // endpoints in MV3.
    if (err.name === 'TypeError' && /Failed to fetch/i.test(err.message)) {
      const hasPerm = await hasHostPermission(this.baseUrl);
      if (!hasPerm) {
        // Use a structured prefix so the chat UI can detect this and show
        // an "Authorize now" button. Keep the URL token intact for extraction.
        const err2 = new Error(
          `Host permission missing for ${this.baseUrl}.\n` +
          `Chrome needs you to authorize this host once. Click "Authorize LLM Host" below — a Chrome prompt will appear, click "Allow".`
        );
        err2.code = 'HOST_PERMISSION_MISSING';
        err2.llmBaseUrl = this.baseUrl;
        return err2;
      }
      return new Error(
        `Cannot reach LLM endpoint at ${this.baseUrl} (host permission is granted).\n` +
        `Common causes:\n` +
        `  1. The endpoint is not running (e.g. local Ollama / LM Studio not started).\n` +
        `  2. The URL is wrong or missing the http:/https: prefix.\n` +
        `  3. CORS is blocking the request — if using a local LLM, set OLLAMA_ORIGINS=* (or the equivalent for your server).\n` +
        `  4. Self-signed certificate on an https endpoint (service workers cannot prompt to trust these).\n` +
        `  5. Network / VPN disconnected.`
      );
    }
    return err;
  }

  /**
   * Run a completion against the cheaper model (used by the search pipeline:
   * ticket summarization, query expansion, rerank). Falls back to the main
   * model when no cheap model is configured. Same request shape as chat().
   */
  async chatCheap(messages, options = {}) {
    return this.chat(messages, {
      ...options,
      model: this.cheapModel || this.model
    });
  }

  async testConnection() {
    // Check host permission first so we can give a clear error instead of
    // a opaque "Failed to fetch".
    const hasPerm = await hasHostPermission(this.baseUrl);
    if (!hasPerm) {
      throw new Error('Host permission missing for ' + this.baseUrl + '. Click "Test LLM Connection" again and approve the Chrome permission prompt.');
    }
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });
    if (!res.ok) throw new Error(`LLM connection failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return { models: data.data?.map(m => m.id) || [] };
  }
}
