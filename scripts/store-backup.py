#!/usr/bin/env python3
"""Independent Randewoo/Ozon snapshots; legacy combined recovery remains available."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sqlite3

spec = importlib.util.spec_from_file_location('price_checker_backup', Path(__file__).with_name('google-drive-backup.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


class StoreBackup(base.Backup):
    manifest_format = 'price-checker-store-backup-v1'

    def __init__(self, config, provider):
        if provider not in base.STORES:
            raise base.BackupError('Unknown backup store')
        self.stores = {provider: base.STORES[provider]}
        self.tag = 'price-checker-' + provider
        config = dict(config)
        legacy_work = Path(config['work_dir'])
        config.setdefault('coordination_dir', str(legacy_work.parent / 'price-checker-backup-coordination'))
        config['work_dir'] = str(legacy_work.with_name('price-checker-' + provider + '-backup'))
        super().__init__(config)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=base.DEFAULT_CONFIG)
    parser.add_argument('--store', required=True, choices=tuple(base.STORES))
    commands = parser.add_subparsers(dest='command', required=True)
    run = commands.add_parser('run')
    run.add_argument('--force', action='store_true')
    run.add_argument('--verify', action='store_true')
    commands.add_parser('status')
    verify = commands.add_parser('verify')
    verify.add_argument('snapshot')
    restore = commands.add_parser('restore')
    restore.add_argument('snapshot')
    restore.add_argument('--target', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        backup = StoreBackup(base.load_config(args.config), args.store)
        if args.command == 'run':
            result = backup.run(args.force, args.verify)
        elif args.command == 'status':
            result = backup.state
        else:
            with backup.lock():
                result = backup.audit_verify(args.snapshot) if args.command == 'verify' else backup.restore(args.snapshot, args.target)
        print(json.dumps(result))
    except (base.BackupError, OSError, sqlite3.Error, ValueError) as error:
        message = str(error) if isinstance(error, base.BackupError) else type(error).__name__
        print(json.dumps({'status': 'error', 'error': message}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
