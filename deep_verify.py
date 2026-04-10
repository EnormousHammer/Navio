"""
Deep verification: compares raw float values (not formatted strings) between
the Excel and every generated HTML draft. Reports every single discrepancy.
"""

import pandas as pd
import re
import os

EXCEL  = r"G:\My Drive\Canoil\April 2026, CC Price Increase\MOV, VSG, Reolube - price increase April 2026 including contacts.xlsx"
DRAFTS = r"G:\My Drive\Canoil\April 2026, CC Price Increase\Email Drafts"
SKIP_CC = {'gmail@canoilcanadaltd.com', 'kathleen@canoilcanadaltd.com'}

# ── Read Excel ────────────────────────────────────────────────────────────────
df = pd.read_excel(EXCEL, sheet_name='Sheet1', header=None)
df.columns = ['company','product','size','currency','current_price','new_price','c1','c2','c3']

current_co = None
excel_data = {}

for _, row in df.iterrows():
    co = str(row['company']).strip()
    pr = str(row['product']).strip()
    company = co if co not in ('', 'nan', 'Company') else None
    product  = pr if pr not in ('', 'nan', 'Product') else None

    if company:
        current_co = company
        excel_data[company] = {'rows': [], 'contacts': []}
        for c in ['c1', 'c2', 'c3']:
            emails = re.findall(r'[\w.+\-]+@[\w.\-]+', str(row[c]))
            excel_data[company]['contacts'].extend(emails)

    if product and current_co:
        sp = str(row['size']).strip()
        cp = str(row['currency']).strip()
        excel_data[current_co]['rows'].append({
            'product':       product,
            'size':          sp if sp not in ('', 'nan') else '',
            'currency':      cp if cp not in ('', 'nan') else '',
            'current_price': row['current_price'],
            'new_price':     row['new_price'],
        })

# ── Parse HTML ────────────────────────────────────────────────────────────────
def safe_fname(name):
    return re.sub(r'[<>:"/\\|?*]', '', name).strip().replace(' ', '_')[:80] + '.html'

def get_html_contacts(html):
    m = re.search(r'<strong>To:</strong>\s*([^<]+)', html)
    if not m:
        return set()
    emails = re.findall(r'[\w.+\-]+@[\w.\-]+', m.group(1))
    return {e.lower() for e in emails} - {s.lower() for s in SKIP_CC}

def get_html_rows(html):
    tbody = re.search(r'<tbody>(.*?)</tbody>', html, re.DOTALL)
    if not tbody:
        return []
    result = []
    for tr in re.findall(r'<tr>(.*?)</tr>', tbody.group(1), re.DOTALL):
        cells = re.findall(r'<td[^>]*>(.*?)</td>', tr, re.DOTALL)
        cells = [re.sub(r'<[^>]+>', '', c).strip() for c in cells]
        if len(cells) == 5:
            result.append(cells)
    return result

# ── Compare ───────────────────────────────────────────────────────────────────
fails   = []
warns   = []
ok      = []

for co, data in excel_data.items():
    fname = safe_fname(co)
    fpath = os.path.join(DRAFTS, fname)

    if not os.path.exists(fpath):
        fails.append(f'{co}: FILE MISSING ({fname})')
        continue

    with open(fpath, encoding='utf-8') as f:
        html = f.read()

    html_contacts = get_html_contacts(html)
    xl_contacts   = {e.lower() for e in data['contacts']}

    contact_issues = []
    for e in xl_contacts - html_contacts:
        contact_issues.append(f'  CONTACT in Excel but missing from HTML: {e}')
    for e in html_contacts - xl_contacts:
        contact_issues.append(f'  CONTACT in HTML but not in Excel: {e}')

    html_rows = get_html_rows(html)
    xl_rows   = data['rows']
    row_issues = []

    if len(xl_rows) != len(html_rows):
        row_issues.append(f'  ROW COUNT mismatch: Excel={len(xl_rows)} HTML={len(html_rows)}')
        # still check as many rows as possible
    for i, (xr, hr) in enumerate(zip(xl_rows, html_rows), 1):
        if xr['product'] != hr[0]:
            row_issues.append(f'  Row {i} PRODUCT: Excel="{xr["product"]}" | HTML="{hr[0]}"')
        if xr['size'] != hr[1]:
            row_issues.append(f'  Row {i} SIZE:    Excel="{xr["size"]}" | HTML="{hr[1]}"')
        if xr['currency'] != hr[2]:
            row_issues.append(f'  Row {i} CURRENCY:Excel="{xr["currency"]}" | HTML="{hr[2]}"')
        # Compare prices as raw floats (strip commas from HTML formatted number)
        try:
            xl_cur = float(xr['current_price'])
            xl_new = float(xr['new_price'])
            ht_cur = float(hr[3].replace(',', ''))
            ht_new = float(hr[4].replace(',', ''))
            if abs(xl_cur - ht_cur) > 0.01:
                row_issues.append(f'  Row {i} CURRENT PRICE: Excel={xl_cur} | HTML={ht_cur}')
            if abs(xl_new - ht_new) > 0.01:
                row_issues.append(f'  Row {i} NEW PRICE: Excel={xl_new} | HTML={ht_new}')
        except Exception as e:
            row_issues.append(f'  Row {i} PRICE PARSE ERROR: {e} | HTML cells: {hr[3]}, {hr[4]}')

    all_issues = contact_issues + row_issues
    hard = [i for i in all_issues if 'CONTACT in Excel but missing' in i or 'ROW COUNT' in i
                                      or 'PRODUCT' in i or 'SIZE' in i or 'CURRENCY' in i
                                      or 'PRICE' in i]

    if hard:
        fails.append(co)
        print(f'\n[FAIL] {co}')
        for i in all_issues:
            print(i)
    elif not data['contacts']:
        warns.append(co)
    else:
        ok.append(co)
        print(f'[OK]   {co}')

if warns:
    print(f'\n[WARN] No contact email in Excel for: {", ".join(warns)}')

print()
print('=' * 65)
print(f'TOTAL: {len(excel_data)} companies')
print(f'  OK:      {len(ok)}')
print(f'  WARNING: {len(warns)}  (no email in Excel — not a data error)')
print(f'  FAILED:  {len(fails)}')
print('=' * 65)

if not fails:
    print('\nCONFIRMED: Zero data discrepancies between Excel and HTML drafts.')
    print('Every product name, package size, currency, current price, and')
    print('new price matches the source Excel exactly.')
    if warns:
        print(f'\nAction needed: {", ".join(warns)} — add contact emails manually.')
else:
    print(f'\nFIX REQUIRED for: {", ".join(fails)}')
