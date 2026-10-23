#!/usr/bin/env python3
"""Select one private VPN profile for the dedicated Ozon proxy."""
import argparse
import copy
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess


class ProxyError(Exception):
    pass


def build_config(document, server):
    nodes = document.get('proxies') if isinstance(document, dict) else None
    if not isinstance(nodes, list):
        raise ProxyError('Missing provider profiles')
    matches = [node for node in nodes if isinstance(node, dict) and node.get('server') == server]
    if len(matches) != 1:
        raise ProxyError('Expected exactly one matching VPN profile')
    node = copy.deepcopy(matches[0])
    if node.get('type') not in ('vless', 'vmess', 'trojan', 'ss', 'ssr', 'hysteria2', 'tuic'):
        raise ProxyError('Unsupported VPN profile')
    if not isinstance(node.get('port'), int) or isinstance(node['port'], bool) or not 1 <= node['port'] <= 65535:
        raise ProxyError('Invalid VPN port')
    try:
        if not ipaddress.ip_address(server).is_global:
            raise ProxyError('Expected a public VPN address')
    except ValueError:
        raise ProxyError('Expected a public VPN IP') from None
    node['name'] = 'ozon-fixed'
    return {'mixed-port': 17891, 'bind-address': '127.0.0.1', 'allow-lan': False,
            'mode': 'rule', 'log-level': 'warning', 'ipv6': False,
            'tun': {'enable': False}, 'proxies': [node], 'rules': ['MATCH,ozon-fixed']}


def prepare(provider, server, destination):
    import yaml
    source = Path(provider)
    if source.is_symlink() or not source.is_file() or source.stat().st_size > 5 * 1024 * 1024:
        raise ProxyError('Invalid private provider file')
    try:
        document = yaml.safe_load(source.read_text(encoding='utf-8'))
    except yaml.YAMLError:
        raise ProxyError('Cannot parse private provider file') from None
    config = build_config(document, server)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
        json.dump(config, output)


def verify(proxy='http://127.0.0.1:17891', country='KZ'):
    def request(url):
        response = subprocess.run(['/usr/bin/curl', '--disable', '--proxy', proxy,
                                   '--noproxy', '', '--silent', '--show-error', '--fail',
                                   '--connect-timeout', '6', '--max-time', '12', url],
                                  capture_output=True, text=True, timeout=15)
        if response.returncode:
            raise ProxyError('VPN HTTPS request failed')
        data = json.loads(response.stdout)
        if not isinstance(data, dict):
            raise ProxyError('Invalid VPN verification response')
        return data
    data = request('https://api.ipify.org?format=json')
    address = ipaddress.ip_address(data.get('ip', ''))
    if address.version != 4 or not address.is_global:
        raise ProxyError('Invalid VPN exit IP')
    location = request('https://ipwho.is/'+str(address))
    code = location.get('country_code')
    if location.get('success') is False or location.get('ip') != str(address) or not isinstance(code, str) or not re.fullmatch('[A-Z]{2}', code):
        raise ProxyError('VPN exit country was not confirmed')
    if country is not None and code != country:
        raise ProxyError('Expected VPN exit country was not confirmed')
    return {'https': True, 'exit_ipv4': str(address), 'country': code}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    create = commands.add_parser('prepare')
    create.add_argument('provider')
    create.add_argument('server')
    create.add_argument('destination')
    check = commands.add_parser('verify')
    check.add_argument('--country', default='KZ')
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            prepare(args.provider, args.server, args.destination)
        else:
            if args.country != 'ANY' and not re.fullmatch('[A-Z]{2}', args.country):
                raise ProxyError('Expected an ISO country code or ANY')
            print(json.dumps(verify(country=None if args.country == 'ANY' else args.country)))
    except (ProxyError, OSError, ImportError, ValueError, TypeError, subprocess.SubprocessError):
        parser.exit(1, 'Ozon VPN preparation or HTTPS verification failed; private details omitted.\n')


if __name__ == '__main__':
    main()
