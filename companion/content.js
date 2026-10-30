const runtimeAPI = typeof browser !== 'undefined' ? browser : chrome;
window.addEventListener('message', event=>{
  if(event.source!==window || event.origin!==location.origin || event.data?.channel!=='payroll-companion-request') return;
  const {id,request}=event.data;
  runtimeAPI.runtime.sendMessage(request).then(response=>{
    // JSON text avoids cross-compartment object restrictions in Firefox.
    window.postMessage(JSON.stringify({channel:'payroll-companion-response',id,...response}),location.origin);
  }).catch(error=>window.postMessage(JSON.stringify({channel:'payroll-companion-response',id,error:error.message}),location.origin));
});
