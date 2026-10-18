import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import sqlite3
from contextlib import closing
import unittest
from unittest.mock import Mock, call, patch

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).resolve().parents[1] / 'scripts/deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def archive(extra=()):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as bundle:
        for name in ('run.js', 'package.json', 'package-lock.json', '.nvmrc', 'dist/index.html'):
            entry = tarfile.TarInfo(name)
            entry.size = 2
            bundle.addfile(entry, io.BytesIO(b'{}'))
        for entry in extra:
            bundle.addfile(entry)
    output.seek(0)
    return output


class DeploymentTests(unittest.TestCase):
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

    def test_backup_happens_after_stopping_before_switching(self):
        events = []
        with patch.object(deploy, 'service', side_effect=lambda action: events.append(action)), \
                patch.object(deploy, 'switch_current', side_effect=lambda target: events.append(target)), \
                patch.object(deploy, 'wait_healthy', side_effect=lambda: events.append('healthy')):
            deploy.activate_release('new', 'old', lambda: events.append('backup'))
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

    def test_failed_health_restores_previous_code_without_deleting_shared_data(self):
        backup = Mock()
        with patch.object(deploy, 'service') as service, \
                patch.object(deploy, 'switch_current') as switch, \
                patch.object(deploy, 'wait_healthy', side_effect=[RuntimeError('bad release'), None]):
            with self.assertRaisesRegex(RuntimeError, 'bad release'):
                deploy.activate_release('new', 'old', backup)
        self.assertEqual(service.call_args_list, [call('stop'), call('start'), call('stop'), call('start')])
        self.assertEqual(switch.call_args_list, [call('new'), call('old')])
        backup.assert_called_once_with()

    def test_backup_failure_restarts_the_existing_release(self):
        with patch.object(deploy, 'service') as service, \
                patch.object(deploy, 'switch_current') as switch, patch.object(deploy, 'wait_healthy'):
            with self.assertRaisesRegex(OSError, 'disk full'):
                deploy.activate_release('new', 'old', Mock(side_effect=OSError('disk full')))
        self.assertEqual(switch.call_args_list, [call('old')])
        self.assertEqual(service.call_args_list, [call('stop'), call('stop'), call('start')])


if __name__ == '__main__':
    unittest.main()
