// MV3 content script — now a real ES module that imports shared content modules.
// Requires manifest.json content_scripts entry to set "type": "module".

import { IssueExtractor } from './issue-extractor.js';
import { ChatUI } from './chat-ui.js';
import { UIInjector } from './ui-injector.js';

(function bootstrap() {
  const ui = new UIInjector();
  let lastUrl = location.href;

  function handleRouteChange() {
    const issueKey = IssueExtractor.extract();
    if (issueKey) {
      ui.inject(issueKey);
      ui.updateIssueKey(issueKey);
    } else {
      ui.remove();
    }
  }

  new MutationObserver(() => {
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      handleRouteChange();
    }
  }).observe(document, { subtree: true, childList: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', handleRouteChange);
  } else {
    handleRouteChange();
  }
})();
