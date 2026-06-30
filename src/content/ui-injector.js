import { ChatUI } from './chat-ui.js';

export class UIInjector {
  constructor() {
    this.buttonHost = null;
    this.chatUI = null;
    this.currentIssueKey = null;
  }

  inject(issueKey) {
    if (this.currentIssueKey === issueKey && this.buttonHost) return;
    this.currentIssueKey = issueKey;
    this.remove();

    this.buttonHost = document.createElement('div');
    this.buttonHost.id = 'jira-ai-btn-host';
    const shadow = this.buttonHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .open-btn {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: #0052cc;
        color: #fff;
        border: none;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        font-size: 24px;
        cursor: pointer;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.15s, background 0.15s;
      }
      .open-btn:hover { background: #0747a6; transform: scale(1.05); }
      .badge {
        position: absolute;
        top: -2px;
        right: -2px;
        background: #de350b;
        color: #fff;
        font-size: 10px;
        padding: 2px 5px;
        border-radius: 10px;
        display: none;
      }
    `;

    const btn = document.createElement('button');
    btn.className = 'open-btn';
    btn.title = 'Open Jira AI Assistant';
    btn.innerHTML = '🤖<span class="badge"></span>';
    btn.addEventListener('click', () => this.toggleChat());

    shadow.appendChild(style);
    shadow.appendChild(btn);
    document.body.appendChild(this.buttonHost);
  }

  remove() {
    this.buttonHost?.remove();
    this.buttonHost = null;
  }

  toggleChat() {
    if (!this.chatUI) {
      this.chatUI = new ChatUI(this.currentIssueKey);
    }
    this.chatUI.toggle(document.body);
  }

  updateIssueKey(issueKey) {
    this.currentIssueKey = issueKey;
    if (this.chatUI) {
      this.chatUI.issueKey = issueKey;
      // If chat is open, add a context note about navigation
      if (this.chatUI.isOpen) {
        this.chatUI.addToolMessage('context', {}, { summary: `Switched to issue ${issueKey}` });
      }
    }
  }
}
