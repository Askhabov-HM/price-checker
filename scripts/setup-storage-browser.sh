#!/usr/bin/env bash
# Update journal writers without triggering a backup, collection or application restart.
set -euo pipefail
[[ $EUID == 0 && $# == 1 && $1 == --update ]] || { echo 'Usage: sudo bash scripts/setup-storage-browser.sh --update' >&2; exit 1; }
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test -d /var/lib/price-checker/data
test -f /etc/price-checker-backup.json
install -d -m 755 /usr/local/lib/price-checker
install -d -m 700 /var/lib/price-checker-backup-coordination
exec 9>/opt/price-checker/.deploy.lock
flock -n 9
exec 8>/var/lib/price-checker-backup-coordination/repository.lock
flock -w 2400 8
saved=$(mktemp -d /var/lib/price-checker-backup-coordination/journal-update-XXXXXXXX)
scripts=(backup-journal.py google-drive-backup.py store-backup.py lamoda-backup.py backup-maintenance.py)
units=(price-checker-backup.service price-checker-lamoda-backup.service price-checker-store-backup@.service price-checker-backup-maintenance.service)
for name in "${scripts[@]}"; do
  python3 -c 'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read())' "$directory/$name"
done
install -d -m 750 -o root -g pricechecker /var/lib/price-checker/data/backup-journal
python3 "$directory/backup-journal.py" /var/lib/price-checker/data
targets=()
for name in "${scripts[@]}"; do targets+=("/usr/local/lib/price-checker/$name"); done
for name in "${units[@]}"; do
  test -f "$directory/systemd/$name"
  targets+=("/etc/systemd/system/$name")
done
declare -A existed
for target in "${targets[@]}"; do
  if [[ -f $target ]]; then cp -p "$target" "$saved/$(basename "$target")"; existed[$target]=1; fi
done
printf 'Previous files: %s\n' "$saved"
rollback() {
  code=$?
  trap - EXIT
  if (( code != 0 )); then
    for target in "${targets[@]}"; do
      if [[ ${existed[$target]:-0} == 1 ]]; then cp -p "$saved/$(basename "$target")" "$target";
      else rm -f -- "$target"; fi
    done
    systemctl daemon-reload
    echo 'Installation failed; previous writer files restored.' >&2
  fi
  exit "$code"
}
trap rollback EXIT
for name in "${scripts[@]}"; do
  install -m 644 "$directory/$name" "/usr/local/lib/price-checker/$name.new"
  mv -T "/usr/local/lib/price-checker/$name.new" "/usr/local/lib/price-checker/$name"
done
for name in "${units[@]}"; do install -m 644 "$directory/systemd/$name" "/etc/systemd/system/$name"; done
systemctl daemon-reload
echo 'Journal writers installed; existing timers preserved.'
