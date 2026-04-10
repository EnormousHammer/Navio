import sqlite3, shutil, os, tempfile

db  = r'C:\Users\Haron\AppData\Local\Google\DriveFS\110506887602034261149\metadata_sqlite_db'
tmp = os.path.join(tempfile.gettempdir(), 'gdrive_meta.db')
shutil.copy2(db, tmp)

conn = sqlite3.connect(tmp)
cur  = conn.cursor()

# Get the actual Google Drive ID for Email Drafts (stable_id=1060027)
cur.execute("SELECT stable_id, id, local_title FROM items WHERE stable_id IN (1060027, 1059371, 1059375)")
rows = cur.fetchall()
for r in rows:
    print(f'stable_id={r[0]}  drive_id={r[1]}  name={r[2]}')

conn.close()
