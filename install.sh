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
def download(url):
    try:
        request=urllib.request.Request(url,headers={'User-Agent':'payroll-helper-installer'})
        with urllib.request.urlopen(request,timeout=120) as response:return response.read()
    except urllib.error.HTTPError as error:
        raise SystemExit('Download failed (HTTP '+str(error.code)+'). Please retry or download the .deb from GitHub Releases.')
    except urllib.error.URLError as error:
        raise SystemExit('Download failed: '+str(error.reason))
channel_url='https://raw.githubusercontent.com/'+repo+'/main/channels/'+mode+'.json'
channel=json.loads(download(channel_url))
version=channel.get('version')
if version is None:
    raise SystemExit('No stable release yet. Install the current preview with:\n'
        'curl -fsSL https://raw.githubusercontent.com/'+repo+'/main/install.sh | bash -s -- --preview')
if not isinstance(version,str) or not re.fullmatch(r'\d+\.\d+\.\d+',version):raise SystemExit('Invalid release channel version')
name='odoo-payroll-helper_'+version+'_all.deb'
base='https://github.com/'+repo+'/releases/download/v'+version+'/'
for filename in [name,'SHA256SUMS']:
    (directory/filename).write_bytes(download(base+filename))
names=[name]
checks={line.split()[1]:line.split()[0] for line in (directory/'SHA256SUMS').read_text().splitlines()}
if hashlib.sha256((directory/names[0]).read_bytes()).hexdigest()!=checks.get(names[0]):raise SystemExit('Checksum mismatch; nothing installed')
(directory/'package-name').write_text(names[0])
print('Downloaded release v'+version)
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
