import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guard = load('git_guard', 'codex-git-guard.py')
launcher = load('root_launcher', 'codex-root-launcher.py')


class GitGuardTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.root = self.base / 'repo'
        self.remote = self.base / 'remote.git'
        self.run_git('init', '--bare', str(self.remote))
        self.run_git('init', '-b', 'main', str(self.root))
        self.git('config', 'user.name', 'Synthetic Codex')
        self.git('config', 'user.email', 'synthetic@example.test')
        self.git('config', 'commit.gpgsign', 'false')
        (self.root / 'app.txt').write_text('initial\n')
        self.git('add', 'app.txt')
        self.git('commit', '-m', 'feat: initial fixture')
        self.git('remote', 'add', 'origin', str(self.remote))
        self.git('push', '-u', 'origin', 'main')
        self.baseline = guard.snapshot(self.root)

    def run_git(self, *args):
        result = subprocess.run(['git', *args], capture_output=True, text=True, check=True)
        return result.stdout.strip()

    def git(self, *args):
        return self.run_git('-C', str(self.root), *args)

    def change(self):
        (self.root / 'app.txt').write_text('updated\n')
        self.git('add', 'app.txt')
        self.git('commit', '-m', 'fix: update fixture')

    def test_read_only_turn_needs_no_empty_commit(self):
        self.assertEqual(guard.verify(self.baseline)['changed'], False)

    def test_uncommitted_and_untracked_changes_block_completion(self):
        (self.root / 'new.txt').write_text('private-content-must-not-enter-report')
        with self.assertRaises(guard.DeliveryError) as error:
            guard.verify(self.baseline)
        self.assertNotIn('private-content', str(error.exception))

    def test_a_commit_and_forged_tracking_ref_do_not_prove_push(self):
        self.change()
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        with self.assertRaises(guard.DeliveryError):
            guard.verify(self.baseline)

    def test_actual_push_is_accepted(self):
        self.change()
        self.git('push')
        result = guard.verify(self.baseline)
        self.assertTrue(result['verified'])
        self.assertTrue(result['changed'])
        self.assertEqual(result['head'], self.git('rev-parse', 'HEAD'))

    def test_a_newer_remote_tip_containing_the_commit_is_accepted(self):
        self.change()
        self.git('push')
        other = self.base / 'other'
        self.run_git('clone', '-b', 'main', str(self.remote), str(other))
        self.run_git('-C', str(other), 'config', 'user.name', 'Synthetic Other')
        self.run_git('-C', str(other), 'config', 'user.email', 'other@example.test')
        (other / 'other.txt').write_text('another change')
        self.run_git('-C', str(other), 'add', 'other.txt')
        self.run_git('-C', str(other), '-c', 'commit.gpgsign=false', 'commit', '-m', 'feat: another fixture')
        self.run_git('-C', str(other), 'push')
        self.assertTrue(guard.verify(self.baseline)['verified'])

    def test_branch_switch_and_missing_upstream_are_rejected(self):
        self.git('switch', '-c', 'other')
        with self.assertRaises(guard.DeliveryError):
            guard.verify(self.baseline)
        self.git('switch', 'main')
        self.change()
        self.git('branch', '--unset-upstream')
        with self.assertRaises(guard.DeliveryError):
            guard.verify(self.baseline)

    def test_hook_continues_once_then_launcher_audit_still_fails(self):
        self.change()
        baseline = self.base / 'baseline.json'
        baseline.write_text(json.dumps(self.baseline))
        env = {**os.environ, 'PRICE_CHECKER_CODEX_GIT_BASELINE': str(baseline)}
        for active in [False, True]:
            result = subprocess.run([sys.executable, str(SCRIPTS / 'codex-git-guard.py')],
                                    input=json.dumps({'stop_hook_active': active}),
                                    capture_output=True, text=True, env=env, check=True)
            output = json.loads(result.stdout)
            if active:
                self.assertFalse(output['continue'])
            else:
                self.assertEqual(output['decision'], 'block')
        report = json.loads(baseline.with_suffix('.result.json').read_text())
        self.assertFalse(report['verified'])
        self.assertFalse(guard.audit(baseline)['verified'])

    def test_existing_dirty_work_is_rejected_before_codex_starts(self):
        (self.root / 'app.txt').write_text('owner work')
        with self.assertRaises(guard.DeliveryError):
            guard.snapshot(self.root)


class RootLauncherTests(unittest.TestCase):
    def command(self, args):
        return 'codex-v1 ' + base64.urlsafe_b64encode(json.dumps(args).encode()).decode()

    def test_explicit_resume_and_working_directory_are_preserved(self):
        args = ['exec', '--cd', str(launcher.ROOT), '--strict-config', '--json',
                '-c', 'features.hooks=true', 'resume', '11111111-1111-1111-1111-111111111111', '-']
        self.assertEqual(launcher.arguments(self.command(args)), args)

    def test_hook_disabling_and_arbitrary_ssh_commands_are_rejected(self):
        for command in ['id', self.command(['exec', '--cd', '/tmp', '--json', '-']),
                        self.command(['exec', '--cd', str(launcher.ROOT), '--json', '-c', 'features.hooks=false', '-']),
                        self.command(['exec', '--cd', str(launcher.ROOT), '--json', '--ignore-user-config', '-'])]:
            with self.assertRaises(ValueError):
                launcher.arguments(command)


if __name__ == '__main__':
    unittest.main()
