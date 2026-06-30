import { MESSAGE_TYPES } from '../shared/message-types.js';
import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../shared/constants.js';
import { ChatOrchestrator } from './chat-orchestrator.js';
import { LlmClient } from './llm-client.js';
import { ApiClient, SlackClient } from './api-client.js';

const allKeys = Object.values(STORAGE_KEYS);

async function loadConfig() {
  const stored = await chrome.storage.local.get([...allKeys, 'driveToken']);
  const config = { ...DEFAULT_SETTINGS, ...stored };

  if (!config.confluenceApiToken && config.jiraApiToken) {
    config.confluenceApiToken = config.jiraApiToken;
  }
  if (!config.confluenceBaseUrl && config.jiraBaseUrl) {
    config.confluenceBaseUrl = config.jiraBaseUrl;
  }

  return config;
}

// Single global orchestrator for the standalone chat page.
// Each Jira tab can still use its own via the content script sidebar.
let globalOrchestrator = null;
const tabOrchestrators = new Map();

function getGlobalOrchestrator(config) {
  if (!globalOrchestrator) {
    globalOrchestrator = new ChatOrchestrator(config, 'global');
  } else {
    globalOrchestrator.config = config;
  }
  return globalOrchestrator;
}

function getOrchestrator(config, issueKey, tabId, conversationId) {
  // Standalone chat page uses conversation-scoped orchestrators so that each
  // conversation has its own history and context. Jira sidebar uses tab scope.
  if (conversationId) {
    const scopeKey = `conv:${conversationId}`;
    if (!tabOrchestrators.has(scopeKey)) {
      tabOrchestrators.set(scopeKey, new ChatOrchestrator(config, scopeKey));
    } else {
      tabOrchestrators.get(scopeKey).config = config;
    }
    return tabOrchestrators.get(scopeKey);
  }

  if (tabId) {
    const scopeKey = `tab:${tabId}`;
    if (!tabOrchestrators.has(scopeKey)) {
      tabOrchestrators.set(scopeKey, new ChatOrchestrator(config, scopeKey));
    } else {
      tabOrchestrators.get(scopeKey).config = config;
    }
    return tabOrchestrators.get(scopeKey);
  }
  return getGlobalOrchestrator(config);
}

