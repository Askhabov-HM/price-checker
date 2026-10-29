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
from contextlib import closing, contextmanager, nullcontext
from urllib.request import urlopen, Request
import select
import signal

import importlib.util
_journal_spec = importlib.util.spec_from_file_location('backup_journal', Path(__file__).with_name('backup-journal.py'))
journal_module = importlib.util.module_from_spec(_journal_spec)
_journal_spec.loader.exec_module(journal_module)

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
    for required in ('run.js', 'package.json', 'package-lock.json', '.nvmrc', 'dist/index.html',
                     'storage-contract.json', 'scripts/storage-maintenance.js'):
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


def healthy(required_stores=(), storage_protocol=False):
    try:
        with urlopen('http://127.0.0.1:8000/api/health', timeout=2) as response:
            result = json.load(response)
        return (result.get('ok') is True and result.get('runtime') == 'node.js'
                and (not storage_protocol or result.get('storage_protocol') == 1)
                and all(result.get('stores', {}).get(store, {}).get('ok') is True for store in required_stores))
    except (OSError, ValueError):
        return False


def wait_healthy(required_stores=(), storage_protocol=False):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if healthy(required_stores, storage_protocol):
            return
        time.sleep(1)
    raise RuntimeError('Service did not become healthy within 30 seconds')


def backup_databases(data, commit, account=None):
    """Back up each existing store independently; never restore one as another."""
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    copies = []
    journal = journal_module.Journal(data)
    journal.import_local()
    for provider, relative in [('randewoo', 'prices.sqlite3'), ('ozon', 'ozon/prices.sqlite3'), ('lamoda', 'lamoda/prices.sqlite3')]:
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
        run_id = journal.start(provider,'deploy')
        try:
            with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as database:
                if provider == 'ozon' and database.execute('SELECT provider,version FROM ozon_meta WHERE id=1').fetchone() != ('ozon-prices', 1):
                    raise ValueError('Unsupported Ozon database')
                if provider == 'lamoda' and database.execute('SELECT provider,version FROM lamoda_meta WHERE id=1').fetchone() != ('lamoda-prices', 1):
                    raise ValueError('Unsupported Lamoda database')
                with closing(sqlite3.connect(target)) as copy:
                    database.backup(copy)
                    if copy.execute('PRAGMA quick_check').fetchone() != ('ok',):
                        raise ValueError('Invalid database backup')
            target.chmod(0o600)
            if account:
                shutil.chown(target, account.pw_uid, account.pw_gid)
            journal.artifact(provider,'vps',str(target.relative_to(data)),run_id,journal_module.now(),target.stat().st_size,'sqlite_ok')
            journal.finish(run_id,'success')
        except BaseException:
            journal.finish(run_id,'error','deployment_backup_failed')
            raise
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


STORE_PATHS = {'randewoo': 'prices.sqlite3', 'ozon': 'ozon/prices.sqlite3', 'lamoda': 'lamoda/prices.sqlite3'}
JOURNAL_TABLES = {'storage_meta', 'storage_migrations', 'projection_versions'}


def release_contract(release):
    path = Path(release) / 'storage-contract.json'
    if not path.exists():
        return None
    value = json.loads(path.read_text())
    if value.get('protocol') != 1:
        raise ValueError('Unsupported storage deployment protocol')
    for store in STORE_PATHS:
        entry = value['stores'][store]
        if any(not isinstance(entry.get(mode), list) or not entry[mode]
               or any(type(version) is not int or version < 1 for version in entry[mode]) for mode in ('read', 'write')):
            raise ValueError('Invalid storage compatibility declaration')
    return value


