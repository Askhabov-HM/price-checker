"""Executed on the server via SSH stdin; stdout contains only SQLite bytes."""

from contextlib import closing
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile

sources = {
    'randewoo': 'prices.sqlite3',
    'ozon': 'ozon/prices.sqlite3',
    'lamoda': 'lamoda/prices.sqlite3',
}
store = sys.argv[1] if len(sys.argv) == 2 else 'randewoo'
if store not in sources:
    raise SystemExit('Unknown store')
source = Path('/var/lib/price-checker/data') / sources[store]
with tempfile.TemporaryDirectory(prefix='price-checker-snapshot-') as directory:
    snapshot = Path(directory) / 'prices.sqlite3'
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=10)) as database:
        with closing(sqlite3.connect(snapshot)) as destination:
            database.backup(destination, pages=256, sleep=0.05)
    snapshot.chmod(0o600)
    with snapshot.open('rb') as result:
        shutil.copyfileobj(result, sys.stdout.buffer, length=1024 * 1024)
    sys.stdout.buffer.flush()
