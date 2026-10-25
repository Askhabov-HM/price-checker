#!/usr/bin/env python3
"""Prepare a private, independent Lamoda route and verify its Russian exit."""
import argparse
import copy
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time

ENDPOINT = 'http://127.0.0.1:17892'


class ProxyError(Exception):
    pass


def build_config(document, alias):
    if not isinstance(alias, str) or not re.fullmatch(r'eos-[a-f0-9]{12}', alias):
        raise ProxyError('Invalid node alias')
    nodes = document.get('proxies') if isinstance(document, dict) else None
    if not isinstance(nodes, list):
        raise ProxyError('Missing provider nodes')
    matches = [node for node in nodes if isinstance(node, dict) and node.get('name') == alias]
    if len(matches) != 1:
        raise ProxyError('Expected one matching provider node')
    node = matches[0]
    if node.get('type') not in ('vless', 'vmess', 'trojan', 'ss', 'ssr', 'hysteria2', 'tuic') or not node.get('server'):
        raise ProxyError('Expected a remote VPN node')
    return single_node_config(node, alias)


def single_node_config(node, alias):
    return {'mixed-port': 17892, 'bind-address': '127.0.0.1', 'allow-lan': False,
            'mode': 'rule', 'log-level': 'warning', 'ipv6': False,
            'proxies': [copy.deepcopy(node)], 'rules': ['MATCH,' + alias]}


def build_wasp_config(catalog, alias):
    if not isinstance(alias, str) or not re.fullmatch(r'wasp-[a-f0-9]{12}', alias):
        raise ProxyError('Invalid WASP node ID')
    entries = catalog.get('nodes') if isinstance(catalog, dict) and catalog.get('version') == 1 else None
    if not isinstance(entries, list) or len(entries) > 1000:
        raise ProxyError('Invalid private VPN catalog')
    matches = [entry for entry in entries if isinstance(entry, dict) and entry.get('id') == alias
               and entry.get('provider') == 'wasp']
    if len(matches) != 1:
        raise ProxyError('Expected one WASP node')
    profile = matches[0].get('profile')
    if not isinstance(profile, dict) or profile.get('type') not in ('vless', 'vmess', 'trojan', 'ss', 'ssr', 'hysteria2', 'tuic'):
        raise ProxyError('Invalid WASP profile')
    server, port = profile.get('server'), profile.get('port')
    if (not isinstance(server, str) or not re.fullmatch(r'[A-Za-z0-9.:-]{1,253}', server)
            or isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535):
        raise ProxyError('Invalid WASP endpoint')
    try:
        address = ipaddress.ip_address(server)
    except ValueError:
        if not re.fullmatch(r'(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}', server):
            raise ProxyError('Invalid WASP hostname') from None
        addresses = sorted({row[4][0] for row in socket.getaddrinfo(server, port, socket.AF_INET, socket.SOCK_STREAM)})
        if not addresses:
            raise ProxyError('WASP hostname has no IPv4 address')
        address = ipaddress.ip_address(addresses[0])
    if address.version != 4 or not address.is_global:
        raise ProxyError('WASP node needs a public IPv4 endpoint')
    node = copy.deepcopy(profile)
    node['server'] = str(address)
    if node.get('tls') and not node.get('servername'):
        node['servername'] = server
    node['name'] = alias
    return single_node_config(node, alias)


def prepare(provider, alias, destination):
    source = Path(provider)
    if source.is_symlink() or not source.is_file() or source.stat().st_size > 5 * 1024 * 1024:
        raise ProxyError('Missing or redirected private provider')
    if alias.startswith('wasp-'):
        stat = source.stat()
        if os.name == 'posix' and (stat.st_uid != os.geteuid() or stat.st_mode & 0o077):
            raise ProxyError('Private VPN catalog has unsafe permissions')
        config = build_wasp_config(json.loads(source.read_text(encoding='utf-8')), alias)
    else:
        import yaml  # Server dependency only; unit checks do not need PyYAML.
        try:
            document = yaml.safe_load(source.read_text(encoding='utf-8'))
        except yaml.YAMLError:
            raise ProxyError('Cannot parse private provider') from None
        config = build_config(document, alias)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
        json.dump(config, output)


def wait_for_proxy():
    for _ in range(50):
        try:
            with socket.create_connection(('127.0.0.1', 17892), timeout=0.2):
                return
        except OSError:
            time.sleep(0.1)
    raise ProxyError('Lamoda proxy did not start; browser route preserved')


def verify_route():
    wait_for_proxy()
    addresses = []
    for url in ('https://ipinfo.io/json', 'https://ipwho.is/'):
        try:
            response = subprocess.run(
                ['/usr/bin/curl', '--disable', '--proxy', ENDPOINT, '--noproxy', '',
                 '--silent', '--show-error', '--fail', '--connect-timeout', '8',
                 '--max-time', '16', url], capture_output=True, text=True, timeout=20)
            data = json.loads(response.stdout) if response.returncode == 0 else {}
            if not isinstance(data, dict) or data.get('country_code', data.get('country')) != 'RU':
                raise ProxyError('Russian exit was not confirmed; browser route preserved')
            if not isinstance(data.get('ip'), str):
                raise ProxyError('Missing public exit address; browser route preserved')
            addresses.append(str(ipaddress.ip_address(data['ip'])))
        except (ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            raise ProxyError('Russian exit check failed; browser route preserved') from error
    return addresses


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    create = commands.add_parser('prepare')
    create.add_argument('provider')
    create.add_argument('alias')
    create.add_argument('destination')
    commands.add_parser('verify')
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            prepare(args.provider, args.alias, args.destination)
        else:
            print('Russian Lamoda exit confirmed: ' + ', '.join(verify_route()))
    except (ProxyError, OSError, ImportError, ValueError):
        # Provider/parser/curl errors may contain private connection parameters.
        parser.exit(1, 'Lamoda proxy preparation or Russian exit verification failed.\n')


if __name__ == '__main__':
    main()
