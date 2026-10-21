#!/usr/bin/env python3
"""Read-only host/service measurements; never launches Chrome or a collection."""
import argparse
import json
from pathlib import Path
import subprocess
import time

UNITS = ('price-checker.service', 'price-checker-ozon-recovery.service', 'price-checker-lamoda-browser.service')


def sample():
    memory = {line.split(':')[0]: int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines() if line.split()[1].isdigit()}
    units = {}
    for unit in UNITS:
        output = subprocess.run(['systemctl', 'show', unit, '--property=ActiveState,MemoryCurrent,MemoryPeak,CPUUsageNSec,IOReadBytes,IOWriteBytes'],
                                capture_output=True, text=True, timeout=10, check=False)
        units[unit] = dict(line.split('=', 1) for line in output.stdout.splitlines() if '=' in line)
    return {'monotonic': time.monotonic(), 'available_mib': round(memory['MemAvailable'] / 1024, 1),
            'swap_used_mib': round((memory['SwapTotal'] - memory['SwapFree']) / 1024, 1), 'services': units}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=int, choices=range(1, 61), default=10)
    args = parser.parse_args()
    before = sample()
    time.sleep(args.seconds)
    after = sample()
    for unit, values in after['services'].items():
        old = before['services'][unit]
        start, end = old.get('CPUUsageNSec', ''), values.get('CPUUsageNSec', '')
        if start.isdigit() and end.isdigit() and int(end) >= int(start):
            values['cpu_percent'] = round((int(end) - int(start)) / 1e7 / (after['monotonic'] - before['monotonic']), 2)
    print(json.dumps({'before': before, 'after': after}, indent=2))


if __name__ == '__main__':
    main()