async function resetOrchestrator(scopeKey) {
  const orchestrator = tabOrchestrators.get(scopeKey);
  if (orchestrator) {
    await orchestrator.reset();
    tabOrchestrators.delete(scopeKey);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case MESSAGE_TYPES.CHAT_MESSAGE: {
          const config = await loadConfig();
          if (!config.llmBaseUrl || !config.llmApiKey) {
            return sendResponse({ success: false, error: { message: 'LLM not configured. Open extension settings.' } });
          }
          if (!config.jiraBaseUrl || !config.jiraApiToken) {
            return sendResponse({ success: false, error: { message: 'Jira not configured. Open extension settings.' } });
          }

          const orchestrator = getOrchestrator(config, message.payload.issueKey, sender.tab?.id, message.payload.conversationId);

          // Apply per-conversation source flags before handle(). The chat
          // page sends these in the payload; the Jira sidebar leaves defaults.
          if (message.payload.sourceFlags) {
            orchestrator.setConversationMeta({
              sourceFlags: message.payload.sourceFlags
            });
          }

          // Stream reasoning tokens back to the chat UI in real-time.
          // Extension pages (chrome-extension://...) listen on
          // chrome.runtime.onMessage and filter by conversationId. Content
          // scripts in Jira tabs receive via chrome.tabs.sendMessage for
          // targeted delivery — no filter needed.
          const conversationId = message.payload.conversationId;
          const senderTabId = sender.tab?.id;
          const isExtensionPage = sender.url?.startsWith('chrome-extension://');
          const onDelta = (delta) => {
            try {
              const msg = {
                type: MESSAGE_TYPES.CHAT_DELTA,
                payload: { ...delta, conversationId }
              };
              if (isExtensionPage) {
                chrome.runtime.sendMessage(msg).catch(() => {});
              } else if (senderTabId !== undefined) {
                chrome.tabs.sendMessage(senderTabId, msg).catch(() => {});
              }
            } catch (e) {
              // SW may have just started; ignore send failures.
            }
          };

          const data = await orchestrator.handle(message.payload, onDelta);
          return sendResponse({ success: true, data });
        }

        case MESSAGE_TYPES.RESET_CONVERSATION: {
          const conversationId = message.payload?.conversationId;
          if (conversationId) {
            await resetOrchestrator(`conv:${conversationId}`);
          } else if (sender.tab?.id) {
            await resetOrchestrator(`tab:${sender.tab.id}`);
          } else if (globalOrchestrator) {
            await globalOrchestrator.reset();
          }
          return sendResponse({ success: true });
        }

        case MESSAGE_TYPES.CLEAR_ALL_CONVERSATIONS: {
          // Reset every conversation-scoped orchestrator we have in memory.
          for (const [scopeKey, orchestrator] of tabOrchestrators) {
            if (scopeKey.startsWith('conv:')) {
              await orchestrator.reset();
            }
          }
          tabOrchestrators.clear();
          if (globalOrchestrator) {
            await globalOrchestrator.reset();
            globalOrchestrator = null;
          }
          // Also remove any persisted conversation/context keys that are no
          // longer referenced by the UI's conversation list.
          const allStorage = await chrome.storage.local.get(null);
          const keysToRemove = Object.keys(allStorage).filter(
            k => k.startsWith('chatHistory:conv:') || k.startsWith('chatContext:conv:') || k.startsWith('contextState:conv:')
          );
          if (keysToRemove.length) {
            await chrome.storage.local.remove(keysToRemove);
          }
          return sendResponse({ success: true });
        }

        case MESSAGE_TYPES.TEST_JIRA_CONNECTION: {
          const config = await loadConfig();
          if (!config.jiraBaseUrl || !config.jiraApiToken) {
            return sendResponse({ success: false, error: 'Jira not configured.' });
          }

          // If user filled in a cloudId, auto-resolve it now if blank was attempted
          // (no-op for classic tokens)
          try {
            const api = new ApiClient(config);
            const myself = await api.testJiraConnection();
            return sendResponse({ success: true, displayName: myself.displayName });
          } catch (err) {
            return sendResponse({
              success: false,
              error: `${err.message}\n\nTip: if you created a scoped token (with scopes), you must also fill in Cloud ID. For classic tokens, leave Cloud ID blank.`
            });
          }
        }

        case MESSAGE_TYPES.TEST_LLM_CONNECTION: {
          const config = await loadConfig();
          if (!config.llmBaseUrl || !config.llmApiKey) {
            return sendResponse({ success: false, error: 'LLM not configured.' });
          }
          try {
            const llm = new LlmClient(config);
            const result = await llm.testConnection();
            return sendResponse({ success: true, model: config.llmModel, models: result.models });
          } catch (err) {
            return sendResponse({ success: false, error: err.message });
          }
        }

        case MESSAGE_TYPES.TEST_SLACK_CONNECTION: {
          const config = await loadConfig();
          if (!config.slackToken) {
            return sendResponse({ success: false, error: 'Slack token not configured.' });
          }
          try {
            const slack = new SlackClient(config.slackToken);
            const result = await slack.testConnection();
            return sendResponse({ success: true, user: result.user, team: result.team });
          } catch (err) {
            return sendResponse({ success: false, error: err.message });
          }
        }

        case MESSAGE_TYPES.GET_CHAT_CONTEXT: {
          const config = await loadConfig();
          const orchestrator = getOrchestrator(config, message.payload?.issueKey, sender.tab?.id, message.payload?.conversationId);
          const context = await orchestrator.getContext();
          return sendResponse({ success: true, data: context });
        }

        case MESSAGE_TYPES.GET_SETTINGS: {
          const stored = await chrome.storage.local.get(allKeys);
          return sendResponse({ success: true, data: { ...DEFAULT_SETTINGS, ...stored } });
        }

        default:
          return sendResponse({ success: false, error: 'Unknown message type.' });
      }
    } catch (err) {
      sendResponse({
        success: false,
        error: {
          message: err.message,
          code: err.code || null,
          llmBaseUrl: err.llmBaseUrl || null
        }
      });
    }
  })();
  return true; // keep channel open for async response
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.tabs.create({ url: 'src/chat/chat.html' });
  }
});

// Open the standalone chat page when the toolbar icon is clicked.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'src/chat/chat.html' });
});
