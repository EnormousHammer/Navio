"""
Generates one HTML email draft per customer from the Canoil price increase spreadsheet.
Output: one .html file per company, saved in the "Email Drafts" folder next to the spreadsheet.
"""

import pandas as pd
import os
import re

EXCEL_PATH = r"G:\My Drive\Canoil\April 2026, CC Price Increase\MOV, VSG, Reolube - price increase April 2026 including contacts.xlsx"
OUTPUT_DIR = r"G:\My Drive\Canoil\April 2026, CC Price Increase\Email Drafts"

EMAIL_INTRO = (
    "Further to our recent email regarding price increases on our products, "
    "below please find the details for the specific items your company purchases from Canoil.<br>"
    "The new prices are effective <strong>April 15, 2026</strong>."
)

CC_ADDRESSES = "gmail@canoilcanadaltd.com; kathleen@canoilcanadaltd.com"

EMAIL_FOOTER = (
    "Canoil Canada thanks you for your business.<br>"
    "If you require additional information, please contact "
    "<a href='mailto:kathleen@canoilcanadaltd.com'>Kathleen Bevan, Sales Manager</a> "
    "at kathleen@canoilcanadaltd.com"
)


def safe_filename(name: str) -> str:
    """Convert a company name to a safe filename."""
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    name = name.strip().replace(' ', '_')
    return name[:80]


def extract_emails(raw: str) -> list[str]:
    """Pull email addresses out of a cell value (handles 'Name <email>' format)."""
    if not raw or str(raw).strip() in ('', 'nan'):
        return []
    raw = str(raw).strip()
    found = re.findall(r'[\w.+\-]+@[\w.\-]+', raw)
    return found


def fmt_price(val) -> str:
    try:
        return f"{float(val):,.4f}".rstrip('0').rstrip('.')
    except (ValueError, TypeError):
        return str(val)


def build_html(company: str, contacts: list[str], rows: list[dict]) -> str:
    to_field = "; ".join(contacts) if contacts else "(no contacts found)"
    cc_field = CC_ADDRESSES

    rows_html = ""
    for r in rows:
        rows_html += (
            f"    <tr>"
            f"<td>{r['product']}</td>"
            f"<td>{r['size']}</td>"
            f"<td>{r['currency']}</td>"
            f"<td style='text-align:right'>{fmt_price(r['current_price'])}</td>"
            f"<td style='text-align:right'><strong>{fmt_price(r['new_price'])}</strong></td>"
            f"</tr>\n"
        )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Price Increase Notice – {company}</title>
  <style>
    body {{ font-family: Arial, sans-serif; font-size: 14px; color: #222; margin: 40px; }}
    .meta {{ background: #f0f4f8; padding: 10px 16px; border-radius: 6px; margin-bottom: 24px; font-size: 13px; }}
    .meta strong {{ display: inline-block; width: 60px; }}
    table {{ border-collapse: collapse; width: 100%; margin: 20px 0; }}
    th {{ background: #1a3c6e; color: #fff; padding: 8px 12px; text-align: left; }}
    td {{ padding: 7px 12px; border-bottom: 1px solid #dde3ea; }}
    tr:nth-child(even) {{ background: #f7f9fc; }}
    p {{ line-height: 1.6; }}
  </style>
</head>
<body>
  <div class="meta">
    <div><strong>To:</strong> {to_field}</div>
    <div><strong>CC:</strong> {cc_field}</div>
    <div><strong>Subject:</strong> Canoil Canada – Price Increase Effective April 15, 2026</div>
  </div>

  <p>Dear {company} Team,</p>

  <p>{EMAIL_INTRO}</p>

  <table>
    <thead>
      <tr>
        <th>Product</th>
        <th>Package Size</th>
        <th>Currency</th>
        <th style="text-align:right">Current Price</th>
        <th style="text-align:right">New Price (Apr 15, 2026)</th>
      </tr>
    </thead>
    <tbody>
{rows_html}    </tbody>
  </table>

  <p>{EMAIL_FOOTER}</p>
</body>
</html>
"""
    return html


def main():
    df = pd.read_excel(EXCEL_PATH, sheet_name='Sheet1', header=None)
    df.columns = ['company', 'product', 'size', 'currency', 'current_price', 'new_price',
                  'contact1', 'contact2', 'contact3']

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    current_company = None
    current_contacts: list[str] = []
    current_rows: list[dict] = []
    companies_written = 0

    def flush(company, contacts, rows):
        nonlocal companies_written
        if not company or not rows:
            return
        html = build_html(company, contacts, rows)
        filename = safe_filename(company) + ".html"
        filepath = os.path.join(OUTPUT_DIR, filename)
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(html)
        companies_written += 1
        print(f"  [{companies_written:02d}] {company}  ->  {filename}  (contacts: {len(contacts)}, products: {len(rows)})")

    for _, row in df.iterrows():
        company = str(row['company']).strip() if str(row['company']).strip() not in ('', 'nan') else None
        product = str(row['product']).strip() if str(row['product']).strip() not in ('', 'nan') else None

        if company and company != 'Company':
            # Save previous company before starting new one
            flush(current_company, current_contacts, current_rows)
            current_company = company
            current_contacts = []
            current_rows = []
            # Collect contacts from this first row
            for col in ['contact1', 'contact2', 'contact3']:
                emails = extract_emails(str(row[col]))
                current_contacts.extend(emails)

        if product and product != 'Product' and current_company:
            current_rows.append({
                'product': product,
                'size': row['size'] if str(row['size']).strip() not in ('', 'nan') else '',
                'currency': row['currency'] if str(row['currency']).strip() not in ('', 'nan') else '',
                'current_price': row['current_price'],
                'new_price': row['new_price'],
            })

    # Flush last company
    flush(current_company, current_contacts, current_rows)

    print(f"\nDone. {companies_written} email drafts saved to:\n{OUTPUT_DIR}")


if __name__ == '__main__':
    main()
