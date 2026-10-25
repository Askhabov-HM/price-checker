import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from test_google_drive_backup import store

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), SCRIPTS / (name + '.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


backup = module('store-backup')
maintenance = module('backup-maintenance')


class IndependentBackupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config = {'data_dir': str(self.root / 'live'), 'work_dir': str(self.root / 'legacy'),
                       'repository': 'rclone:example:price-checker-backups',
                       'rclone_config': str(self.root / 'rclone.conf'), 'password_file': str(self.root / 'password')}

    def runner(self, provider):
        runner = backup.StoreBackup(self.config, provider)
        connection = store(Path(self.config['data_dir']) / runner.stores[provider], provider)
        self.addCleanup(connection.close)
        return runner

    def successful_remote(self, runner):
        runner.restic = Mock(return_value=json.dumps({'message_type': 'summary', 'snapshot_id': 'c' * 64}))
        return patch.object(runner, 'verify', side_effect=lambda _: backup.base.validate_recovery(
            runner.work, runner.stores, runner.manifest_format))

    def test_each_store_can_backup_and_restore_when_the_other_database_is_missing(self):
        for provider in ('randewoo', 'ozon'):
            with self.subTest(provider=provider):
                self.config = {**self.config, 'data_dir': str(self.root / provider / 'live'),
                               'work_dir': str(self.root / provider / 'legacy')}
                runner = self.runner(provider)
                other = 'ozon' if provider == 'randewoo' else 'randewoo'
                self.assertFalse((Path(self.config['data_dir']) / backup.base.STORES[other]).exists())
                with patch.object(runner, 'lock'), self.successful_remote(runner):
                    result = runner.run(force=True)
                self.assertTrue(result['recovery_verified'])
                self.assertEqual([entry['provider'] for entry in result['databases']], [provider])
                calls = runner.restic.call_args_list
                self.assertIn('price-checker-' + provider, calls[0].args)
                self.assertIn('price-checker-' + provider, calls[1].args)
                self.assertNotIn('--prune', calls[1].args)
                self.assertNotIn('price-checker-' + other, str(calls))
                self.assertEqual({p.name for p in (runner.work / 'staging').iterdir()}, {'manifest.json', provider + '.sqlite3'})

    def test_one_store_failure_does_not_advance_its_success_or_prevent_other_backup(self):
        bad, good = self.runner('randewoo'), self.runner('ozon')
        bad.state = {'snapshot_id': 'a' * 64, 'last_success_epoch': 100}
        with patch.object(bad, 'lock'), patch.object(bad, 'restic', side_effect=backup.base.BackupError('synthetic failure')):
            with self.assertRaises(backup.base.BackupError):
                bad.run(force=True)
        with patch.object(good, 'lock'), self.successful_remote(good):
            self.assertEqual(good.run(force=True)['status'], 'saved')
        self.assertEqual(bad.state['snapshot_id'], 'a' * 64)
        self.assertEqual(bad.state['last_success_epoch'], 100)
        self.assertIsNone(good.state['last_error'])
        self.assertNotEqual(bad.work, good.work)
        self.assertEqual(bad.coordination, good.coordination)

    def test_changes_in_ozon_do_not_trigger_randewoo_copy_and_hourly_fallback_remains(self):
        runner = self.runner('randewoo')
        self.runner('ozon')
        runner.state = {'signatures': backup.base.current_signatures(self.config['data_dir'], runner.stores),
                        'last_success_epoch': 10000, 'last_verified_epoch': 10000}
        with patch.object(runner, 'lock'), patch('time.time', return_value=10030), patch.object(runner, 'restic') as remote:
            self.assertEqual(runner.run()['status'], 'unchanged')
            remote.assert_not_called()
        with patch.object(runner, 'lock'), patch('time.time', return_value=13601), self.successful_remote(runner):
            self.assertEqual(runner.run()['status'], 'saved')

    def test_daily_recovery_gate_preserves_snapshots_on_failure(self):
        runner = self.runner('ozon')
        runner.state = {'last_success_epoch': 100, 'last_verified_epoch': 100}
        runner.restic = Mock(return_value=json.dumps({'message_type': 'summary', 'snapshot_id': 'c' * 64}))
        with patch.object(runner, 'lock'), patch('time.time', return_value=90000), patch.object(runner, 'verify', side_effect=backup.base.BackupError('Recovery failed')):
            with self.assertRaises(backup.base.BackupError):
                runner.run()
        self.assertEqual(runner.state['last_success_epoch'], 100)
        self.assertEqual(len(runner.restic.call_args_list), 1)

    def test_swapped_or_legacy_manifest_is_rejected_by_single_store_recovery(self):
        runner = self.runner('ozon')
        manifest = backup.base.create_snapshots(self.config['data_dir'], runner.work / 'staging', runner.stores, runner.manifest_format)
        with self.assertRaises(backup.base.BackupError):
            backup.base.validate_recovery(runner.work, {'randewoo': 'prices.sqlite3'}, runner.manifest_format)
        manifest['format'] = backup.base.FORMAT
        backup.base.atomic_json(runner.work / 'staging/manifest.json', manifest)
        with self.assertRaises(backup.base.BackupError):
            backup.base.validate_recovery(runner.work, runner.stores, runner.manifest_format)

    def test_maintenance_never_forgets_any_store_or_reads_live_databases(self):
        runner = maintenance.Maintenance(self.config)
        with patch.object(runner, 'lock'), patch.object(runner, 'restic') as remote:
            self.assertEqual(runner.run()['status'], 'verified')
        self.assertEqual([call.args for call in remote.call_args_list], [('check',), ('prune',), ('check',)])
        self.assertFalse(Path(self.config['data_dir']).exists())

    @unittest.skipIf(os.name == 'nt', 'Production locking uses Linux flock')
    def test_processes_serialize_and_release_the_queue_after_owner_termination(self):
        code = '''import importlib.util,json,sys,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('backup',sys.argv[1])
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
runner=b.StoreBackup(json.loads(sys.argv[2]),sys.argv[3])
print('ready',flush=True)
with runner.lock():
 print('entered',flush=True)
 if sys.argv[4]=='hold': sys.stdin.readline()
'''
        def launch(provider, mode):
            child = subprocess.Popen([sys.executable, '-u', '-c', code, str(SCRIPTS / 'store-backup.py'),
                                      json.dumps(self.config), provider, mode], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            def cleanup():
                if child.poll() is None:
                    child.kill()
                child.communicate(timeout=5)
            self.addCleanup(cleanup)
            self.assertEqual(child.stdout.readline().strip(), 'ready')
            return child
        first = launch('randewoo', 'hold')
        self.assertEqual(first.stdout.readline().strip(), 'entered')
        duplicate = launch('randewoo', 'exit')
        output, error = duplicate.communicate(timeout=5)
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn('Another backup operation', error)
        second = launch('ozon', 'exit')
        time.sleep(0.3)
        self.assertIsNone(second.poll())
        first.kill();first.communicate(timeout=5)
        output, error = second.communicate(timeout=5)
        self.assertEqual(second.returncode, 0, error)
        self.assertEqual(output.strip(), 'entered')

    @unittest.skipIf(os.name == 'nt', 'Production locking uses Linux flock')
    def test_queue_wait_is_bounded_and_timed_out_store_can_retry(self):
        first = backup.StoreBackup(self.config, 'randewoo')
        second = backup.StoreBackup({**self.config, 'queue_timeout_seconds': 0}, 'ozon')
        with first.lock(), self.assertRaisesRegex(backup.base.BackupError, 'backup queue'):
            with second.lock():
                self.fail('Overlapping backups')
        with second.lock():
            pass
        self.assertIn('backup queue', json.loads(second.state_file.read_text())['last_error'])

    @unittest.skipIf(os.name == 'nt', 'Production timeout kills a Linux process group')
    def test_restic_timeout_stops_its_transfer_child_before_releasing_the_queue(self):
        executable = self.root / 'fake-restic'
        pidfile = self.root / 'child.pid'
        executable.write_text('#!' + sys.executable + '\n' +
            'import subprocess,sys,time\nfrom pathlib import Path\n' +
            'child=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"])\n' +
            'Path(' + repr(str(pidfile)) + ').write_text(str(child.pid))\n' +
            'time.sleep(60)\n')
        executable.chmod(0o755)
        runner = backup.StoreBackup({**self.config, 'restic': str(executable)}, 'randewoo')
        with runner.lock():
            runner.deadline = time.monotonic() + 0.5
            with self.assertRaisesRegex(backup.base.BackupError, 'timed out'):
                runner.restic('backup', 'staging')
        child = int(pidfile.read_text())
        proc = Path('/proc') / str(child) / 'stat'
        for _ in range(20):
            if not proc.exists() or proc.read_text().split()[2] == 'Z':
                break
            time.sleep(0.05)
        else:
            self.fail('Transfer child survived the timeout')
        with backup.StoreBackup({**self.config, 'queue_timeout_seconds': 0}, 'ozon').lock():
            pass


if __name__ == '__main__':
    unittest.main()
