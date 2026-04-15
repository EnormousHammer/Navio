"""
Generates one professional PDF letter per customer from the Canoil price increase spreadsheet.
Uses Playwright (Chromium) to render HTML -> PDF with the Canoil logo letterhead.

Output: one .pdf file per company, saved in the "PDF Letters" folder next to the spreadsheet.
Run:  python generate_pdf_letters.py
"""

import os
import re

import pandas as pd
from playwright.sync_api import sync_playwright

# ── Paths ────────────────────────────────────────────────────────────────────
EXCEL_PATH = (
    r"G:\My Drive\Canoil\April 2026, CC Price Increase"
    r"\MOV, VSG, Reolube - price increase April 2026 including contacts.xlsx"
)
OUTPUT_DIR = r"G:\My Drive\Canoil\April 2026, CC Price Increase\PDF Letters"
LOGO_PATH  = (
    r"G:\Shared drives\IT_Automation\Canoil Apps\Canoil Helper"
    r"\canoil-portal\frontend\public\Canoil_logo.png"
)
SIGNATURE_PATH = r"C:\Users\Haron\Downloads\G-Signature-cleaner.png"

# ── Email fields ─────────────────────────────────────────────────────────────
CC_ADDRESSES = "gmail@canoilcanadaltd.com; kathleen@canoilcanadaltd.com"
EFFECTIVE_DATE = "April 15, 2026"
LETTER_DATE = "April 10, 2026"


# ── Helpers ──────────────────────────────────────────────────────────────────
def safe_filename(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    name = name.strip().replace(' ', '_')
    return (name + "_-_Canoil_Canada_Price_Increase_Notice_-_Apr_15_2026")[:120]


def extract_emails(raw: str) -> list[str]:
    if not raw or str(raw).strip() in ('', 'nan'):
        return []
    return re.findall(r'[\w.+\-]+@[\w.\-]+', str(raw).strip())


def fmt_price(val) -> str:
    try:
        return f"{float(val):,.2f}"
    except (ValueError, TypeError):
        return str(val)


def logo_data_uri(path: str) -> str:
    # Use file:// URI so Playwright can load it directly from disk
    return "file:///" + path.replace("\\", "/")


# ── HTML letter template ──────────────────────────────────────────────────────
def build_html(company: str, contacts: list[str], rows: list[dict], logo_uri: str, sig_uri: str) -> str:
    to_field = "; ".join(contacts) if contacts else "(no contacts on file)"

    rows_html = ""
    for i, r in enumerate(rows):
        bg = "#f7f9fc" if i % 2 == 0 else "#ffffff"
        rows_html += (
            f'<tr style="background:{bg}">'
            f'<td>{r["product"]}</td>'
            f'<td>{r["size"]}</td>'
            f'<td style="text-align:center">{r["currency"]}</td>'
            f'<td style="text-align:right">${fmt_price(r["current_price"])}</td>'
            f'<td style="text-align:right; font-weight:700; color:#1a3c6e">${fmt_price(r["new_price"])}</td>'
            f'</tr>\n'
        )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}

    @page {{
      size: Letter;
      margin: 18mm 20mm 20mm 20mm;
    }}

    body {{
      font-family: Arial, Helvetica, sans-serif;
      font-size: 10.5pt;
      color: #1a1a1a;
      background: #fff;
    }}

    /* ── Letterhead ── */
    .lh-table {{
      width: 100%;
      border-collapse: collapse;
      padding-bottom: 10px;
      border-bottom: 3px solid #1a3c6e;
      margin-bottom: 22px;
    }}
    .lh-lockup {{
      display: inline-block;
      text-align: center;
    }}
    .lh-lockup img {{
      height: 56px;
      width: auto;
      display: block;
      margin-left: auto;
      margin-right: auto;
    }}
    .lh-canada-ltd {{
      font-family: Arial, Helvetica, sans-serif;
      font-size: 15px;
      font-weight: 400;
      color: #1f1f1f;
      letter-spacing: 0.11em;
      margin-top: 5px;
      line-height: 1.15;
      text-transform: uppercase;
      text-align: center;
    }}
    .lh-address {{
      text-align: right;
      font-size: 8.5pt;
      color: #555;
      line-height: 1.6;
      vertical-align: middle;
    }}
    .lh-address strong {{
      display: block;
      font-size: 9.5pt;
      color: #1a3c6e;
      font-weight: 700;
      margin-bottom: 2px;
    }}

    /* ── Date & recipient ── */
    .date-line {{
      font-size: 10pt;
      color: #555;
      margin-bottom: 18px;
    }}
    .salutation {{
      font-size: 10.5pt;
      margin-bottom: 14px;
    }}

    /* ── Body text ── */
    .body-text {{
      font-size: 10.5pt;
      line-height: 1.65;
      margin-bottom: 18px;
    }}

    /* ── Price table ── */
    .price-table {{
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 22px;
      font-size: 10pt;
    }}
    .price-table thead tr {{
      background: #1a3c6e;
    }}
    .price-table thead th {{
      color: #fff;
      font-weight: 600;
      padding: 8px 10px;
      text-align: left;
      letter-spacing: 0.02em;
    }}
    .price-table thead th.num {{
      text-align: right;
    }}
    .price-table thead th.ctr {{
      text-align: center;
    }}
    .price-table tbody td {{
      padding: 7px 10px;
      border-bottom: 1px solid #dde3ea;
      vertical-align: middle;
    }}

    /* ── Closing ── */
    .closing-text {{
      font-size: 10.5pt;
      line-height: 1.65;
      margin-bottom: 30px;
    }}
    .closing-text a {{
      color: #1a3c6e;
    }}

    /* ── Signature block ── */
    .sig-block {{
      font-size: 10pt;
      color: #333;
      line-height: 1.7;
    }}
    .sig-block .sig-name {{
      font-weight: 700;
      font-size: 11pt;
      color: #1a3c6e;
    }}
    .sig-block .sig-title {{
      color: #555;
      font-size: 9.5pt;
    }}

    /* ── Footer rule ── */
    .footer {{
      position: running(footer);
      font-size: 7.5pt;
      color: #aaa;
      text-align: center;
      border-top: 1px solid #e0e0e0;
      padding-top: 4px;
    }}
  </style>
