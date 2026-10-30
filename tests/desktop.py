import importlib.util,tempfile,threading,json,http.client
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('desktop', 'desktop.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 store=m.Store(tmp)
 import io,types
 Handler=m.handler(store,'test-token')
 def request(method,path,data=None,auth=True):
  h=object.__new__(Handler);h.server=types.SimpleNamespace(server_port=12345)
  h.path='/test-token/'+path
  raw=b'' if data is None else json.dumps(data).encode()
  h.headers={'Host':'127.0.0.1:12345','Content-Length':str(len(raw))}
  if auth:h.headers['X-Payroll-Token']='test-token'
  h.rfile=io.BytesIO(raw);result=[]
  h.respond=lambda status,body,mime=None:result.append((status,body if isinstance(body,bytes) else json.dumps(body).encode()))
  getattr(h,'do_'+method)();return result[0]
 data={'payroll':{'employees':[{'name':'test'}],'structures':[],'settings':{'key':'secret'}}}
 assert request('POST','storage',data)[0]==200
 assert json.loads(request('GET','storage')[1])==data
 assert request('POST','storage',data,False)[0]==403
 data['payroll']['employees'].append({'name':'next'});assert request('POST','storage',data)[0]==200
 assert len(json.loads((Path(tmp)/'payroll.previous.json').read_text())['payroll']['employees'])==1
 assert (Path(tmp)/'payroll.json').stat().st_mode & 0o777==0o600
 assert request('GET','../desktop.py')[0]==404
 assert request('GET','app.html')[0]==200
 assert b'desktop-bridge.js' in request('GET','app.html')[1]
 class Response:
  status=200
  def read(self,n):return b'[1,2]'
 class Connection:
  def __init__(self,host,port,timeout):assert host=='example.odoo.com'
  def request(self,method,path,body,headers):
   assert method=='POST' and path=='/json/2/res.company/search_read';assert headers['Authorization']=='bearer secret';assert 'Cookie' not in headers
  def getresponse(self):return Response()
  def close(self):pass
 with patch.object(m.http.client,'HTTPSConnection',Connection):
  status,body=request('POST','proxy',{'url':'https://example.odoo.com/json/2/res.company/search_read','body':'{}','headers':{'Authorization':'bearer secret','Cookie':'not-forwarded'}})
  assert status==200 and body==b'[1,2]'
 assert request('POST','proxy',{'url':'http://example.odoo.com/jsonrpc','body':'{}'})[0]==502

 # Browser changes or app restarts read the same disk state.
 assert m.Store(tmp).read()==data
 print('PASS: persistent storage/restart, backups, permissions, token checks, assets, HTTPS proxy and header filtering.')

# Exercise the real loopback HTTP transport in addition to isolated handler tests.
import urllib.request, urllib.error
with tempfile.TemporaryDirectory() as directory:
 server=m.ThreadingHTTPServer(('127.0.0.1',0),m.handler(m.Store(directory),'http-test-token'))
 thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 try:
  base='http://127.0.0.1:'+str(server.server_port)+'/http-test-token/'
  payload=json.dumps({'payroll':{'employees':[],'structures':[]}}).encode()
  request=urllib.request.Request(base+'storage',data=payload,headers={'Content-Type':'application/json','X-Payroll-Token':'http-test-token'})
  with urllib.request.urlopen(request,timeout=5) as response:assert response.status==200
  with urllib.request.urlopen(base+'storage',timeout=5) as response:assert json.load(response)['payroll']['employees']==[]
  request=urllib.request.Request(base+'storage',data=payload,headers={'Origin':'https://untrusted.example'})
  try:urllib.request.urlopen(request,timeout=5);raise AssertionError('Unauthenticated write accepted')
  except urllib.error.HTTPError as error:assert error.code==403
 finally:server.shutdown();server.server_close()
 print('PASS: actual loopback HTTP read/write and unauthenticated cross-origin rejection.')
