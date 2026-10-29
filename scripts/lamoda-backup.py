#!/usr/bin/env python3
"""Independent Lamoda snapshots in the existing encrypted restic repository."""
import argparse
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time

spec = importlib.util.spec_from_file_location('price_checker_backup', Path(__file__).with_name('google-drive-backup.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
FORMAT = 'price-checker-lamoda-backup-v1'
TAG = 'price-checker-lamoda'


def describe(path):
    with closing(base.open_readonly(path)) as connection:
        if connection.execute('SELECT provider,version FROM lamoda_meta WHERE id=1').fetchone() != ('lamoda-prices', 1):
            raise base.BackupError('Unsupported Lamoda database')
        if connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise base.BackupError('Lamoda integrity_check failed')
        if connection.execute('PRAGMA foreign_key_check').fetchall():
            raise base.BackupError('Lamoda foreign_key_check failed')
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        counts = {table: connection.execute('SELECT COUNT(*) FROM "' + table.replace('"', '""') + '"').fetchone()[0] for table in tables}
        first, last = connection.execute('SELECT MIN(checked_at),MAX(checked_at) FROM observations').fetchone()
        return {'provider': 'lamoda', 'filename': 'lamoda.sqlite3', 'schema_version': 1,
                'sha256': base.sha256(path), 'bytes': Path(path).stat().st_size, 'counts': counts,
                'first_observation': first, 'last_observation': last, 'signature': base.signature(connection)}


def source_path(data_dir):
    root = Path(data_dir).resolve(strict=True)
    path = root / 'lamoda' / 'prices.sqlite3'
    if not path.is_file() or path.is_symlink() or path.resolve() != path:
        raise base.BackupError('Missing or redirected Lamoda database')
    return path


def create_snapshot(data_dir, work):
    source = source_path(data_dir)
    stage = Path(work) / 'staging'
    if stage.is_symlink():
        raise base.BackupError('Lamoda staging must not be a symlink')
    stage.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any(path.name not in {'manifest.json', 'lamoda.sqlite3'} or path.is_symlink() for path in stage.iterdir()):
        raise base.BackupError('Unexpected file in Lamoda backup staging')
    with tempfile.TemporaryDirectory(prefix='sqlite-', dir=work) as directory:
        temporary = Path(directory) / 'lamoda.sqlite3'
        deadline = time.monotonic() + 120

        def progress(*_):
            if time.monotonic() > deadline:
                raise base.BackupError('Lamoda backup timed out')

        with closing(base.open_readonly(source)) as live, closing(sqlite3.connect(temporary)) as copy:
            live.backup(copy, pages=256, progress=progress)
            copy.execute('PRAGMA journal_mode=DELETE')
        temporary.chmod(0o600)
        metadata = describe(temporary)
        os.replace(temporary, stage / 'lamoda.sqlite3')
    manifest = {'format': FORMAT, 'created_at': base.utc_now(), 'databases': [metadata]}
    base.atomic_json(stage / 'manifest.json', manifest)
    return manifest


def validate_recovery(target):
    stage = Path(target) / 'staging'
    manifest_path = stage / 'manifest.json'
    if stage.is_symlink() or manifest_path.is_symlink() or not manifest_path.is_file():
        raise base.BackupError('Missing Lamoda recovery manifest')
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('format') != FORMAT or len(manifest.get('databases', [])) != 1:
        raise base.BackupError('Unsupported Lamoda recovery format')
    expected = manifest['databases'][0]
    path = stage / 'lamoda.sqlite3'
    if expected.get('provider') != 'lamoda' or expected.get('filename') != path.name or path.is_symlink() or not path.is_file():
        raise base.BackupError('Missing or mismatched Lamoda recovery file')
    if describe(path) != expected:
        raise base.BackupError('Lamoda recovery differs from its manifest')
    return manifest


class LamodaBackup(base.Backup):
    def verify(self, snapshot):
        if not base.re.fullmatch('[0-9a-f]{8,64}', snapshot):
            raise base.BackupError('An explicit snapshot ID is required')
        with tempfile.TemporaryDirectory(prefix='verify-', dir=self.work) as directory:
            self.restic('restore', snapshot, '--target', directory)
            return validate_recovery(directory)

    def restore(self, snapshot, target):
        target = Path(target).resolve()
        data = Path(self.config['data_dir']).resolve()
        if target.exists() or target.is_relative_to(data) or data.is_relative_to(target) or target.is_relative_to(self.work) or self.work.is_relative_to(target):
            raise base.BackupError('Restore target must be a new directory separate from live data and backup state')
        if not base.re.fullmatch('[0-9a-f]{8,64}', snapshot):
            raise base.BackupError('An explicit snapshot ID is required')
        target.mkdir(mode=0o700, parents=True)
        self.restic('restore', snapshot, '--target', str(target))
        return validate_recovery(target)

    def _run(self, force, force_verify):
        with closing(base.open_readonly(source_path(self.config['data_dir']))) as connection:
            signature = base.signature(connection)
        now = time.time()
        if not force and not force_verify and signature == self.state.get('signature') and now - self.state.get('last_success_epoch', 0) < 3600:
            return {'status': 'unchanged', 'snapshot_id': self.state.get('snapshot_id')}
        manifest = create_snapshot(self.config['data_dir'], self.work)
        if getattr(self,'journal',None): self.journal.stage(self.journal_run,'uploading')
        output = self.restic('backup', '--json', '--host', 'price-checker', '--tag', TAG, 'staging')
        summaries = [entry for line in output.splitlines() if line.strip() for entry in [json.loads(line)] if entry.get('message_type') == 'summary']
        snapshot = summaries[-1].get('snapshot_id', '') if summaries else ''
        if not base.re.fullmatch('[0-9a-f]{8,64}', snapshot):
            raise base.BackupError('restic did not confirm a completed Lamoda snapshot')
        self.record_snapshot(snapshot,manifest)
        maintenance = force_verify or now - self.state.get('last_verified_epoch', 0) >= 86400
        if maintenance:
            if getattr(self,'journal',None): self.journal.stage(self.journal_run,'verifying')
            if self.verify(snapshot) != manifest:
                raise base.BackupError('Downloaded Lamoda manifest differs from its snapshot')
            self.record_verified()
            # Only this tag's recovery points are expired. The separate shared
            # maintenance service checks/prunes under the same backup lock.
            self.restic('forget', '--tag', TAG, '--host', 'price-checker', '--group-by', 'host,paths,tags',
                        '--keep-last', '1', '--keep-within', '48h', '--keep-daily', '30', '--keep-monthly', '12')
            self.state.update(last_verified_epoch=now, last_verified_at=base.utc_now())
        self.state.update(snapshot_id=snapshot, signature=manifest['databases'][0]['signature'],
                          last_success_epoch=now, last_success_at=base.utc_now(), last_error=None)
        base.atomic_json(self.state_file, self.state)
        return {'status': 'saved', 'snapshot_id': snapshot, 'recovery_verified': maintenance}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default='/etc/price-checker-backup.json')
    sub = parser.add_subparsers(dest='command', required=True)
    run = sub.add_parser('run')
    run.add_argument('--force', action='store_true')
    run.add_argument('--verify', action='store_true')
    sub.add_parser('status')
    verify = sub.add_parser('verify')
    verify.add_argument('snapshot')
    restore = sub.add_parser('restore')
    restore.add_argument('snapshot')
    restore.add_argument('--target', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        config = base.load_config(args.config)
        config['work_dir'] = str(Path(config['work_dir']).with_name('price-checker-lamoda-backup'))
        backup = LamodaBackup(config)
        if args.command == 'run':
            result = backup.run(args.force, args.verify)
        elif args.command == 'status':
            result = backup.state
        else:
            with backup.lock():
                result = backup.audit_verify(args.snapshot) if args.command == 'verify' else backup.restore(args.snapshot, args.target)
        print(json.dumps(result))
        return 0
    except (base.BackupError, OSError, sqlite3.Error, ValueError) as error:
        print(json.dumps({'error': str(error) if isinstance(error, base.BackupError) else type(error).__name__}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
