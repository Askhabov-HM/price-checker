#!/usr/bin/env python3
"""Consistent SQLite snapshots, encrypted restic storage, and isolated recovery."""

import argparse
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import tempfile
import time


FORMAT = 'price-checker-database-backup-v1'
TAG = 'price-checker-databases'
STORES = {'randewoo': 'prices.sqlite3', 'ozon': 'ozon/prices.sqlite3'}
DEFAULT_CONFIG = '/etc/price-checker-backup.json'


class BackupError(RuntimeError):
    pass


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path = Path(path)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                     prefix=path.name + '.', delete=False) as output:
        temporary = Path(output.name)
        os.chmod(temporary, 0o600)
        try:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def sha256(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def open_readonly(path):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, timeout=30)
    connection.execute('PRAGMA query_only=ON')
    return connection


def validate_provider(connection, provider):
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    required = {'products', 'checks', 'observations'}
    required |= {'variants', 'memberships', 'settings'} if provider == 'randewoo' else {'ozon_meta', 'collector_state', 'membership'}
    if not required <= tables or (provider == 'randewoo' and 'ozon_meta' in tables):
        raise BackupError(f'Unexpected {provider} database schema')
    if provider == 'ozon':
        if connection.execute('SELECT provider,version FROM ozon_meta WHERE id=1').fetchone() != ('ozon-prices', 1):
            raise BackupError('Unsupported Ozon database')


def signature(connection):
    check = connection.execute("SELECT id,status,finished_at FROM checks WHERE finished_at IS NOT NULL AND status<>'running' ORDER BY id DESC LIMIT 1").fetchone()
    observation = connection.execute('SELECT MAX(id) FROM observations').fetchone()[0]
    # SQLite's schema cookie changes when copying into a new database. Compare
    # the actual schema so a valid copy does not trigger another upload forever.
    schema = connection.execute("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").fetchall()
    fingerprint = hashlib.sha256(json.dumps(schema).encode('utf-8')).hexdigest()
    return {'check': list(check) if check else None, 'observation': observation, 'schema': fingerprint}


def describe(path, provider):
    with closing(open_readonly(path)) as connection:
        validate_provider(connection, provider)
        if connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise BackupError(f'{provider} snapshot failed integrity_check')
        counts = {table: connection.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                  for table in ('products', 'checks', 'observations')}
        first, last = connection.execute('SELECT MIN(checked_at),MAX(checked_at) FROM observations').fetchone()
        foreign_key_violations = len(connection.execute('PRAGMA foreign_key_check').fetchall())
        return {'provider': provider, 'filename': Path(path).name, 'sha256': sha256(path),
                'bytes': Path(path).stat().st_size, 'counts': counts, 'first_observation': first,
                'last_observation': last, 'foreign_key_violations': foreign_key_violations,
                'signature': signature(connection)}


def source_paths(data_dir, stores=None):
    root = Path(data_dir).resolve(strict=True)
    paths = {}
    for provider, relative in (STORES if stores is None else stores).items():
        path = root / relative
        if path.is_symlink() or not path.is_file() or path.resolve() != path:
            raise BackupError(f'Missing or redirected {provider} database')
        paths[provider] = path
    return paths


def current_signatures(data_dir, stores=None):
    result = {}
    for provider, path in source_paths(data_dir, stores).items():
        with closing(open_readonly(path)) as connection:
            validate_provider(connection, provider)
            result[provider] = signature(connection)
    return result


def create_snapshots(data_dir, staging, stores=None, manifest_format=FORMAT):
    stores = STORES if stores is None else stores
    staging = Path(staging)
    if staging.is_symlink():
        raise BackupError('Staging directory must not be a symlink')
    staging.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Never include arbitrary files or secrets from a reused staging directory.
    allowed = {'manifest.json', *(f'{provider}.sqlite3' for provider in stores)}
    if any(path.name not in allowed or path.is_symlink() for path in staging.iterdir()):
        raise BackupError('Unexpected file in backup staging directory')
    metadata = []
    for provider, source in source_paths(data_dir, stores).items():
        target = staging / f'{provider}.sqlite3'
        with tempfile.TemporaryDirectory(prefix='sqlite-', dir=staging.parent) as directory:
            temporary = Path(directory) / target.name
            deadline = time.monotonic() + 120

            def progress(*_):
                if time.monotonic() > deadline:
                    raise BackupError(f'{provider} SQLite backup timed out')

            with closing(open_readonly(source)) as live, closing(sqlite3.connect(temporary)) as copy:
                validate_provider(live, provider)
                live.backup(copy, pages=256, progress=progress)
                copy.execute('PRAGMA journal_mode=DELETE')
            os.chmod(temporary, 0o600)
            entry = describe(temporary, provider)
            os.replace(temporary, target)
            metadata.append(entry)
    manifest = {'format': manifest_format, 'created_at': utc_now(), 'databases': metadata}
    atomic_json(staging / 'manifest.json', manifest)
    return manifest


