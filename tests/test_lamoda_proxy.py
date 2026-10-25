import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('lamoda_proxy_config', Path(__file__).resolve().parents[1] / 'scripts' / 'lamoda-proxy-config.py')
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class LamodaProxyTests(unittest.TestCase):
    def setUp(self):
        self.alias = 'eos-000000000001'
        self.node = {'name': self.alias, 'type': 'vless', 'server': 'synthetic.invalid',
                     'port': 443, 'uuid': 'synthetic-private-value'}

    def test_selected_node_is_isolated_without_auto_selection_or_direct_fallback(self):
        document = {'proxies': [self.node, {**self.node, 'name': 'eos-000000000002'}],
                    'rules': ['MATCH,DIRECT'], 'mixed-port': 17891}
        previous = copy.deepcopy(document)
        config = proxy.build_config(document, self.alias)
        self.assertEqual(config['proxies'], [self.node])
        self.assertEqual(config['rules'], ['MATCH,' + self.alias])
        self.assertEqual(config['mixed-port'], 17892)
        self.assertEqual(config['bind-address'], '127.0.0.1')
        self.assertFalse(config['allow-lan'])
        self.assertEqual(document, previous)
        config['proxies'][0]['server'] = 'changed.invalid'
        self.assertEqual(document, previous)

    def test_missing_ambiguous_or_non_vpn_nodes_are_rejected(self):
        for document, alias in [({}, self.alias), ({'proxies': []}, self.alias),
                                ({'proxies': [self.node, self.node]}, self.alias),
                                ({'proxies': [{**self.node, 'type': 'direct'}]}, self.alias),
                                ({'proxies': [self.node]}, 'DIRECT'),
                                ({'proxies': [self.node]}, self.alias + ',DIRECT')]:
            with self.subTest(alias=alias), self.assertRaises(proxy.ProxyError):
                proxy.build_config(document, alias)

    def test_wasp_node_uses_only_its_own_profile_and_pins_dns_without_changing_tls_identity(self):
        alias = 'wasp-000000000001'
        profile = {**self.node, 'name': 'Synthetic WASP', 'server': 'node.example.com', 'tls': True}
        catalog = {'version': 1, 'nodes': [
            {'id': alias, 'provider': 'wasp', 'profile': profile},
            {'id': 'un1-000000000001', 'provider': 'un1', 'profile': self.node},
        ]}
        previous = copy.deepcopy(catalog)
        with patch.object(proxy.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('1.1.1.1', 443))]):
            config = proxy.build_wasp_config(catalog, alias)
        self.assertEqual(config['proxies'], [{**profile, 'name': alias, 'server': '1.1.1.1', 'servername': 'node.example.com'}])
        self.assertEqual(config['rules'], ['MATCH,' + alias])
        self.assertEqual(config['mixed-port'], 17892)
        self.assertEqual(catalog, previous)

    def test_wasp_selection_rejects_wrong_provider_duplicates_and_private_endpoints(self):
        alias = 'wasp-000000000001'
        entry = {'id': alias, 'provider': 'wasp', 'profile': {**self.node, 'server': '1.1.1.1'}}
        for catalog in ({'version': 1, 'nodes': [{**entry, 'provider': 'un1'}]},
                        {'version': 1, 'nodes': [entry, entry]},
                        {'version': 1, 'nodes': [{**entry, 'profile': {**self.node, 'server': '127.0.0.1'}}]}):
            with self.subTest(catalog=catalog), self.assertRaises(proxy.ProxyError):
                proxy.build_wasp_config(catalog, alias)

    def test_private_wasp_catalog_is_loaded_without_exposing_credentials(self):
        alias = 'wasp-000000000001'
        profile = {**self.node, 'name': 'Synthetic WASP', 'server': '1.1.1.1'}
        with tempfile.TemporaryDirectory() as directory:
            source, destination = Path(directory) / 'catalog.json', Path(directory) / 'candidate.json'
            source.write_text(json.dumps({'version': 1, 'nodes': [{'id': alias, 'provider': 'wasp', 'profile': profile}]}))
            if os.name == 'posix':
                source.chmod(0o600)
            proxy.prepare(source, alias, destination)
            self.assertEqual(json.loads(destination.read_text())['proxies'][0]['uuid'], 'synthetic-private-value')
            if os.name == 'posix':
                self.assertEqual(destination.stat().st_mode & 0o777, 0o600)

    def response(self, data, returncode=0):
        return subprocess.CompletedProcess([], returncode, json.dumps(data), '')

    def test_private_configuration_is_created_without_overwriting_an_existing_file(self):
        yaml = SimpleNamespace(safe_load=json.loads, YAMLError=ValueError)
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, {'yaml': yaml}):
            source, destination = Path(directory) / 'provider', Path(directory) / 'candidate'
            source.write_text(json.dumps({'proxies': [self.node]}), encoding='utf-8')
            proxy.prepare(source, self.alias, destination)
            self.assertEqual(json.loads(destination.read_text())['proxies'], [self.node])
            if os.name != 'nt':
                self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            destination.write_text('preserve-existing')
            with self.assertRaises(FileExistsError):
                proxy.prepare(source, self.alias, destination)
            self.assertEqual(destination.read_text(), 'preserve-existing')

    def test_provider_parse_failure_does_not_print_private_content(self):
        def fail(document):
            raise ValueError(document)
        yaml = SimpleNamespace(safe_load=fail, YAMLError=ValueError)
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, {'yaml': yaml}):
            source = Path(directory) / 'provider'
            source.write_text('synthetic-private-provider-content')
            with patch.object(sys, 'argv', ['proxy', 'prepare', str(source), self.alias, str(source) + '.candidate']):
                with patch.object(sys, 'stderr', new_callable=io.StringIO) as output:
                    with self.assertRaises(SystemExit) as error:
                        proxy.main()
            self.assertEqual(error.exception.code, 1)
            self.assertNotIn('synthetic-private-provider-content', output.getvalue())
            self.assertFalse(Path(str(source) + '.candidate').exists())

    @patch.object(proxy, 'wait_for_proxy')
    def test_russian_exit_requires_both_checks_through_the_lamoda_endpoint(self, wait):
        responses = [self.response({'ip': '192.0.2.1', 'country': 'RU'}),
                     self.response({'ip': '2001:db8::1', 'country_code': 'RU'})]
        with patch.object(proxy.subprocess, 'run', side_effect=responses) as run:
            self.assertEqual(proxy.verify_route(), ['192.0.2.1', '2001:db8::1'])
        wait.assert_called_once()
        self.assertEqual(run.call_count, 2)
        for call in run.call_args_list:
            arguments = call.args[0]
            self.assertEqual(arguments[arguments.index('--proxy') + 1], 'http://127.0.0.1:17892')
            self.assertEqual(arguments[arguments.index('--noproxy') + 1], '')

    @patch.object(proxy, 'wait_for_proxy')
    def test_foreign_ambiguous_or_failed_exit_checks_do_not_confirm_the_route(self, wait):
        russian = self.response({'ip': '192.0.2.1', 'country': 'RU'})
        for bad in [self.response({'ip': '192.0.2.1', 'country_code': 'DE'}),
                    self.response({'ip': '192.0.2.1'}), self.response([]),
                    self.response({'ip': 'invalid', 'country': 'RU'}),
                    self.response({'ip': 1, 'country': 'RU'}),
                    self.response({}, returncode=35)]:
            with self.subTest(response=bad.stdout):
                with patch.object(proxy.subprocess, 'run', side_effect=[russian, bad]):
                    with self.assertRaises(proxy.ProxyError):
                        proxy.verify_route()
        with patch.object(proxy.subprocess, 'run', side_effect=subprocess.TimeoutExpired('curl', 20)):
            with self.assertRaises(proxy.ProxyError):
                proxy.verify_route()


if __name__ == '__main__':
    unittest.main()
