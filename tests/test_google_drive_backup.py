import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location('drive_backup', Path(__file__).resolve().parents[1] / 'scripts/google-drive-backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def store(path, provider):
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE products(id INTEGER PRIMARY KEY);
        CREATE TABLE checks(id INTEGER PRIMARY KEY,status TEXT,finished_at TEXT);
        CREATE TABLE observations(id INTEGER PRIMARY KEY,checked_at TEXT);
        INSERT INTO products VALUES(1);
        INSERT INTO checks VALUES(1,'success','2026-10-20T12:00:00Z');
        INSERT INTO observations VALUES(1,'2023-01-01T00:00:00Z'),(2,'2026-10-20T12:00:00Z');
    """)
    if provider == 'ozon':
        connection.executescript("""
            CREATE TABLE ozon_meta(id INTEGER,provider TEXT,version INTEGER);
            INSERT INTO ozon_meta VALUES(1,'ozon-prices',1);
            CREATE TABLE collector_state(id INTEGER);
            CREATE TABLE membership(id INTEGER);
        """)
    else:
        connection.executescript("""
            CREATE TABLE variants(id INTEGER);
            CREATE TABLE memberships(id INTEGER);
            CREATE TABLE settings(key TEXT,value TEXT);
            INSERT INTO settings VALUES('schedule','["09:00"]');
        """)
    connection.commit()
    return connection


class DriveBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / 'live'
        self.connections = []
        for provider, relative in backup.STORES.items():
            connection = store(self.data / relative, provider)
            self.connections.append(connection)
            self.addCleanup(connection.close)
        self.config = {'data_dir': str(self.data), 'work_dir': str(self.root / 'work'),
                       'rclone_config': str(self.root / 'rclone.conf'),
                       'password_file': str(self.root / 'password'),
                       'repository': 'rclone:pricechecker-drive:price-checker-backups'}

    def test_live_wal_snapshots_preserve_all_history_and_settings_without_changing_sources(self):
        for connection in self.connections:
            connection.execute("INSERT INTO observations VALUES(3,'2026-10-20T12:30:00Z')")
            connection.commit()
        before = {provider: backup.describe(path, provider) for provider, path in backup.source_paths(self.data).items()}
        stage = self.root / 'recovered' / 'staging'
        manifest = backup.create_snapshots(self.data, stage)
        self.assertEqual(backup.validate_recovery(stage.parent), manifest)
        self.assertEqual({entry['provider']: entry['signature'] for entry in manifest['databases']},
                         backup.current_signatures(self.data))
        for entry in manifest['databases']:
            self.assertEqual(entry['counts']['observations'], 3)
            self.assertEqual(entry['first_observation'], '2023-01-01T00:00:00Z')
            self.assertEqual(entry['last_observation'], '2026-10-20T12:30:00Z')
        with closing(sqlite3.connect(stage / 'randewoo.sqlite3')) as copy:
            self.assertEqual(copy.execute('SELECT value FROM settings').fetchone()[0], '["09:00"]')
        after = {provider: backup.describe(path, provider) for provider, path in backup.source_paths(self.data).items()}
        self.assertEqual(before, after)
        self.assertEqual({p.name for p in stage.iterdir()}, {'manifest.json', 'randewoo.sqlite3', 'ozon.sqlite3'})

    def test_swapped_store_is_rejected(self):
        with self.assertRaises(backup.BackupError):
            with closing(backup.open_readonly(self.data / 'ozon/prices.sqlite3')) as connection:
                backup.validate_provider(connection, 'randewoo')

    def test_missing_store_does_not_silently_create_an_empty_database(self):
        self.connections[1].close()
        (self.data / 'ozon/prices.sqlite3').unlink()
        with self.assertRaises(backup.BackupError):
            backup.create_snapshots(self.data, self.root / 'staging')
        self.assertFalse((self.data / 'ozon/prices.sqlite3').exists())

    def test_corrupted_source_cannot_replace_existing_recovery_points(self):
        self.connections[1].close()
        source = self.data / 'ozon/prices.sqlite3'
        source.write_bytes(b'broken sqlite database')
        with self.assertRaises(sqlite3.DatabaseError):
            backup.create_snapshots(self.data, self.root / 'staging')

    def test_tampered_recovery_is_rejected_even_if_it_remains_valid_sqlite(self):
        stage = self.root / 'recovered' / 'staging'
        backup.create_snapshots(self.data, stage)
        with closing(sqlite3.connect(stage / 'ozon.sqlite3')) as copy, copy:
            copy.execute('DELETE FROM observations WHERE id=1')
        with self.assertRaises(backup.BackupError):
            backup.validate_recovery(stage.parent)

    def test_manifest_cannot_redirect_to_another_file(self):
        stage = self.root / 'recovered' / 'staging'
        manifest = backup.create_snapshots(self.data, stage)
        manifest['databases'][0]['filename'] = '../../live/prices.sqlite3'
        backup.atomic_json(stage / 'manifest.json', manifest)
        with self.assertRaises(backup.BackupError):
            backup.validate_recovery(stage.parent)

    def test_initial_manifests_with_schema_cookies_remain_recoverable(self):
        stage = self.root / 'recovered' / 'staging'
        manifest = backup.create_snapshots(self.data, stage)
        for entry in manifest['databases']:
            entry['signature']['schema'] = 1
        backup.atomic_json(stage / 'manifest.json', manifest)
        self.assertEqual(backup.validate_recovery(stage.parent), manifest)

    def test_staging_refuses_extra_files_instead_of_uploading_them(self):
        stage = self.root / 'staging'
        stage.mkdir()
        (stage / 'private-notes.txt').write_text('private fixture')
        with self.assertRaises(backup.BackupError):
            backup.create_snapshots(self.data, stage)

    def test_failure_does_not_advance_last_success_or_expose_provider_output(self):
        runner = backup.Backup(self.config)
        runner.state = {'last_success_epoch': 123, 'snapshot_id': 'a' * 64}
        with patch.object(runner, 'lock'), patch.object(runner, 'restic', side_effect=backup.BackupError('remote unavailable')):
            with self.assertRaises(backup.BackupError):
                runner.run(force=True)
        saved = json.loads(runner.state_file.read_text())
        self.assertEqual(saved['last_success_epoch'], 123)
        self.assertEqual(saved['snapshot_id'], 'a' * 64)
        self.assertEqual(saved['last_error'], 'remote unavailable')

    def test_failed_recovery_prevents_retention_and_success_marker(self):
        runner = backup.Backup(self.config)
        runner.restic = Mock(return_value=json.dumps({'message_type': 'summary', 'snapshot_id': 'b' * 64}))
        with patch.object(runner, 'lock'), patch.object(runner, 'verify', side_effect=backup.BackupError('bad recovery')):
            with self.assertRaises(backup.BackupError):
                runner.run(force=True)
        self.assertNotIn('last_success_epoch', runner.state)
        self.assertEqual(len(runner.restic.call_args_list), 1)

    def test_success_is_marked_only_after_upload_and_validated_download(self):
        runner = backup.Backup(self.config)
        runner.restic = Mock(return_value=json.dumps({'message_type': 'summary', 'snapshot_id': 'c' * 64}))

        def verify(_):
            return json.loads((runner.work / 'staging/manifest.json').read_text())

        with patch.object(runner, 'lock'), patch.object(runner, 'verify', side_effect=verify):
            result = runner.run(force=True)
        self.assertEqual(result['status'], 'saved')
        self.assertTrue(result['recovery_verified'])
        self.assertEqual(runner.state['snapshot_id'], 'c' * 64)
        self.assertIsNone(runner.state['last_error'])
        self.assertEqual(runner.restic.call_args_list[-1].args[0], 'forget')
        self.assertNotIn('--prune', runner.restic.call_args_list[-1].args)

    def test_unchanged_data_is_skipped_but_hourly_backup_is_kept(self):
        runner = backup.Backup(self.config)
        runner.state = {'signatures': backup.current_signatures(self.data), 'last_success_epoch': 10000}
        with patch.object(runner, 'lock'), patch('time.time', return_value=10030), patch.object(runner, 'restic') as remote:
            self.assertEqual(runner.run()['status'], 'unchanged')
            remote.assert_not_called()
        with patch.object(runner, 'lock'), patch('time.time', return_value=13601), patch.object(runner, 'restic', side_effect=backup.BackupError('attempted upload')) as remote:
            with self.assertRaises(backup.BackupError):
                runner.run()
            remote.assert_called_once()

    def test_enabling_again_still_requires_downloaded_recovery_verification(self):
        runner = backup.Backup(self.config)
        runner.state = {'signatures': backup.current_signatures(self.data),
                        'last_success_epoch': 10000, 'last_verified_epoch': 10000}
        runner.restic = Mock(return_value=json.dumps({'message_type': 'summary', 'snapshot_id': 'e' * 64}))

        def verify(_):
            return json.loads((runner.work / 'staging/manifest.json').read_text())

        with patch.object(runner, 'lock'), patch('time.time', return_value=10030), patch.object(runner, 'verify', side_effect=verify) as checked:
            self.assertTrue(runner.run(force_verify=True)['recovery_verified'])
            checked.assert_called_once_with('e' * 64)

    def test_restore_never_overwrites_live_data_or_existing_directories(self):
        runner = backup.Backup(self.config)
        for target in (self.data, self.data / 'restored', self.root, runner.work / 'restore'):
            with self.subTest(target=target), self.assertRaises(backup.BackupError):
                runner.restore('d' * 64, target)

    def test_raw_command_error_does_not_leak_credentials(self):
        runner = backup.Backup(self.config)
        process = Mock(returncode=1)
        process.communicate.return_value = ('', 'token=private-fixture')
        with patch('subprocess.Popen') as popen:
            popen.return_value.__enter__.return_value = process
            with self.assertRaises(backup.BackupError) as caught:
                runner.restic('backup', 'staging')
        self.assertNotIn('private-fixture', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
