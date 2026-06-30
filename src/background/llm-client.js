import { LLM_TIMEOUT_MS } from '../shared/constants.js';
import { hasHostPermission } from '../shared/permissions.js';

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
  }

  get chatCompletionsUrl() {
    return `${this.baseUrl}/chat/completions`;
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
      return data.choices?.[0]?.message || { role: 'assistant', content: '' };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error('LLM request timed out after 60 seconds.');
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
          throw err2;
        }
        throw new Error(
          `Cannot reach LLM endpoint at ${this.baseUrl} (host permission is granted).\n` +
          `Common causes:\n` +
          `  1. The endpoint is not running (e.g. local Ollama / LM Studio not started).\n` +
          `  2. The URL is wrong or missing the http:/https: prefix.\n` +
          `  3. CORS is blocking the request — if using a local LLM, set OLLAMA_ORIGINS=* (or the equivalent for your server).\n` +
          `  4. Self-signed certificate on an https endpoint (service workers cannot prompt to trust these).\n` +
          `  5. Network / VPN disconnected.`
        );
      }
      throw err;
    }
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
