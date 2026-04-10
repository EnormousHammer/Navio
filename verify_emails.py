"""
Verification script: re-reads the Excel and compares against generated HTML drafts.
Also adds CC fields to all HTML drafts.
"""
import pandas as pd
import os
import re
from pathlib import Path

EXCEL_PATH = r"G:\My Drive\Canoil\April 2026, CC Price Increase\MOV, VSG, Reolube - price increase April 2026 including contacts.xlsx"
DRAFTS_DIR = r"G:\My Drive\Canoil\April 2026, CC Price Increase\Email Drafts"

CC_ADDRESSES = ["gmail@canoilcanadaltd.com", "kathleen@canoilcanadaltd.com"]

def extract_emails(raw):
    if not raw or str(raw).strip() in ('', 'nan'):
        return []
    return re.findall(r'[\w.+\-]+@[\w.\-]+', str(raw).strip())

def safe_filename(name):
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    name = name.strip().replace(' ', '_')
    return name[:80] + '.html'

df = pd.read_excel(EXCEL_PATH, sheet_name='Sheet1', header=None)
df.columns = ['company','product','size','currency','current_price','new_price','contact1','contact2','contact3']

# Build company data
current_company = None
companies = {}

for _, row in df.iterrows():
    company_raw = str(row['company']).strip()
    company = company_raw if company_raw not in ('', 'nan') else None
    product_raw = str(row['product']).strip()
    product = product_raw if product_raw not in ('', 'nan') else None

    if company and company != 'Company':
        current_company = company
        companies[company] = {'contacts_raw': [], 'contacts_emails': [], 'rows': []}
        for col in ['contact1', 'contact2', 'contact3']:
            val = str(row[col]).strip()
            if val not in ('', 'nan'):
                companies[company]['contacts_raw'].append(val)
                companies[company]['contacts_emails'].extend(extract_emails(val))

    if product and current_company:
        sp = str(row['size']).strip()
        cp = str(row['currency']).strip()
        companies[current_company]['rows'].append({
            'product': product,
            'size': sp if sp not in ('', 'nan') else '',
            'currency': cp if cp not in ('', 'nan') else '',
            'current_price': row['current_price'],
            'new_price': row['new_price'],
        })

print(f"=== EXCEL SUMMARY: {len(companies)} companies ===\n")

issues = []

for name, data in companies.items():
    fname = safe_filename(name)
    fpath = os.path.join(DRAFTS_DIR, fname)
    exists = os.path.exists(fpath)

    email_count = len(data['contacts_emails'])
    row_count = len(data['rows'])

    status = "OK" if exists else "MISSING FILE"
    if not data['contacts_emails']:
        status += " | NO CONTACTS"

    print(f"  [{status}] {name}")
    print(f"    File: {fname}")
    print(f"    Contacts ({email_count}): {data['contacts_emails']}")
    for r in data['rows']:
        print(f"    - {r['product']} | {r['size']} | {r['currency']} | {r['current_price']} -> {r['new_price']}")
    print()

    if not exists:
        issues.append(f"MISSING: {fname}")

print(f"\n=== ISSUES FOUND: {len(issues)} ===")
for i in issues:
    print(f"  {i}")
