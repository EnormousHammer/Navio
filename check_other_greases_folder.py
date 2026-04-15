import sqlite3, os, shutil, tempfile

db_path = r'C:\Users\Haron\AppData\Local\Google\DriveFS\110506887602034261149\metadata_sqlite_db'
tmp = tempfile.mktemp(suffix='.db')
shutil.copy2(db_path, tmp)
conn = sqlite3.connect(tmp)
cur = conn.cursor()
cur.execute(
    "SELECT id, local_title FROM items WHERE local_title = 'Other Greases PDF Letters'"
)
for r in cur.fetchall():
    print("drive_id:", r[0], "title:", r[1])
conn.close()
os.remove(tmp)
