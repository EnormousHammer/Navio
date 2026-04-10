"""
Strict verification: every product row and every contact email in each HTML draft
must exactly match what is in the Excel spreadsheet. Any mismatch is a FAIL.
"""

import pandas as pd
import os
import re

EXCEL_PATH = r"G:\My Drive\Canoil\April 2026, CC Price Increase\MOV, VSG, Reolube - price increase April 2026 including contacts.xlsx"
DRAFTS_DIR = r"G:\My Drive\Canoil\April 2026, CC Price Increase\Email Drafts"

SKIP_CC = {"gmail@canoilcanadaltd.com", "kathleen@canoilcanadaltd.com"}


def extract_emails(raw):
    if not raw or str(raw).strip() in ('', 'nan'):
        return []
    return re.findall(r'[\w.+\-]+@[\w.\-]+', str(raw).strip())


def safe_filename(name):
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    return name.strip().replace(' ', '_')[:80] + '.html'


def fmt_price(val):
    try:
        s = f"{float(val):,.4f}".rstrip('0').rstrip('.')
        return s
    except (ValueError, TypeError):
        return str(val)


# ── Read Excel ────────────────────────────────────────────────────────────────
df = pd.read_excel(EXCEL_PATH, sheet_name='Sheet1', header=None)
df.columns = ['company', 'product', 'size', 'currency', 'current_price', 'new_price',
              'contact1', 'contact2', 'contact3']

current_company = None
excel_data = {}  # company -> {contacts: [], rows: []}

for _, row in df.iterrows():
    co = str(row['company']).strip()
    pr = str(row['product']).strip()
    company = co if co not in ('', 'nan', 'Company') else None
    product = pr if pr not in ('', 'nan', 'Product') else None

    if company:
        current_company = company
        excel_data[company] = {'contacts': [], 'rows': []}
        for col in ['contact1', 'contact2', 'contact3']:
            excel_data[company]['contacts'].extend(extract_emails(str(row[col])))

    if product and current_company:
        sp = str(row['size']).strip()
        cp = str(row['currency']).strip()
        excel_data[current_company]['rows'].append({
            'product': product,
            'size': sp if sp not in ('', 'nan') else '',
            'currency': cp if cp not in ('', 'nan') else '',
            'current_price': fmt_price(row['current_price']),
            'new_price': fmt_price(row['new_price']),
        })


# ── Parse HTML helpers ────────────────────────────────────────────────────────
def parse_html_contacts(html):
    to_match = re.search(r'<strong>To:</strong>\s*([^<]+)', html)
    if not to_match:
        return []
    raw = to_match.group(1).strip()
    emails = re.findall(r'[\w.+\-]+@[\w.\-]+', raw)
    return [e for e in emails if e.lower() not in SKIP_CC]


def parse_html_rows(html):
    tbody = re.search(r'<tbody>(.*?)</tbody>', html, re.DOTALL)
    if not tbody:
        return []
    rows = re.findall(r'<tr>(.*?)</tr>', tbody.group(1), re.DOTALL)
    result = []
    for row in rows:
        cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
        cells = [re.sub(r'<[^>]+>', '', c).strip() for c in cells]
        if len(cells) == 5:
            result.append({
                'product': cells[0],
                'size': cells[1],
                'currency': cells[2],
                'current_price': cells[3],
                'new_price': cells[4],
            })
    return result


# ── Run comparison ────────────────────────────────────────────────────────────
print("=" * 70)
print("VERIFICATION: Excel vs HTML Drafts")
print("=" * 70)

total_companies = len(excel_data)
passed = 0
failed = 0
warnings = 0
all_issues = []

for company, data in excel_data.items():
    fname = safe_filename(company)
    fpath = os.path.join(DRAFTS_DIR, fname)
    issues = []

    if not os.path.exists(fpath):
        issues.append(f"  FAIL: File does not exist: {fname}")
        failed += 1
        all_issues.append((company, issues))
        print(f"\n[FAIL] {company}")
        for i in issues:
            print(i)
        continue

    with open(fpath, encoding='utf-8') as f:
        html = f.read()

    html_contacts = parse_html_contacts(html)
    html_rows = parse_html_rows(html)

    # --- Check contacts ---
    excel_contacts = data['contacts']
    ec_lower = [e.lower() for e in excel_contacts]
    hc_lower = [e.lower() for e in html_contacts]

    for ec in ec_lower:
        if ec not in hc_lower:
            issues.append(f"  FAIL contact MISSING in HTML: {ec}")
    for hc in hc_lower:
        if hc not in ec_lower:
            issues.append(f"  FAIL contact EXTRA in HTML (not in Excel): {hc}")

    if not excel_contacts:
        issues.append(f"  WARN: No contacts in Excel for this company")

    # --- Check product rows ---
    excel_rows = data['rows']
    if len(excel_rows) != len(html_rows):
        issues.append(
            f"  FAIL row count: Excel has {len(excel_rows)}, HTML has {len(html_rows)}"
        )
    else:
        for i, (er, hr) in enumerate(zip(excel_rows, html_rows), 1):
            if er['product'] != hr['product']:
                issues.append(f"  FAIL row {i} product: Excel='{er['product']}' HTML='{hr['product']}'")
            if er['size'] != hr['size']:
                issues.append(f"  FAIL row {i} size: Excel='{er['size']}' HTML='{hr['size']}'")
            if er['currency'] != hr['currency']:
                issues.append(f"  FAIL row {i} currency: Excel='{er['currency']}' HTML='{hr['currency']}'")
            if er['current_price'] != hr['current_price']:
                issues.append(f"  FAIL row {i} current price: Excel='{er['current_price']}' HTML='{hr['current_price']}'")
            if er['new_price'] != hr['new_price']:
                issues.append(f"  FAIL row {i} new price: Excel='{er['new_price']}' HTML='{hr['new_price']}'")

    hard_fails = [i for i in issues if 'FAIL' in i]
    soft_warns = [i for i in issues if 'WARN' in i]

    if hard_fails:
        failed += 1
        all_issues.append((company, issues))
        print(f"\n[FAIL] {company}")
        for i in issues:
            print(i)
    elif soft_warns:
        warnings += 1
        all_issues.append((company, soft_warns))
        print(f"[WARN] {company} — {soft_warns[0].strip()}")
    else:
        passed += 1
        print(f"[OK]   {company}")

print()
print("=" * 70)
print(f"RESULT: {passed}/{total_companies} passed | {failed} FAILED | {warnings} warnings")
print("=" * 70)

if failed == 0 and warnings == 0:
    print("\nAll drafts match the Excel 100%. Ready to send.")
elif failed == 0:
    print(f"\nNo data errors. {warnings} companies have no contact email in the Excel.")
else:
    print(f"\nFIX REQUIRED: {failed} companies have data mismatches. See details above.")
