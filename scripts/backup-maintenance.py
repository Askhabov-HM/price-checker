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
        # This task never forgets snapshots, including the legacy combined tag.
        self.restic('check')
        self.restic('prune')
        self.restic('check')
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
