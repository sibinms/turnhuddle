// A VS Code window that was open when Turnhuddle updated from 0.2.x keeps the old layout until it reloads, and the old Chat
// pane would spin forever. Fill it with a note and a Reload button instead. Webview views accept a provider for an id the
// manifest no longer declares; tree views don't (VS Code shows an error), so only the old Chat pane gets one.
import * as vscode from 'vscode';
/** View ids from earlier versions that a window opened before the update may still show. */
export const LEGACY_CHAT_VIEW = 'turnhuddle.conversation';
export function legacyHtml(nonce: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:12px 16px;line-height:1.5}
button{margin-top:8px;padding:4px 12px;border:none;border-radius:2px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer;font:inherit}
button:hover{background:var(--vscode-button-hoverBackground)}</style></head><body>
<p><strong>Turnhuddle has been updated.</strong></p>
<p>Reload the window to finish updating. Threads then appear in the left bar and the chat in the right-hand sidebar.</p>
<button id="reload">Reload Window</button>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById('reload').addEventListener('click',()=>vscode.postMessage({type:'reload'}));</script>
</body></html>`;
}
export function registerLegacyViews(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(LEGACY_CHAT_VIEW, {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: true };
      view.webview.html = legacyHtml(Math.random().toString(36).slice(2) + Date.now().toString(36));
      view.webview.onDidReceiveMessage(m => { if (m?.type === 'reload') void vscode.commands.executeCommand('workbench.action.reloadWindow'); });
    }
  }));
}
