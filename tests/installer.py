import hashlib,io,json,re,sys,tempfile,urllib.error
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
script=(ROOT/'install.sh').read_text().split("<<'PY'\n",1)[1].split('\nPY\n',1)[0]
def run(mode,version='1.3.1',corrupt=False,fail=False):
 with tempfile.TemporaryDirectory() as tmp:
  urls=[];package=b'deb-test';name='odoo-payroll-helper_1.3.1_all.deb'
  def fetch(request,timeout):
   url=request.full_url;urls.append(url);assert 'api.github.com' not in url
   if fail:raise urllib.error.HTTPError(url,403,'Forbidden',{},None)
   if url.endswith('.json'):return io.BytesIO(json.dumps({'version':version}).encode())
   if url.endswith('SHA256SUMS'):return io.BytesIO((('0'*64 if corrupt else hashlib.sha256(package).hexdigest())+'  '+name+'\n').encode())
   return io.BytesIO(package)
  with patch('sys.argv',['installer','harnik-jammarh/payroll-helper',tmp,mode]),patch('urllib.request.urlopen',fetch):
   exec(compile(script,'install.sh','exec'),{})
  assert (Path(tmp)/'package-name').read_text()==name
  assert len(urls)==3
run('preview')
for kwargs,text in [({'version':None},'--preview'),({'corrupt':True},'Checksum mismatch'),({'fail':True},'HTTP 403')]:
 try:run('stable',**kwargs);raise AssertionError('Expected clear installer failure')
 except SystemExit as error:assert text in str(error)
print('PASS: API-free channel lookup, downloads, checksum, missing stable release and readable HTTP errors.')
