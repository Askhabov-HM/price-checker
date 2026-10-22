#!/usr/bin/env python3
"""Install the scoped Android upload limit in the existing Price Checker HTTPS host."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run as root.')
    site = Path('/etc/nginx/sites-enabled/price-checker').resolve(strict=True)
    if not site.is_relative_to('/etc/nginx'):
        raise SystemExit('Unexpected Nginx site path.')
    target = Path('/etc/nginx/snippets/price-checker-lamoda-mobile.conf')
    if target.is_symlink():
        raise SystemExit('Redirected mobile snippet.')
    source = Path(__file__).resolve().parent / 'nginx/lamoda-mobile.conf'
    text = site.read_text()
    include = '    include /etc/nginx/snippets/price-checker-lamoda-mobile.conf;'
    anchor = '    include /etc/nginx/snippets/price-checker-lamoda-login.conf;'
    if include not in text:
        if text.count(anchor) != 1:
            raise SystemExit('Expected one existing Lamoda HTTPS include; configuration unchanged.')
        text = text.replace(anchor, anchor + '\n' + include)
    audit = Path(tempfile.mkdtemp(prefix='price-checker-lamoda-mobile-nginx-', dir='/var/tmp'))
    audit.chmod(0o700)
    shutil.copy2(site, audit / 'site.before')
    existed = target.exists()
    if existed:
        shutil.copy2(target, audit / 'snippet.before')
    try:
        site.write_text(text)
        target.write_bytes(source.read_bytes())
        target.chmod(0o644)
        validation = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
        (audit / 'validation.log').write_text(validation.stdout + validation.stderr)
        if validation.returncode:
            raise RuntimeError('Nginx validation failed.')
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True, capture_output=True)
    except Exception:
        shutil.copy2(audit / 'site.before', site)
        if existed:
            shutil.copy2(audit / 'snippet.before', target)
        else:
            target.unlink(missing_ok=True)
        raise SystemExit('Mobile Nginx setup failed; previous files restored. Audit: ' + str(audit)) from None
    print('Android page upload limit installed (2 MiB); other request limits preserved. Audit: ' + str(audit))


if __name__ == '__main__':
    main()
