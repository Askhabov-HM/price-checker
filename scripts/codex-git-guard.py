#!/usr/bin/env python3
"""Read-only completion audit, shared by the Codex Stop hook and root launcher."""

import json
import os
from pathlib import Path
import subprocess
import sys


class DeliveryError(Exception):
    pass


def git(root, *args):
    try:
        result = subprocess.run(['git', '-C', str(root), *args], capture_output=True,
                                text=True, timeout=40,
                                env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
    except (OSError, subprocess.TimeoutExpired):
        raise DeliveryError('Git command unavailable or timed out.') from None
    if result.returncode:
        # Never forward Git stderr: a remote URL or credential helper can expose secrets.
        raise DeliveryError('Git command failed: ' + args[0])
    return result.stdout.strip()


def snapshot(root):
    root = Path(git(root, 'rev-parse', '--show-toplevel')).resolve()
    branch = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD')
    if branch != 'develop':
        raise DeliveryError('Codex may work only on the develop branch.')
    if (git(root, 'config', '--get', 'branch.develop.remote') != 'origin'
            or git(root, 'config', '--get', 'branch.develop.merge') != 'refs/heads/develop'):
        raise DeliveryError('Codex requires the origin/develop upstream.')
    if git(root, 'status', '--porcelain=v1', '--untracked-files=all'):
        raise DeliveryError('The repository contains uncommitted changes. Preserve them; do not stage unrelated work.')
    for name in ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']:
        if Path(git(root, 'rev-parse', '--path-format=absolute', '--git-path', name)).exists():
            raise DeliveryError('An unfinished Git operation must be resolved by the owner.')
    return {'root': str(root), 'branch': branch, 'head': git(root, 'rev-parse', 'HEAD')}


def verify(baseline):
    current = snapshot(baseline['root'])
    if current['root'] != baseline['root'] or current['branch'] != baseline['branch']:
        raise DeliveryError('The working repository or branch changed during the task.')
    if current['head'] == baseline['head']:
        return {'verified': True, 'changed': False, 'head': current['head']}
    root, branch = current['root'], current['branch']
    git(root, 'merge-base', '--is-ancestor', baseline['head'], current['head'])
    remote = git(root, 'config', '--get', 'branch.' + branch + '.remote')
    ref = git(root, 'config', '--get', 'branch.' + branch + '.merge')
    if remote != 'origin' or ref != 'refs/heads/develop':
        raise DeliveryError('Codex requires the origin/develop upstream.')
    # Fetch the actual remote branch, rather than trusting a stale origin/* ref.
    git(root, 'fetch', '--no-tags', '--no-recurse-submodules', remote, ref)
    git(root, 'merge-base', '--is-ancestor', current['head'], 'FETCH_HEAD')
    return {'verified': True, 'changed': True, 'head': current['head'], 'remote': remote, 'ref': ref}


def audit(path):
    path = Path(path)
    try:
        baseline = json.loads(path.read_text())
        result = verify(baseline)
    except (OSError, ValueError, KeyError, TypeError, DeliveryError) as error:
        message = str(error) if isinstance(error, DeliveryError) else 'Git baseline unavailable or invalid.'
        result = {'verified': False, 'reason': message}
    report = path.with_suffix('.result.json')
    report.write_text(json.dumps(result, ensure_ascii=False) + '\n')
    report.chmod(0o600)
    return result


def main():
    if len(sys.argv) == 4 and sys.argv[1] == '--snapshot':
        path = Path(sys.argv[3])
        path.write_text(json.dumps(snapshot(sys.argv[2])) + '\n')
        path.chmod(0o600)
        return 0
    path = os.environ.get('PRICE_CHECKER_CODEX_GIT_BASELINE')
    if not path:
        result = {'verified': False, 'reason': 'Git baseline is not configured.'}
    else:
        result = audit(path)
    if '--verify' in sys.argv:
        print(json.dumps(result))
        return 0 if result['verified'] else 1
    event = json.load(sys.stdin)
    if result['verified']:
        print('{}')
    else:
        reason = ('Git delivery is not verified: ' + result['reason']
                  + ' Use $safe-commit-auto to review only your changes, commit and push them, then finish again. '
                    'Do not bypass hooks, force push, amend history, or include pre-existing changes. '
                    'If the skill stops or the owner forbids push, report the blocker honestly.')
        if event.get('stop_hook_active'):
            # Do not loop forever on rejected pushes or unavailable authentication.
            # The launcher still fails its final audit and withholds turn.completed.
            print(json.dumps({'continue': False, 'stopReason': reason, 'systemMessage': reason}))
        else:
            print(json.dumps({'decision': 'block', 'reason': reason}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
