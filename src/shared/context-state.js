// ContextState: tracks the current product / config / customer context for
// the conversation. Set explicitly by the LLM's set_context tool or by the
// user via the chat UI. No auto-detection — that previously relied on the
// local document library, which has been removed.

const STORAGE_KEY = 'contextState:';

export class ContextState {
  constructor(scopeKey = 'global') {
    this.scopeKey = scopeKey;
    this.state = { product: null, config: null, customer: null, locked: false };
  }

  get storageKey() {
    return `${STORAGE_KEY}${this.scopeKey}`;
  }

  async load() {
    try {
      const stored = await chrome.storage.local.get(this.storageKey);
      if (stored[this.storageKey]) {
        this.state = { ...this.state, ...stored[this.storageKey] };
      }
    } catch (err) {
      console.warn('Failed to load context state:', err.message);
    }
    return this.state;
  }

  async save() {
    try {
      await chrome.storage.local.set({ [this.storageKey]: this.state });
    } catch (err) {
      console.warn('Failed to save context state:', err.message);
    }
  }

  // Kept as a no-op so the orchestrator call site doesn't need to change.
  // Auto-detection from text is gone with the document library; the LLM
  // drives context via the set_context tool instead.
  async updateFromText() {
    return this.state;
  }

  async set(product, config, customer, lock = false) {
    this.state = { product, config, customer, locked: lock };
    await this.save();
    return this.state;
  }

  async clear() {
    this.state = { product: null, config: null, customer: null, locked: false };
    await this.save();
  }

  get() {
    return { ...this.state };
  }

  toDisplayString() {
    const parts = [];
    if (this.state.product) parts.push(this.state.product);
    if (this.state.config) parts.push(this.state.config);
    if (this.state.customer && this.state.customer !== 'general') parts.push(this.state.customer);
    if (this.state.locked) parts.push('🔒');
    return parts.length ? parts.join(' · ') : 'No context';
  }
}
