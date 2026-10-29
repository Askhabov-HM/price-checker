"""Local backup audit. No credentials, raw command output or source records."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from contextlib import closing
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE runs(id INTEGER PRIMARY KEY, store TEXT NOT NULL, reason TEXT NOT NULL,
 started_at TEXT NOT NULL, finished_at TEXT, stage TEXT NOT NULL, status TEXT NOT NULL,
 error TEXT, duration_seconds INTEGER, owner TEXT NOT NULL, imported_key TEXT UNIQUE);
CREATE TABLE artifacts(id INTEGER PRIMARY KEY, run_id INTEGER REFERENCES runs(id), store TEXT NOT NULL,
 location TEXT NOT NULL, locator TEXT NOT NULL, created_at TEXT, bytes INTEGER,
 verification TEXT NOT NULL DEFAULT 'unknown', verified_at TEXT,
 availability TEXT NOT NULL DEFAULT 'unknown', checked_at TEXT, origin TEXT NOT NULL,
 UNIQUE(store,location,locator));
CREATE INDEX runs_started ON runs(started_at DESC,id DESC);
CREATE INDEX artifacts_created ON artifacts(created_at DESC,id DESC);
"""

def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')

def timestamp(value):
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace('Z','+00:00'))
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')

def owner(pid=None):
    pid = pid or os.getpid()
    try:
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
        return f'{pid}:{boot}:{stat}'
    except OSError:
        return str(pid) if pid == os.getpid() else None

class Journal:
    def __init__(self, data):
        self.data = Path(data)
        self.path = self.data / 'backup-journal/events.sqlite3'
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
        if self.path.is_symlink() or self.path.parent.is_symlink():
            raise ValueError('Unexpected journal path')
        checksum = hashlib.sha256(SCHEMA.encode()).hexdigest()
        with closing(self.connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('CREATE TABLE IF NOT EXISTS journal_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)')
            row = db.execute('SELECT checksum FROM journal_migrations WHERE version=1').fetchone()
            if row and row[0] != checksum:
                raise ValueError('Journal migration checksum mismatch')
            if not row:
                for statement in SCHEMA.split(';'):
                    if statement.strip(): db.execute(statement)
                db.execute('INSERT INTO journal_migrations VALUES(1,?,?)',(checksum,now()))
            for run_id, identity in db.execute("SELECT id,owner FROM runs WHERE status='running'").fetchall():
                if identity != owner(int(identity.split(':')[0])):
                    db.execute("UPDATE runs SET status='interrupted',stage='interrupted',finished_at=?,error='process_interrupted' WHERE id=?",(now(),run_id))
        # Match the installation directory's reader group, without granting write access.
        if os.name != 'nt':
            if os.geteuid() == 0: os.chown(self.path,0,self.path.parent.stat().st_gid)
            self.path.chmod(0o640)

    def connect(self):
        db = sqlite3.connect(self.path,timeout=5)
        db.execute('PRAGMA foreign_keys=ON')
        return db

    def start(self, store, reason):
        with closing(self.connect()) as db, db:
            return db.execute("INSERT INTO runs(store,reason,started_at,stage,status,owner) VALUES(?,?,?,'waiting','running',?)",(store,reason,now(),owner())).lastrowid

    def stage(self, run, stage):
        with closing(self.connect()) as db, db:
            db.execute('UPDATE runs SET stage=? WHERE id=?',(stage,run))

    def finish(self, run, status, error=None):
        with closing(self.connect()) as db, db:
            stamp=now()
            db.execute('UPDATE runs SET status=?,finished_at=?,error=?,duration_seconds=MAX(0,CAST((julianday(?)-julianday(started_at))*86400 AS INTEGER)) WHERE id=?',(status,stamp,error,stamp,run))

    def artifact(self, store, location, locator, run=None, created=None, size=None, verification='unknown', origin='recorded'):
        with closing(self.connect()) as db, db:
            db.execute("""INSERT INTO artifacts(run_id,store,location,locator,created_at,bytes,verification,verified_at,availability,checked_at,origin)
              VALUES(?,?,?,?,?,?,?,?, 'present',?,?) ON CONFLICT(store,location,locator) DO UPDATE SET
              availability='present',checked_at=excluded.checked_at,
              run_id=COALESCE(artifacts.run_id,excluded.run_id),bytes=COALESCE(excluded.bytes,artifacts.bytes)""",
              (run,store,location,locator,timestamp(created),size,verification,now() if verification!='unknown' else None,now(),origin))

    def verified(self, run):
        with closing(self.connect()) as db, db:
            db.execute("UPDATE artifacts SET verification='restore_ok',verified_at=? WHERE run_id=?",(now(),run))

    def cloud_inventory(self, snapshots):
        # Called only after a successful full inventory. An unavailable cloud is not deletion evidence.
        if not isinstance(snapshots,list): raise ValueError('Invalid snapshot inventory')
        stamp = now()
        tags = {'price-checker-randewoo':['randewoo'],'price-checker-ozon':['ozon'],'price-checker-lamoda':['lamoda'],
                'price-checker-databases':['randewoo','ozon'],'price-checker-journal':['journal']}
        with closing(self.connect()) as db, db:
            db.execute("UPDATE artifacts SET availability='absent',checked_at=? WHERE location='cloud'",(stamp,))
            for snapshot in snapshots:
                stores = set()
                for tag in snapshot.get('tags',[]): stores.update(tags.get(tag,[]))
                locator = snapshot.get('id','')
                if len(locator)!=64 or any(c not in '0123456789abcdef' for c in locator): raise ValueError('Invalid snapshot ID')
                for store in stores:
                    db.execute("""INSERT INTO artifacts(store,location,locator,created_at,availability,checked_at,origin)
                     VALUES(?,'cloud',?,?,'present',?,'discovered') ON CONFLICT(store,location,locator)
                     DO UPDATE SET availability='present',checked_at=excluded.checked_at""",(store,locator,timestamp(snapshot.get('time')),stamp))

    def import_local(self):
        for manifest in (self.data/'backups').glob('pre-deploy-*.json'):
            try:
                value=json.loads(manifest.read_text())
                for entry in value.get('databases',[]):
                    store=entry.get('provider')
                    if store not in ('randewoo','ozon','lamoda'): continue
                    relative=entry.get('backup','')
                    path=self.data/relative
                    if not path.resolve().is_relative_to(self.data.resolve()) or path.is_symlink(): continue
                    if path.is_file(): self.artifact(store,'vps',relative,size=path.stat().st_size,origin='discovered')
            except (OSError,ValueError,TypeError): continue
        with closing(self.connect()) as db, db:
            rows=db.execute("SELECT id,locator FROM artifacts WHERE location='vps'").fetchall()
            for identity,relative in rows:
                path=self.data/relative
                exists=path.resolve().is_relative_to(self.data.resolve()) and path.is_file() and not path.is_symlink()
                db.execute('UPDATE artifacts SET availability=?,checked_at=? WHERE id=?',('present' if exists else 'absent',now(),identity))

    def snapshot(self, target):
        target=Path(target)
        target.parent.mkdir(parents=True,exist_ok=True)
        with closing(self.connect()) as source, closing(sqlite3.connect(target)) as copy:
            source.backup(copy)
            if copy.execute('PRAGMA quick_check').fetchone()[0]!='ok': raise ValueError('Journal backup invalid')

if __name__ == '__main__':
    import argparse
    parser=argparse.ArgumentParser()
    parser.add_argument('data')
    args=parser.parse_args()
    Journal(args.data).import_local()
