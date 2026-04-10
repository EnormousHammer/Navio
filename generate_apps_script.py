"""
Reads all 78 HTML draft files and generates a self-contained Google Apps Script
with the email data embedded. No Drive access required — only Gmail.
"""

import os
import re
import json

DRAFTS_DIR = r"G:\My Drive\Canoil\April 2026, CC Price Increase\Email Drafts"
OUTPUT_FILE = r"G:\My Drive\Canoil\April 2026, CC Price Increase\create_gmail_drafts_v2.gs"

SKIP_CC = {'gmail@canoilcanadaltd.com', 'kathleen@canoilcanadaltd.com'}


def extract_body(html):
    """Strip the meta header box, keep only the email body content."""
    body_match = re.search(r'<body[^>]*>([\s\S]*?)</body>', html, re.IGNORECASE)
    body = body_match.group(1) if body_match else html
    # Remove the grey meta div (To/CC/Subject display — not part of the email)
    body = re.sub(r'<div class="meta">[\s\S]*?</div>\s*', '', body)
    return body.strip()


emails = []

for fname in sorted(os.listdir(DRAFTS_DIR)):
    if not fname.endswith('.html'):
        continue
    fpath = os.path.join(DRAFTS_DIR, fname)
    with open(fpath, encoding='utf-8') as f:
        html = f.read()

    to_match  = re.search(r'<strong>To:</strong>\s*([^<]+)', html)
    cc_match  = re.search(r'<strong>CC:</strong>\s*([^<]+)', html)
    sub_match = re.search(r'<strong>Subject:</strong>\s*([^<]+)', html)

    if not to_match:
        print(f'  SKIP (no To): {fname}')
        continue

    to_raw  = to_match.group(1).strip()
    cc_raw  = cc_match.group(1).strip() if cc_match else 'gmail@canoilcanadaltd.com; kathleen@canoilcanadaltd.com'
    subject = sub_match.group(1).strip() if sub_match else 'Canoil Canada \u2013 Price Increase Effective April 15, 2026'

    to_emails = re.findall(r'[\w.+\-]+@[\w.\-]+', to_raw)
    to_emails = [e for e in to_emails if e.lower() not in SKIP_CC]

    if not to_emails:
        print(f'  SKIP (no valid To email): {fname}')
        continue

    body = extract_body(html)

    emails.append({
        'company': fname.replace('.html', '').replace('_', ' '),
        'to':      ', '.join(to_emails),
        'cc':      cc_raw,
        'subject': subject,
        'body':    body,
    })

print(f'Loaded {len(emails)} emails.')

# ── Build the .gs file ────────────────────────────────────────────────────────
gs_lines = []

gs_lines.append("""/**
 * Canoil Price Increase - Create Gmail Drafts (v2, self-contained)
 *
 * HOW TO USE:
 * 1. Go to https://script.google.com - New project
 * 2. Delete default code, paste this entire script
 * 3. Save, then click Run (authorise Gmail access when prompted)
 * 4. Open Gmail - Drafts - all emails will be waiting for your review
 *
 * NOTHING IS SENT. Only Gmail.Users.Drafts.create() is called.
 */

function createCanoilDrafts() {
  var emails = EMAIL_DATA();
  var created = 0;
  var skipped = [];

  for (var i = 0; i < emails.length; i++) {
    var e = emails[i];
    try {
      var raw = buildRawMessage(e.to, e.cc, e.subject, e.body);
      var draft = Gmail.Users.Drafts.create({ message: { raw: raw } }, 'me');
      if (draft && draft.id) {
        created++;
        Logger.log('DRAFT SAVED [' + (i+1) + '/' + emails.length + ']: ' + e.company + ' -> ' + e.to);
      } else {
        skipped.push(e.company + ' (no draft ID returned)');
      }
    } catch(err) {
      skipped.push(e.company + ': ' + err.message);
      Logger.log('ERROR: ' + e.company + ' — ' + err.message);
    }
  }

  Logger.log('==============================================');
  Logger.log('DONE: ' + created + ' drafts saved to Gmail.');
  if (skipped.length > 0) {
    Logger.log('SKIPPED/ERRORS (' + skipped.length + '):');
    for (var j = 0; j < skipped.length; j++) Logger.log('  ' + skipped[j]);
  }
  Logger.log('==============================================');
}

function buildRawMessage(to, cc, subject, htmlBody) {
  var fullHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
    + '<style>'
    + 'body{font-family:Arial,sans-serif;font-size:14px;color:#222;margin:20px}'
    + 'table{border-collapse:collapse;width:100%;margin:20px 0}'
    + 'th{background:#1a3c6e;color:#fff;padding:8px 12px;text-align:left}'
    + 'td{padding:7px 12px;border-bottom:1px solid #dde3ea}'
    + 'tr:nth-child(even){background:#f7f9fc}'
    + 'p{line-height:1.6}'
    + '</style></head><body>'
    + htmlBody
    + '</body></html>';

  var message = [
    'To: ' + to,
    'Cc: ' + cc,
    'Subject: ' + subject,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    fullHtml
  ].join('\\r\\n');

  return Utilities.base64EncodeWebSafe(message);
}

""")

# Embed all email data as a JS function returning an array
gs_lines.append('function EMAIL_DATA() {')
gs_lines.append('  return [')

for i, e in enumerate(emails):
    comma = ',' if i < len(emails) - 1 else ''
    # Escape the body for embedding in a JS string
    body_escaped = (e['body']
        .replace('\\', '\\\\')
        .replace('`', '\\`')
        .replace('${', '\\${')
    )
    gs_lines.append(f'    {{')
    gs_lines.append(f'      company: {json.dumps(e["company"], ensure_ascii=True)},')
    gs_lines.append(f'      to:      {json.dumps(e["to"],      ensure_ascii=True)},')
    gs_lines.append(f'      cc:      {json.dumps(e["cc"],      ensure_ascii=True)},')
    gs_lines.append(f'      subject: {json.dumps(e["subject"], ensure_ascii=True)},')
    gs_lines.append(f'      body:    {json.dumps(e["body"],    ensure_ascii=True)}')
    gs_lines.append(f'    }}{comma}')

gs_lines.append('  ];')
gs_lines.append('}')

script_content = '\n'.join(gs_lines)

with open(OUTPUT_FILE, 'w', encoding='ascii', errors='replace') as f:
    f.write(script_content)

print(f'\nGenerated: {OUTPUT_FILE}')
print(f'File size: {os.path.getsize(OUTPUT_FILE):,} bytes')
print(f'Emails embedded: {len(emails)}')
