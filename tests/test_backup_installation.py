"""Exercise migration and rollback with fake systemd/remote storage in a temp root."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


@unittest.skipIf(os.name == 'nt' or not hasattr(os, 'geteuid') or os.geteuid() != 0,
                     'Installer harness requires Linux root; all paths and commands are isolated')
class BackupInstallationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'repository/scripts'
        self.source.mkdir(parents=True)
        original = Path(__file__).resolve().parents[1] / 'scripts'
        for name in ('google-drive-backup.py', 'store-backup.py', 'lamoda-backup.py', 'backup-maintenance.py'):
            shutil.copyfile(original / name, self.source / name)
        shutil.copytree(original / 'systemd', self.source / 'systemd')
        text = (original / 'setup-independent-backups.sh').read_text()
        for path in ('/var/lib/price-checker', '/usr/local/lib/price-checker', '/etc/systemd/system', '/etc/price-checker-backup.json'):
            text = text.replace(path, str(self.root) + path)
        self.installer = self.source / 'setup-independent-backups.sh'
        self.installer.write_text(text)
        self.tools = self.root / 'usr/local/lib/price-checker'
        self.tools.mkdir(parents=True)
        (self.tools / 'google-drive-backup.py').write_text('previous-tools\n')
        (self.root / 'etc/systemd/system').mkdir(parents=True)
        data = self.root / 'var/lib/price-checker/data'
        for relative in ('prices.sqlite3', 'ozon/prices.sqlite3', 'lamoda/prices.sqlite3'):
            path = data / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('synthetic database placeholder')
        (self.root / 'etc/price-checker-backup.json').write_text(json.dumps({
            'data_dir': str(data), 'work_dir': str(self.root / 'var/lib/price-checker-backup')}))
        self.state = self.root / 'systemd.json'
        self.initial = {name: {'enabled': True, 'active': True} for name in
                        ('price-checker-backup.timer', 'price-checker-lamoda-backup.timer')}
        self.state.write_text(json.dumps(self.initial))
        self.log = self.root / 'operations.log'
        binary = self.root / 'bin'
        binary.mkdir()
        driver = '''import json,os,sys
from pathlib import Path
args=sys.argv[1:];name=Path(sys.argv[0]).name
state_path=Path(os.environ['INSTALL_TEST_STATE'])
with Path(os.environ['INSTALL_TEST_LOG']).open('a') as output: output.write(name+' '+ ' '.join(args)+'\\n')
if name=='git':
 if '--show-toplevel' in args: print(os.environ['INSTALL_TEST_REPO'])
 elif '--show-current' in args: print('develop')
 elif '--abbrev-ref' in args: print('origin/develop')
elif name=='python3':
 if args==['-']: exec(sys.stdin.read())
 elif os.environ.get('INSTALL_TEST_FAIL') and os.environ['INSTALL_TEST_FAIL'] in ' '.join(args): sys.exit(1)
elif name=='systemctl':
 state=json.loads(state_path.read_text());command=args[0]
 if command in ('is-enabled','is-active'):
  flag='enabled' if command=='is-enabled' else 'active'
  yes=state.get(args[1],{}).get(flag,False)
  print(flag if yes else ('disabled' if flag=='enabled' else 'inactive'));sys.exit(0 if yes else 1)
 elif command=='show': print('inactive')
 elif command in ('stop','start','enable','disable'):
  for unit in (a for a in args[1:] if not a.startswith('-')):
   entry=state.setdefault(unit,{'enabled':False,'active':False})
   if command in ('stop','start'): entry['active']=command=='start'
   else:
    entry['enabled']=command=='enable'
    if '--now' in args: entry['active']=command=='enable'
  state_path.write_text(json.dumps(state))
'''
        for name in ('git', 'systemctl', 'restic', 'rclone', 'python3'):
            path = binary / name
            path.write_text('#!' + sys.executable + '\n' + driver)
            path.chmod(0o755)
        self.environment = {**os.environ, 'PATH': str(binary) + os.pathsep + os.environ['PATH'],
                            'INSTALL_TEST_STATE': str(self.state), 'INSTALL_TEST_LOG': str(self.log),
                            'INSTALL_TEST_REPO': str(self.source.parent)}

    def run_installer(self, failure=''):
        return subprocess.run(['bash', str(self.installer), '--enable'], env={**self.environment, 'INSTALL_TEST_FAIL': failure},
                              text=True, capture_output=True, timeout=30)

    def test_activation_happens_only_after_three_verified_uploads_and_maintenance(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        state = json.loads(self.state.read_text())
        self.assertFalse(state['price-checker-backup.timer']['enabled'])
        for name in ('price-checker-store-backup@randewoo.timer', 'price-checker-store-backup@ozon.timer',
                     'price-checker-lamoda-backup.timer', 'price-checker-backup-maintenance.timer'):
            self.assertEqual(state[name], {'enabled': True, 'active': True})
        log = self.log.read_text()
        disabled = log.index('systemctl disable price-checker-backup.timer')
        for command in ('--store randewoo run --force --verify', '--store ozon run --force --verify',
                        'lamoda-backup.py run --force --verify', 'backup-maintenance.py run'):
            self.assertLess(log.index(command), disabled)

    def test_failed_recovery_rolls_back_tools_and_prior_timer_states(self):
        result = self.run_installer('--store ozon')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.tools / 'google-drive-backup.py').read_text(), 'previous-tools\n')
        self.assertFalse((self.tools / 'store-backup.py').exists())
        state = json.loads(self.state.read_text())
        for name, expected in self.initial.items():
            self.assertEqual(state[name], expected)
        for name in ('price-checker-store-backup@randewoo.timer', 'price-checker-store-backup@ozon.timer',
                     'price-checker-backup-maintenance.timer'):
            self.assertEqual(state[name], {'enabled': False, 'active': False})
        self.assertNotIn('backup-maintenance.py run', self.log.read_text())


if __name__ == '__main__':
    unittest.main()