</head>
<body>

  <!-- Letterhead -->
  <table class="lh-table">
    <tr>
      <td class="lh-logo" style="vertical-align:middle; width:50%;">
        <div class="lh-lockup">
          <img src="{logo_uri}" alt="Canoil">
          <div class="lh-canada-ltd">CANADA LTD.</div>
        </div>
      </td>
      <td style="text-align:right; vertical-align:middle;">
        <table style="border-collapse:collapse; display:inline-table; text-align:left;">
          <tr><td style="font-size:9.5pt; color:#1a3c6e; font-weight:700; padding-bottom:3px;">Canoil Canada Ltd.</td></tr>
          <tr><td style="font-size:8.5pt; color:#555; line-height:1.7;">62 Todd Road, Georgetown</td></tr>
          <tr><td style="font-size:8.5pt; color:#555; line-height:1.7;">Ontario&nbsp; L7G 4R7, Canada</td></tr>
          <tr><td style="font-size:8.5pt; color:#555; line-height:1.7;">Tel: 1 905-820-2022&nbsp;&nbsp;|&nbsp;&nbsp;Toll Free: 1-855-520-2022</td></tr>
          <tr><td style="font-size:8.5pt; color:#555; line-height:1.7;">www.canoilcanadaltd.com</td></tr>
        </table>
      </td>
    </tr>
  </table>

  <!-- Date -->
  <p class="date-line">{LETTER_DATE}</p>

  <!-- Salutation -->
  <p class="salutation">Dear {company} Team,</p>

  <!-- Body -->
  <p class="body-text">
    Further to our recent email regarding price increases on our products, below please find
    the details for the specific items your company purchases from Canoil.
    The new prices are effective <strong>{EFFECTIVE_DATE}</strong>.
  </p>

  <!-- Price table -->
  <table class="price-table">
    <thead>
      <tr>
        <th>Product</th>
        <th>Package Size</th>
        <th class="ctr">Currency</th>
        <th class="num">Current Price</th>
        <th class="num">New Price ({EFFECTIVE_DATE})</th>
      </tr>
    </thead>
    <tbody>
{rows_html}    </tbody>
  </table>

  <!-- Closing -->
  <p class="closing-text">
    Canoil Canada thanks you for your business. If you require additional information,
    please do not hesitate to contact us.
  </p>

  <!-- Signature -->
  <div class="sig-block">
    <p style="margin-bottom:18px;">Sincerely,</p>
    <img src="{sig_uri}" alt="Signature" style="height:28px; display:block; margin-bottom:4px;">
    <p class="sig-name">Dr. Gamil Alhakimi, PhD, MBA</p>
    <p class="sig-title">President, Canoil Canada Ltd.</p>
    <p>gamil@canoilcanadaltd.com</p>
    <p>Tel: 1-905-820-2022 &nbsp;|&nbsp; Cell: 905-808-4877</p>
    <p>Toll Free: 1-855-520-2022</p>
  </div>

