"""
Generates a self-contained Google Apps Script (create_drafts.gs) that:
  - Creates one Gmail draft per company
  - Attaches the corresponding PDF from Google Drive
  - Sets To, CC, Subject, and body automatically

Run:  python generate_draft_script.py
Then paste the output into Google Apps Script editor and run createAllDrafts().
"""

import json
import os
import re

import pandas as pd

EXCEL_PATH = (
    r"G:\My Drive\Canoil\April 2026, CC Price Increase"
    r"\MOV, VSG, Reolube - price increase April 2026 including contacts.xlsx"
)

SKIP_COMPANIES = {"Wilcox & Flegel", "Xin Pinda Intl - China", "Vattenfall"}

CC_ADDRESSES = "gamil@canoilcanadaltd.com, kathleen@canoilcanadaltd.com"
SUBJECT      = "Canoil Canada Ltd. - Price Increase Effective April 15, 2026"
OUTPUT_GS    = os.path.join(os.path.dirname(__file__), "create_drafts.gs")


def safe_filename(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    name = name.strip().replace(' ', '_')
    return (name + "_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026")[:120]


def extract_emails(raw: str) -> list[str]:
    if not raw or str(raw).strip() in ('', 'nan'):
        return []
    return re.findall(r'[\w.+\-]+@[\w.\-]+', str(raw).strip())


def parse_excel() -> list[dict]:
    df = pd.read_excel(EXCEL_PATH, sheet_name='Sheet1', header=None)
    df.columns = ['company', 'product', 'size', 'currency', 'current_price', 'new_price',
                  'contact1', 'contact2', 'contact3']

    companies = []
    current_company = None
    current_contacts: list[str] = []

    for _, row in df.iterrows():
        company = str(row['company']).strip()
        company = None if company in ('', 'nan', 'Company') else company

        if company:
            if current_company:
                companies.append({
                    'company':  current_company,
                    'contacts': list(current_contacts),
                    'pdf_name': safe_filename(current_company) + '.pdf',
                })
            current_company  = company
            current_contacts = []
            for col in ['contact1', 'contact2', 'contact3']:
                current_contacts.extend(extract_emails(str(row[col])))

    if current_company:
        companies.append({
            'company':  current_company,
            'contacts': list(current_contacts),
            'pdf_name': safe_filename(current_company) + '.pdf',
        })

    return companies


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
    companies = parse_excel()
    print(f"Found {len(companies)} companies.")

    # Build JS array
    records = []
    for c in companies:
        if c['company'] in SKIP_COMPANIES:
            print(f"  SKIPPED: {c['company']}")
            continue
        to_str = ", ".join(c['contacts']) if c['contacts'] else ""
        records.append({
            'company':  c['company'],
            'to':       to_str,
            'cc':       CC_ADDRESSES,
            'subject':  SUBJECT,
            'body':     build_body(c['company']),
            'pdf_name': c['pdf_name'],
        })

    js_array = json.dumps(records, indent=2, ensure_ascii=True)

    gs = f"""// ============================================================
// Canoil Canada - Price Increase Gmail Drafts
// Creates one draft per company with the PDF letter attached.
// HOW TO USE:
//   1. Open script.google.com
//   2. Paste this entire file into the editor
//   3. Go to Editor -> Services -> Add "Gmail API" (v1) and click Add
//   4. Click Run -> createAllDrafts
//   5. Approve permissions when prompted
//   6. Check Gmail Drafts folder
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

function createAllDrafts() {{
  var companies = {js_array};

  // Get the PDF Letters folder directly by ID
  var pdfFolder = null;
  try {{
    pdfFolder = DriveApp.getFolderById('1mLgeuvKDMGSJQ3akrkO6_pxNdqvcvGmy');
    Logger.log('PDF Letters folder found: ' + pdfFolder.getName());
  }} catch(e) {{
    Logger.log('ERROR: Could not open PDF Letters folder: ' + e.message);
  }}

  // Fetch Gmail signature once
  var signature = getGmailSignature();
  Logger.log(signature ? 'Signature loaded.' : 'No signature found - drafts will have no signature.');

  var created = 0;
  var skipped = 0;

  for (var i = 0; i < companies.length; i++) {{
    var c = companies[i];

    if (c.to === '') {{
      Logger.log('SKIPPED (no contacts): ' + c.company);
      skipped++;
      continue;
    }}

    // Find the PDF in the folder
    var blob = null;
    if (pdfFolder) {{
      var files = pdfFolder.getFilesByName(c.pdf_name);
      if (files.hasNext()) {{
        blob = files.next().getBlob().setName(c.pdf_name);
      }} else {{
        Logger.log('WARNING: PDF not found: ' + c.pdf_name);
      }}
    }}

    // Build HTML body with signature appended
    var htmlBody = c.body.replace(/\\n/g, '<br>');
    if (signature) {{
      htmlBody += '<br><br>' + signature;
    }}

    var options = {{ cc: c.cc, htmlBody: htmlBody }};
    if (blob) {{ options.attachments = [blob]; }}

    GmailApp.createDraft(c.to, c.subject, '', options);
    Logger.log('[' + (i + 1) + '/' + companies.length + '] Draft created: ' + c.company + (blob ? ' (+PDF)' : ' (no PDF)'));
    created++;
  }}

  Logger.log('Done. ' + created + ' drafts created, ' + skipped + ' skipped (no contacts).');
}}
"""

    with open(OUTPUT_GS, 'w', encoding='utf-8') as f:
        f.write(gs)

    print(f"Apps Script saved to:\n{OUTPUT_GS}")
    print(f"\nNext steps:")
    print("  1. Go to script.google.com")
    print("  2. Create new project, paste the contents of create_drafts.gs")
    print("  3. Run createAllDrafts()")


if __name__ == '__main__':
    main()
