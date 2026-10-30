#!/usr/bin/env python3
import argparse, hashlib, json, re, subprocess, sys, urllib.request, zipfile, shutil
from pathlib import Path
from xml.sax.saxutils import escape
from crx3 import pack
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('version');p.add_argument('--key',type=Path,required=True);p.add_argument('--firefox-xpi-url');p.add_argument('--require-companions',action='store_true');p.add_argument('--preview',action='store_true');a=p.parse_args()
if not re.fullmatch(r'\d+\.\d+\.\d+',a.version):p.error('Use X.Y.Z')
if a.require_companions and not a.firefox_xpi_url:p.error('A Mozilla-signed Firefox XPI URL is required for automatic companion deployment')
out=ROOT/'dist';out.mkdir(exist_ok=True)
base=('https://github.com/harnik-jammarh/payroll-helper/releases/download/v'+a.version+'/' if a.preview else 'https://github.com/harnik-jammarh/payroll-helper/releases/latest/download/')
extid=pack(ROOT/'companion',a.key,out/'payroll-tab-companion.crx',base+'companion-updates.xml',a.version)
(out/'companion-updates.xml').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="{extid}"><updatecheck codebase="{base}payroll-tab-companion.crx" version="{a.version}" /></app></gupdate>\n''')
config={'chromium_id':extid,'chromium_update_url':base+'companion-updates.xml','firefox_id':'payroll-tab-companion@local.odoo-helper','firefox_install_url':None}
if a.firefox_xpi_url:
    if not a.firefox_xpi_url.startswith('https://'):p.error('Firefox download must use HTTPS')
    with urllib.request.urlopen(a.firefox_xpi_url,timeout=120) as response:blob=response.read(20*1024*1024+1)
    if len(blob)>20*1024*1024:p.error('XPI too large')
    xpi=out/'payroll-tab-companion.xpi';xpi.write_bytes(blob)
    with zipfile.ZipFile(xpi) as archive:
        names={name.lower() for name in archive.namelist()}
        if not {'meta-inf/mozilla.rsa','meta-inf/mozilla.sf'}.issubset(names):p.error('Firefox XPI has no Mozilla signature files')
        manifest=json.loads(archive.read('manifest.json'))
        if manifest.get('browser_specific_settings',{}).get('gecko',{}).get('id')!=config['firefox_id']:p.error('Unexpected Firefox add-on ID')
        if manifest['version']!=a.version:p.error('Signed Firefox version must match release version')
    # Firefox performs actual certificate/signature verification at installation.
    config['firefox_install_url']=base+'payroll-tab-companion.xpi'
config_path=out/'deployment.json';config_path.write_text(json.dumps(config,indent=2)+'\n')
subprocess.run([sys.executable,str(ROOT/'build.py'),a.version,str(out),'--deployment',str(config_path)],check=True)
for browser in ('chrome','firefox'):
    with zipfile.ZipFile(out/f'payroll-tab-companion-{browser}.zip','w',zipfile.ZIP_DEFLATED) as z:
        for name in ('background.js','content.js'):z.write(ROOT/'companion'/name,name)
        manifest=json.loads((ROOT/'companion'/f'manifest-{browser}.json').read_text());manifest['version']=a.version
        z.writestr('manifest.json',json.dumps(manifest,indent=2))
shutil.copyfile(ROOT/'install.sh',out/'install.sh')
files=sorted(f for f in out.iterdir() if f.is_file() and f.name!='SHA256SUMS')
(out/'SHA256SUMS').write_text(''.join(hashlib.sha256(f.read_bytes()).hexdigest()+'  '+f.name+'\n' for f in files))
print('Chromium companion ID:',extid)
print('Firefox automatic installation:', 'configured' if a.firefox_xpi_url else 'PENDING MOZILLA SIGNING')
