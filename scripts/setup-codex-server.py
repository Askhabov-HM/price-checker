#!/usr/bin/env python3
"""Install the explicitly authorized root Codex integration; never run tests."""

import argparse
import datetime
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import urllib.request

STATE = Path('/var/lib/price-checker-codex')
REPO = Path('/opt/price-checker/repository')
CODEX_HOME = Path('/var/lib/price-checker/.codex')
REMOTE = 'git@github.com:Askhabov-HM/price-checker.git'


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def prepare_key():
    directory = STATE / '.ssh'
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    key = directory / 'price-checker-github'
    if not key.exists():
        run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'price-checker-server-codex', '-f', str(key))
    key.chmod(0o600)
    return key


def require_develop_workspace():
    if run('git', '-C', str(REPO), 'symbolic-ref', '--quiet', '--short', 'HEAD') != 'develop':
        raise RuntimeError('Codex workspace must use the develop branch')
    if (run('git', '-C', str(REPO), 'config', '--get', 'branch.develop.remote') != 'origin'
            or run('git', '-C', str(REPO), 'config', '--get', 'branch.develop.merge') != 'refs/heads/develop'):
        raise RuntimeError('Codex workspace must track origin/develop')


def install(source, name, email):
    key = prepare_key()
    with urllib.request.urlopen('https://api.github.com/meta', timeout=30) as response:
        keys = json.load(response)['ssh_keys']
    known = STATE / '.ssh/github-known-hosts'
    known.write_text(''.join('github.com ' + key + '\n' for key in keys))
    ssh_command = f'ssh -i {key} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile={known} -o HostKeyAlias=github.com -o Hostname=ssh.github.com -p 443'
    if not REPO.exists():
        run('git', '-c', 'core.sshCommand=' + ssh_command, 'clone', '--branch', 'develop', REMOTE, str(REPO))
    REPO.chmod(0o755)
    if run('git', '-C', str(REPO), 'remote', 'get-url', 'origin') != REMOTE:
        raise RuntimeError('Unexpected repository remote')
    if run('git', '-C', str(REPO), 'status', '--porcelain'):
        raise RuntimeError('Preserve existing repository changes before installation')
    require_develop_workspace()
    for setting, value in [('core.sshCommand', ssh_command), ('user.name', name), ('user.email', email)]:
        run('git', '-C', str(REPO), 'config', setting, value)
    # Independent SSH process escapes the web service's filesystem sandbox.
    # No changes to NoNewPrivileges, ProtectSystem or the application's UID are needed.
    account = pwd.getpwnam('pricechecker')
    secret = Path('/var/lib/price-checker/secrets')
    client_key = secret / 'codex-root-ed25519'
    if not client_key.exists():
        run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'price-checker-codex-root', '-f', str(client_key))
    for path in [client_key, client_key.with_suffix('.pub')]:
        path.chmod(0o600)
        os.chown(path, account.pw_uid, account.pw_gid)
    host = Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().split()
    local_known = secret / 'codex-root-known-hosts'
    local_known.write_text('127.0.0.1 ' + ' '.join(host[:2]) + '\n')
    local_known.chmod(0o600)
    os.chown(local_known, account.pw_uid, account.pw_gid)
    library = Path('/usr/local/lib/price-checker')
    library.mkdir(parents=True, exist_ok=True)
    backup = STATE / 'install-backups' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup.mkdir(parents=True, mode=0o700)
    files = [(source / 'scripts/codex-root-launcher.py', library / 'codex-root-launcher.py'),
             (source / 'scripts/codex-git-guard.py', library / 'codex-git-guard.py'),
             (source / 'scripts/codex-ssh-client.py', Path('/usr/local/bin/price-checker-codex')),
             (source / 'scripts/codex-hooks.json', CODEX_HOME / 'hooks.json')]
    for index, (original, target) in enumerate(files):
        if target.exists():
            shutil.copy2(target, backup / str(index))
        shutil.copyfile(original, target)
        target.chmod(0o644 if target.suffix == '.json' else 0o755)
    authorized = Path('/root/.ssh/authorized_keys')
    public = client_key.with_suffix('.pub').read_text().strip()
    line = 'restrict,from="127.0.0.1",command="/usr/bin/python3 /usr/local/lib/price-checker/codex-root-launcher.py" ' + public
    existing = authorized.read_text()
    if public.split()[1] not in existing:
        shutil.copy2(authorized, backup / 'authorized_keys')
        authorized.write_text(existing.rstrip() + '\n' + line + '\n')
        authorized.chmod(0o600)
    config = CODEX_HOME / 'config.toml'
    shutil.copy2(config, backup / 'config.toml')
    content = config.read_text()
    content = re.sub(r'^sandbox_mode\s*=.*$', 'sandbox_mode = "danger-full-access"', content, flags=re.M)
    content = re.sub(r'^approval_policy\s*=.*$', 'approval_policy = "never"', content, flags=re.M)
    project = '[projects."' + str(REPO) + '"]'
    if project not in content:
        content += '\n' + project + '\ntrust_level = "trusted"\n'
    config.write_text(content)
    config.chmod(0o600)
    # The supplied skill and its required guidance remain versioned in the repository.
    for original in (source / '.agents/skills/safe-commit-auto').rglob('*'):
        if original.is_file():
            target = CODEX_HOME / 'skills/safe-commit-auto' / original.relative_to(source / '.agents/skills/safe-commit-auto')
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            shutil.copyfile(original, target)
    env_path = Path('/etc/price-checker-telegram.env')
    shutil.copy2(env_path, backup / 'telegram.env')
    content = env_path.read_text()
    content, count = re.subn(r'^PRICE_CHECKER_CODEX_WORKSPACE=.*$', 'PRICE_CHECKER_CODEX_WORKSPACE=' + str(REPO), content, flags=re.M)
    if count != 1:
        raise RuntimeError('Expected one configured Codex workspace')
    env_path.write_text(content)
    env_path.chmod(0o600)
    print(json.dumps({'installed': True, 'repository': str(REPO), 'backup': str(backup),
                      'root_access': True, 'completion_hook': True, 'service_restart_required': True}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepare-key', action='store_true')
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--git-name', default='Price Checker Codex')
    parser.add_argument('--git-email', default='codex@price-checker.local')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Run as root')
    os.umask(0o077)
    if args.prepare_key:
        print(prepare_key().with_suffix('.pub').read_text().strip())
    else:
        install(args.source.resolve(), args.git_name, args.git_email)


if __name__ == '__main__':
    main()
