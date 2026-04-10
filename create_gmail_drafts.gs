/**
 * Canoil Price Increase — Create Gmail Drafts
 *
 * HOW TO USE:
 * 1. Go to https://script.google.com and create a New Project
 * 2. Delete the default code and paste this entire script
 * 3. Click the floppy-disk Save icon
 * 4. Click Run (▶) — first run will ask you to authorise Gmail + Drive access
 * 5. Open Gmail — all 78 drafts will be waiting for you to review and send
 */

function createCanoilDrafts() {

  // ── Locate the Email Drafts folder directly by ID ────────────────────────
  var draftsFolder = DriveApp.getFolderById('1dRBn8Mo1NCk0m5gVwmdQPv61T_LNgkkb');

  var files = draftsFolder.getFilesByType(MimeType.HTML);
  var created = 0;
  var skipped = 0;
  var errors  = [];

  while (files.hasNext()) {
    var file = files.next();
    var html  = file.getBlob().getDataAsString();

    // ── Parse To ───────────────────────────────────────────────────────────
    var toMatch = html.match(/<strong>To:<\/strong>\s*([^<]+)/);
    if (!toMatch) { skipped++; continue; }
    var toRaw    = toMatch[1].trim();
    var toEmails = extractEmails(toRaw);
    if (toEmails.length === 0) { skipped++; continue; }

    // ── Parse CC ───────────────────────────────────────────────────────────
    var ccMatch  = html.match(/<strong>CC:<\/strong>\s*([^<]+)/);
    var ccString = ccMatch ? ccMatch[1].trim() : 'gmail@canoilcanadaltd.com; kathleen@canoilcanadaltd.com';

    // ── Parse Subject ──────────────────────────────────────────────────────
    var subMatch = html.match(/<strong>Subject:<\/strong>\s*([^<]+)/);
    var subject  = subMatch ? subMatch[1].trim() : 'Canoil Canada \u2013 Price Increase Effective April 15, 2026';

    // ── Extract email body (everything inside <body>, strip the meta div) ──
    var bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    var body = bodyMatch ? bodyMatch[1] : html;

    // Remove the grey meta header box (To/CC/Subject) — not part of the email
    body = body.replace(/<div class="meta">[\s\S]*?<\/div>\s*/, '');

    // ── Build the raw RFC 2822 email message ───────────────────────────────
    var toStr = toEmails.join(', ');
    var raw = buildRawMessage(toStr, ccString, subject, body);

    // ── Create the Gmail draft (DRAFTS ONLY — nothing is sent) ────────────
    // Gmail.Users.Drafts.create() stores the email as a draft.
    // It does NOT call Gmail.Users.Messages.send() and does NOT send anything.
    try {
      var draft = Gmail.Users.Drafts.create(
        { message: { raw: raw } },
        'me'
      );
      // Verify it was saved as a draft, not sent
      if (!draft || !draft.id) {
        errors.push(file.getName() + ': Draft ID not returned — may not have saved correctly.');
        continue;
      }
      created++;
      Logger.log('DRAFT SAVED (not sent): ' + file.getName() + ' -> ' + toStr + ' | Draft ID: ' + draft.id);
    } catch (e) {
      errors.push(file.getName() + ': ' + e.message);
      Logger.log('ERROR ' + file.getName() + ': ' + e.message);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  Logger.log('========================================');
  Logger.log('DONE: ' + created + ' drafts created in Gmail.');
  if (skipped > 0)      Logger.log(skipped + ' files skipped (no To address found).');
  if (errors.length > 0) Logger.log('ERRORS:\n' + errors.join('\n'));
  Logger.log('========================================');
}


// ── Helpers ──────────────────────────────────────────────────────────────────

function extractEmails(str) {
  var matches = str.match(/[\w.+\-]+@[\w.\-]+/g); 
  return matches ? matches : [];
}

/**
 * Builds a Base64url-encoded RFC 2822 message suitable for the Gmail API.
 * The body is sent as text/html so the table renders correctly.
 */
function buildRawMessage(to, cc, subject, htmlBody) {

  // Wrap body in a minimal HTML document so Gmail renders the table correctly
  var fullHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
    + '<style>'
    + 'body{font-family:Arial,sans-serif;font-size:14px;color:#222;margin:20px}'
    + 'table{border-collapse:collapse;width:100%;margin:20px 0}'
    + 'th{background:#1a3c6e;color:#fff;padding:8px 12px;text-align:left}'
    + 'td{padding:7px 12px;border-bottom:1px solid #dde3ea}'
    + 'tr:nth-child(even){background:#f7f9fc}'
    + 'p{line-height:1.6}'
    + '</style>'
    + '</head><body>'
    + htmlBody
    + '</body></html>';

  var headers = [
    'To: '      + to,
    'Cc: '      + cc,
    'Subject: ' + subject,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    ''
  ].join('\r\n');

  var message = headers + '\r\n' + fullHtml;

  // Base64url encode (Gmail API requires base64url, not standard base64)
  var encoded = Utilities.base64EncodeWebSafe(message);
  return encoded;
}
