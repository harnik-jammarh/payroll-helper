#!/bin/bash
set -euo pipefail
# Installs/upgrades the app and configured companions; never touches payroll data.
mode=stable
if [[ ${1:-} == --preview ]]; then mode=preview
elif [[ $# -gt 0 ]]; then echo "Usage: bash install.sh [--preview]" >&2; exit 1
fi
source /etc/os-release
if [[ ${ID:-} != ubuntu ]] || ! dpkg --compare-versions "${VERSION_ID:-0}" ge 22.04; then
    echo 'Ubuntu 22.04 or later is required.' >&2; exit 1
fi
command -v python3 >/dev/null || { echo 'Python 3 is required.' >&2; exit 1; }
REPOSITORY=harnik-jammarh/payroll-helper
stage=$(mktemp -d)
trap 'python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1])" "$stage"' EXIT
python3 - "$REPOSITORY" "$stage" "$mode" <<'PY'
import hashlib,json,re,sys,urllib.request,urllib.error
from pathlib import Path
repo,directory,mode=sys.argv[1:];directory=Path(directory)
headers={'Accept':'application/vnd.github+json','User-Agent':'payroll-helper-installer'}
endpoint='/releases' if mode=='preview' else '/releases/latest'
request=urllib.request.Request('https://api.github.com/repos/'+repo+endpoint,headers=headers)
try:
    with urllib.request.urlopen(request,timeout=60) as r:release=json.load(r)
except urllib.error.HTTPError as e:
    if e.code==404:raise SystemExit('No stable release yet. Use --preview to test a prerelease; Firefox automatic setup may be pending.')
    raise
if mode=='preview':
    release=next((item for item in release if not item['draft']),None)
    if release is None:raise SystemExit('No published release available yet')
assets={a['name']:a['browser_download_url'] for a in release['assets']}
names=[n for n in assets if re.fullmatch(r'odoo-payroll-helper_\d+\.\d+\.\d+_all\.deb',n)]
if len(names)!=1:raise SystemExit('Release must contain exactly one payroll .deb')
for name in [names[0],'SHA256SUMS']:
    with urllib.request.urlopen(assets[name],timeout=120) as r:(directory/name).write_bytes(r.read())
checks={line.split()[1]:line.split()[0] for line in (directory/'SHA256SUMS').read_text().splitlines()}
if hashlib.sha256((directory/names[0]).read_bytes()).hexdigest()!=checks.get(names[0]):raise SystemExit('Checksum mismatch; nothing installed')
(directory/'package-name').write_text(names[0])
print('Downloaded release',release['tag_name'])
PY
package=$(cat "$stage/package-name")
chmod 755 "$stage"
chmod 644 "$stage/$package"
if [[ $EUID -eq 0 ]]; then
    apt-get update
    apt-get install -y "$stage/$package"
else
    sudo apt-get update
    sudo apt-get install -y "$stage/$package"
fi
printf '\nInstalled. Restart your browsers, then run: odoo-payroll-helper\n'
