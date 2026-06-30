// Conversation persistence: list, create, load, update, delete conversations
// stored in chrome.storage.local. Each conversation has an id, title, messages,
// and context state.

const STORAGE_KEY = 'conversations';
const ACTIVE_KEY = 'activeConversationId';

const MAX_CONVERSATIONS = 50;

export async function listConversations() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const conversations = stored[STORAGE_KEY] || [];
  // Sort by updatedAt desc
  return conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getConversation(id) {
  const conversations = await listConversations();
  return conversations.find(c => c.id === id) || null;
}

export async function getActiveConversationId() {
  const stored = await chrome.storage.local.get(ACTIVE_KEY);
  return stored[ACTIVE_KEY] || null;
}

export async function setActiveConversationId(id) {
  await chrome.storage.local.set({ [ACTIVE_KEY]: id });
}

export async function createConversation(title = 'New conversation', options = {}) {
  const conversations = await listConversations();
  const conv = {
    id: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    messages: [],
    context: { product: null, config: null, customer: null, locked: false },
    // Default all sources ON.
    sourceFlags: options.sourceFlags || { jira: true, confluence: true, slack: true },
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  conversations.unshift(conv);
  await saveConversations(conversations);
  await setActiveConversationId(conv.id);
  return conv;
}

export async function updateConversation(id, patch) {
  const conversations = await listConversations();
  const idx = conversations.findIndex(c => c.id === id);
  if (idx === -1) return null;
  conversations[idx] = { ...conversations[idx], ...patch, updatedAt: Date.now() };
  await saveConversations(conversations);
  return conversations[idx];
}

export async function appendMessage(id, message) {
  const conversations = await listConversations();
  const idx = conversations.findIndex(c => c.id === id);
  if (idx === -1) return null;
  conversations[idx].messages.push(message);
  conversations[idx].updatedAt = Date.now();
  // Auto-title from first user message
  if (message.role === 'user' && (!conversations[idx].title || conversations[idx].title === 'New conversation')) {
    conversations[idx].title = message.content.slice(0, 40) + (message.content.length > 40 ? '...' : '');
  }
  await saveConversations(conversations);
  return conversations[idx];
}

export async function deleteConversation(id) {
  const conversations = await listConversations();
  const filtered = conversations.filter(c => c.id !== id);
  await saveConversations(filtered);
  const activeId = await getActiveConversationId();
  if (activeId === id) {
    const next = filtered[0]?.id || null;
    await setActiveConversationId(next);
    return next;
  }
  return activeId;
}

export async function clearAllConversations() {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  await setActiveConversationId(null);
}

async function saveConversations(conversations) {
  // Cap at MAX_CONVERSATIONS, drop oldest
  const capped = conversations.slice(0, MAX_CONVERSATIONS);
  await chrome.storage.local.set({ [STORAGE_KEY]: capped });
}
