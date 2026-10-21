#!/usr/bin/env bash
# Install GitHub CLI and create xman without changing the root Codex integration.
set -euo pipefail

if (( EUID != 0 )); then
  echo 'Run as root: sudo bash scripts/setup-server-tools.sh' >&2
  exit 1
fi

if getent passwd xman >/dev/null && [[ $(id -u xman) == 0 ]]; then
  echo 'Refusing an existing xman account with UID 0.' >&2
  exit 1
fi

if ! command -v gh >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l \
    apt-get install --no-install-recommends --yes gh
fi

if ! getent passwd xman >/dev/null; then
  useradd --create-home --user-group --shell /bin/bash xman
  chmod 700 /home/xman
fi

gh --version
id xman
