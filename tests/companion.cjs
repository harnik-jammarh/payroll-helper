const vm=require('vm'),fs=require('fs'),assert=require('assert');
(async()=>{
 for(const namespace of ['chrome','browser']){
  let listener,query,valid=true,origin='https://example.odoo.com',mode='tab',calls=0;
  const api={runtime:{onMessage:{addListener:f=>listener=f}},tabs:{query:async q=>{query=q;return [{id:8,active:true}];}},scripting:{executeScript:async q=>{calls++;assert.equal(q.target.tabId,8);assert.equal(q.world,'MAIN');assert.equal(q.args[0],'res.company');return [{result:{result:[{name:'company'}]}}];}}};
  const token='a'.repeat(43);const url='http://127.0.0.1:12345/'+token+'/app.html';const sender={url,tab:{id:1},frameId:0};
  const fetch=async (target,options)=>{assert.equal(target,'http://127.0.0.1:12345/'+token+'/companion-handshake');assert.equal(options.headers['X-Payroll-Token'],token);assert.equal(options.redirect,'error');return {ok:valid,json:async()=>({app:'odoo-payroll-helper',protocol:1,mode,odoo_origin:origin})};};
  vm.runInNewContext(fs.readFileSync('companion/background.js','utf8'),{[namespace]:api,URL,fetch,AbortSignal});
  const send=message=>new Promise(resolve=>listener(message,sender,resolve));
  assert((await send({kind:'find',origin})).value.found);
  const rpc={kind:'rpc',origin,args:['res.company','search_read',[],{}]};
  assert.equal((await send(rpc)).value.result[0].name,'company');assert.equal(query.url,origin+'/*');assert.equal(calls,1);
  valid=false;assert((await send(rpc)).error.includes('Update'));valid=true;
  origin='https://another.odoo.com';assert((await send(rpc)).error.includes('Save the Odoo URL'));
  origin=rpc.origin;mode='api';assert((await send(rpc)).error);assert.equal(calls,1);
  mode='tab';sender.url=url+'?different';assert((await send(rpc)).error);
  sender.url='https://evil.example/'+token+'/app.html';assert((await send(rpc)).error);
  sender.url=url;sender.frameId=3;assert((await send(rpc)).error);
 }
 console.log('PASS: automatic local-page verification, saved Odoo origin/mode binding, no toolbar approval, and untrusted-page rejection.');
})().catch(e=>{console.error(e);process.exit(1)});
