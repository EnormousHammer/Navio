"""
Generates create_drafts_other_greases.gs for Gmail drafts + Other Greases PDFs.

Run:  python generate_draft_script_other_greases.py
"""

import json
import os

from generate_pdf_letters_other_greases import parse_other_greases_excel, safe_filename

EMAIL_TXT = (
    r"G:\My Drive\Canoil\April 2026, CC Price Increase"
    r"\Emails for other greases.txt"
)
OUTPUT_GS = os.path.join(os.path.dirname(__file__), "create_drafts_other_greases.gs")

# Map names as they appear in the email list file -> exact company name from the Excel / PDF
TXT_TO_EXCEL = {
    "Applied Industrial Technologies": "Applied Industrial Technology",
    "Caesarstone": "CaesarStone",
    "GRP Company": "GRP",
    "GRTP Italy": "GRTP SRI",
    "Lubespec / LSI Elite Choice": "LSI",
    "PM Group": "PMGI",
    "Ventra Plastics / Flex-N-Gate": "Ventra Plastics",
    "Wajax": "Wajax Industrial",
}

CC = "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com"
SUBJECT = "Canoil Canada Ltd. - Price Increase Effective April 15, 2026"

# Google Drive folder "Other Greases PDF Letters"
PDF_FOLDER_ID = "1zfSGWO9RquRqyIXCmDOEG0Y2NAKxQ-Ws"


def parse_email_txt(path: str) -> dict[str, str]:
    mapping: dict[str, str] = {}
    with open(path, encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("According") or "Company name" in line and "email" in line:
                continue
            sep = None
            if " — " in line:
                sep = " — "
            elif " - " in line:
                sep = " - "
            if not sep:
                continue
            left, right = line.split(sep, 1)
            company = left.strip()
            right = right.strip()
            low = right.lower()
            if "no verified" in low or "not found" in low:
                mapping[company] = ""
            else:
                mapping[company] = right
    return mapping


def build_body(company: str) -> str:
    return (
        f"Dear {company} Team,\n\n"
        "Please find attached our formal price increase notification for the "
        "products your company purchases from Canoil Canada.\n\n"
        "As outlined in the attached letter, the updated prices will be "
        "effective April 15, 2026.\n\n"
        "Should you have any questions or require additional information, "
        "please do not hesitate to contact us."
    )


def main():
    txt_map = parse_email_txt(EMAIL_TXT)
    excel_emails: dict[str, str] = {}
    for txt_name, email in txt_map.items():
        excel_name = TXT_TO_EXCEL.get(txt_name, txt_name)
        if email:
            excel_emails[excel_name] = email
        elif excel_name not in excel_emails:
            excel_emails[excel_name] = ""

    companies = parse_other_greases_excel()
    records = []
    for c in companies:
        name = c["company"]
        to_str = excel_emails.get(name, "").strip()
        records.append({
            "company": name,
            "to": to_str,
            "cc": CC,
            "subject": SUBJECT,
            "body": build_body(name),
            "pdf_name": safe_filename(name) + ".pdf",
        })

    js_array = json.dumps(records, indent=2, ensure_ascii=True)

    gs = f"""// ============================================================
// Canoil Canada - Other Greases - Gmail Drafts (PDF attached)
//
// Each draft: short email + PDF + signature. Delete any old drafts that
// show a full price table in the message body.
//
// 1. Paste ENTIRE file (including getGmailSignature).
// 2. Services -> Add Gmail API v1
// 3. Run: createAllDraftsOtherGreases  (NOT getGmailSignature)
// ============================================================

function getGmailSignature() {{
  try {{
    var aliases = Gmail.Users.Settings.SendAs.list('me').sendAs;
    for (var i = 0; i < aliases.length; i++) {{
      if (aliases[i].isDefault) {{
        return aliases[i].signature || '';
      }}
    }}
  }} catch(e) {{
    Logger.log('Could not fetch signature: ' + e.message);
  }}
  return '';
}}

function createAllDraftsOtherGreases() {{
  var companies = {js_array};

  var pdfFolder = null;
  try {{
    pdfFolder = DriveApp.getFolderById('{PDF_FOLDER_ID}');
    Logger.log('Folder: ' + pdfFolder.getName());
  }} catch(e) {{
    Logger.log('ERROR opening PDF folder: ' + e.message);
  }}

  var signature = getGmailSignature();
  Logger.log(signature ? 'Signature loaded.' : 'No signature.');

  var created = 0;
  var skipped = 0;

  for (var i = 0; i < companies.length; i++) {{
    var c = companies[i];

    if (c.to === '') {{
      Logger.log('SKIPPED (no email in list): ' + c.company);
      skipped++;
      continue;
    }}

    var blob = null;
    if (pdfFolder) {{
      var files = pdfFolder.getFilesByName(c.pdf_name);
      if (files.hasNext()) {{
        blob = files.next().getBlob().setName(c.pdf_name);
      }} else {{
        Logger.log('WARNING: PDF not found: ' + c.pdf_name);
      }}
    }}

    var htmlBody = c.body.replace(/\\n/g, '<br>');
    if (signature) {{
      htmlBody += '<br><br>' + signature;
    }}

    var options = {{ cc: c.cc, htmlBody: htmlBody }};
    if (blob) {{ options.attachments = [blob]; }}

    GmailApp.createDraft(c.to, c.subject, '', options);
    Logger.log('[' + (i + 1) + '/' + companies.length + '] ' + c.company + (blob ? ' (+PDF)' : ' (no PDF)'));
    created++;
  }}

  Logger.log('Done. ' + created + ' drafts, ' + skipped + ' skipped.');
}}
"""

    with open(OUTPUT_GS, "w", encoding="utf-8") as f:
        f.write(gs)

    missing = [r["company"] for r in records if not r["to"]]
    print(f"Wrote {OUTPUT_GS}")
    print(f"Drafts to create: {sum(1 for r in records if r['to'])}")
    if missing:
        print("Skipped (no email in txt / mapping):", ", ".join(missing))


if __name__ == "__main__":
    main()
