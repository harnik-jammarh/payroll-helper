const vm=require('vm'),fs=require('fs'),assert=require('assert');
(async()=>{
 for(const namespace of ['chrome','browser']){
  const stored={};let listener,clicked,query;
  const api={action:{onClicked:{addListener:f=>clicked=f},setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},storage:{local:{set:async d=>Object.assign(stored,d),get:async key=>({[key]:stored[key]})}},runtime:{onMessage:{addListener:f=>listener=f}},tabs:{query:async q=>{query=q;return [{id:8,active:true}];}},scripting:{executeScript:async q=>{assert.equal(q.target.tabId,8);assert.equal(q.world,'MAIN');assert.equal(q.args[0],'res.company');return [{result:{result:[{name:'company'}]}}];}}};
  vm.runInNewContext(fs.readFileSync('companion/background.js','utf8'),{[namespace]:api,URL});
  const url='http://127.0.0.1:12345/'+'a'.repeat(43)+'/app.html';const sender={url,tab:{id:1}};
  const send=message=>new Promise(resolve=>listener(message,sender,resolve));
  assert((await send({kind:'find',origin:'https://example.odoo.com'})).error.includes('toolbar'));
  await clicked({id:1,url});assert((await send({kind:'find',origin:'https://example.odoo.com'})).value.found);
  const result=await send({kind:'rpc',origin:'https://example.odoo.com',args:['res.company','search_read',[],{}]});assert.equal(result.value.result[0].name,'company');assert.equal(query.url,'https://example.odoo.com/*');
  assert((await send({kind:'find',origin:'http://example.odoo.com'})).error.includes('HTTPS'));
  sender.url=url+'?different';assert((await send({kind:'ping'})).error);
 }
 console.log('PASS: Chrome/Firefox API branches, explicit tab approval, exact app URL, origin matching, MAIN-world RPC result and HTTPS restriction.');
})().catch(e=>{console.error(e);process.exit(1)});
