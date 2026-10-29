import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import sqlite3
from contextlib import closing, contextmanager
import unittest
from unittest.mock import Mock, call, patch

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).resolve().parents[1] / 'scripts/deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def archive(extra=()):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as bundle:
        for name in ('run.js', 'package.json', 'package-lock.json', '.nvmrc', 'dist/index.html', 'storage-contract.json', 'scripts/storage-maintenance.js'):
            entry = tarfile.TarInfo(name)
            entry.size = 2
            bundle.addfile(entry, io.BytesIO(b'{}'))
        for entry in extra:
            bundle.addfile(entry)
    output.seek(0)
    return output


class DeploymentTests(unittest.TestCase):
    def test_storage_format_checks_read_and_write_support_independently(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            with closing(sqlite3.connect(data / 'prices.sqlite3')) as sql, sql:
                sql.execute('CREATE TABLE storage_meta(id INTEGER,store TEXT,format INTEGER)')
                sql.execute("INSERT INTO storage_meta VALUES(1,'randewoo',2)")
            contract = {'stores': {'randewoo': {'read': [1, 2], 'write': [1]}}}
            self.assertFalse(deploy.compatible_databases(data, contract, ['randewoo']))
            contract['stores']['randewoo']['write'].append(2)
            self.assertTrue(deploy.compatible_databases(data, contract, ['randewoo']))

    def test_legacy_bridge_requires_unchanged_schema_and_baseline_calculations(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            current, before = data / 'prices.sqlite3', data / 'before.sqlite3'
            with closing(sqlite3.connect(current)) as sql, closing(sqlite3.connect(before)) as copy:
                sql.execute('CREATE TABLE observations(id INTEGER PRIMARY KEY,price INTEGER)')
                sql.execute('INSERT INTO observations VALUES(1,100)');sql.commit();sql.backup(copy)
                sql.execute('CREATE TABLE storage_meta(id INTEGER,store TEXT,format INTEGER)')
                sql.execute("INSERT INTO storage_meta VALUES(1,'randewoo',1)")
                sql.execute('CREATE TABLE projection_versions(name TEXT PRIMARY KEY,version TEXT)')
                sql.execute("INSERT INTO projection_versions VALUES('price_rows','1')")
                sql.execute('INSERT INTO observations VALUES(2,90)');sql.commit()
            copies = [{'provider': 'randewoo', 'backup': 'before.sqlite3'}]
            contract = {'projections': {'rows': 1, 'history': 1, 'published': 1}}
            self.assertTrue(deploy.legacy_rollback_compatible(data, copies, ['randewoo'], contract))
            # New observations survive code rollback; restoring the old DB is unnecessary.
            with closing(sqlite3.connect(current)) as sql, sql:
                self.assertEqual(sql.execute('SELECT COUNT(*) FROM observations').fetchone()[0], 2)
                sql.execute('ALTER TABLE observations ADD COLUMN changed TEXT')
            self.assertFalse(deploy.legacy_rollback_compatible(data, copies, ['randewoo'], contract))

    @patch.object(deploy, 'StorageDeployment')
    def test_incompatible_rollback_never_launches_previous_code_or_restores_databases(self, factory):
        storage = factory.return_value
        storage.stores = []
        storage.can_rollback.return_value = False
        with patch.object(deploy, 'service') as service, patch.object(deploy, 'switch_current') as switch, \
                patch.object(deploy, 'wait_healthy', side_effect=RuntimeError('bad new release')):
            with self.assertRaisesRegex(RuntimeError, 'rollback blocked'):
                deploy.activate_release('new', 'old', Mock(return_value=[]))
        self.assertEqual(switch.call_args_list, [call('new')])
        self.assertEqual(service.call_args_list.count(call('start')), 1)
        storage.activate.assert_not_called()
        storage.phase.assert_any_call('blocked')

    @patch.object(deploy, 'StorageDeployment')
    def test_migrations_precede_start_and_rollback_prepares_previous_calculations(self, factory):
        storage = factory.return_value
        storage.stores = ['ozon']
        storage.previous_contract = True
        storage.preparation_started = False
        events = []
        @contextmanager
        def locked(release):
            events.append(('locked', release))
            yield lambda: events.append(('prepared', release))
            events.append(('unlocked', release))
        storage.locked.side_effect = locked
        storage.activate.side_effect = lambda: events.append('activate')
        with patch.object(deploy, 'service', side_effect=lambda action: events.append(action)), \
                patch.object(deploy, 'switch_current', side_effect=lambda value: events.append(('switch', value))), \
                patch.object(deploy, 'wait_healthy', side_effect=[RuntimeError('bad new release'), None]):
            with self.assertRaisesRegex(RuntimeError, 'bad new release'):
                deploy.activate_release('new', 'old', lambda: [{'provider': 'ozon'}])
        self.assertLess(events.index(('prepared', 'new')), events.index(('switch', 'new')))
        self.assertLess(events.index(('prepared', 'old')), events.index(('switch', 'old')))
        self.assertEqual(events[-1], 'activate')

    def test_health_requires_each_expected_store_and_storage_protocol(self):
        response = Mock()
        response.__enter__ = Mock(return_value=io.BytesIO(b'{"ok":true,"runtime":"node.js","storage_protocol":1,"stores":{"randewoo":{"ok":true},"ozon":{"ok":false}}}'))
        response.__exit__ = Mock(return_value=False)
        with patch.object(deploy, 'urlopen', return_value=response):
            self.assertFalse(deploy.healthy(['randewoo', 'ozon'], True))

    def test_each_store_has_its_own_consistent_backup_and_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            (data / 'ozon').mkdir()
            for name in ['prices.sqlite3', 'ozon/prices.sqlite3']:
                with closing(sqlite3.connect(data / name)) as connection, connection:
                    connection.execute('CREATE TABLE sample(value TEXT)')
                    connection.execute('INSERT INTO sample VALUES(?)', (name,))
                    if name.startswith('ozon/'):
                        connection.execute('CREATE TABLE ozon_meta(id INTEGER,provider TEXT,version INTEGER)')
                        connection.execute("INSERT INTO ozon_meta VALUES(1,'ozon-prices',1)")
            copies = deploy.backup_databases(data, 'a' * 40)
            self.assertEqual([entry['provider'] for entry in copies], ['randewoo', 'ozon'])
            for entry in copies:
                with closing(sqlite3.connect(data / entry['backup'])) as connection:
                    self.assertEqual(connection.execute('SELECT value FROM sample').fetchone()[0], entry['source'])
            self.assertEqual(len(list((data / 'backups').glob('*.json'))), 1)

    def test_foreign_ozon_store_is_rejected_without_opening_it_for_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            (data / 'ozon').mkdir()
            source = data / 'ozon/prices.sqlite3'
            with closing(sqlite3.connect(source)) as connection, connection:
                connection.execute('CREATE TABLE randewoo(value TEXT)')
            before = source.read_bytes()
            with self.assertRaises(sqlite3.Error):
                deploy.backup_databases(data, 'b' * 40)
            self.assertEqual(source.read_bytes(), before)

    def test_only_exact_deploy_commands_are_accepted(self):
        sha = 'a' * 40
        self.assertEqual(deploy.commit_from_command('deploy ' + sha), sha)
        for command in ('', 'bash', 'deploy main', 'deploy ' + sha + ';id', 'deploy ' + sha + '\n'):
            with self.subTest(command=command), self.assertRaises(ValueError):
                deploy.commit_from_command(command)

    def test_release_contains_the_built_frontend(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            deploy.extract_release(archive(), destination)
            self.assertTrue((destination / 'dist/index.html').is_file())
            empty = io.BytesIO()
            with tarfile.open(fileobj=empty, mode='w:gz'):
                pass
            empty.seek(0)
            with self.assertRaisesRegex(ValueError, 'missing'):
                deploy.extract_release(empty, destination / 'empty')

    @unittest.skipIf(os.name == 'nt', 'Linux deployment filesystem permissions')
    def test_extraction_is_readable_under_a_restrictive_umask(self):
        script = tarfile.TarInfo('scripts/task.sh')
        script.mode = 0o700
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'release'
            destination.mkdir(mode=0o755)
            previous = os.umask(0o077)
            try:
                deploy.extract_release(archive([script]), destination)
            finally:
                os.umask(previous)
            for path in destination.rglob('*'):
                expected = 0o755 if path.is_dir() or path.name == 'task.sh' else 0o644
                self.assertEqual(path.stat().st_mode & 0o777, expected, str(path))

    @unittest.skipIf(os.name == 'nt', 'Linux deployment filesystem permissions')
    def test_dependency_permissions_preserve_executables_and_private_symlink_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release, private = root / 'release', root / 'private'
            dependency = release / 'node_modules/package'
            dependency.mkdir(parents=True, mode=0o700)
            module = dependency / 'index.js'
            module.write_text('export default 1;')
            module.chmod(0o600)
            executable = dependency / 'cli'
            executable.write_text('#!/bin/sh\n')
            executable.chmod(0o700)
            private.mkdir(mode=0o700)
            secret = private / 'session.json'
            secret.write_text('{}')
            secret.chmod(0o600)
            (release / '.secrets').symlink_to(private, target_is_directory=True)
            (dependency / 'private-link').symlink_to(secret)
            deploy.make_release_readable(release)
            self.assertEqual(dependency.stat().st_mode & 0o777, 0o755)
            self.assertEqual(module.stat().st_mode & 0o777, 0o644)
            self.assertEqual(executable.stat().st_mode & 0o777, 0o755)
            self.assertEqual(private.stat().st_mode & 0o777, 0o700)
            self.assertEqual(secret.stat().st_mode & 0o777, 0o600)

    def test_archive_cannot_overwrite_state_or_escape_the_release(self):
        for name in ('../escape', '/absolute', '.secrets/session.json', './.data/prices.sqlite3',
                     '.git/config', 'node_modules/anything'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    deploy.extract_release(archive([tarfile.TarInfo(name)]), Path(directory))
        link = tarfile.TarInfo('link')
        link.type = tarfile.SYMTYPE
        link.linkname = '/etc'
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            deploy.extract_release(archive([link]), Path(directory))

    @patch.object(deploy, 'StorageDeployment')
    def test_backup_happens_after_stopping_before_switching(self, factory):
        storage = factory.return_value
        storage.stores = []
        storage.previous_contract = True
        storage.preparation_started = False
        events = []
        with patch.object(deploy, 'service', side_effect=lambda action: events.append(action)), \
                patch.object(deploy, 'switch_current', side_effect=lambda target: events.append(target)), \
                patch.object(deploy, 'wait_healthy', side_effect=lambda *args: events.append('healthy')):
            deploy.activate_release('new', 'old', lambda: events.append('backup') or [])
        self.assertEqual(events, ['stop', 'backup', 'new', 'start', 'healthy'])

    @unittest.skipIf(os.name == 'nt', 'Linux deployment filesystem check')
    def test_current_symlink_is_replaced_and_temporary_link_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            old, new = base / 'old', base / 'new'
            old.mkdir()
            new.mkdir()
            (base / 'current').symlink_to(old)
            deploy.switch_current(new, base)
            self.assertEqual((base / 'current').resolve(), new)
            self.assertEqual(list(base.glob('.current-*')), [])

    @patch.object(deploy, 'StorageDeployment')
    def test_failed_health_restores_previous_code_without_deleting_shared_data(self, factory):
        storage = factory.return_value
        storage.stores = []
        storage.previous_contract = True
        storage.preparation_started = False
        backup = Mock(return_value=[])
        with patch.object(deploy, 'service') as service, \
                patch.object(deploy, 'switch_current') as switch, \
                patch.object(deploy, 'wait_healthy', side_effect=[RuntimeError('bad release'), None]):
            with self.assertRaisesRegex(RuntimeError, 'bad release'):
                deploy.activate_release('new', 'old', backup)
        self.assertEqual(service.call_args_list, [call('stop'), call('start'), call('stop'), call('start')])
        self.assertEqual(switch.call_args_list, [call('new'), call('old')])
        backup.assert_called_once_with()

    @patch.object(deploy, 'StorageDeployment')
    def test_backup_failure_restarts_the_existing_release(self, factory):
        storage = factory.return_value
        storage.stores = []
        storage.previous_contract = True
        storage.preparation_started = False
        with patch.object(deploy, 'service') as service, \
                patch.object(deploy, 'switch_current') as switch, patch.object(deploy, 'wait_healthy'):
            with self.assertRaisesRegex(OSError, 'disk full'):
                deploy.activate_release('new', 'old', Mock(side_effect=OSError('disk full')))
        self.assertEqual(switch.call_args_list, [call('old')])
        self.assertEqual(service.call_args_list, [call('stop'), call('stop'), call('start')])


if __name__ == '__main__':
    unittest.main()
