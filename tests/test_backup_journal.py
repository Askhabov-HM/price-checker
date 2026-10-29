import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import closing
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('journal',Path(__file__).resolve().parents[1]/'scripts/backup-journal.py')
journal=importlib.util.module_from_spec(spec);spec.loader.exec_module(journal)
class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.j=journal.Journal(self.root)
    def rows(self,table):
        with closing(self.j.connect()) as db:
            db.row_factory=sqlite3.Row
            return [dict(row) for row in db.execute('SELECT * FROM '+table)]
    def test_failure_retains_successful_artifact_and_verification_stage(self):
        run=self.j.start('ozon','schedule')
        self.j.artifact('ozon','cloud','a'*64,run,verification='sqlite_ok')
        self.j.stage(run,'verifying');self.j.finish(run,'error','restore_failed')
        self.assertEqual(self.rows('runs')[0]['stage'],'verifying')
        self.assertEqual(self.rows('runs')[0]['status'],'error')
        self.assertEqual(self.rows('artifacts')[0]['verification'],'sqlite_ok')
        journal.Journal(self.root)
        self.assertEqual(len(self.rows('journal_migrations')),1)
    def test_dead_owner_interrupted_but_current_owner_is_not(self):
        current=self.j.start('randewoo','manual');dead=self.j.start('lamoda','manual')
        with closing(self.j.connect()) as db, db:db.execute("UPDATE runs SET owner='999999999' WHERE id=?",(dead,))
        journal.Journal(self.root)
        rows=self.rows('runs');self.assertEqual(rows[0]['status'],'running');self.assertEqual(rows[1]['status'],'interrupted')
    def test_cloud_inventory_is_atomic_idempotent_and_retains_deleted_artifacts(self):
        snapshots=[{'id':'a'*64,'tags':['price-checker-ozon'],'time':'2026-10-29T15:00:00.123456789+03:00'}]
        self.j.cloud_inventory(snapshots);self.j.cloud_inventory(snapshots)
        self.assertEqual(len(self.rows('artifacts')),1)
        self.assertEqual(self.rows('artifacts')[0]['created_at'],'2026-10-29T12:00:00.123Z')
        with self.assertRaises(ValueError):self.j.cloud_inventory([{'id':'bad'}])
        self.assertEqual(self.rows('artifacts')[0]['availability'],'present')
        self.j.cloud_inventory([]);self.assertEqual(self.rows('artifacts')[0]['availability'],'absent')
    def test_import_does_not_invent_history_and_backup_survives_artifact_deletion(self):
        directory=self.root/'backups';directory.mkdir();target=directory/'old.sqlite3';target.write_bytes(b'known')
        (directory/'pre-deploy-old.json').write_text(json.dumps({'databases':[{'provider':'randewoo','backup':'backups/old.sqlite3'}]}))
        self.j.import_local();self.j.import_local()
        row=self.rows('artifacts')[0];self.assertEqual(row['origin'],'discovered');self.assertIsNone(row['created_at']);self.assertEqual(self.rows('runs'),[])
        target.unlink();self.j.import_local();self.assertEqual(self.rows('artifacts')[0]['availability'],'absent')
        target=self.root/'recovery.sqlite3';self.j.snapshot(target)
        with closing(sqlite3.connect(target)) as db:self.assertEqual(db.execute('SELECT count(*) FROM artifacts').fetchone()[0],1)
    def test_changed_migration_definition_is_rejected(self):
        with patch.object(journal,'SCHEMA',journal.SCHEMA+' '):
            with self.assertRaises(ValueError):journal.Journal(self.root)