def validate_recovery(target, stores=None, manifest_format=FORMAT):
    stores = STORES if stores is None else stores
    staging = Path(target) / 'staging'
    manifest_path = staging / 'manifest.json'
    if staging.is_symlink() or manifest_path.is_symlink() or not manifest_path.is_file():
        raise BackupError('Recovery manifest is missing')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('format') != manifest_format:
        raise BackupError('Unsupported recovery manifest')
    entries = manifest.get('databases', [])
    if len(entries) != len(stores) or {entry.get('provider') for entry in entries} != set(stores):
        raise BackupError('Recovery must contain exactly the requested store databases')
    for entry in entries:
        provider = entry['provider']
        if entry.get('filename') != f'{provider}.sqlite3':
            raise BackupError('Unexpected recovery filename')
        path = staging / entry['filename']
        if path.is_symlink() or not path.is_file():
            raise BackupError(f'Missing {provider} recovery file')
        actual = describe(path, provider)
        # Scheduling signatures are not recovery evidence. Older v1 manifests
        # stored SQLite schema cookies here; keep those existing copies readable.
        if {k: v for k, v in actual.items() if k != 'signature'} != {k: v for k, v in entry.items() if k != 'signature'}:
            raise BackupError(f'{provider} recovery differs from the snapshot manifest')
    return manifest


def load_config(path):
    config = json.loads(Path(path).read_text(encoding='utf-8'))
    for field in ('data_dir', 'work_dir', 'rclone_config', 'password_file'):
        config[field] = str(Path(config[field]).resolve())
    if not re.fullmatch(r'rclone:[A-Za-z0-9_-]+:price-checker-backups', config['repository']):
        raise BackupError('Repository must be a dedicated price-checker-backups folder')
    data, work = Path(config['data_dir']), Path(config['work_dir'])
    if work.is_relative_to(data) or data.is_relative_to(work):
        raise BackupError('Backup work directory must be separate from live data')
    return config


