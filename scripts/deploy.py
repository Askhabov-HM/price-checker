#!/usr/bin/env python3
"""Restricted SSH deployment entrypoint for the existing Ubuntu installation."""

import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from contextlib import closing
from urllib.request import urlopen

BASE = Path('/opt/price-checker')
DATA = Path('/var/lib/price-checker/data')
SECRETS = Path('/var/lib/price-checker/secrets')
SERVICE = 'price-checker.service'
APP_USER = 'pricechecker'
MAX_ARCHIVE = 50 * 1024 * 1024


def commit_from_command(command):
    match = re.fullmatch(r'deploy ([0-9a-f]{40})', command)
    if not match:
        raise ValueError('Only "deploy <40-character commit SHA>" is allowed')
    return match[1]


def make_release_readable(release):
    """Keep root-owned code readable by the service, independent of SSH umask."""
    for directory, folders, files in os.walk(release, followlinks=False):
        Path(directory).chmod(0o755)
        for name in files:
            path = Path(directory) / name
            if not path.is_symlink():
                path.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)


def extract_release(archive, destination):
    with tarfile.open(fileobj=archive, mode='r:gz') as bundle:
        members = bundle.getmembers()
        if len(members) > 10000 or sum(member.size for member in members) > 100 * 1024 * 1024:
            raise ValueError('Release archive is too large')
        reserved = {'.data', '.secrets', '.git', 'node_modules'}
        for member in members:
            path = PurePosixPath(member.name)
            if (path.is_absolute() or '..' in path.parts or not path.parts
                    or path.parts[0] in reserved or not (member.isfile() or member.isdir())):
                raise ValueError('Release contains a forbidden archive entry')
        bundle.extractall(destination, members=members, filter='data')
    make_release_readable(destination)
    for required in ('run.js', 'package.json', 'package-lock.json', '.nvmrc', 'dist/index.html'):
        if not (destination / required).is_file():
            raise ValueError(f'Release is missing {required}')


def switch_current(target, base=BASE):
    # The temporary symlink and current live on the same filesystem.
    temporary = base / f'.current-{os.getpid()}'
    try:
        temporary.symlink_to(target)
        os.replace(temporary, base / 'current')
    finally:
        temporary.unlink(missing_ok=True)


def service(action):
    subprocess.run(['/usr/bin/systemctl', action, SERVICE], check=True, timeout=90)


def healthy():
    try:
        with urlopen('http://127.0.0.1:8000/api/health', timeout=2) as response:
            result = json.load(response)
        return result.get('ok') is True and result.get('runtime') == 'node.js'
    except (OSError, ValueError):
        return False


def wait_healthy():
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if healthy():
            return
        time.sleep(1)
    raise RuntimeError('Service did not become healthy within 30 seconds')


def backup_databases(data, commit, account=None):
    """Back up each existing store independently; never restore one as another."""
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    copies = []
    for provider, relative in [('randewoo', 'prices.sqlite3'), ('ozon', 'ozon/prices.sqlite3')]:
        source = data / relative
        if not source.exists():
            continue
        if source.is_symlink() or source.resolve() != data.resolve() / relative:
            raise ValueError('Unexpected database path')
        directory = source.parent / 'backups'
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink() or not directory.resolve().is_relative_to(data.resolve()):
            raise ValueError('Unexpected backup directory')
        if account:
            shutil.chown(directory, account.pw_uid, account.pw_gid)
        target = directory / f'pre-deploy-{stamp}-{commit[:12]}.sqlite3'
        if target.exists():
            raise ValueError('Deployment backup already exists')
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as database:
            if provider == 'ozon' and database.execute('SELECT provider,version FROM ozon_meta WHERE id=1').fetchone() != ('ozon-prices', 1):
                raise ValueError('Unsupported Ozon database')
            with closing(sqlite3.connect(target)) as copy:
                database.backup(copy)
                if copy.execute('PRAGMA quick_check').fetchone() != ('ok',):
                    raise ValueError('Invalid database backup')
        target.chmod(0o600)
        if account:
            shutil.chown(target, account.pw_uid, account.pw_gid)
        copies.append({'provider': provider, 'source': relative, 'backup': str(target.relative_to(data))})
        print(f'Database backup ({provider}): {target.name}', flush=True)
    if copies:
        manifest = data / 'backups' / f'pre-deploy-{stamp}-{commit[:12]}.json'
        manifest.parent.mkdir(mode=0o700, exist_ok=True)
        with manifest.open('x') as output:
            json.dump({'commit': commit, 'databases': copies}, output)
        manifest.chmod(0o600)
        if account:
            shutil.chown(manifest, account.pw_uid, account.pw_gid)
    return copies


def activate_release(release, previous, backup):
    # Stop polling and SQLite writes before taking the deployment backup.
    # Retain the database on rollback: a new process may already have saved data.
    try:
        service('stop')
        backup()
        switch_current(release)
        service('start')
        wait_healthy()
    except BaseException:
        print('Deployment failed; restoring the previous code version.', flush=True)
        service('stop')
        switch_current(previous)
        service('start')
        wait_healthy()
        raise


def main():
    import fcntl
    import pwd

    commit = commit_from_command(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    if os.geteuid() != 0:
        raise RuntimeError('The deployment entrypoint must run as root')
    previous = (BASE / 'current').resolve(strict=True)
    if not previous.is_relative_to(BASE / 'releases'):
        raise RuntimeError('Current release is outside the release directory')
    if not (SECRETS / 'price-checker-auth.json').is_file() or not DATA.is_dir():
        raise RuntimeError('Existing application data or authentication is missing')
    account = pwd.getpwnam(APP_USER)
    with (BASE / '.deploy.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tempfile.TemporaryFile() as archive:
            size = 0
            while chunk := sys.stdin.buffer.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_ARCHIVE:
                    raise ValueError('Compressed release archive is too large')
                archive.write(chunk)
            archive.seek(0)
            release = Path(tempfile.mkdtemp(prefix=f'github-{commit[:12]}-', dir=BASE / 'releases'))
            release.chmod(0o755)
            extract_release(archive, release)
        (release / 'REVISION').write_text(commit + '\n')
        shutil.chown(release, account.pw_uid, account.pw_gid)
        for directory, folders, files in os.walk(release):
            for name in folders + files:
                shutil.chown(Path(directory) / name, account.pw_uid, account.pw_gid)
        print(f'Installing dependencies for {commit}', flush=True)
        subprocess.run(['/usr/sbin/runuser', '-u', APP_USER, '--', '/usr/local/bin/npm',
                        'ci', '--no-audit', '--no-fund'], cwd=release, check=True, timeout=300,
                       env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': account.pw_dir})
        # Root owns the code; the application writes only to its shared state.
        for directory, folders, files in os.walk(release):
            os.chown(directory, 0, 0, follow_symlinks=False)
            for name in folders + files:
                os.chown(Path(directory) / name, 0, 0, follow_symlinks=False)
        shutil.chown(release, 0, 0)
        make_release_readable(release)
        (release / '.data').symlink_to(DATA)
        (release / '.secrets').symlink_to(SECRETS)

        def backup():
            backup_databases(DATA, commit, account)

        activate_release(release, previous, backup)
        print(f'Deployed {commit}; health check passed.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Deployment failed: {error}', file=sys.stderr)
        sys.exit(1)
