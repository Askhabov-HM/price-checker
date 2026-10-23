#!/usr/bin/env bash
# Install one complete private Kazakhstan VPN profile for Ozon only.
set -euo pipefail
if [[ $EUID != 0 || $# != 2 ]]; then
  echo 'Usage: sudo bash scripts/setup-ozon-proxy.sh PRIVATE_PROVIDER_YAML SERVER_IP' >&2
  exit 1
fi
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(dirname -- "$directory")

# Collections and interactive Ozon login must finish before changing their route.
if [[ ${PRICE_CHECKER_OZON_PROXY_LEASE:-} != 1 ]]; then
  exec /usr/local/bin/node --input-type=module - "$root" "$@" <<'NODE'
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
const [root,...args] = process.argv.slice(2);
const runtimeRoot = '/opt/price-checker/current';
const {acquireInstance} = await import(pathToFileURL(join(runtimeRoot,'src/instance.js')));
const {acquireCollection} = await import(pathToFileURL(join(runtimeRoot,'src/collection-queue.js')));
let releaseStore,releaseQueue;
try {
  releaseStore = await acquireInstance(join(runtimeRoot,'.data/ozon/collector.lock'));
  releaseQueue = await acquireCollection(runtimeRoot);
  const child = spawn('/bin/bash',[join(root,'scripts/setup-ozon-proxy.sh'),...args],
    {stdio:'inherit',env:{...process.env,PRICE_CHECKER_OZON_PROXY_LEASE:'1'}});
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => child.kill(signal));
  process.exitCode = await new Promise((resolve,reject) => {child.once('error',reject);child.once('exit',code => resolve(code ?? 1));});
} catch {console.error('Ozon VPN update failed or Ozon is busy; close its login window and wait for collection.');process.exitCode = 1;}
finally {try {await releaseQueue?.();} finally {await releaseStore?.();}}
NODE
fi

provider=$1
server=$2
configdir=/etc/price-checker-ozon-proxy
config=$configdir/config.json
service=price-checker-ozon-proxy.service
helper=$directory/ozon-proxy-config.py
test -x /usr/local/bin/mihomo
test -x /usr/bin/curl
getent passwd priceproxy >/dev/null
python3 -c 'import yaml'
for path in "$configdir" "$config" /var/lib/price-checker-ozon-proxy "/etc/systemd/system/$service"; do
  [[ ! -L $path ]]
done
install -d -o root -g priceproxy -m 750 "$configdir"
workdir=$(mktemp -d "$configdir/.setup.XXXXXX")
was_active=0
systemctl is-active --quiet "$service" && was_active=1
rollback=0
browser_restart=0
cleanup() {
  if (( rollback )); then
    systemctl stop "$service" || true
    if [[ -f $workdir/previous.json ]]; then
      install -o priceproxy -g priceproxy -m 600 "$workdir/previous.json" "$config"
    else
      rm -f -- "$config"
    fi
    if (( was_active )); then systemctl start "$service" || true; fi
    if (( browser_restart )); then systemctl try-restart price-checker-ozon-recovery.service || true; fi
  fi
  rm -rf -- "$workdir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$helper" prepare "$provider" "$server" "$workdir/candidate.json"
if ! /usr/local/bin/mihomo -t -d "$workdir" -f "$workdir/candidate.json" >"$workdir/validation.log" 2>&1; then
  echo 'Ozon VPN profile validation failed; private details omitted.' >&2
  exit 1
fi
if [[ -f $config ]]; then cp -p -- "$config" "$workdir/previous.json"; fi
rollback=1
install -o priceproxy -g priceproxy -m 600 "$workdir/candidate.json" "$configdir/config.next"
mv -- "$configdir/config.next" "$config"
install -m 644 "$directory/systemd/$service" "/etc/systemd/system/$service"
systemctl daemon-reload
systemctl restart "$service"
sleep 1
python3 "$helper" verify
systemctl enable "$service"
browser_restart=1
systemctl try-restart price-checker-ozon-recovery.service
rollback=0
echo 'Dedicated Ozon VPN route installed and verified.'
