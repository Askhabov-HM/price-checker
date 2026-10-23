#!/usr/bin/env bash
# Install one complete private Kazakhstan VPN profile for Ozon only.
set -euo pipefail
if [[ $EUID != 0 || $# -lt 1 || $# -gt 2 ]]; then
  echo 'Usage: sudo bash scripts/setup-ozon-proxy.sh PRIVATE_PROVIDER_YAML [SERVER_IP]' >&2
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
server=${2:-95.56.251.12}
configdir=/etc/price-checker-ozon-proxy
config=$configdir/config.json
environment=/etc/price-checker-ozon-proxy.env
service=price-checker-ozon-proxy.service
helper=$directory/ozon-proxy-config.py
consumers=(price-checker.service price-checker-ozon-recovery@.service price-checker-ozon-browser.service)
managed_paths=("$config" "/etc/systemd/system/$service" "$environment"
  /etc/systemd/system/price-checker-ozon-recovery.service.d/ozon-proxy.conf)
for consumer in "${consumers[@]}"; do
  managed_paths+=("/etc/systemd/system/$consumer.d/ozon-proxy.conf")
done
test -x /usr/local/bin/mihomo
test -x /usr/bin/curl
getent passwd priceproxy >/dev/null
python3 -c 'import yaml'
for path in "$configdir" /var/lib/price-checker-ozon-proxy "${managed_paths[@]}"; do
  [[ ! -L $path && ! -L $(dirname -- "$path") ]]
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
    for index in "${!managed_paths[@]}"; do
      if [[ -f $workdir/previous.$index ]]; then
        cp -p -- "$workdir/previous.$index" "${managed_paths[$index]}"
      else
        rm -f -- "${managed_paths[$index]}"
      fi
    done
    systemctl daemon-reload || true
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
for index in "${!managed_paths[@]}"; do
  if [[ -f ${managed_paths[$index]} ]]; then cp -p -- "${managed_paths[$index]}" "$workdir/previous.$index"; fi
done
rollback=1
install -o priceproxy -g priceproxy -m 600 "$workdir/candidate.json" "$configdir/config.next"
mv -- "$configdir/config.next" "$config"
install -m 644 "$directory/systemd/$service" "/etc/systemd/system/$service"
printf 'OZON_PROXY_URL=http://127.0.0.1:17891\n' > "$workdir/proxy.env"
install -o root -g root -m 600 "$workdir/proxy.env" "$environment"
install -d -m 755 /etc/systemd/system/price-checker-ozon-recovery.service.d
install -m 644 "$directory/systemd/price-checker-ozon-proxy-order.conf" \
  /etc/systemd/system/price-checker-ozon-recovery.service.d/ozon-proxy.conf
for consumer in "${consumers[@]}"; do
  install -d -m 755 "/etc/systemd/system/$consumer.d"
  install -m 644 "$directory/systemd/price-checker-ozon-proxy.conf" \
    "/etc/systemd/system/$consumer.d/ozon-proxy.conf"
done
systemctl daemon-reload
systemctl restart "$service"
sleep 1
python3 "$helper" verify
systemctl enable "$service"
browser_restart=1
systemctl try-restart price-checker-ozon-recovery.service
rollback=0
if [[ ! -f $workdir/previous.2 ]] || ! cmp -s "$workdir/previous.2" "$environment"; then
  echo 'Restart the web application to load its new Ozon proxy URL.'
fi
echo 'Dedicated Ozon VPN route installed and verified.'
