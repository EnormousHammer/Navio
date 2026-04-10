import pandas as pd

EXCEL_PATH = (
    r"G:\My Drive\Canoil\April 2026, CC Price Increase"
    r"\MOV, VSG, Reolube - price increase April 2026 including contacts.xlsx"
)

df = pd.read_excel(EXCEL_PATH, sheet_name='Sheet1', header=None)
df.columns = ['company', 'product', 'size', 'currency', 'current_price', 'new_price',
              'contact1', 'contact2', 'contact3']

issues = []
samples = []
current_company = None

for _, row in df.iterrows():
    company = str(row['company']).strip()
    if company not in ('', 'nan', 'Company'):
        current_company = company

    product = str(row['product']).strip()
    if product in ('', 'nan', 'Product') or not current_company:
        continue

    for col in ['current_price', 'new_price']:
        val = row[col]
        try:
            float(val)
        except (ValueError, TypeError):
            issues.append(f"  NON-NUMERIC  [{current_company}] {product} | {col} = {repr(val)}")

    try:
        cp  = float(row['current_price'])
        np_ = float(row['new_price'])
        samples.append((current_company, product, cp, np_))
    except Exception:
        pass

# Report issues
if issues:
    print(f"ISSUES FOUND ({len(issues)}):")
    for i in issues:
        print(i)
else:
    print("All prices are valid numbers — no non-numeric values.\n")

# Show all formatted values
print(f"{'Company':<32} {'Product':<38} {'Current':>10}  {'New Price':>10}")
print("-" * 96)
for company, product, cp, np_ in samples:
    flag = "  <-- PRICE DECREASE?" if np_ < cp else ""
    print(f"{company:<32} {product:<38} ${cp:>9,.2f}  ${np_:>9,.2f}{flag}")

print(f"\nTotal rows verified: {len(samples)}")
