/**
 * Safe text -> HTML helpers for places that use v-html.
 * Anything that can come from the user or from a shared Google Sheet (chat text, account names,
 * expense titles...) MUST go through escapeHtml before any markup is added.
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Assistant/chat message text: escapes everything first, then turns **bold** into <strong>
 * and newlines into <br>. Same visible result as before for normal messages, but any HTML a
 * user (or a collaborator, via the shared ChatHistory tab) puts in a message is shown as text.
 */
export function renderChatText(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}
