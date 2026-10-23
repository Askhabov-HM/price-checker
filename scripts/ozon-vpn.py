#!/usr/bin/env python3
"""Manage private UN1/WASP nodes; probe neutral endpoints and switch Ozon on request."""
import argparse
import base64
import copy
from datetime import datetime, timezone
import hashlib
import html
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import signal
import socket
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

BASE = Path('/etc/price-checker-ozon-proxy')
MAX_BYTES = 5 * 1024 * 1024
PROVIDERS = ('un1', 'wasp')
spec = importlib.util.spec_from_file_location('ozon_proxy_config', Path(__file__).with_name('ozon-proxy-config.py'))
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class CatalogError(Exception):
    pass


def stamp():
    return datetime.now(timezone.utc).isoformat()


def read_private(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise CatalogError('Private VPN configuration is missing or invalid.')
    if os.name == 'posix' and (path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o077):
        raise CatalogError('Private VPN files must belong to root with mode 0600.')
    return json.loads(path.read_text(encoding='utf-8'))


def write_private(path, value):
    if path.is_symlink():
        raise CatalogError('Refusing a symlink for private VPN data.')
    descriptor, temporary = tempfile.mkstemp(prefix='.vpn-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def download(url, headers):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise CatalogError('A private HTTPS subscription URL is required.')
    # The server Codex uses a separate proxy for its own API; subscriptions must
    # not depend on that route or inherit the store's selected VPN.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(urllib.request.Request(url, headers=headers), timeout=20) as response:
        content = response.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise CatalogError('Subscription response is too large.')
    return content.decode('utf-8-sig')


def panel_endpoint(page):
    match = re.search(r'data-panel=[\"\x27]([^\"\x27]+)', page)
    if not match:
        raise CatalogError('WASP did not provide subscription metadata.')
    value = html.unescape(match.group(1))
    for _ in range(5):
        try:
            document = json.loads(value)
            if isinstance(document, dict):
                response = document.get('response', document)
                if isinstance(response, dict) and isinstance(response.get('subscriptionUrl'), str):
                    return response['subscriptionUrl']
                break
        except ValueError:
            pass
        value = base64.b64decode(value + '=' * (-len(value) % 4), validate=True).decode('utf-8')
    raise CatalogError('WASP subscription metadata is invalid.')


def catalog_entries(provider, document):
    nodes = document.get('proxies') if isinstance(document, dict) else None
    if not isinstance(nodes, list) or not nodes or len(nodes) > 1000:
        raise CatalogError('Subscription has no supported profiles.')
    entries, identities = [], set()
    for index, node in enumerate(nodes, 1):
        if not isinstance(node, dict) or node.get('type') not in ('vless', 'vmess', 'trojan', 'ss', 'ssr', 'hysteria2', 'tuic'):
            raise CatalogError('Subscription contains an unsupported profile.')
        server, port = node.get('server'), node.get('port')
        if not isinstance(server, str) or not re.fullmatch(r'[A-Za-z0-9.:-]{1,253}', server):
            raise CatalogError('Invalid subscription endpoint.')
        try:
            if not ipaddress.ip_address(server).is_global:
                raise CatalogError('Subscription contains a placeholder or private endpoint.')
        except ValueError:
            if not re.fullmatch(r'(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}', server):
                raise CatalogError('Invalid subscription hostname.')
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise CatalogError('Invalid subscription port.')
        identity = {key: value for key, value in node.items() if key != 'name'}
        digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:12]
        identifier = provider + '-' + digest
        if identifier in identities:
            raise CatalogError('Subscription contains duplicate profiles.')
        identities.add(identifier)
        entries.append({'id': identifier, 'provider': provider, 'index': index, 'profile': copy.deepcopy(node)})
    return entries


def fetch_provider(name, source):
    import yaml
    headers = {'User-Agent': 'mihomo', 'Accept': 'application/yaml,*/*'}
    url = source['url']
    if name == 'wasp':
        machine = Path('/etc/machine-id').read_text().strip()
        headers.update({'x-hwid': hashlib.sha256(('price-checker:wasp-vpn:' + machine).encode()).hexdigest(),
                        'x-device-os': 'Linux', 'x-ver-os': platform.release(), 'x-device-model': 'Price Checker server'})
        page = download(url, {'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html'})
        url = panel_endpoint(page)
    return catalog_entries(name, yaml.safe_load(download(url, headers)))


def refresh(base, provider=None):
    sources = read_private(base / 'subscriptions.json')
    cache = base / 'catalog.json'
    current = read_private(cache) if cache.exists() else {'version': 1, 'nodes': []}
    selected = [provider] if provider else list(PROVIDERS)
    replacement = []
    # Publish only after every selected provider succeeds; preserve the old cache on failure.
    for name in selected:
        replacement.extend(fetch_provider(name, sources[name]))
    kept = [entry for entry in current['nodes'] if entry['provider'] not in selected]
    result = {'version': 1, 'refreshed_at': stamp(), 'nodes': kept + replacement}
    write_private(cache, result)
    return result


def select(catalog, selector):
    matches = [entry for entry in catalog['nodes'] if selector in (entry['id'], f"{entry['provider']}:{entry['index']}")]
    if len(matches) != 1:
        raise CatalogError('Node not found; run list and choose an exact ID or provider:index.')
    return matches[0]


def public_entry(entry):
    profile = entry['profile']
    return {'id': entry['id'], 'selector': f"{entry['provider']}:{entry['index']}",
            'name': str(profile.get('name', ''))[:256], 'type': profile['type'],
            'server': profile['server'], 'port': profile['port'], 'last_check': entry.get('last_check')}


def pin_profile(entry):
    node = copy.deepcopy(entry['profile'])
    original = node['server']
    try:
        address = ipaddress.ip_address(original)
    except ValueError:
        addresses = sorted({row[4][0] for row in socket.getaddrinfo(original, node['port'], socket.AF_INET, socket.SOCK_STREAM)})
        if not addresses:
            raise CatalogError('No IPv4 address for the selected node.')
        address = ipaddress.ip_address(addresses[0])
        if node.get('tls') and not node.get('servername'):
            node['servername'] = original
    if address.version != 4 or not address.is_global:
        raise CatalogError('Selected node needs a public IPv4 endpoint.')
    node['server'] = str(address)
    return node


def probe(node):
    config = proxy.build_config({'proxies': [node]}, node['server'])
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    config['mixed-port'] = port
    with tempfile.TemporaryDirectory(prefix='price-checker-vpn-', dir='/run') as temporary:
        directory = Path(temporary)
        path = directory / 'config.json'
        write_private(path, config)
        validation = subprocess.run(['/usr/local/bin/mihomo', '-t', '-d', str(directory), '-f', str(path)],
                                    capture_output=True, timeout=20)
        if validation.returncode:
            raise CatalogError('Private Mihomo configuration did not pass validation.')
        with (directory / 'proxy.log').open('w') as log:
            process = subprocess.Popen(['/usr/local/bin/mihomo', '-d', str(directory), '-f', str(path)], stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise CatalogError('Temporary proxy failed to start.')
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                            break
                    except OSError:
                        time.sleep(0.1)
                else:
                    raise CatalogError('Temporary proxy did not become ready.')
                return proxy.verify(proxy=f'http://127.0.0.1:{port}', country=None)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def operate(base, selector, switch=False):
    catalog = read_private(base / 'catalog.json')
    entry = select(catalog, selector)
    node = pin_profile(entry)
    try:
        result = probe(node)
    except Exception:
        entry['last_check'] = {'ok': False, 'checked_at': stamp()}
        write_private(base / 'catalog.json', catalog)
        raise
    entry['last_check'] = {'ok': True, 'checked_at': stamp(), 'server_ipv4': node['server'], **result}
    write_private(base / 'catalog.json', catalog)
    print(json.dumps({'node': public_entry(entry), 'switched': False}), flush=True)
    if switch:
        with tempfile.TemporaryDirectory(prefix='price-checker-vpn-switch-', dir='/run') as temporary:
            profile = Path(temporary) / 'profile.json'
            write_private(profile, {'proxies': [node]})
            process = subprocess.Popen(['/bin/bash', str(Path(__file__).with_name('setup-ozon-proxy.sh')), str(profile), node['server'], result['country']], start_new_session=True)
            try:
                if process.wait():
                    raise CatalogError('VPN installer failed; inspect the current route with list.')
            except BaseException:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=50)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)
                raise
        print(json.dumps({'node_id': entry['id'], 'switched': True, **result}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('list', 'refresh'):
        commands.add_parser(command).add_argument('provider', nargs='?', choices=PROVIDERS)
    for command in ('check', 'switch'):
        commands.add_parser(command).add_argument('node')
    args = parser.parse_args()
    try:
        if os.geteuid() != 0:
            raise CatalogError('Run as root on the Price Checker server.')
        os.umask(0o077)
        if BASE.is_symlink() or not BASE.is_dir():
            raise CatalogError('Private Ozon proxy directory is missing.')
        if args.command == 'list':
            catalog = read_private(BASE / 'catalog.json')
            active_path = BASE / 'config.json'
            if active_path.is_symlink() or not active_path.is_file() or active_path.stat().st_size > MAX_BYTES:
                raise CatalogError('Active VPN configuration is missing or invalid.')
            active = json.loads(active_path.read_text())
            print(json.dumps({'active_server': active['proxies'][0]['server'], 'refreshed_at': catalog.get('refreshed_at'),
                              'nodes': [public_entry(entry) for entry in catalog['nodes'] if not args.provider or entry['provider'] == args.provider]}))
            return
        import fcntl
        lock = BASE / 'catalog.lock'
        if lock.is_symlink():
            raise CatalogError('Invalid VPN catalog lock.')
        with lock.open('a') as lease:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.command == 'refresh':
                catalog = refresh(BASE, args.provider)
                print(json.dumps({'refreshed': True, 'providers': {name: sum(entry['provider'] == name for entry in catalog['nodes']) for name in PROVIDERS}}))
            else:
                operate(BASE, args.node, switch=args.command == 'switch')
    except CatalogError as error:
        parser.exit(1, str(error) + '\n')
    except KeyboardInterrupt:
        parser.exit(130, 'VPN operation interrupted.\n')
    except Exception:
        parser.exit(1, 'VPN operation failed; inspect the current route with list. Private details omitted.\n')


if __name__ == '__main__':
    def interrupted(*_):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    main()
