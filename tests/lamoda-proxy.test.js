import test from 'node:test';
import assert from 'node:assert/strict';
import {LamodaBrowser,lamodaBrowserProxyArgs} from '../src/providers/lamoda/browser.js';

test('Lamoda uses its own proxy setting for the browser and keeps the default route when unset',t => {
  const previous = {lamoda:process.env.LAMODA_PROXY_URL,ozon:process.env.OZON_PROXY_URL};
  t.after(() => {
    for (const [name,value] of [['LAMODA_PROXY_URL',previous.lamoda],['OZON_PROXY_URL',previous.ozon]]) {
      if (value === undefined) delete process.env[name];else process.env[name] = value;
    }
  });
  delete process.env.LAMODA_PROXY_URL;process.env.OZON_PROXY_URL = 'http://127.0.0.1:17891';
  assert.deepEqual(new LamodaBrowser().proxyArgs,[]);
  process.env.LAMODA_PROXY_URL = 'http://127.0.0.1:17892';
  assert.deepEqual(new LamodaBrowser().proxyArgs,['--proxy-server=http://127.0.0.1:17892','--disable-quic']);
  assert.equal(process.env.OZON_PROXY_URL,'http://127.0.0.1:17891');
  assert.deepEqual(lamodaBrowserProxyArgs('http://127.0.0.1:65535'),['--proxy-server=http://127.0.0.1:65535','--disable-quic']);
});

test('Lamoda rejects malformed, remote, credentialed, and DIRECT fallback proxy settings before launch',() => {
  for (const proxy of ['',null,123,'http://127.0.0.1:0','http://127.0.0.1:65536',
    'https://127.0.0.1:17891','socks5://127.0.0.1:17891','http://proxy.example:17891',
    'http://127.0.0.1:17891/','http://user:synthetic@127.0.0.1:17891',
    'http://127.0.0.1:17891,direct://','http://127.0.0.1:17891\n','http://127.0.0.1:17891\r\n',
    'http://127.0.0.1:17891\n--no-proxy-server']) {
    assert.throws(() => new LamodaBrowser({proxy}),{message:'Invalid LAMODA_PROXY_URL: expected a local HTTP proxy'});
  }
});
