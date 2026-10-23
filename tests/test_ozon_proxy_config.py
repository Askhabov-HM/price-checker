import copy
import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location('ozon_proxy_config', Path(__file__).resolve().parents[1] / 'scripts/ozon-proxy-config.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class OzonProxyConfigTests(unittest.TestCase):
    def setUp(self):
        self.node = {'name': 'Synthetic Kazakhstan', 'type': 'vless', 'server': '95.56.251.12',
                     'port': 443, 'uuid': 'synthetic-identity', 'tls': True,
                     'servername': 'synthetic.example', 'client-fingerprint': 'chrome',
                     'reality-opts': {'public-key': 'synthetic-public-key', 'short-id': '01234567'}}

    def test_selects_the_complete_profile_without_provider_routes_or_direct_fallback(self):
        source = {'proxies': [self.node, {**self.node, 'server': '1.1.1.1'}],
                  'tun': {'enable': True}, 'rules': ['MATCH,DIRECT'], 'external-controller': ':9090'}
        before = copy.deepcopy(source)
        result = helper.build_config(source, '95.56.251.12')
        selected = result['proxies'][0]
        self.assertEqual({k: v for k, v in selected.items() if k != 'name'},
                         {k: v for k, v in self.node.items() if k != 'name'})
        self.assertEqual(result['rules'], ['MATCH,ozon-fixed'])
        self.assertEqual(result['mixed-port'], 17891)
        self.assertEqual(result['bind-address'], '127.0.0.1')
        self.assertFalse(result['allow-lan'])
        self.assertFalse(result['tun']['enable'])
        self.assertNotIn('external-controller', result)
        self.assertEqual(source, before)

    def test_rejects_missing_or_ambiguous_profiles(self):
        for nodes in [[], [self.node, self.node]]:
            with self.subTest(count=len(nodes)), self.assertRaises(helper.ProxyError):
                helper.build_config({'proxies': nodes}, '95.56.251.12')

    def test_rejects_placeholder_addresses_invalid_ports_and_unsupported_types(self):
        for change in [{'server': '0.0.0.0'}, {'server': '127.0.0.1'}, {'server': 'not-an-ip'},
                       {'port': 0}, {'port': True}, {'port': 65536}, {'type': 'direct'}]:
            node = {**self.node, **change}
            with self.subTest(change=change), self.assertRaises(helper.ProxyError):
                helper.build_config({'proxies': [node]}, node['server'])


if __name__ == '__main__':
    unittest.main()
