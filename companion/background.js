const api = typeof browser !== 'undefined' ? browser : chrome;
function appURL(value) {
  try { const u=new URL(value); return u.protocol==='http:' && u.hostname==='127.0.0.1' && /^\/[A-Za-z0-9_-]{40,}\/app\.html$/.test(u.pathname); } catch (_) { return false; }
}
api.action.onClicked.addListener(async tab => {
  if (!appURL(tab.url)) return;
  await api.storage.local.set({['approved-'+tab.id]:tab.url});
  await api.action.setBadgeText({tabId:tab.id,text:'ON'});
  await api.action.setBadgeBackgroundColor({tabId:tab.id,color:'#017e84'});
});
api.runtime.onMessage.addListener((message,sender,respond)=>{
  (async()=>{
    if(!sender.tab || !appURL(sender.url)) throw new Error('Open the desktop payroll application first.');
    const key='approved-'+sender.tab.id;
    const approved=await api.storage.local.get(key);
    if(approved[key]!==sender.url) throw new Error('Click the Payroll Tab Companion toolbar icon on this payroll tab to enable logged-in-tab access.');
    if(message.kind==='ping') return {ready:true};
    const origin=new URL(message.origin).origin;
    if(!origin.startsWith('https://')) throw new Error('Use an HTTPS Odoo URL.');
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
