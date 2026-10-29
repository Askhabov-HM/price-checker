#!/usr/bin/env python3
"""Check/prune the shared repository under the same lock as all store backups."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sqlite3

spec = importlib.util.spec_from_file_location('price_checker_backup', Path(__file__).with_name('google-drive-backup.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


class Maintenance(base.Backup):
    def __init__(self, config):
        config = dict(config)
        work = Path(config['work_dir'])
        config.setdefault('coordination_dir', str(work.parent / 'price-checker-backup-coordination'))
        config['work_dir'] = str(work.with_name('price-checker-backup-maintenance'))
        super().__init__(config)

    def _run(self, force, force_verify):
        # Each store expires only its own snapshots after successful recovery.
        # Price snapshots (including the legacy combined tag) are never forgotten here.
        self.restic('check')
        self.restic('prune')
        self.restic('check')
        if getattr(self,'journal',None):
            self.journal.import_local()
            self.journal.snapshot(self.work / 'journal' / 'backup-journal.sqlite3')
            output = self.restic('backup','--json','--host','price-checker','--tag','price-checker-journal','journal')
            summaries = [json.loads(line) for line in output.splitlines() if line.strip()]
            snapshot = next((entry.get('snapshot_id') for entry in reversed(summaries) if entry.get('message_type') == 'summary'),None)
            if not snapshot or not base.re.fullmatch('[0-9a-f]{64}',snapshot): raise base.BackupError('Journal snapshot was not confirmed')
            self.journal.artifact('journal','cloud',snapshot,self.journal_run,base.utc_now(),verification='sqlite_ok')
            self.journal.stage(self.journal_run,'verifying')
            with base.tempfile.TemporaryDirectory(prefix='journal-verify-',dir=self.work) as recovery:
                self.restic('restore',snapshot,'--target',recovery)
                recovered = Path(recovery)/'journal/backup-journal.sqlite3'
                with base.closing(sqlite3.connect(recovered.resolve().as_uri()+'?mode=ro',uri=True)) as sql:
                    if sql.execute('PRAGMA quick_check').fetchone()[0]!='ok' or sql.execute('SELECT count(*) FROM journal_migrations').fetchone()[0]!=1:
                        raise base.BackupError('Journal recovery check failed')
                if base.sha256(recovered) != base.sha256(self.work / 'journal' / 'backup-journal.sqlite3'):
                    raise base.BackupError('Journal recovery differs from saved snapshot')
                self.journal.verified(self.journal_run)
            self.restic('forget','--tag','price-checker-journal','--host','price-checker','--group-by','host,paths,tags','--keep-last','7','--keep-daily','30','--keep-monthly','12')
            self.journal.cloud_inventory(json.loads(self.restic('snapshots','--json')))
        self.state.update(last_success_at=base.utc_now(), last_error=None)
        base.atomic_json(self.state_file, self.state)
        return {'status': 'verified', 'last_success_at': self.state['last_success_at']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=base.DEFAULT_CONFIG)
    parser.add_argument('command', choices=('run', 'status'))
    args = parser.parse_args()
    os.umask(0o077)
    try:
        maintenance = Maintenance(base.load_config(args.config))
        print(json.dumps(maintenance.run() if args.command == 'run' else maintenance.state))
    except (base.BackupError, OSError, sqlite3.Error, ValueError) as error:
        message = str(error) if isinstance(error, base.BackupError) else type(error).__name__
        print(json.dumps({'status': 'error', 'error': message}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
