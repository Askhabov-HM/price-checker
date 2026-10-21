import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('lamoda_backup', Path(__file__).resolve().parents[1] / 'scripts/lamoda-backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class LamodaBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / 'data'
        self.work = self.root / 'work'
        self.work.mkdir()
        path = self.data / 'lamoda' / 'prices.sqlite3'
        path.parent.mkdir(parents=True)
        self.connection = sqlite3.connect(path)
        self.addCleanup(self.connection.close)
        self.connection.executescript("""
          PRAGMA journal_mode=WAL;
          CREATE TABLE lamoda_meta(id INTEGER PRIMARY KEY,provider TEXT,version INTEGER);
          INSERT INTO lamoda_meta VALUES(1,'lamoda-prices',1);
          CREATE TABLE products(id INTEGER);
          CREATE TABLE checks(id INTEGER,status TEXT,finished_at TEXT);
          INSERT INTO checks VALUES(1,'success','2026-10-21T10:00:00Z');
          CREATE TABLE observations(id INTEGER,checked_at TEXT);
          INSERT INTO observations VALUES(1,'2025-01-01T10:00:00Z');
          CREATE TABLE collector_state(schedule_enabled INTEGER);
          INSERT INTO collector_state VALUES(1);
          CREATE TABLE telegram_outbox(event_id TEXT,payload TEXT);
          INSERT INTO telegram_outbox VALUES('synthetic-event','synthetic-report');
        """)
        self.config = {'data_dir': str(self.data), 'work_dir': str(self.work),
                       'repository': 'rclone:example:price-checker-backups',
                       'rclone_config': str(self.root / 'rclone.conf'), 'password_file': str(self.root / 'password')}

    def test_lamoda_does_not_require_or_read_the_other_stores(self):
        manifest = backup.create_snapshot(self.data, self.work)
        self.assertEqual(backup.validate_recovery(self.work), manifest)
        entry = manifest['databases'][0]
        self.assertEqual(entry['provider'], 'lamoda')
        self.assertEqual(entry['counts']['telegram_outbox'], 1)
        self.assertEqual(entry['first_observation'], '2025-01-01T10:00:00Z')
        self.assertFalse((self.data / 'prices.sqlite3').exists())
        self.assertFalse((self.data / 'ozon').exists())

    def test_a_changed_copy_or_foreign_store_cannot_pass_recovery(self):
        backup.create_snapshot(self.data, self.work)
        with closing(sqlite3.connect(self.work / 'staging/lamoda.sqlite3')) as connection, connection:
            connection.execute('DELETE FROM telegram_outbox')
        with self.assertRaises(backup.base.BackupError):
            backup.validate_recovery(self.work)

    def test_upload_and_retention_are_tagged_only_for_lamoda(self):
        runner = backup.LamodaBackup(self.config)
        runner.restic = Mock(return_value=json.dumps({'message_type': 'summary', 'snapshot_id': 'c' * 64}))

        def verify(_):
            return backup.validate_recovery(self.work)

        with patch.object(runner, 'lock'), patch.object(runner, 'verify', side_effect=verify):
            self.assertEqual(runner.run(force=True)['status'], 'saved')
        calls = runner.restic.call_args_list
        self.assertEqual(calls[0].args, ('backup', '--json', '--host', 'price-checker', '--tag', 'price-checker-lamoda', 'staging'))
        self.assertIn('price-checker-lamoda', calls[1].args)
        self.assertNotIn('--prune', calls[1].args)
        self.assertNotIn('price-checker-databases', str(calls))

    def test_failed_verification_preserves_last_success_and_does_not_expire_snapshots(self):
        runner = backup.LamodaBackup(self.config)
        runner.state = {'last_success_epoch': 100, 'snapshot_id': 'a' * 64}
        runner.restic = Mock(return_value=json.dumps({'message_type': 'summary', 'snapshot_id': 'b' * 64}))
        with patch.object(runner, 'lock'), patch.object(runner, 'verify', side_effect=backup.base.BackupError('Recovery failed')):
            with self.assertRaises(backup.base.BackupError):
                runner.run(force=True)
        self.assertEqual(runner.state['last_success_epoch'], 100)
        self.assertEqual(len(runner.restic.call_args_list), 1)
        self.assertEqual(runner.state['last_error'], 'Recovery failed')

    def test_lamoda_restore_refuses_an_existing_target_and_old_combined_manifest(self):
        runner = backup.LamodaBackup(self.config)
        with self.assertRaises(backup.base.BackupError):
            runner.restore('a' * 64, self.data)
        stage = self.root / 'old/staging'
        stage.mkdir(parents=True)
        (stage / 'manifest.json').write_text(json.dumps({'format': 'price-checker-database-backup-v1', 'databases': []}))
        with self.assertRaises(backup.base.BackupError):
            backup.validate_recovery(stage.parent)


if __name__ == '__main__':
    unittest.main()
