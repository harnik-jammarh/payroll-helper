#!/usr/bin/env python3
"""Build with: python3 build.py 1.0.0 [output-directory]"""
import sys, json, hashlib, base64, shutil, subprocess, tempfile, re
from pathlib import Path
root = Path(__file__).resolve().parent
version = sys.argv[1] if len(sys.argv)>1 else '1.0.0'
if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
    raise SystemExit('Use a numeric version such as 1.0.1')
out = Path(sys.argv[2] if len(sys.argv)>2 else root / 'dist').resolve()
out.mkdir(parents=True, exist_ok=True)
deployment = None
if '--deployment' in sys.argv:
    deployment=json.loads(Path(sys.argv[sys.argv.index('--deployment')+1]).read_text())
manifest = json.loads((root/'extension/manifest.json').read_text())
extid = ''.join(chr(97+int(c,16)) for c in hashlib.sha256(base64.b64decode(manifest['key'])).hexdigest()[:32])
with tempfile.TemporaryDirectory() as tmp:
    pkg = Path(tmp)/'package'
    def put(name, data, mode=0o644):
        p=pkg/name; p.parent.mkdir(parents=True, exist_ok=True);p.write_text(data);p.chmod(mode)
    shutil.copytree(root/'extension',pkg/'usr/share/odoo-payroll-helper/extension',ignore=shutil.ignore_patterns('__pycache__'))
    for browser_name in ('chrome','firefox'):
        companion_dir=pkg/'usr/share/odoo-payroll-helper/companion'/browser_name
        companion_dir.mkdir(parents=True)
        for filename in ('background.js','content.js'):
            shutil.copyfile(root/'companion'/filename,companion_dir/filename)
        shutil.copyfile(root/'companion'/('manifest-'+browser_name+'.json'),companion_dir/'manifest.json')
    manifest['version']=version
    put('usr/share/odoo-payroll-helper/extension/manifest.json',json.dumps(manifest,indent=2)+'\n')
    put('DEBIAN/control', f'''Package: odoo-payroll-helper
Version: {version}
Section: office
Priority: optional
Architecture: all
Maintainer: Odoo Payroll Helper package maintainers <maintainer@example.invalid>
Depends: python3 (>= 3.8), python3-tk
Description: Odoo Payroll Helper desktop launcher
 Opens the local payroll application in a user-selected web browser.
 User data is kept outside the installed package across upgrades.
''')
    if deployment:
        put('usr/share/odoo-payroll-helper/deployment.json',json.dumps(deployment,indent=2)+'\n')
        put('usr/share/odoo-payroll-helper/policies.py',(root/'scripts/policies.py').read_text())
        put('DEBIAN/postinst', '#!/bin/sh\nset -eu\nif [ "$1" = configure ]; then\n /usr/bin/python3 /usr/share/odoo-payroll-helper/policies.py install\nfi\n',0o755)
        put('DEBIAN/prerm', '#!/bin/sh\nset -eu\nif [ "$1" = remove ] || [ "$1" = deconfigure ]; then\n /usr/bin/python3 /usr/share/odoo-payroll-helper/policies.py remove\nfi\n',0o755)
    put('usr/share/odoo-payroll-helper/desktop.py', (root/'desktop.py').read_text())
    put('usr/bin/odoo-payroll-helper', '#!/bin/sh\nexec /usr/bin/python3 /usr/share/odoo-payroll-helper/desktop.py "$@"\n', 0o755)
    put('usr/share/applications/odoo-payroll-helper.desktop', '''[Desktop Entry]
Type=Application
Name=Odoo Payroll Helper
Comment=Manage payroll and connect to Odoo
Exec=odoo-payroll-helper
Icon=odoo-payroll-helper
Terminal=false
Categories=Office;Finance;
''')
    put('usr/share/icons/hicolor/scalable/apps/odoo-payroll-helper.svg', '''<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="24" fill="#714b67"/><rect x="30" y="20" width="68" height="88" rx="7" fill="white"/><path d="M43 40h42M43 55h42M43 70h20M43 85h20" stroke="#714b67" stroke-width="6"/><circle cx="86" cy="87" r="20" fill="#017e84"/><path d="M78 87l6 6 11-13" fill="none" stroke="white" stroke-width="5"/></svg>''')
    put('usr/share/doc/odoo-payroll-helper/README', (root/'README.md').read_text())
    subprocess.run(['dpkg-deb','--root-owner-group','--build',str(pkg),str(out/f'odoo-payroll-helper_{version}_all.deb')],check=True)
