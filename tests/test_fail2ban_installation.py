"""Run the installer with fake system commands; no network or real services."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


@unittest.skipIf(os.name == 'nt', 'Isolated installer harness requires Linux bash')
class Fail2banInstallationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'repository/scripts'
        self.source.mkdir(parents=True)
        original = Path(__file__).resolve().parents[1] / 'scripts'
        shutil.copytree(original / 'fail2ban', self.source / 'fail2ban')
        script = (original / 'setup-fail2ban.sh').read_text()
        # Every privileged path and command below is isolated. CI needs no root.
        script = script.replace('[[ $EUID == 0 && $# == 0 ]]', '[[ $# == 0 ]]')
        for path in ('/etc/os-release', '/etc/fail2ban', '/run/lock/price-checker-fail2ban-install.lock',
                     '/var/backups/price-checker-fail2ban'):
            script = script.replace(path, str(self.root) + path)
        self.installer = self.source / 'setup-fail2ban.sh'
        self.installer.write_text(script)
        (self.root / 'run/lock').mkdir(parents=True)
        (self.root / 'etc').mkdir()
        (self.root / 'etc/os-release').write_text('ID=ubuntu\nVERSION_ID=24.04\n')
        self.target = self.root / 'etc/fail2ban/jail.d/99-price-checker-sshd.local'
        self.state = self.root / 'state.json'
        self.state.write_text(json.dumps({'active': False, 'enabled': False, 'masked': False, 'installed': False}))
        self.log = self.root / 'calls.jsonl'
        binary = self.root / 'bin'
        binary.mkdir()
        driver = '''#!/usr/bin/python3
import json,os,sys
from pathlib import Path
args=sys.argv[1:];name=Path(sys.argv[0]).name
state_path=Path(os.environ['F2B_TEST_STATE'])
state=json.loads(state_path.read_text())
with Path(os.environ['F2B_TEST_LOG']).open('a') as out: out.write(json.dumps([name,*args])+'\\n')
if name=='git':
 if '--show-toplevel' in args: print(os.environ['F2B_TEST_REPO'])
 elif '--show-current' in args: print(os.environ.get('F2B_TEST_BRANCH','develop'))
 elif '--abbrev-ref' in args: print('origin/develop')
 elif '--git-path' in args: print(os.environ['F2B_TEST_REPO']+'/.git/'+args[-1])
elif name=='sshd':
 if '-T' in args: print('port 22')
elif name=='dpkg-query':
 if state['installed']: print('install ok installed')
 else: sys.exit(1)
elif name=='apt-get':
 if os.environ.get('F2B_TEST_FAIL')=='package': sys.exit(1)
 if 'install' in args:
  if not state['installed']: assert state['masked'], 'Premature package auto-start possible'
  state['installed']=True
elif name=='systemctl':
 command=args[0]
 if command=='is-enabled':
  print('masked-runtime' if state['masked'] else ('enabled' if state['enabled'] else 'disabled'))
  sys.exit(0 if state['enabled'] else 1)
 if command=='is-active': sys.exit(0 if state['active'] else 3)
 if command in ('mask','unmask'): state['masked']=command=='mask'
 elif command in ('enable','disable'): state['enabled']=command=='enable'
 elif command in ('start','restart','stop'): state['active']=command!='stop'
elif name=='fail2ban-client':
 if args==['-t'] and os.environ.get('F2B_TEST_FAIL')=='config': sys.exit(1)
 if args==['ping']: sys.exit(0 if state['active'] else 1)
 if args[:2]==['get','sshd']: print({'maxretry':5,'findtime':600,'bantime':3600}[args[2]])
state_path.write_text(json.dumps(state))
'''
        for name in ('git', 'sshd', 'iptables', 'ip6tables', 'dpkg-query', 'apt-get', 'systemctl', 'fail2ban-client'):
            path = binary / name
            path.write_text(driver)
            path.chmod(0o755)
        self.env = dict(os.environ, PATH=str(binary) + ':' + os.environ['PATH'],
                        F2B_TEST_STATE=str(self.state), F2B_TEST_LOG=str(self.log),
                        F2B_TEST_REPO=str(self.source.parent))

    def run_installer(self, failure=None):
        env = dict(self.env)
        if failure:
            env['F2B_TEST_FAIL'] = failure
        return subprocess.run(['bash', str(self.installer)], env=env, text=True,
                              capture_output=True, timeout=20)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def existing(self):
        self.state.write_text(json.dumps({'active': True, 'enabled': True, 'masked': False, 'installed': True}))
        self.target.parent.mkdir(parents=True)
        self.target.write_text('previous managed policy\n')
        self.other = self.target.with_name('other.local')
        self.other.write_text('unrelated jail\n')

    def test_first_install_is_masked_until_validated(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        state = json.loads(self.state.read_text())
        self.assertEqual(state, {'active': True, 'enabled': True, 'masked': False, 'installed': True})
        self.assertEqual(self.target.read_text(), (self.source / 'fail2ban/sshd.conf').read_text())
        calls = self.calls()
        self.assertLess(calls.index(['fail2ban-client', '-t']),
                        calls.index(['systemctl', 'start', 'fail2ban.service']))
        self.assertFalse(any(call[0] == 'systemctl' and any(
            unit in call for unit in ('ssh.service', 'ufw.service', 'price-checker.service')) for call in calls))

    def test_reload_preserves_other_jails(self):
        self.existing()
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.other.read_text(), 'unrelated jail\n')
        self.assertIn(['fail2ban-client', 'reload'], self.calls())
        self.assertNotIn(['systemctl', 'stop', 'fail2ban.service'], self.calls())
        copies = list((self.root / 'var/backups/price-checker-fail2ban').glob('*/jail.previous'))
        self.assertEqual(copies[0].read_text(), 'previous managed policy\n')

    def test_invalid_config_restores_running_policy(self):
        self.existing()
        result = self.run_installer('config')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.target.read_text(), 'previous managed policy\n')
        self.assertEqual(self.other.read_text(), 'unrelated jail\n')
        self.assertTrue(json.loads(self.state.read_text())['active'])

    def test_package_failure_removes_runtime_mask(self):
        result = self.run_installer('package')
        self.assertNotEqual(result.returncode, 0)
        state = json.loads(self.state.read_text())
        self.assertFalse(state['active'])
        self.assertFalse(state['enabled'])
        self.assertFalse(state['masked'])
        self.assertFalse(self.target.exists())

    def test_wrong_branch_stops_before_mutations(self):
        self.env['F2B_TEST_BRANCH'] = 'main'
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertFalse(any(call[0] in ('apt-get', 'systemctl') for call in self.calls()))


if __name__ == '__main__':
    unittest.main()
