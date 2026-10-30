const api = typeof browser !== 'undefined' ? browser : chrome;
function appURL(value) {
  try { const u=new URL(value); return u.protocol==='http:' && u.hostname==='127.0.0.1' && !u.username && !u.password && !u.search && !u.hash && /^\/[A-Za-z0-9_-]{40,}\/app\.html$/.test(u.pathname); } catch (_) { return false; }
}
async function verifyPayrollPage(url, origin) {
  const target=new URL('companion-handshake',url);
  let response;
  try {
    response=await fetch(target.href,{headers:{'X-Payroll-Token':new URL(url).pathname.split('/')[1]},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
  } catch (_) { throw new Error('Cannot verify the local payroll app. Restart Payroll Helper and use its newly opened tab.'); }
  if(!response.ok) throw new Error('Update and restart Payroll Helper to enable automatic logged-in-tab access.');
  const info=await response.json();
  if(info.app!=='odoo-payroll-helper' || info.protocol!==1 || info.mode!=='tab' || (origin && info.odoo_origin!==origin))
    throw new Error('Save the Odoo URL in logged-in-tab mode using Connect before accessing Odoo.');
}
api.runtime.onMessage.addListener((message,sender,respond)=>{
  (async()=>{
    if(!sender.tab || !appURL(sender.url)) throw new Error('Open the desktop payroll application first.');
    if(sender.frameId && sender.frameId!==0) throw new Error('Open Payroll Helper in a normal browser tab.');
    const origin=message.kind==='ping' ? null : new URL(message.origin).origin;
    if(origin && !origin.startsWith('https://')) throw new Error('Use an HTTPS Odoo URL.');
    await verifyPayrollPage(sender.url,origin);
    if(message.kind==='ping') return {ready:true};
    const tabs=(await api.tabs.query({url:origin+'/*'})).sort((a,b)=>Number(b.active)-Number(a.active));
    if(!tabs.length) throw new Error('Open and log in to '+origin+' in this browser and profile, then retry.');
    if(message.kind==='find') return {found:true};
    if(message.kind!=='rpc' || !Array.isArray(message.args)) throw new Error('Invalid companion request.');
    const [model,method,args,kwargs]=message.args;
    const results=await api.scripting.executeScript({target:{tabId:tabs[0].id},world:'MAIN',func:async(model,method,args,kwargs)=>{
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),60000);
      try {
        const response=await fetch('/web/dataset/call_kw',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method:'call',params:{model,method,args,kwargs}}),signal:controller.signal});
        const data=await response.json();
        return data.error ? {__error:data.error.data?.message || data.error.message} : {result:data.result};
      } catch(e) { return {__error:e.message}; } finally { clearTimeout(timer); }
    },args:[model,method,args,kwargs]});
    if(!results?.[0]?.result) throw new Error('No response from the Odoo tab. Reload it and retry.');
    return results[0].result;
  })().then(value=>respond({value}),error=>respond({error:error.message}));
  return true;
});