def database_format(path, store):
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as sql:
        tables = {row[0] for row in sql.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if store != 'randewoo':
            if sql.execute(f'SELECT provider,version FROM {store}_meta WHERE id=1').fetchone() != (store + '-prices', 1):
                raise ValueError('Unexpected store identity')
        elif 'ozon_meta' in tables or 'lamoda_meta' in tables:
            raise ValueError('Unexpected store identity')
        if 'storage_meta' not in tables:
            return 1
        row = sql.execute('SELECT store,format FROM storage_meta WHERE id=1').fetchone()
        if not row or row[0] != store:
            raise ValueError('Unexpected storage identity')
        return row[1]


def compatible_databases(data, contract, stores):
    if not contract:
        return False
    try:
        for store in stores:
            version = database_format(data / STORE_PATHS[store], store)
            if any(version not in contract['stores'][store][mode] for mode in ('read', 'write')):
                return False
        return True
    except (OSError, sqlite3.Error, ValueError, KeyError, TypeError):
        return False


def legacy_schema(path):
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as sql:
        return {name: (kind, definition) for kind, name, table, definition in
                sql.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
                if table not in JOURNAL_TABLES}


def legacy_rollback_compatible(data, copies, stores, new_contract):
    # Bridge only: the previously running release already handled the exact
    # pre-deploy schema. Prove that only isolated bookkeeping tables were added
    # and that calculations still use the unchanged baseline formulas.
    if new_contract.get('projections') != {'rows': 1, 'history': 1, 'published': 1}:
        return False
    by_store = {entry['provider']: entry for entry in copies}
    try:
        for store in stores:
            current = data / STORE_PATHS[store]
            previous = data / by_store[store]['backup']
            if database_format(current, store) != 1 or legacy_schema(current) != legacy_schema(previous):
                return False
            with closing(sqlite3.connect(current.resolve().as_uri() + '?mode=ro', uri=True)) as sql:
                if sql.execute("SELECT 1 FROM projection_versions WHERE version<>'1' LIMIT 1").fetchone():
                    return False
        return True
    except (OSError, sqlite3.Error, ValueError, KeyError):
        return False


class StorageDeployment:
    def __init__(self, release, previous, data=DATA):
        self.release, self.previous, self.data = Path(release), Path(previous), Path(data)
        self.contract, self.previous_contract = release_contract(release), release_contract(previous)
        self.stores = [store for store, path in STORE_PATHS.items() if (self.data / path).exists()]
        self.marker = self.data / 'deployment.json'
        self.copies = []
        self.preparation_started = False

    def preflight(self):
        if self.marker.exists():
            raise RuntimeError('Unfinished deployment: inspect deployment.json before continuing')
        if not self.contract or not compatible_databases(self.data, self.contract, self.stores):
            raise RuntimeError('New release cannot read/write the existing databases')

    def phase(self, phase):
        temporary = self.marker.with_name(f'.deployment-{os.getpid()}.json')
        temporary.write_text(json.dumps({'phase': phase, 'required_stores': self.stores,
                                        'release': self.release.name, 'previous': self.previous.name}))
        temporary.chmod(0o644)
        os.replace(temporary, self.marker)

    def control(self, action, method='GET'):
        # The local control token is never logged, sent to another host or saved in the marker.
        value = json.loads((self.data / 'server.json').read_text())
        request = Request(f'http://127.0.0.1:8000/api/deploy/{action}', method=method,
                          headers={'Authorization': 'Bearer ' + value['control_token']})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def drain(self):
        self.phase('drain')
        if not self.previous_contract:
            return  # First installation: legacy SIGTERM already interrupts safely.
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                if self.control('status').get('drained'):
                    return
            except (OSError, ValueError, KeyError):
                return
            time.sleep(1)
        # systemctl stop now uses the application's normal interruption path.

    @contextmanager
    def locked(self, release):
        process = subprocess.Popen(['/usr/sbin/runuser', '-u', APP_USER, '--', '/usr/local/bin/node',
                                    str(Path(release) / 'scripts/storage-maintenance.js'), 'hold', str(release)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, start_new_session=True)
        def receive(timeout=120):
            if not select.select([process.stdout], [], [], timeout)[0]:
                raise RuntimeError('Storage preparation timed out')
            try:
                result = json.loads(process.stdout.readline())
            except (ValueError, OSError):
                raise RuntimeError('Storage preparation process failed') from None
            if result.get('ok') is not True:
                reason = result.get('reason', 'storage_operation_failed')
                if not isinstance(reason, str) or not re.fullmatch('[a-z_]+', reason):
                    reason = 'storage_operation_failed'
                store = result.get('store') if result.get('store') in STORE_PATHS else 'storage'
                raise RuntimeError(f'Storage preparation failed: {store}: {reason}')
            return result
        def prepare():
            process.stdin.write('prepare\n');process.stdin.flush()
            receive(300)
        try:
            locked = receive()
            if set(locked.get('stores', [])) != set(self.stores):
                raise RuntimeError('Store inventory changed while stopping writers')
            yield prepare
        finally:
            try:
                process.stdin.write('release\n');process.stdin.flush();process.stdin.close()
                process.wait(timeout=15)
            except (OSError, subprocess.TimeoutExpired):
                os.killpg(process.pid, signal.SIGTERM)
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: os.killpg(process.pid, signal.SIGKILL);process.wait()
            process.stdout.close()

    def can_rollback(self):
        if not self.preparation_started:
            return True
        if self.previous_contract:
            return compatible_databases(self.data, self.previous_contract, self.stores)
        return legacy_rollback_compatible(self.data, self.copies, self.stores, self.contract)

    def activate(self):
        self.marker.unlink()
        try:
            if self.control('activate', 'POST').get('ok') is not True:
                raise RuntimeError('Collector activation failed')
        except BaseException:
            self.phase('blocked')
            raise


def activate_release(release, previous, backup):
    storage = StorageDeployment(release, previous)
    storage.preflight()
    try:
        storage.drain()
        service('stop')
        storage.phase('prepare')
        with storage.locked(release) as prepare:
            storage.copies = backup()
            if {entry['provider'] for entry in storage.copies} != set(storage.stores):
                raise RuntimeError('Incomplete deployment backup')
            storage.preparation_started = True
            prepare()
        storage.phase('validate')
        switch_current(release)
        service('start')
        wait_healthy(storage.stores, True)
        storage.activate()
    except BaseException:
        storage.phase('blocked')
        service('stop')
        if not storage.can_rollback():
            raise RuntimeError('Automatic rollback blocked: previous code is incompatible; current databases and backups retained') from None
        print('Deployment failed; returning to compatible previous code without restoring databases.', flush=True)
        try:
            lock = storage.locked(previous if storage.previous_contract else release) if storage.preparation_started else nullcontext()
            with lock as prepare:
                if not storage.can_rollback():
                    raise RuntimeError('Storage compatibility changed before rollback')
                if storage.previous_contract and storage.preparation_started:
                    prepare()  # Rebuild calculations for the previous algorithm, too.
            switch_current(previous)
            if storage.previous_contract:
                storage.phase('validate');service('start');wait_healthy(storage.stores, True);storage.activate()
            else:
                storage.marker.unlink();service('start');wait_healthy()
        except BaseException:
            storage.phase('blocked');service('stop')
            raise RuntimeError('Rollback readiness failed; collection remains stopped and databases retained') from None
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
            return backup_databases(DATA, commit, account)

        activate_release(release, previous, backup)
        print(f'Deployed {commit}; health check passed.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Deployment failed: {error}', file=sys.stderr)
        sys.exit(1)
