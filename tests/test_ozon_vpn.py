import base64
import copy
import importlib.util
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('ozon_vpn', Path(__file__).resolve().parents[1] / 'scripts/ozon-vpn.py')
vpn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vpn)


class VpnCatalogTests(unittest.TestCase):
    def setUp(self):
        self.profile = {'name': 'Synthetic Kazakhstan', 'type': 'vless', 'server': 'node.example.com',
                        'port': 443, 'uuid': 'synthetic-private-identity', 'tls': True,
                        'reality-opts': {'public-key': 'synthetic-key', 'short-id': '01234567'}}

    def entries(self, count=1):
        return vpn.catalog_entries('un1', {'proxies': [{**self.profile, 'server': f'node{i}.example.com'} for i in range(count)]})

    def test_keeps_all_profiles_but_public_list_has_no_credentials(self):
        entries = self.entries(5)
        self.assertEqual(len(entries), 5)
        self.assertEqual(entries[-1]['index'], 5)
        self.assertEqual(entries[-1]['profile']['uuid'], self.profile['uuid'])
        output = json.dumps([vpn.public_entry(entry) for entry in entries])
        self.assertNotIn(self.profile['uuid'], output)
        self.assertNotIn('synthetic-key', output)

    def test_ids_survive_display_name_changes_and_exact_selection_is_required(self):
        entry = self.entries()[0]
        changed = {**entry['profile'], 'name': 'Renamed'}
        self.assertEqual(vpn.catalog_entries('un1', {'proxies': [changed]})[0]['id'], entry['id'])
        catalog = {'nodes': self.entries(5)}
        self.assertEqual(vpn.select(catalog, 'un1:2')['index'], 2)
        self.assertEqual(vpn.select(catalog, catalog['nodes'][2]['id'])['index'], 3)
        for selector in ('un1', '2', 'un1:99'):
            with self.subTest(selector=selector), self.assertRaises(vpn.CatalogError):
                vpn.select(catalog, selector)

    def test_rejects_placeholders_and_preserves_tls_identity_when_pinning_dns(self):
        with self.assertRaises(vpn.CatalogError):
            vpn.catalog_entries('wasp', {'proxies': [{**self.profile, 'server': '0.0.0.0'}]})
        entry = {'profile': self.profile}
        original = copy.deepcopy(entry)
        with patch.object(vpn.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('1.1.1.1', 443))]):
            pinned = vpn.pin_profile(entry)
        self.assertEqual(pinned['server'], '1.1.1.1')
        self.assertEqual(pinned['servername'], 'node.example.com')
        self.assertEqual(pinned['reality-opts'], self.profile['reality-opts'])
        self.assertEqual(entry, original)

    def test_decodes_nested_wasp_panel_without_exposing_the_private_url(self):
        endpoint = 'https://example.com/private-placeholder'
        payload = json.dumps({'response': {'subscriptionUrl': endpoint}}).encode()
        for _ in range(2):
            payload = base64.b64encode(payload)
        self.assertEqual(vpn.panel_endpoint('<div data-panel="'+payload.decode()+'">'), endpoint)

    def test_failed_refresh_preserves_the_complete_previous_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            vpn.write_private(base / 'subscriptions.json', {'un1': {}, 'wasp': {}})
            previous = {'version': 1, 'nodes': self.entries(5)}
            vpn.write_private(base / 'catalog.json', previous)
            before = (base / 'catalog.json').read_bytes()
            with patch.object(vpn, 'fetch_provider', side_effect=[self.entries(), vpn.CatalogError('Unavailable')]):
                with self.assertRaises(vpn.CatalogError):
                    vpn.refresh(base)
            self.assertEqual((base / 'catalog.json').read_bytes(), before)

    def test_failed_probe_prevents_installation_and_records_failure(self):
        entry = self.entries()[0]
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            vpn.write_private(base / 'catalog.json', {'version': 1, 'nodes': [entry]})
            with patch.object(vpn, 'pin_profile', return_value=self.profile), patch.object(vpn, 'probe', side_effect=vpn.CatalogError('Unavailable')), patch.object(vpn.subprocess, 'Popen') as installer:
                with self.assertRaises(vpn.CatalogError):
                    vpn.operate(base, entry['id'], switch=True)
            installer.assert_not_called()
            self.assertFalse(vpn.read_private(base / 'catalog.json')['nodes'][0]['last_check']['ok'])

    def test_failed_https_probe_stops_temporary_proxy_and_removes_private_files(self):
        entry = {'profile': {**self.profile, 'server': '1.1.1.1'}}
        process = Mock()
        process.poll.return_value = None
        node = vpn.pin_profile(entry)
        real_directory = tempfile.TemporaryDirectory
        with tempfile.TemporaryDirectory() as parent:
            def temporary(**kwargs):
                return real_directory(prefix=kwargs['prefix'], dir=parent)
            with patch.object(vpn.tempfile, 'TemporaryDirectory', side_effect=temporary), patch.object(vpn.subprocess, 'run', return_value=Mock(returncode=0)), patch.object(vpn.subprocess, 'Popen', return_value=process), patch.object(vpn.socket, 'create_connection'), patch.object(vpn.proxy, 'verify', side_effect=vpn.proxy.ProxyError()):
                with self.assertRaises(vpn.proxy.ProxyError):
                    vpn.probe(node)
            process.terminate.assert_called_once()
            process.wait.assert_called_once()
            self.assertEqual(list(Path(parent).iterdir()), [])

    def test_switch_passes_the_complete_profile_and_verified_country_to_the_locked_installer(self):
        entry = self.entries()[0]
        pinned = {**self.profile, 'server': '1.1.1.1', 'servername': self.profile['server']}
        process = Mock()
        process.wait.return_value = 0
        captured = {}
        real_directory = tempfile.TemporaryDirectory
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            vpn.write_private(base / 'catalog.json', {'nodes': [entry]})
            def temporary(**kwargs):
                return real_directory(prefix=kwargs['prefix'], dir=base)
            def installer(arguments, **kwargs):
                captured['arguments'] = arguments
                captured['profile'] = json.loads(Path(arguments[2]).read_text())
                return process
            with patch.object(vpn.tempfile, 'TemporaryDirectory', side_effect=temporary), patch.object(vpn, 'pin_profile', return_value=pinned), patch.object(vpn, 'probe', return_value={'https': True, 'exit_ipv4': '1.1.1.1', 'country': 'DE'}), patch.object(vpn.subprocess, 'Popen', side_effect=installer), redirect_stdout(io.StringIO()):
                vpn.operate(base, entry['id'], switch=True)
            self.assertEqual(captured['arguments'][-2:], ['1.1.1.1', 'DE'])
            self.assertEqual(captured['profile']['proxies'], [pinned])
            self.assertEqual(Path(captured['arguments'][1]).name, 'setup-ozon-proxy.sh')
            self.assertFalse(Path(captured['arguments'][2]).exists())
            self.assertTrue(vpn.read_private(base / 'catalog.json')['nodes'][0]['last_check']['ok'])


