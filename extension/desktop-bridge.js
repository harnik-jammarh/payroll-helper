// Desktop storage and HTTPS API transport. No browser extension is required.
const desktopBase = new URL('.', location.href);
const desktopToken = desktopBase.pathname.split('/')[1];
const browserFetch = window.fetch.bind(window);
async function desktopCall(path, value) {
  let response;
  try {
    response = await browserFetch(new URL(path, desktopBase), value === undefined ? {} : {
      method: 'POST', headers: {'Content-Type':'application/json','X-Payroll-Token':desktopToken}, body:JSON.stringify(value)
    });
  } catch (_) {
    throw new Error('Cannot reach the local Payroll Helper service. Launch odoo-payroll-helper again, choose your browser, and use the newly opened payroll tab. If the service is running, check whether this browser is blocking requests to 127.0.0.1.');
  }
  if (!response.ok) { const err=await response.json(); throw new Error(err.error || err.message || 'Local storage failed'); }
  return response.json();
}
let storageQueue = Promise.resolve();
window.chrome = {
  storage: {local: {
    get: async () => { await storageQueue; return desktopCall('storage'); },
    set: value => {
      const next=storageQueue.then(()=>desktopCall('storage',value));
      storageQueue=next.catch(()=>{});
      next.catch(e=>alert('Payroll data could not be saved: '+e.message));
      return next;
    }
  }},
  permissions: {contains:async()=>true, request:async()=>true},
  tabs: {query:async ({url})=>{
    const origin=new URL(url.replace(/\*$/, '')).origin;
    await companionCall({kind:'find',origin});return [{id:origin}];
  }},
  scripting: {executeScript:async ({target,args})=>[{result:await companionCall({kind:'rpc',origin:target.tabId,args})}]}
};
window.fetch = (input, options={}) => {
  const url=new URL(input,location.href);
  if(url.origin===location.origin) return browserFetch(input,options);
  return browserFetch(new URL('proxy',desktopBase),{
    method:'POST',headers:{'Content-Type':'application/json','X-Payroll-Token':desktopToken},
    body:JSON.stringify({url:url.href,headers:options.headers||{},body:options.body||'{}'})
  });
};

function companionCall(request) {
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    const timer=setTimeout(()=>{window.removeEventListener('message',receive);reject(new Error('No companion response. Update or enable Payroll Tab Companion in this browser, then reload this page.'));},request.kind==='rpc'?70000:3000);
    function receive(event) {
      if(event.source!==window || event.origin!==location.origin || typeof event.data!=='string') return;
      let message;try{message=JSON.parse(event.data);}catch(_){return;}
      if(message.channel!=='payroll-companion-response' || message.id!==id) return;
      clearTimeout(timer);window.removeEventListener('message',receive);
      if(message.error) reject(new Error(message.error));else resolve(message.value);
    }
    window.addEventListener('message',receive);
    window.postMessage({channel:'payroll-companion-request',id,request},location.origin);
  });
}
