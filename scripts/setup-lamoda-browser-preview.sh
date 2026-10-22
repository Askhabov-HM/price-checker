#!/usr/bin/env bash
# Manually install the committed develop browser for an owner's live diagnosis.
set -euo pipefail
[[ $EUID == 0 && $# == 0 ]]
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository=/opt/price-checker/repository
base=/opt/price-checker/lamoda-browser-preview
[[ $(git -C "$repository" branch --show-current) == develop ]]
[[ $(git -C "$repository" rev-parse --abbrev-ref '@{upstream}') == origin/develop ]]
[[ -z $(git -C "$repository" status --porcelain) ]]
for operation in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer; do
  [[ ! -e $(git -C "$repository" rev-parse --absolute-git-dir)/$operation ]]
done
commit=$(git -C "$repository" rev-parse refs/remotes/origin/develop)
[[ $commit =~ ^[a-f0-9]{40}$ ]]
test -d /opt/price-checker/current/node_modules
test -f /etc/systemd/system/price-checker-lamoda-browser.service
[[ ! -L $base ]]
install -d -m 755 "$base"
[[ ! -e $base/current || -L $base/current ]]
[[ ! -L /etc/systemd/system/price-checker-lamoda-browser.service.d ]]
workdir=$(mktemp -d "$base/.install.XXXXXX")
trap 'rm -rf -- "$workdir"' EXIT
destination=$base/$commit
if [[ ! -e $destination ]]; then
  mkdir "$workdir/source"
  git -C "$repository" archive "$commit" package.json scripts/lamoda-browser.js \
    src/providers/lamoda/browser.js src/providers/lamoda/parser.js \
    src/providers/lamoda/channel.js src/providers/lamoda/diagnostics.js | tar -xf - -C "$workdir/source"
  ln -s /opt/price-checker/current/node_modules "$workdir/source/node_modules"
  chmod 755 "$workdir/source"
  mv -- "$workdir/source" "$destination"
fi
test -f "$destination/src/providers/lamoda/diagnostics.js"
ln -s "$destination" "$workdir/current"
mv -Tf -- "$workdir/current" "$base/current"
install -d -m 755 /etc/systemd/system/price-checker-lamoda-browser.service.d
install -m 644 "$directory/systemd/price-checker-lamoda-diagnostics.conf" \
  /etc/systemd/system/price-checker-lamoda-browser.service.d/diagnostics.conf
systemctl daemon-reload
systemctl restart price-checker-lamoda-browser.service
printf 'Lamoda browser diagnosis started from committed develop %s\n' "$commit"
