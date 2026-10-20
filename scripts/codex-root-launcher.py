#!/usr/bin/env python3
"""Forced SSH command: run Codex as root and verify Git before completion."""

import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import uuid

ROOT = Path('/opt/price-checker/repository')
STATE = Path('/var/lib/price-checker-codex')
CODEX_HOME = Path('/var/lib/price-checker/.codex')
BINARY = '/opt/price-checker-tools/codex/bin/codex'
GUARD = '/usr/local/lib/price-checker/codex-git-guard.py'


def arguments(command):
    if not re.fullmatch(r'codex-v1 [A-Za-z0-9_-]{1,100000}={0,2}', command):
        raise ValueError('Unsupported invocation')
    args = json.loads(base64.urlsafe_b64decode(command.split(' ', 1)[1]))
    if args == ['--version']:
        return args
    if not isinstance(args, list) or not args or args[0] != 'exec' or args[-1] != '-':
        raise ValueError('Only codex exec is allowed')
    if any(not isinstance(arg, str) or len(arg) > 20000 or '\0' in arg for arg in args) or len(args) > 100:
        raise ValueError('Invalid arguments')
    # These are the only transport options accepted from CodexRunner.
    flags = {'--strict-config', '--json', '--dangerously-bypass-hook-trust'}
    settings = {'sandbox_mode', 'approval_policy', 'web_search', 'developer_instructions',
                'features.shell_tool', 'features.apps', 'features.plugins', 'features.hooks',
                'features.multi_agent', 'features.browser_use', 'features.computer_use',
                'features.image_generation', 'features.view_image'}
    index = 1
    while index < len(args) - 1:
        arg = args[index]
        if arg in flags:
            index += 1
        elif arg == '--cd' and index + 1 < len(args) and args[index + 1] == str(ROOT):
            index += 2
        elif arg == '-c' and index + 1 < len(args) and args[index + 1].split('=', 1)[0] in settings:
            setting = args[index + 1]
            if setting.startswith('features.hooks=') and setting != 'features.hooks=true':
                raise ValueError('The completion hook is mandatory')
            index += 2
        elif arg == 'resume' and index == len(args) - 3 and re.fullmatch(r'[0-9a-fA-F-]{36}', args[index + 1]):
            index += 2
        else:
            raise ValueError('Unsupported transport option')
    if '--cd' not in args or '--json' not in args:
        raise ValueError('Missing transport options')
    return args


def environment():
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(STATE),
           'CODEX_HOME': str(CODEX_HOME), 'LANG': 'ru_RU.UTF-8', 'TZ': 'Europe/Moscow'}
    allowed = {'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
               'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'}
    for line in Path('/etc/price-checker-proxy.env').read_text().splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            if key in allowed:
                env[key] = value
    return env


def failed():
    print(json.dumps({'type': 'turn.failed', 'error': {'message': 'git_delivery_not_verified'}}), flush=True)


def main():
    if os.geteuid() != 0:
        raise ValueError('Root launcher required')
    args = arguments(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    env = environment()
    os.umask(0o077)
    if args == ['--version']:
        os.execve(BINARY, [BINARY, *args], env)
    os.chdir(ROOT)
    spec = importlib.util.spec_from_file_location('codex_guard', GUARD)
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    directory = STATE / 'git-checks'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    baseline = directory / (str(uuid.uuid4()) + '.json')
    try:
        baseline.write_text(json.dumps(guard.snapshot(ROOT)) + '\n')
        baseline.chmod(0o600)
    except guard.DeliveryError as error:
        baseline.with_suffix('.result.json').write_text(json.dumps({'verified': False, 'reason': str(error)}) + '\n')
        failed()
        return 3
    env['PRICE_CHECKER_CODEX_GIT_BASELINE'] = str(baseline)
    child = subprocess.Popen([BINARY, *args], stdin=sys.stdin, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, env=env, text=True, start_new_session=True)

    def stop(signum, frame):
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        raise SystemExit(128 + signum)

    for name in [signal.SIGHUP, signal.SIGTERM, signal.SIGINT, signal.SIGALRM]:
        signal.signal(name, stop)
    signal.alarm(2700)
    completion = None
    try:
        for line in child.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                child.terminate()
                return 2
            if event.get('type') == 'turn.completed':
                completion = line
            else:
                sys.stdout.write(line)
                sys.stdout.flush()
        code = child.wait()
        if code or completion is None:
            return code or 2
        if not guard.audit(baseline)['verified']:
            failed()
            return 3
        sys.stdout.write(completion)
        sys.stdout.flush()
        return 0
    finally:
        signal.alarm(0)
        if child.poll() is None:
            stop(signal.SIGTERM, None)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError):
        # Prompts, authentication data and CLI stderr must not enter system logs.
        sys.exit(2)
