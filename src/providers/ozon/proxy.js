import {ProxyAgent} from 'undici';
import {ozonProxyUrl} from './proxy-config.js';

let proxyAgent;

// A dispatcher on Ozon requests leaves the other stores and Telegram alone.
// Proxy failures propagate to the existing collector error handling.
export function ozonFetch(url, options) {
  const proxy = ozonProxyUrl();
  if (!proxy) return fetch(url, options);
  proxyAgent ??= new ProxyAgent(proxy);
  return fetch(url, {...options, dispatcher: proxyAgent});
}
