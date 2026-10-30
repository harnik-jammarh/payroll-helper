#!/usr/bin/env python3
"""Install only our extension policy entries; restore earlier values on removal."""
import argparse, json, os, tempfile
from pathlib import Path

def read(path):return json.loads(path.read_text()) if path.exists() else {}
def write(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd,'w') as f:json.dump(data,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
        os.chmod(name,0o644);os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)
def parent_for(data,keys):
    for key in keys:
        data=data.setdefault(key,{})
        if not isinstance(data,dict):raise ValueError('Existing browser policy has an incompatible structure')
    return data

def configure(root,config=None):
    root=Path(root);state=root/'var/lib/odoo-payroll-helper/policy-state.json'
    previous=read(state).get('entries',[])
    changes={};entries=[]
    def document(relative):
        if relative not in changes:changes[relative]=read(root/relative)
        return changes[relative]
    for record in previous:
        doc=document(record['file']);parent=parent_for(doc,record['keys'][:-1]);key=record['keys'][-1]
        if parent.get(key)==record['installed']:
            if record['existed']:parent[key]=record['old']
            else:parent.pop(key,None)
    def install(relative,keys,value):
        parent=parent_for(document(relative),keys[:-1]);key=keys[-1]
        entries.append({'file':relative,'keys':keys,'existed':key in parent,'old':parent.get(key),'installed':value})
        parent[key]=value
    if config:
        chromium={'installation_mode':'force_installed','update_url':config['chromium_update_url']}
        for path in ['etc/opt/chrome/policies/managed/odoo-payroll-helper.json','etc/brave/policies/managed/odoo-payroll-helper.json']:
            install(path,['ExtensionSettings',config['chromium_id']],chromium)
        if config.get('firefox_install_url'):
            install('etc/firefox/policies/policies.json',['policies','ExtensionSettings',config['firefox_id']],{'installation_mode':'force_installed','install_url':config['firefox_install_url']})
    for relative,data in changes.items():write(root/relative,data)
    write(state,{'entries':entries})

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['install','remove']);p.add_argument('--root',default='/');p.add_argument('--config',default='/usr/share/odoo-payroll-helper/deployment.json');a=p.parse_args()
    configure(a.root,read(Path(a.config)) if a.action=='install' else None)