class NeutralVerificationTests(unittest.TestCase):
    def response(self, value):
        return Mock(returncode=0, stdout=json.dumps(value))

    def test_other_countries_are_supported_and_only_neutral_urls_are_requested(self):
        replies = [self.response({'ip': '1.1.1.1'}), self.response({'ip': '1.1.1.1', 'country_code': 'AU'})]
        with patch.object(vpn.proxy.subprocess, 'run', side_effect=replies) as request:
            result = vpn.proxy.verify(proxy='http://127.0.0.1:12345', country=None)
        self.assertEqual(result['country'], 'AU')
        self.assertEqual([call.args[0][-1] for call in request.call_args_list], ['https://api.ipify.org?format=json', 'https://ipwho.is/1.1.1.1'])
        self.assertTrue(all('http://127.0.0.1:12345' in call.args[0] for call in request.call_args_list))

    def test_default_kazakhstan_check_rejects_a_different_country(self):
        replies = [self.response({'ip': '1.1.1.1'}), self.response({'ip': '1.1.1.1', 'country_code': 'AU'})]
        with patch.object(vpn.proxy.subprocess, 'run', side_effect=replies), self.assertRaises(vpn.proxy.ProxyError):
            vpn.proxy.verify()


if __name__ == '__main__':
    unittest.main()