class Backup:
    stores = STORES
    manifest_format = FORMAT
    tag = TAG

    def __init__(self, config):
        self.config = config
        self.work = Path(config['work_dir'])
        self.work.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.state_file = self.work / 'state.json'
        self.state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {}
        self.coordination = Path(config.get('coordination_dir', self.work.parent / 'price-checker-backup-coordination'))
        self.deadline = None

    def restic(self, *arguments):
        environment = dict(os.environ, RESTIC_REPOSITORY=self.config['repository'],
                           RESTIC_PASSWORD_FILE=self.config['password_file'],
                           RESTIC_CACHE_DIR=str(self.work / 'cache'),
                           RCLONE_CONFIG=self.config['rclone_config'], RCLONE_FAST_LIST='true')
        command = [self.config.get('restic', '/usr/bin/restic'), '--retry-lock', '2m', '-o',
                   'rclone.program=' + self.config.get('rclone', '/usr/bin/rclone'), *arguments]
        try:
            timeout = min(900, self.deadline - time.monotonic()) if self.deadline is not None else 900
            if timeout <= 0:
                raise BackupError('Backup operation timed out')
            with subprocess.Popen(command, cwd=self.work, env=environment, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, start_new_session=os.name != 'nt') as process:
                try:
                    stdout, _ = process.communicate(timeout=timeout)
                except subprocess.TimeoutExpired:
                    # rclone is a restic child: stop the entire group before releasing
                    # the repository lock, including for manual invocations.
                    if os.name == 'nt':
                        process.kill()
                    else:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    process.communicate()
                    raise
                returncode = process.returncode
        except subprocess.TimeoutExpired:
            raise BackupError(f'restic {arguments[0]} timed out') from None
        # Credentials and raw provider responses must never reach logs or chat.
        if returncode:
            raise BackupError(f'restic {arguments[0]} failed (exit {returncode}); check connectivity, Drive quota and authorization')
        return stdout

    @contextmanager
    def lock(self):
        import fcntl
        with (self.work / 'backup.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise BackupError('Another backup operation is running') from None
            # A separate lock for the shared disk/repository, never the collection queue.
            # Keep the per-store lock while waiting so repeated triggers cannot pile up.
            self.coordination.mkdir(mode=0o700, parents=True, exist_ok=True)
            with (self.coordination / 'repository.lock').open('a') as shared:
                deadline = time.monotonic() + self.config.get('queue_timeout_seconds', 2400)
                while True:
                    try:
                        fcntl.flock(shared, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            message = 'Timed out waiting for the backup queue'
                            self.state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {}
                            self.state.update(last_error=message, last_failure_at=utc_now())
                            atomic_json(self.state_file, self.state)
                            raise BackupError(message) from None
                        time.sleep(0.2)
                # Refresh state after admission, including manual invocations.
                self.state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {}
                self.deadline = time.monotonic() + 1200
                try:
                    yield
                finally:
                    self.deadline = None

    def verify(self, snapshot):
        if not re.fullmatch('[0-9a-f]{8,64}', snapshot):
            raise BackupError('An explicit snapshot ID is required')
        with tempfile.TemporaryDirectory(prefix='verify-', dir=self.work) as directory:
            self.restic('restore', snapshot, '--target', directory)
            return validate_recovery(directory, self.stores, self.manifest_format)

    def restore(self, snapshot, target):
        target = Path(target).resolve()
        data = Path(self.config['data_dir']).resolve()
        protected = (data, self.work, self.coordination.resolve())
        if target.exists() or any(target.is_relative_to(path) or path.is_relative_to(target) for path in protected):
            raise BackupError('Restore target must be a new directory separate from live data and backup state')
        if not re.fullmatch('[0-9a-f]{8,64}', snapshot):
            raise BackupError('An explicit snapshot ID is required')
        target.mkdir(mode=0o700, parents=True)
        self.restic('restore', snapshot, '--target', str(target))
        return validate_recovery(target, self.stores, self.manifest_format)

    def run(self, force=False, force_verify=False):
        with self.lock():
            try:
                return self._run(force, force_verify)
            except (BackupError, OSError, sqlite3.Error, ValueError) as error:
                # Only our own messages are safe to persist; sqlite/JSON errors can contain data.
                message = str(error) if isinstance(error, BackupError) else type(error).__name__
                self.state.update(last_error=message, last_failure_at=utc_now())
                atomic_json(self.state_file, self.state)
                raise BackupError(message) from None

    def _run(self, force, force_verify):
        current = current_signatures(self.config['data_dir'], self.stores)
        now = time.time()
        if not force and not force_verify and current == self.state.get('signatures') and now - self.state.get('last_success_epoch', 0) < 3600:
            return {'status': 'unchanged', 'snapshot_id': self.state.get('snapshot_id')}
        manifest = create_snapshots(self.config['data_dir'], self.work / 'staging', self.stores, self.manifest_format)
        output = self.restic('backup', '--json', '--host', 'price-checker', '--tag', self.tag, 'staging')
        summaries = [item for line in output.splitlines() if line.strip()
                     for item in [json.loads(line)] if item.get('message_type') == 'summary']
        snapshot = summaries[-1].get('snapshot_id', '') if summaries else ''
        if not re.fullmatch('[0-9a-f]{8,64}', snapshot):
            raise BackupError('restic did not confirm a completed snapshot')
        maintenance = force_verify or now - self.state.get('last_verified_epoch', 0) >= 86400
        if maintenance:
            if self.verify(snapshot) != manifest:
                raise BackupError('Downloaded snapshot manifest differs from the local snapshot')
            # Retention removes old recovery points, never rows from the live databases.
            self.restic('forget', '--tag', self.tag, '--host', 'price-checker', '--group-by', 'host,paths,tags',
                        '--keep-last', '1', '--keep-within', '48h', '--keep-daily', '30', '--keep-monthly', '12')
            self.state['last_verified_epoch'] = now
            self.state['last_verified_at'] = utc_now()
        self.state.update(snapshot_id=snapshot, last_success_at=utc_now(), last_success_epoch=now,
                          signatures={entry['provider']: entry['signature'] for entry in manifest['databases']},
                          databases=manifest['databases'], last_error=None)
        atomic_json(self.state_file, self.state)
        return {'status': 'saved', 'snapshot_id': snapshot, 'recovery_verified': maintenance,
                'databases': manifest['databases']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=DEFAULT_CONFIG)
    commands = parser.add_subparsers(dest='command', required=True)
    run = commands.add_parser('run')
    run.add_argument('--force', action='store_true')
    run.add_argument('--verify', action='store_true', help='Require downloaded recovery verification even if checked today')
    commands.add_parser('status')
    commands.add_parser('init')
    verify = commands.add_parser('verify')
    verify.add_argument('snapshot')
    restore = commands.add_parser('restore')
    restore.add_argument('snapshot')
    restore.add_argument('--target', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        backup = Backup(load_config(args.config))
        if args.command == 'run':
            result = backup.run(args.force, args.verify)
        elif args.command == 'status':
            result = backup.state
        else:
            with backup.lock():
                if args.command == 'init':
                    backup.restic('init', '--repository-version', '2')
                    result = {'status': 'initialized'}
                elif args.command == 'verify':
                    result = backup.verify(args.snapshot)
                else:
                    result = backup.restore(args.snapshot, args.target)
        print(json.dumps(result, ensure_ascii=False))
    except (BackupError, OSError, sqlite3.Error, ValueError) as error:
        message = str(error) if isinstance(error, BackupError) else type(error).__name__
        print(json.dumps({'status': 'error', 'error': message}), flush=True)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
