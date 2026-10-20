// Only an explicit, local HTTP proxy is supported. An invalid configured route
// must fail rather than silently sending account traffic directly.
export function ozonProxyUrl() {
  const value = process.env.OZON_PROXY_URL;
  if (value === undefined) return null;
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value) || Number(value.slice(value.lastIndexOf(':')+1)) > 65535) {
    throw new Error('Invalid OZON_PROXY_URL: expected a local HTTP proxy');
  }
  return value;
}

export function ozonBrowserProxyArgs() {
  const proxy = ozonProxyUrl();
  return proxy ? ['--proxy-server='+proxy, '--disable-quic'] : [];
}
