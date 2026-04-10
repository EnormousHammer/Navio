import sqlite3, os, shutil, tempfile

db_path = r'C:\Users\Haron\AppData\Local\Google\DriveFS\110506887602034261149\metadata_sqlite_db'
tmp = tempfile.mktemp(suffix='.db')
shutil.copy2(db_path, tmp)

conn = sqlite3.connect(tmp)
cur = conn.cursor()

# Count new-named PDFs synced
cur.execute("SELECT COUNT(*) FROM items WHERE local_title LIKE '%Canoil_Canada_Price_Increase_Notice%'")
count = cur.fetchone()[0]
print(f"New-format PDFs synced to cloud: {count} / 78")

# Show a few examples
cur.execute("SELECT local_title FROM items WHERE local_title LIKE '%Canoil_Canada_Price_Increase_Notice%' LIMIT 5")
rows = cur.fetchall()
print("\nSample synced files:")
for r in rows:
    print(f"  {r[0]}")

# Check for any old-format PDFs still there
cur.execute("SELECT COUNT(*) FROM items WHERE local_title LIKE 'Canoil_Canada_-_Price_Increase_Notice%'")
old_count = cur.fetchone()[0]
print(f"\nOld-format PDFs still in cloud: {old_count}")

conn.close()
os.remove(tmp)