</body>
</html>"""


# ── Excel parsing ─────────────────────────────────────────────────────────────
def parse_excel() -> list[dict]:
    """Return list of {company, contacts, rows} dicts."""
    df = pd.read_excel(EXCEL_PATH, sheet_name='Sheet1', header=None)
    df.columns = ['company', 'product', 'size', 'currency', 'current_price', 'new_price',
                  'contact1', 'contact2', 'contact3']

    companies = []
    current_company = None
    current_contacts: list[str] = []
    current_rows: list[dict] = []

    def flush():
        if current_company and current_rows:
            companies.append({
                'company':  current_company,
                'contacts': list(current_contacts),
                'rows':     list(current_rows),
            })

    for _, row in df.iterrows():
        company = str(row['company']).strip()
        company = None if company in ('', 'nan', 'Company') else company
        product = str(row['product']).strip()
        product = None if product in ('', 'nan', 'Product') else product

        if company:
            flush()
            current_company = company
            current_contacts = []
            current_rows = []
            for col in ['contact1', 'contact2', 'contact3']:
                current_contacts.extend(extract_emails(str(row[col])))

        if product and current_company:
            current_rows.append({
                'product':       product,
                'size':          row['size'] if str(row['size']).strip() not in ('', 'nan') else '',
                'currency':      row['currency'] if str(row['currency']).strip() not in ('', 'nan') else '',
                'current_price': row['current_price'],
                'new_price':     row['new_price'],
            })

    flush()
    return companies


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("Reading Excel...")
    companies = parse_excel()
    print(f"Found {len(companies)} companies.\n")

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print(f"Output folder: {OUTPUT_DIR}\n")

    print("Encoding logo...")
    logo_uri = logo_data_uri(LOGO_PATH)
    sig_uri  = logo_data_uri(SIGNATURE_PATH)

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()

        for idx, entry in enumerate(companies, 1):
            company  = entry['company']
            contacts = entry['contacts']
            rows     = entry['rows']

            html = build_html(company, contacts, rows, logo_uri, sig_uri)

            # Write temp HTML so Playwright can load it (base64 img needs file protocol)
            tmp_html = os.path.join(OUTPUT_DIR, "_tmp_letter.html")
            with open(tmp_html, 'w', encoding='utf-8') as f:
                f.write(html)

            page.goto(f"file:///{tmp_html.replace(os.sep, '/')}")
            page.wait_for_load_state("networkidle")

            pdf_name = safe_filename(company) + ".pdf"
            pdf_path = os.path.join(OUTPUT_DIR, pdf_name)
            page.pdf(
                path=pdf_path,
                format="Letter",
                print_background=True,
                margin={"top": "18mm", "right": "20mm", "bottom": "20mm", "left": "20mm"},
            )

            contacts_str = f"{len(contacts)} contact(s)" if contacts else "NO CONTACTS"
            print(f"  [{idx:02d}/{len(companies)}] {company:45s}  {len(rows)} product(s)  |  {contacts_str}")

        browser.close()

    # Remove temp file
    try:
        os.remove(tmp_html)
    except Exception:
        pass

    print(f"\nDone. {len(companies)} PDF letters saved to:\n{OUTPUT_DIR}")


if __name__ == '__main__':
    main()
