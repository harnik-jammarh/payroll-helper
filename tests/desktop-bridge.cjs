const vm=require('vm'),fs=require('fs'),assert=require('assert');
(async()=>{
 const alerts=[];
 const context={URL,location:{href:'http://127.0.0.1:12345/test-token/app.html'},alert:message=>alerts.push(message)};
 context.window={fetch:async()=>{throw new TypeError('Failed to fetch')}};
 vm.runInNewContext(fs.readFileSync('extension/desktop-bridge.js','utf8'),context);
 await assert.rejects(context.window.chrome.storage.local.set({payroll:{}}),/Launch odoo-payroll-helper again/);
 assert(alerts[0].includes('newly opened payroll tab'));
 await assert.rejects(context.window.chrome.storage.local.get('payroll'),/local Payroll Helper service/);
 console.log('PASS: unavailable service gives a recovery message on save and load.');
})().catch(error=>{console.error(error);process.exit(1)});
