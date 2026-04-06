/**
 * Email context helpers (web-mail MVP per docs/adr/002-email-mvp-webmail.md).
 * Native IMAP client is out of scope; we detect mail URLs for UI hints only.
 */

const MAIL_HOST_PATTERNS = [
  /mail\.google\.com/i,
  /outlook\.(live|office)\.com/i,
  /outlook\.office365\.com/i,
  /mail\.yahoo\.com/i,
  /proton\.me/i,
  /fastmail\.com/i
];

const EmailAssistant = {
  isMailUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return MAIL_HOST_PATTERNS.some((re) => re.test(url));
  },

  contextHint(url) {
    if (!this.isMailUrl(url)) return '';
    return 'You appear to be on a web mail tab. Summaries and drafts stay in this browser; nothing is sent except what you include in chat and your chosen AI provider policy.';
  }
};
