import json,subprocess,sys,tempfile,struct
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from policies import configure
from crx3 import pack
with tempfile.TemporaryDirectory() as tmp:
 root=Path(tmp);path=root/'etc/firefox/policies/policies.json';path.parent.mkdir(parents=True)
 original={'policies':{'DisableTelemetry':True,'ExtensionSettings':{'other@example.com':{'installation_mode':'allowed'}}}}
 path.write_text(json.dumps(original))
 config={'chromium_id':'a'*32,'chromium_update_url':'https://example.com/update.xml','firefox_id':'test@example.com','firefox_install_url':'https://example.com/signed.xpi'}
 configure(root,config);configure(root,config)
 data=json.loads(path.read_text());assert data['policies']['DisableTelemetry'];assert data['policies']['ExtensionSettings']['other@example.com']=={'installation_mode':'allowed'}
 configure(root,None);assert json.loads(path.read_text())==original
 configure(root,config);data=json.loads(path.read_text());data['policies']['ExtensionSettings']['test@example.com']={'installation_mode':'blocked'};path.write_text(json.dumps(data));configure(root,None)
 assert json.loads(path.read_text())['policies']['ExtensionSettings']['test@example.com']['installation_mode']=='blocked'
 key=root/'key.pem';subprocess.run(['openssl','genrsa','-out',str(key),'2048'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 crx=root/'test.crx';extid=pack(ROOT/'companion',key,crx,'https://example.com/updates.xml','1.3.0')
 assert len(extid)==32
 blob=crx.read_bytes();assert blob[:4]==b'Cr24';version,size=struct.unpack('<II',blob[4:12]);assert version==3
 def integer(buf,index):
  n=0;shift=0
  while True:
   v=buf[index];index+=1;n|=(v&127)<<shift
   if v<128:return n,index
   shift+=7
 def fields(buf):
  result={};i=0
  while i<len(buf):
   tag,i=integer(buf,i);length,i=integer(buf,i);result[tag>>3]=buf[i:i+length];i+=length
  return result
 header=fields(blob[12:12+size]);proof=fields(header[2]);signed=header[10000]
 public=root/'pub.der';public.write_bytes(proof[1]);signature=root/'sig';signature.write_bytes(proof[2]);payload=root/'payload';payload.write_bytes(b'CRX3 SignedData\x00'+struct.pack('<I',len(signed))+signed+blob[12+size:])
 pubpem=root/'pub.pem';subprocess.run(['openssl','pkey','-pubin','-inform','DER','-in',str(public),'-out',str(pubpem)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run(['openssl','dgst','-sha256','-verify',str(pubpem),'-signature',str(signature),str(payload)],check=True)
 assert pack(ROOT/'companion',key,root/'next.crx','https://example.com/updates.xml','1.3.1')==extid
print('PASS: policy upgrades, preservation/removal, admin edits, independent CRX3 RSA signature verification and stable extension ID.')
