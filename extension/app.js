// Odoo Payroll Helper - data stays in chrome.storage.local; Odoo is reached through a logged-in Odoo tab.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const CUR = () => (S && S.cache && S.cache.currency) || { symbol: '', name: '', position: 'before', decimals: 2 };
const LOCALE = () => (CUR().name === 'INR' ? 'en-IN' : undefined);
const money = n => (Number(n) || 0).toLocaleString(LOCALE(), { minimumFractionDigits: 0, maximumFractionDigits: CUR().decimals ?? 2 });
const cur = n => { const c = CUR(); return c.position === 'after' ? `${money(n)} ${c.symbol}` : `${c.symbol} ${money(n)}`.trim(); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const ROLES = { expense: 'Salary expense', pf: 'Social security / pension payable', esi: 'Health insurance payable', pt: 'Local / professional tax payable', tds: 'Income tax withheld payable', other: 'Other deductions', payable: 'Salaries payable', employer_exp: 'Employer contribution expense' };
const METHODS = { pct_gross: '% of gross', pct_basic: '% of BASIC', fixed: 'Fixed amount', balance: 'Balance of gross' };
const TYPES = { earning: 'Earning', deduction: 'Deduction', employer: 'Employer contribution' };

const DEFAULT_STRUCTURE = {
  id: 'generic', name: 'Generic (edit or import from Odoo)', components: [
    { code: 'BASIC', name: 'Basic salary', type: 'earning', method: 'pct_gross', value: 60, max: '', maxGross: '', role: 'expense' },
    { code: 'ALW', name: 'Allowances', type: 'earning', method: 'balance', value: '', max: '', maxGross: '', role: 'expense' },
    { code: 'SS', name: 'Social security (employee)', type: 'deduction', method: 'pct_gross', value: 0, max: '', maxGross: '', role: 'pf' },
    { code: 'TAX', name: 'Income tax withheld', type: 'deduction', method: 'fixed', value: 0, max: '', maxGross: '', role: 'tds' },
    { code: 'SS_ER', name: 'Social security (employer)', type: 'employer', method: 'pct_gross', value: 0, max: '', maxGross: '', role: 'pf' },
  ],
};

let S = { employees: [], structures: [DEFAULT_STRUCTURE], settings: { url: '', journal: '', autoPost: '0', accounts: {} }, cache: { accounts: [], journals: [] } };
let lastRun = null;

const load = async () => { const d = await chrome.storage.local.get('payroll'); if (d.payroll) S = { ...S, ...d.payroll }; };
const save = () => chrome.storage.local.set({ payroll: S });

// ---------- Odoo bridge ----------
async function odooTab() {
  const url = (S.settings.url || '').replace(/\/+$/, '');
  if (!url) throw new Error('Set the Odoo URL in Settings first.');
  const origin = new URL(url).origin;
  if (!origin.endsWith('.odoo.com') && !(await chrome.permissions.contains({ origins: [origin + '/*'] }))) throw new Error('Click Connect in 1. Odoo connection to allow access to ' + origin + '.');
  const tabs = await chrome.tabs.query({ url: origin + '/*' });
  if (!tabs.length) throw new Error('Open and log in to ' + origin + ' in another tab, then try again.');
  return tabs[0].id;
}
async function odooViaTab(model, method, args = [], kwargs = {}) {
  const tabId = await odooTab();
  const [res] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async (model, method, args, kwargs) => {
      const r = await fetch('/web/dataset/call_kw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { model, method, args, kwargs } }) }).then(r => r.json());
      return r.error ? { __error: (r.error.data && r.error.data.message) || r.error.message } : { result: r.result };
    },
    args: [model, method, args, kwargs],
  });
  if (!res || !res.result) throw new Error('No answer from the Odoo tab. Reload it and try again.');
  if (res.result.__error) throw new Error(res.result.__error);
  return res.result.result;
}

// --- External API (API key). Tries Odoo's JSON-2 API first, then classic JSON-RPC. ---
const ARGNAMES = { search_read: ['domain', 'fields'], search: ['domain'], search_count: ['domain'], read: ['ids', 'fields'], write: ['ids', 'vals'], create: ['vals_list'], default_get: ['fields'], action_post: ['ids'], fields_get: ['allfields'] };
let rpcUid = null;
async function apiBase() {
  const url = (S.settings.url || '').replace(/\/+$/, '');
  if (!url || !S.settings.key) throw new Error('Fill the Odoo URL and API key in 1. Odoo connection.');
  const origin = new URL(url).origin;
  if (!origin.endsWith('.odoo.com') && !(await chrome.permissions.contains({ origins: [origin + '/*'] }))) throw new Error('Click Connect in 1. Odoo connection to allow access to ' + origin + '.');
  return url;
}
async function odooJson2(model, method, args, kwargs) {
  const url = await apiBase();
  const names = ARGNAMES[method] || [];
  const body = { ...kwargs };
  let single = false;
  args.forEach((v, i) => {
    let n = names[i] || 'arg' + i;
    if (method === 'create' && !Array.isArray(v)) { v = [v]; single = true; }
    body[n] = v;
  });
  const r = await fetch(`${url}/json/2/${model}/${method}`, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', 'Authorization': 'bearer ' + S.settings.key, ...(S.settings.db ? { 'X-Odoo-Database': S.settings.db } : {}) }, body: JSON.stringify(body) });
  if (r.status === 404 && !(await r.clone().text()).includes('"name"')) throw Object.assign(new Error('json2-missing'), { fallback: true });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error((data && (data.message || (data.error && data.error.message))) || `Odoo API error ${r.status}`);
  return single && Array.isArray(data) ? data[0] : data;
}
async function odooJsonRpc(model, method, args, kwargs) {
  const url = await apiBase();
  const call = async (service, m, a) => {
    const r = await fetch(`${url}/jsonrpc`, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method: m, args: a } }) }).then(r => r.json());
    if (r.error) throw new Error((r.error.data && r.error.data.message) || r.error.message);
    return r.result;
  };
  if (!rpcUid) {
    if (!S.settings.db) { try { const l = await call('db', 'list', []); if (l.length === 1) S.settings.db = l[0]; } catch (_) {} if (!S.settings.db) S.settings.db = new URL(url).hostname.split('.')[0]; }
    if (!S.settings.login) throw new Error('This Odoo version (17/18) needs the Login (email) of the API key owner.');
    rpcUid = await call('common', 'authenticate', [S.settings.db, S.settings.login, S.settings.key, {}]);
    if (!rpcUid) throw new Error('Login or API key is wrong.');
  }
  return call('object', 'execute_kw', [S.settings.db, rpcUid, S.settings.key, model, method, args, kwargs]);
}
let useRpc = false;
async function odoo(model, method, args = [], kwargs = {}) {
  if ((S.settings.mode || 'api') === 'tab') return odooViaTab(model, method, args, kwargs);
  if (!useRpc) {
    try { return await odooJson2(model, method, args, kwargs); }
    catch (e) { if (!e.fallback) throw e; useRpc = true; }
  }
  return odooJsonRpc(model, method, args, kwargs);
}

// ---------- Salary engine ----------
function compute(emp, structure, paidDays, monthDays) {
  const fullGross = Number(emp.gross) || 0;
  const factor = monthDays > 0 ? Math.min(paidDays, monthDays) / monthDays : 0;
  const gross = fullGross * factor;
  const lines = []; const byCode = {};
  const applies = c => !(c.maxGross !== '' && c.maxGross != null && fullGross > Number(c.maxGross));
  const amount = (c) => {
    const v = Number(c.value) || 0; let a = 0;
    if (c.method === 'pct_gross') a = gross * v / 100;
    else if (c.method === 'pct_basic') a = (byCode.BASIC || 0) * v / 100;
    else if (c.method === 'fixed') a = c.type === 'earning' ? v * factor : (factor > 0 ? v : 0);
    if (c.max !== '' && c.max != null && Number(c.max) > 0) a = Math.min(a, Number(c.max));
    return Math.round(a);
  };
  const ov = emp.overrides || {};
  structure = { ...structure, components: structure.components.map(c => ({ ...c, ...(ov[c.code] || {}) })) };
  const earnings = structure.components.filter(c => c.type === 'earning');
  let used = 0;
  for (const c of earnings.filter(c => c.method !== 'balance')) { if (!applies(c)) continue; const a = amount(c); byCode[c.code] = a; used += a; lines.push({ ...c, amount: a }); }
  for (const c of earnings.filter(c => c.method === 'balance')) { const a = Math.max(0, Math.round(gross) - used); byCode[c.code] = a; used += a; lines.push({ ...c, amount: a }); }
  for (const c of structure.components.filter(c => c.type !== 'earning')) { if (!applies(c)) continue; const a = amount(c); byCode[c.code] = a; lines.push({ ...c, amount: a }); }
  const totalEarn = lines.filter(l => l.type === 'earning').reduce((s, l) => s + l.amount, 0);
  const totalDed = lines.filter(l => l.type === 'deduction').reduce((s, l) => s + l.amount, 0);
  const totalEmp = lines.filter(l => l.type === 'employer').reduce((s, l) => s + l.amount, 0);
  return { emp, structure, paidDays, monthDays, lines, totalEarn, totalDed, totalEmp, net: totalEarn - totalDed };
}

// ---------- Tabs ----------
$$('nav button').forEach(b => b.onclick = () => {
  $$('nav button').forEach(x => x.classList.toggle('active', x === b));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === b.dataset.tab));
  if (b.dataset.tab === 'payroll') renderAttendance();
  if (b.dataset.tab === 'run') wzInit();
  if (b.dataset.tab === 'history') renderHistory();
});

// ---------- Employees ----------
function structOptions(sel) { sel.innerHTML = S.structures.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join(''); }
function renderEmployees() {
  structOptions($('#empForm [name=structure]'));
  $('#empTable tbody').innerHTML = S.employees.map(e => `<tr>
    <td>${esc(e.code)}</td><td>${esc(e.name)}</td><td>${esc((S.structures.find(s => s.id === e.structure) || {}).name || '—')}</td>
    <td class="num">${money(e.gross)}</td><td>${e.partnerId ? '<span class="ok">#' + e.partnerId + '</span>' : '—'}</td>
    <td><button class="link" data-edit="${e.id}">Edit</button><button class="link" data-pay="${e.id}">Pay structure${Object.keys(e.overrides || {}).length ? ' (' + Object.keys(e.overrides).length + ' own)' : ''}</button><button class="link danger" data-del="${e.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="6" class="hint">No employees yet.</td></tr>';
  $$('#empTable [data-pay]').forEach(b => b.onclick = () => { wz.emp = S.employees.find(e => e.id === b.dataset.pay); $('nav button[data-tab=run]').click(); wzMonthDays(); wzShow(); document.querySelector('#wzStruct').scrollIntoView({ block: 'center' }); });
  $$('#empTable [data-edit]').forEach(b => b.onclick = () => fillEmp(S.employees.find(e => e.id === b.dataset.edit)));
  $$('#empTable [data-del]').forEach(b => b.onclick = () => { if (confirm('Delete this employee from the extension? (The Odoo contact is kept.)')) { S.employees = S.employees.filter(e => e.id !== b.dataset.del); save(); renderEmployees(); } });
  empPreview();
}
function fillEmp(e) {
  const f = $('#empForm'); f.reset();
  for (const [k, v] of Object.entries(e || {})) if (f.elements[k] && f.elements[k].type !== 'checkbox') f.elements[k].value = v;
  $('#empFormTitle').textContent = e ? 'Edit employee' : 'New employee'; empPreview(); window.scrollTo(0, 0);
}
function empPreview() {
  const f = $('#empForm'); const st = S.structures.find(s => s.id === f.elements.structure.value);
  if (!st || !Number(f.elements.gross.value)) { $('#empPreview').textContent = ''; return; }
  const r = compute({ gross: f.elements.gross.value }, st, 30, 30);
  $('#empPreview').innerHTML = 'Full-month split: ' + r.lines.filter(l => l.type !== 'employer').map(l => `${esc(l.code)} ${cur(l.amount)}`).join(' · ') + ` → <b>Net ${cur(r.net)}</b>`;
}
$('#empForm').addEventListener('input', empPreview);
$('#empReset').onclick = () => fillEmp(null);
$('#empForm').onsubmit = async ev => {
  ev.preventDefault();
  const f = ev.target; const data = Object.fromEntries(new FormData(f)); const toOdoo = f.elements.toOdoo.checked; delete data.toOdoo;
  if (S.employees.some(e => e.code === data.code && e.id !== data.id)) return alert('Employee code already used.');
  let emp = S.employees.find(e => e.id === data.id);
  if (emp) Object.assign(emp, data); else { emp = { ...data, id: uid() }; S.employees.push(emp); }
  await save();
  if (toOdoo) {
    try {
      const vals = { name: data.name, email: data.email || false, phone: data.phone || false, ref: data.code, comment: `Payroll worker. Tax ID: ${data.pan || '-'} | Social security no.: ${data.uan || '-'} | Insurance no.: ${data.esi || '-'} | Bank code: ${data.ifsc || '-'}` };
      if (emp.partnerId) await odoo('res.partner', 'write', [[emp.partnerId], vals]);
      else emp.partnerId = await odoo('res.partner', 'create', [vals]);
      if (data.bank) {
        const ex = await odoo('res.partner.bank', 'search', [[['partner_id', '=', emp.partnerId], ['acc_number', '=', data.bank]]]);
        if (!ex.length) await odoo('res.partner.bank', 'create', [{ partner_id: emp.partnerId, acc_number: data.bank }]).catch(() => {});
      }
      await save();
    } catch (e) { alert('Saved in the extension, but the Odoo contact failed: ' + e.message); }
  }
  fillEmp(null); renderEmployees();
};

// ---------- Structures ----------
function compRow(c = {}) {
  const tr = document.createElement('tr');
  const opt = (o, v) => Object.entries(o).map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
  tr.innerHTML = `<td><input data-k="code" value="${esc(c.code)}" required></td><td><input data-k="name" value="${esc(c.name)}"></td>
    <td><select data-k="type">${opt(TYPES, c.type || 'earning')}</select></td><td><select data-k="method">${opt(METHODS, c.method || 'fixed')}</select></td>
    <td><input data-k="value" type="number" step="any" value="${esc(c.value)}"></td><td><input data-k="max" type="number" step="any" value="${esc(c.max)}"></td>
    <td><input data-k="maxGross" type="number" step="any" value="${esc(c.maxGross)}"></td><td><select data-k="role">${opt(ROLES, c.role || 'expense')}</select></td>
    <td><select data-k="account"><option value="">— use role —</option>${S.cache.accounts.map(a => `<option value="${a.id}" ${String(a.id) === String(c.account) ? 'selected' : ''}>${esc(a.code)} ${esc(a.name)}</option>`).join('')}</select>${c.review ? `<div class="hint bad" title="${esc(c.review)}">Check: ${esc(c.review)}</div>` : ''}</td>
    <td><button type="button" class="link danger">✕</button></td>`;
  tr.querySelector('button').onclick = () => tr.remove();
  $('#compTable tbody').appendChild(tr);
}
function fillStructure(s) {
  $('#stForm').reset(); $('#compTable tbody').innerHTML = '';
  $('#stForm').elements.id.value = s ? s.id : ''; $('#stForm').elements.name.value = s ? s.name : '';
  (s ? s.components : [{ code: 'BASIC', type: 'earning', method: 'pct_gross', value: 50 }]).forEach(compRow);
}
function renderStructures() {
  $('#stTable tbody').innerHTML = S.structures.map(s => `<tr><td>${esc(s.name)}</td><td>${s.components.map(c => esc(c.code)).join(', ')}</td>
    <td><button class="link" data-edit="${s.id}">Edit</button><button class="link" data-copy="${s.id}">Copy</button><button class="link danger" data-del="${s.id}">Delete</button></td></tr>`).join('');
  $$('#stTable [data-edit]').forEach(b => b.onclick = () => fillStructure(S.structures.find(s => s.id === b.dataset.edit)));
  $$('#stTable [data-copy]').forEach(b => b.onclick = () => { const s = structuredClone(S.structures.find(s => s.id === b.dataset.copy)); s.id = ''; s.name += ' (copy)'; fillStructure(s); });
  $$('#stTable [data-del]').forEach(b => b.onclick = () => {
    if (S.employees.some(e => e.structure === b.dataset.del)) return alert('Employees use this structure. Change them first.');
    if (confirm('Delete structure?')) { S.structures = S.structures.filter(s => s.id !== b.dataset.del); save(); renderStructures(); renderEmployees(); }
  });
}
$('#addComp').onclick = () => compRow();
$('#stReset').onclick = () => fillStructure(null);
$('#stForm').onsubmit = ev => {
  ev.preventDefault();
  const comps = $$('#compTable tbody tr').map(tr => Object.fromEntries($$('[data-k]', tr).map(i => [i.dataset.k, i.value.trim()])));
  if (!comps.length) return alert('Add at least one component.');
  if (comps.some(c => c.method === 'pct_basic') && !comps.some(c => c.code === 'BASIC')) return alert('A component uses "% of BASIC" but there is no component with code BASIC.');
  const id = ev.target.elements.id.value || uid(); const old = S.structures.find(x => x.id === id) || {}; const s = { ...old, id, name: ev.target.elements.name.value, components: comps };
  const i = S.structures.findIndex(x => x.id === id); if (i >= 0) S.structures[i] = s; else S.structures.push(s);
  save(); renderStructures(); renderEmployees(); fillStructure(s); alert('Structure saved.');
};


// ---------- Import pay structure from Odoo Payroll ----------
$('#loadStructs').onclick = async () => {
  const msg = $('#importMsg'); msg.textContent = 'Loading…';
  try {
    const st = await odoo('hr.payroll.structure', 'search_read', [[], ['name', 'rule_ids']]);
    $('#odooStructs').innerHTML = '<option value="">— Odoo Payroll structures —</option>' + st.map(s => `<option value="${s.id}">${esc(s.name)} (${s.rule_ids.length} rules)</option>`).join('');
    msg.innerHTML = `<span class="ok">${st.length} structure(s) found.</span>`;
  } catch (e) { msg.innerHTML = `<span class="bad">${esc(e.message)} (Is the Payroll app installed in this database?)</span>`; }
};
function mapRule(r, cats, defaults) {
  const catCodes = r.category_ids.map(id => cats[id]).filter(Boolean);
  const all = catCodes.join(' ');
  if (/\b(GROSS|NET)\b/.test(all) && !/\b(BASIC|ALW|DED|COMP)\b/.test(all)) return null; // totals are computed by the extension
  let type = 'earning';
  if (/\bCOMP\b/.test(all)) type = 'employer';
  else if (/\b(DED|PBS|NONTAX)\b/.test(all)) type = 'deduction';
  const c = { code: r.code, name: r.name, type, method: 'fixed', value: 0, max: '', maxGross: '', role: 'expense', account: '' };
  const acc = type === 'earning' ? r.account_debit : (r.account_credit || r.account_debit);
  if (acc) c.account = acc[0];
  const code = (r.code || '').toUpperCase();
  if (type !== 'earning') c.role = /PF|EPF/.test(code) ? 'pf' : /ESI|ESIC/.test(code) ? 'esi' : /PT|PROF/.test(code) ? 'pt' : /TDS|TAX/.test(code) ? 'tds' : 'other';
  const py = r.amount_python_compute || '';
  if (r.amount_select === 'fix') { c.method = 'fixed'; c.value = r.amount_fix; }
  else if (r.amount_select === 'percentage') {
    c.method = /BASIC/.test(r.amount_percentage_base || '') ? 'pct_basic' : 'pct_gross'; c.value = r.amount_percentage;
  } else if (r.amount_select === 'code') {
    const base = /result\s*=\s*categories\[['"]BASIC['"]\]/.test(py) ? 'pct_basic' : /result\s*=\s*categories\[['"]GROSS['"]\]/.test(py) ? 'pct_gross' : null;
    const rate = py.match(/result_rate\s*=\s*(?:version|contract)\.(\w+)(\s*\*\s*100)?/);
    if (code === 'BASIC' || /_get_basic_salary/.test(py)) {
      c.method = 'pct_gross'; const f = rate && rate[1]; const d = (f && defaults[f]) || null;
      c.value = d != null ? Math.round(d * (rate[2] ? 100 : 1) * 100) / 100 : 50;
      if (d == null) c.review = 'Basic % taken as 50 – set it';
    } else if (base && rate) {
      c.method = base; const d = defaults[rate[1]];
      c.value = d != null ? Math.round(d * (rate[2] ? 100 : 1) * 100) / 100 : 0;
      c.review = d != null ? `Odoo default (${rate[1]}) – confirm` : `Set % (Odoo field ${rate[1]})`;
    } else if (/balance|GROSS.*-|- *categories/i.test(py) && type === 'earning') {
      c.method = 'balance'; c.review = 'Python rule mapped to Balance – confirm';
    } else { c.review = 'Python rule – set calculation manually'; }
  } else { c.review = 'Input-based rule – set value manually'; }
  return c;
}
$('#importStruct').onclick = async () => {
  const id = Number($('#odooStructs').value); const msg = $('#importMsg');
  if (!id) return msg.innerHTML = '<span class="bad">Load and pick a structure first.</span>';
  msg.textContent = 'Importing…';
  try {
    if (!S.cache.accounts.length) S.cache.accounts = await odoo('account.account', 'search_read', [[], ['code', 'name']], { order: 'code', limit: 3000 });
    const sf = await odoo('hr.payroll.structure', 'fields_get', [], { attributes: ['type'] });
    const [st] = await odoo('hr.payroll.structure', 'read', [[id], ['name'].concat(sf.journal_id ? ['journal_id'] : [])]);
    const rf = await odoo('hr.salary.rule', 'fields_get', [], { attributes: ['type'] });
    const structF = rf.struct_ids ? 'struct_ids' : 'struct_id'; const catF = rf.category_ids ? 'category_ids' : 'category_id';
    const rulesRaw = await odoo('hr.salary.rule', 'search_read', [[[structF, 'in', [id]], ['active', '=', true]], ['name', 'code', 'sequence', catF, 'amount_select', 'amount_fix', 'amount_percentage', 'amount_percentage_base', 'amount_python_compute', 'account_debit', 'account_credit'].filter(f => rf[f] || f === catF)], { order: 'sequence' });
    const rules = rulesRaw.map(r => ({ ...r, category_ids: Array.isArray(r[catF]) ? (catF === 'category_id' ? [r[catF][0]] : r[catF]) : [] }));
    const cats = Object.fromEntries((await odoo('hr.salary.rule.category', 'search_read', [[], ['code']])).map(c => [c.id, c.code]));
    const fields = [...new Set(rules.flatMap(r => [...(r.amount_python_compute || '').matchAll(/(?:version|contract)\.(\w+)/g)].map(m => m[1])))];
    let defaults = {};
    if (fields.length) {
      for (const mdl of ['hr.version', 'hr.contract']) {
        for (const call of [() => odoo(mdl, 'default_get', [fields]), () => odoo(mdl, 'default_get', [], { fields_list: fields })]) {
          try { defaults = await call() || {}; break; } catch (_) {}
        }
        if (Object.keys(defaults).length) break;
      }
    }
    const missingF = fields.filter(f => !defaults[f]);
    if (missingF.length) { for (const mdl of ['hr.version', 'hr.contract']) { try { const [v] = await odoo(mdl, 'search_read', [[], missingF], { limit: 1, order: 'id desc' }); if (v) missingF.forEach(f => { if (typeof v[f] === 'number' && v[f]) defaults[f] = v[f]; }); break; } catch (_) {} } }
    const comps = rules.map(r => mapRule(r, cats, defaults)).filter(Boolean);
    const netRule = rules.find(r => r.code === 'NET'); const netAcc = netRule && (netRule.account_credit || netRule.account_debit);
    const sid = 'odoo-' + id; const s = { id: sid, name: st.name + ' (from Odoo)', odooId: id, journalId: st.journal_id ? st.journal_id[0] : '', netAccount: netAcc ? netAcc[0] : '', components: comps };
    const i = S.structures.findIndex(x => x.id === sid); if (i >= 0) S.structures[i] = s; else S.structures.push(s);
    await save(); renderStructures(); renderEmployees(); fillStructure(s);
    const rev = comps.filter(c => c.review).length;
    msg.innerHTML = `<span class="ok">Imported ${comps.length} components from "${esc(st.name)}".</span> ${rev ? `<b>${rev} need checking</b> (marked in red below) – Odoo Python rules can't be copied exactly. Fix them and click Save structure.` : ''}`;
  } catch (e) { msg.innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
};

// ---------- Attendance & salary ----------
const attGet = (m, id, def) => { const v = ((S.attendance || {})[m] || {})[id]; return v != null && v !== '' ? v : def; };
const attSet = (m, id, v) => { S.attendance = S.attendance || {}; (S.attendance[m] = S.attendance[m] || {})[id] = v; save(); };
function renderAttendance() {
  const m = $('#runMonth');
  if (!m.value) { const d = new Date(); d.setMonth(d.getMonth() - 1); m.value = d.toISOString().slice(0, 7); }
  const [y, mo] = m.value.split('-').map(Number); if (!$('#runDays').value) $('#runDays').value = new Date(y, mo, 0).getDate();
  const days = Number($('#runDays').value);
  $('#attTable tbody').innerHTML = S.employees.map(e => `<tr><td>${esc(e.code)}</td><td>${esc(e.name)}</td>
    <td>${esc((S.structures.find(s => s.id === e.structure) || {}).name || '—')}</td><td class="num">${money(e.gross)}</td>
    <td><input type="number" min="0" max="31" step="0.5" data-emp="${e.id}" value="${attGet(m.value, e.id, days)}"></td></tr>`).join('') || '<tr><td colspan="5" class="hint">Add employees first.</td></tr>';
}
$('#runMonth').onchange = () => { const [y, mo] = $('#runMonth').value.split('-').map(Number); $('#runDays').value = new Date(y, mo, 0).getDate(); renderAttendance(); };
const monthLabel = m => new Date(m + '-01').toLocaleString(LOCALE(), { month: 'long', year: 'numeric' });
const monthEnd = m => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`; };
const postKey = r => `${lastRun.month}|${r.emp.id}`;
S.posted = S.posted || {};

function renderResults() {
  const results = lastRun.results;
  const codes = []; results.forEach(r => r.lines.forEach(l => { if (!codes.find(c => c.code === l.code)) codes.push({ code: l.code, type: l.type }); }));
  const ord = ['earning', 'deduction', 'employer']; codes.sort((a, b) => ord.indexOf(a.type) - ord.indexOf(b.type));
  const val = (r, code) => { const l = r.lines.find(l => l.code === code); return l ? money(l.amount) : '–'; };
  const sum = f => money(results.reduce((s, r) => s + f(r), 0));
  const status = r => { const id = (S.posted || {})[postKey(r)]; return id ? `<a href="${esc(S.settings.url.replace(/\/+$/, ''))}/odoo/action-account.action_move_journal_line/${id}" target="_blank" class="ok">Entry #${id}</a>` : '<span class="hint">Not posted</span>'; };
  $('#resTable').innerHTML = `<thead><tr><th>Code</th><th>Name</th><th class="num">Days</th>${codes.map(c => `<th class="num">${esc(c.code)}</th>`).join('')}<th class="num">Earnings</th><th class="num">Deductions</th><th class="num">Net pay</th><th>Odoo</th><th></th></tr></thead>
    <tbody>${results.map((r, i) => `<tr><td>${esc(r.emp.code)}</td><td>${esc(r.emp.name)}</td><td class="num">${r.paidDays}</td>${codes.map(c => `<td class="num">${val(r, c.code)}</td>`).join('')}
    <td class="num">${money(r.totalEarn)}</td><td class="num">${money(r.totalDed)}</td><td class="num"><b>${money(r.net)}</b></td><td>${status(r)}</td>
    <td style="white-space:nowrap"><button class="link" data-print="${i}">🖨 Payslip</button><button class="link" data-post="${i}">Post</button></td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="${3 + codes.length}">Total</td><td class="num">${sum(r => r.totalEarn)}</td><td class="num">${sum(r => r.totalDed)}</td><td class="num">${sum(r => r.net)}</td><td colspan="2"></td></tr></tfoot>`;
  $$('#resTable [data-print]').forEach(b => b.onclick = () => printSlips([results[b.dataset.print]]));
  $$('#resTable [data-post]').forEach(b => b.onclick = () => postResults([results[b.dataset.post]], 'single'));
  $('#resultCard').hidden = false;
}
$('#attTable').addEventListener('input', ev => { const i = ev.target; if (i.dataset.emp) attSet($('#runMonth').value, i.dataset.emp, i.value); });
$('#calcBtn').onclick = () => {
  const monthDays = Number($('#runDays').value);
  const results = $$('#attTable [data-emp]').map(i => {
    const e = S.employees.find(x => x.id === i.dataset.emp); const st = S.structures.find(s => s.id === e.structure);
    return st ? compute(e, st, Number(i.value) || 0, monthDays) : null;
  }).filter(Boolean);
  if (!results.length) return;
  lastRun = { month: $('#runMonth').value, monthDays, results };
  recordHistory(results, lastRun.month); $('#postMsg').textContent = ''; renderResults();
};
$('#csvBtn').onclick = () => {
  if (!lastRun) return;
  const codes = [...new Set(lastRun.results.flatMap(r => r.lines.map(l => l.code)))];
  const rows = [['Code', 'Name', 'Paid days', ...codes, 'Earnings', 'Deductions', 'Net', 'Employer']];
  lastRun.results.forEach(r => rows.push([r.emp.code, r.emp.name, r.paidDays, ...codes.map(c => (r.lines.find(l => l.code === c) || {}).amount ?? ''), r.totalEarn, r.totalDed, r.net, r.totalEmp]));
  const blob = new Blob([rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `salary_${lastRun.month}.csv`; a.click();
};

// ---------- Payslip print ----------
function inWords(n) {
  n = Math.round(n); if (!n) return 'Zero';
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const t = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = x => x < 20 ? a[x] : t[Math.floor(x / 10)] + (x % 10 ? ' ' + a[x % 10] : '');
  const three = x => (x >= 100 ? a[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') + (x % 100 ? two(x % 100) : '');
  if (CUR().name !== 'INR') { const p = []; const b = Math.floor(n / 1e9), m = Math.floor(n / 1e6) % 1000, th = Math.floor(n / 1e3) % 1000, r = n % 1000; if (b) p.push(three(b) + ' Billion'); if (m) p.push(three(m) + ' Million'); if (th) p.push(three(th) + ' Thousand'); if (r) p.push(three(r)); return p.join(' '); }
  const parts = []; const cr = Math.floor(n / 1e7), la = Math.floor(n / 1e5) % 100, th = Math.floor(n / 1e3) % 100, rest = n % 1000;
  if (cr) parts.push(three(cr) + ' Crore'); if (la) parts.push(two(la) + ' Lakh'); if (th) parts.push(two(th) + ' Thousand'); if (rest) parts.push(three(rest));
  return parts.join(' ');
}
function printSlips(results, month = lastRun.month) {
  const co = S.cache.company || {}; const m = monthLabel(month);
  const slip = r => {
    const earn = r.lines.filter(l => l.type === 'earning' && l.amount); const ded = r.lines.filter(l => l.type === 'deduction' && l.amount);
    const n = Math.max(earn.length, ded.length);
    const rows = Array.from({ length: n }, (_, i) => `<tr><td>${esc(earn[i] ? earn[i].name || earn[i].code : '')}</td><td class="r">${earn[i] ? money(earn[i].amount) : ''}</td><td>${esc(ded[i] ? ded[i].name || ded[i].code : '')}</td><td class="r">${ded[i] ? money(ded[i].amount) : ''}</td></tr>`).join('');
    return `<div class="slip">
      <div class="head"><div><div class="co">${esc(co.name || '')}</div><div class="addr">${esc([co.street, co.city, co.zip].filter(Boolean).join(', '))}</div></div><div class="title">Payslip<br><span>${m}</span></div></div>
      <table class="info">
        <tr><th>Employee name</th><td>${esc(r.emp.name)}</td><th>Employee code</th><td>${esc(r.emp.code)}</td></tr>
        <tr><th>Joining date</th><td>${esc(r.emp.joining || '-')}</td><th>Pay period</th><td>${month}-01 to ${monthEnd(month)}</td></tr>
        <tr><th>Tax ID</th><td>${esc(r.emp.pan || '-')}</td><th>Social security no.</th><td>${esc(r.emp.uan || '-')}</td></tr>
        <tr><th>Insurance no.</th><td>${esc(r.emp.esi || '-')}</td><th>Paid days</th><td>${r.paidDays} of ${r.monthDays}</td></tr>
        <tr><th>Bank account</th><td>${esc(r.emp.bank || '-')}</td><th>Bank code</th><td>${esc(r.emp.ifsc || '-')}</td></tr>
      </table>
      <table class="pay"><thead><tr><th>Earnings</th><th class="r">Amount${CUR().symbol ? " (" + esc(CUR().symbol) + ")" : ""}</th><th>Deductions</th><th class="r">Amount${CUR().symbol ? " (" + esc(CUR().symbol) + ")" : ""}</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th>Gross earnings</th><th class="r">${money(r.totalEarn)}</th><th>Total deductions</th><th class="r">${money(r.totalDed)}</th></tr></tfoot></table>
      <div class="net"><div>Net pay</div><div class="amt">${cur(r.net)}</div></div>
      <p class="words">Amount in words: ${inWords(r.net)} ${esc(CUR().name === 'INR' ? 'Rupees' : (CUR().unitLabel || CUR().name || ''))} only</p>
      <div class="sign"><div>Employee signature</div><div>Authorised signatory</div></div>
      <p class="foot">This is a computer-generated payslip.</p></div>`;
  };
  const w = window.open('', '_blank');
  w.document.write(`<!doctype html><title>Payslip ${esc(results.length === 1 ? results[0].emp.name : '')} ${month}</title><style>
    @page{size:A4;margin:12mm}body{font:12px/1.4 Arial,sans-serif;color:#111;margin:0}
    .slip{border:1px solid #333;padding:14px 16px;page-break-after:always;margin-bottom:16px}.slip:last-child{page-break-after:auto}
    .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #333;padding-bottom:8px;margin-bottom:10px}
    .co{font-size:17px;font-weight:700}.addr{color:#555}.title{text-align:right;font-size:16px;font-weight:700}.title span{font-size:13px;font-weight:400}
    table{width:100%;border-collapse:collapse;margin-bottom:10px}th,td{border:1px solid #bbb;padding:5px 7px;text-align:left}
    .info th{background:#f2f2f2;width:18%;font-weight:600}.pay thead th,.pay tfoot th{background:#f2f2f2}.r{text-align:right}
    .net{display:flex;justify-content:space-between;align-items:center;border:2px solid #333;padding:8px 12px;font-size:15px;font-weight:700}
    .words{margin:8px 0 28px}.sign{display:flex;justify-content:space-between;margin-top:30px}.sign div{border-top:1px solid #333;padding-top:4px;width:40%;text-align:center}
    .foot{color:#777;font-size:10px;text-align:center;margin-top:14px}</style>${results.map(slip).join('')}`);
  w.document.close(); setTimeout(() => w.print(), 300);
}
$('#slipsBtn').onclick = () => lastRun && printSlips(lastRun.results);

// ---------- Accounting (mirrors Odoo Payroll's payslip entry) ----------
// Odoo: each salary rule with an account makes a line; earnings debit their expense account,
// deductions credit their payable account, the NET rule credits Salaries payable for the employee,
// lines carry the employee as partner unless lines are grouped, date = end of period, journal = structure's journal.
function buildLines(results, grouped) {
  const acc = S.settings.accounts || {}; const lines = []; const missing = new Set();
  const add = (account, label, partner, debit, credit, roleName) => {
    if (!debit && !credit) return; if (!account) { missing.add(roleName); return; }
    lines.push({ account_id: Number(account), name: label, partner_id: partner || false, debit: Math.round(debit * 100) / 100, credit: Math.round(credit * 100) / 100 });
  };
  for (const r of results) {
    const p = r.emp.partnerId;
    for (const l of r.lines) {
      if (!l.amount) continue;
      if (l.type === 'earning') add(l.account || acc.expense, l.name || l.code, p, l.amount, 0, ROLES.expense);
      else if (l.type === 'deduction') add(l.account || acc[l.role] || acc.other, l.name || l.code, p, 0, l.amount, ROLES[l.role] || ROLES.other);
      else { add(acc.employer_exp, l.name || l.code, p, l.amount, 0, ROLES.employer_exp); add(l.account || acc[l.role] || acc.other, l.name || l.code, p, 0, l.amount, ROLES[l.role] || ROLES.other); }
    }
    add(r.structure.netAccount || acc.payable, 'Net Salary', p, 0, r.net, ROLES.payable);
  }
  let out = lines;
  if (grouped) {
    const m = new Map();
    for (const l of lines) { const k = l.account_id + '|' + (l.debit ? 'D' : 'C'); const g = m.get(k) || { ...l, partner_id: false, debit: 0, credit: 0 }; g.debit += l.debit; g.credit += l.credit; m.set(k, g); }
    out = [...m.values()];
  }
  const d = out.reduce((s, l) => s + l.debit, 0), c = out.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(d - c) > 0.001) missing.add('balanced entry (debit ' + d + ' vs credit ' + c + ')');
  return { lines: out, missing: [...missing] };
}

// ---------- Automatic journal & account setup ----------
// Finds the right journal and accounts in the Odoo chart; creates any that are missing. Never overwrites a choice made by the user.
const ACC_RULES = {
  expense: { find: /(salar|wage|payroll).*(exp)|^salar(y|ies)$|salary expense|wages?$/i, type: 'expense', name: 'Salary Expense' },
  employer_exp: { find: /employer.*(contrib|charge|expense)|social.*charge.*exp/i, type: 'expense', name: 'Employer Contribution Expense' },
  payable: { find: /(salar|wage|payroll|net pay).*(payable)|salary.*payable|salaries payable/i, type: 'liability_current', name: 'Salaries Payable' },
  pf: { find: /(provident|\bpf\b|pension|social security).*(payable)?/i, type: 'liability_current', name: 'Social Security / PF Payable' },
  esi: { find: /(\besi|esic|health insur|medical insur).*/i, type: 'liability_current', name: 'Health Insurance / ESI Payable' },
  pt: { find: /professional tax|local tax payable/i, type: 'liability_current', name: 'Professional Tax Payable' },
  tds: { find: /\btds\b|income tax.*(payable|withh)|withholding/i, type: 'liability_current', name: 'Income Tax Withheld Payable' },
  other: { find: /other (salary )?deduction|payroll deduction/i, type: 'liability_current', name: 'Other Payroll Deductions' },
};
async function loadChart() {
  try { S.cache.accounts = await odoo('account.account', 'search_read', [[], ['code', 'name', 'account_type']], { order: 'code', limit: 5000 }); }
  catch (_) { S.cache.accounts = await odoo('account.account', 'search_read', [[], ['code', 'name']], { order: 'code', limit: 5000 }); }
}
function nextCode(type) {
  const same = S.cache.accounts.filter(a => !a.account_type || a.account_type === type).map(a => a.code).filter(c => /^\d+$/.test(c || ''));
  const used = new Set(S.cache.accounts.map(a => a.code)); let n = same.length ? Math.max(...same.map(Number)) + 1 : (type === 'expense' ? 650000 : 260000);
  while (used.has(String(n))) n++; return String(n);
}
async function autoAccounting(log = () => {}, roles = ['expense', 'payable']) {
  if (!S.cache.accounts.length || !('account_type' in (S.cache.accounts[0] || {}))) await loadChart();
  S.settings.accounts = S.settings.accounts || {};
  const isType = (a, t) => !a.account_type || (t === 'expense' ? /expense/.test(a.account_type) : /liabilit|payable/.test(a.account_type));
  const order = Object.keys(ACC_RULES).filter(k => roles.includes(k)).sort((a, b) => (a === 'expense' || a === 'payable' ? -1 : 0) - (b === 'expense' || b === 'payable' ? -1 : 0));
  for (const role of order) { const r = ACC_RULES[role];
    if (S.settings.accounts[role] && S.cache.accounts.some(a => String(a.id) === String(S.settings.accounts[role]))) continue;
    let a = S.cache.accounts.find(a => isType(a, r.type) && r.find.test(a.name || ''));
    if (!a && role === 'employer_exp') a = S.cache.accounts.find(x => String(x.id) === String(S.settings.accounts.expense));
    if (!a && role === 'other') a = S.cache.accounts.find(x => String(x.id) === String(S.settings.accounts.payable));
    if (!a) {
      const code = nextCode(r.type);
      const id = await odoo('account.account', 'create', [{ code, name: r.name, account_type: r.type, ...(r.type === 'liability_current' ? { reconcile: true } : {}) }]);
      a = { id, code, name: r.name, account_type: r.type }; S.cache.accounts.push(a); log(`created account ${code} ${r.name}`);
    }
    S.settings.accounts[role] = String(a.id);
  }
  if (!S.settings.journal) {
    if (!S.cache.journals.length) S.cache.journals = await odoo('account.journal', 'search_read', [[['type', '=', 'general']], ['name', 'code']]);
    let j = S.cache.journals.find(j => /salar|payroll|wage/i.test(j.name) || /^(SLR|SAL|PAY)$/i.test(j.code));
    if (!j) {
      const codes = new Set(S.cache.journals.map(x => x.code)); const code = ['SAL', 'SLR', 'PAYR', 'SALX'].find(c => !codes.has(c));
      const id = await odoo('account.journal', 'create', [{ name: 'Salaries', code, type: 'general' }]);
      j = { id, name: 'Salaries', code }; S.cache.journals.push(j); log('created journal Salaries (' + code + ')');
    }
    S.settings.autoJournal = String(j.id);
  }
  await save(); if (typeof renderSettings === 'function') renderSettings();
}
async function ensureContact(emp) {
  if (emp.partnerId) return;
  emp.partnerId = await odoo('res.partner', 'create', [{ name: emp.name, email: emp.email || false, phone: emp.phone || false, ref: emp.code }]);
  await save();
}

function recordHistory(results, month, moveId) {
  S.history = S.history || {}; const h = (S.history[month] = S.history[month] || {});
  for (const r of results) {
    const prev = h[r.emp.id] || {};
    h[r.emp.id] = { emp: { ...r.emp }, structure: { name: r.structure.name }, paidDays: r.paidDays, monthDays: r.monthDays,
      lines: r.lines.map(l => ({ code: l.code, name: l.name, type: l.type, amount: l.amount })), totalEarn: r.totalEarn, totalDed: r.totalDed, totalEmp: r.totalEmp, net: r.net,
      moveId: moveId || prev.moveId || null, savedAt: new Date().toISOString() };
  }
  save();
}
async function postResults(results, mode, after = renderResults, msgEl) {
  const msg = msgEl || $('#postMsg');
  const already = results.filter(r => S.posted[postKey(r)]);
  if (already.length && !confirm(`${already.map(r => r.emp.name).join(', ')} already posted for ${monthLabel(lastRun.month)}. Post again?`)) return;
  msg.textContent = 'Preparing accounts…';
  try {
    const roles = new Set(['payable']);
    results.forEach(x => { if (!x.structure.netAccount) roles.add('payable'); x.lines.forEach(l => { if (!l.amount) return; if (l.type === 'earning') { if (!l.account) roles.add('expense'); } else { if (!l.account) roles.add(l.role || 'other'); if (l.type === 'employer') { roles.add('expense'); roles.add('employer_exp'); } } }); });
    await autoAccounting(undefined, [...roles]);
    for (const r of results) { await ensureContact(r.emp); }
  } catch (e) { return msg.innerHTML = `<span class="bad">Setup failed: ${esc(e.message)}</span>`; }
  const grouped = S.settings.groupLines === '1';
  const groups = mode === 'batch' ? [results] : results.map(r => [r]);
  const date = monthEnd(lastRun.month); const auto = (S.settings.autoPost ?? '1') === '1';
  const plans = groups.map(g => {
    const journal = S.settings.journal || g[0].structure.journalId || S.settings.autoJournal;
    const { lines, missing } = buildLines(g, grouped && mode === 'batch');
    return { g, journal, lines, missing };
  });
  const bad = plans.find(p => !p.journal || p.missing.length);
  if (bad) return msg.innerHTML = `<span class="bad">Can't post: ${esc(bad.missing.join(', ') || 'no journal')}.</span>`;
  const total = plans.reduce((s, p) => s + p.lines.length, 0);
  if (!confirm(`Create ${plans.length} ${auto ? 'POSTED' : 'draft'} journal entr${plans.length > 1 ? 'ies' : 'y'} dated ${date} (${total} lines) in Odoo?`)) return;
  msg.textContent = 'Posting…'; const done = [];
  try {
    for (const p of plans) {
      const ref = p.g.length === 1 ? `Payslip of ${p.g[0].emp.name} – ${monthLabel(lastRun.month)}` : `Payroll ${monthLabel(lastRun.month)}`;
      const id = await odoo('account.move', 'create', [{ move_type: 'entry', journal_id: Number(p.journal), date, ref, line_ids: p.lines.map(l => [0, 0, l]) }]);
      if (auto) await odoo('account.move', 'action_post', [[id]]);
      p.g.forEach(r => { S.posted[postKey(r)] = id; }); recordHistory(p.g, lastRun.month, id); done.push(id); await save();
    }
    msg.innerHTML = `<span class="ok">Created ${done.length} journal entr${done.length > 1 ? 'ies' : 'y'}: ${done.map(id => '#' + id).join(', ')}.</span>`;
  } catch (e) { msg.innerHTML = `<span class="bad">${esc(e.message)}</span>${done.length ? ' (already created: ' + done.map(id => '#' + id).join(', ') + ')' : ''}`; }
  after();
}
$('#postBtn').onclick = () => lastRun && postResults(lastRun.results, 'batch');
$('#postEachBtn').onclick = () => lastRun && postResults(lastRun.results, 'each');


// ---------- Run salary: one employee, step by step ----------
let wz = { emp: null, result: null };
const accName = id => { const a = S.cache.accounts.find(a => String(a.id) === String(id)); return a ? `${a.code} ${a.name}` : (id ? '#' + id : '—'); };
function wzInit() {
  $('#wzEmp').innerHTML = '<option value="">— Select employee —</option>' + S.employees.map(e => `<option value="${e.id}">${esc(e.code)} – ${esc(e.name)}</option>`).join('');
  if (wz.emp) $('#wzEmp').value = wz.emp.id;
  if (!$('#wzMonth').value) { const d = new Date(); d.setMonth(d.getMonth() - 1); $('#wzMonth').value = d.toISOString().slice(0, 7); wzMonthDays(); }
  wzShow();
}
function wzMonthDays() { const [y, m] = $('#wzMonth').value.split('-').map(Number); $('#wzDays').value = new Date(y, m, 0).getDate(); $('#wzPaid').value = wz.emp ? attGet($('#wzMonth').value, wz.emp.id, $('#wzDays').value) : $('#wzDays').value; }
function wzShow() {
  const e = wz.emp; $$('.wz-step').forEach(x => x.hidden = !e); if (!e) return;
  $('#wzStruct').innerHTML = S.structures.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('#wzStruct').value = e.structure; $('#wzGross').value = e.gross || '';
  wzComps(); wzCalc();
}
function wzComps() {
  const st = S.structures.find(s => s.id === $('#wzStruct').value); if (!st) return;
  const ov = (wz.emp.structure === st.id && wz.emp.overrides) || {};
  const opt = (o, v) => Object.entries(o).map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
  $('#wzCompTable tbody').innerHTML = st.components.map(c => { const o = { ...c, ...(ov[c.code] || {}) }; return `<tr data-code="${esc(c.code)}">
    <td>${esc(c.code)}</td><td>${esc(c.name || '')}</td><td>${TYPES[c.type]}</td>
    <td><select data-k="method">${opt(METHODS, o.method)}</select></td><td><input data-k="value" type="number" step="any" value="${esc(o.value)}"></td>
    <td>${ov[c.code] ? '<span class="ok">own value</span>' : '<span class="hint">structure</span>'}</td></tr>`; }).join('');
}
function wzRead() {
  const st = S.structures.find(s => s.id === $('#wzStruct').value);
  const overrides = {};
  $$('#wzCompTable tbody tr').forEach(tr => {
    const c = st.components.find(x => x.code === tr.dataset.code); const method = $('[data-k=method]', tr).value; const value = $('[data-k=value]', tr).value;
    if (method !== c.method || String(value) !== String(c.value)) overrides[c.code] = { method, value };
  });
  return { st, overrides, gross: $('#wzGross').value };
}
function wzCalc() {
  const { st, overrides, gross } = wzRead(); if (!st) return;
  const emp = { ...wz.emp, structure: st.id, gross, overrides };
  const r = compute(emp, st, Number($('#wzPaid').value) || 0, Number($('#wzDays').value) || 0);
  wz.result = r;
  const rows = t => r.lines.filter(l => l.type === t && l.amount).map(l => `<tr><td>${esc(l.name || l.code)}</td><td class="num">${money(l.amount)}</td></tr>`).join('') || '<tr><td colspan=2 class="hint">—</td></tr>';
  $('#wzSalary').innerHTML = `<div class="grid"><table><thead><tr><th>Earnings</th><th class="num">${esc(CUR().symbol)}</th></tr></thead><tbody>${rows('earning')}</tbody><tfoot><tr><td>Total</td><td class="num">${money(r.totalEarn)}</td></tr></tfoot></table>
    <table><thead><tr><th>Deductions</th><th class="num">${esc(CUR().symbol)}</th></tr></thead><tbody>${rows('deduction')}</tbody><tfoot><tr><td>Total</td><td class="num">${money(r.totalDed)}</td></tr></tfoot></table></div>
    <p style="font-size:16px"><b>Net pay: ${cur(r.net)}</b> <span class="hint">(${r.paidDays} of ${r.monthDays} days)</span></p>`;
  const { lines, missing } = buildLines([r], false);
  const d = lines.reduce((s, l) => s + l.debit, 0), c = lines.reduce((s, l) => s + l.credit, 0);
  const journal = S.settings.journal || st.journalId || S.settings.autoJournal; const j = S.cache.journals.find(x => String(x.id) === String(journal));
  $('#wzAcc').innerHTML = `<p class="hint">Journal: <b>${esc(j ? j.name : (journal ? '#' + journal : 'not set'))}</b> · Date: <b>${monthEnd($('#wzMonth').value)}</b> · Partner: <b>${r.emp.partnerId ? esc(r.emp.name) : 'none (no Odoo contact)'}</b></p>
    <table><thead><tr><th>Label</th><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>${lines.map(l => `<tr><td>${esc(l.name)}</td><td>${esc(accName(l.account_id))}</td><td class="num">${l.debit ? money(l.debit) : ''}</td><td class="num">${l.credit ? money(l.credit) : ''}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan=2>Total</td><td class="num">${money(d)}</td><td class="num">${money(c)}</td></tr></tfoot></table>
    ${missing.length || !journal ? '<p class="hint">Missing journal/accounts will be found or created automatically when you post.</p>' : ''}`;
  const posted = S.posted[`${$('#wzMonth').value}|${wz.emp.id}`];
  $('#wzPostMsg').innerHTML = posted ? `<span class="ok">Already posted for this month: Entry #${posted}</span>` : '';
}
$('#wzEmp').onchange = () => { wz.emp = S.employees.find(e => e.id === $('#wzEmp').value) || null; if (wz.emp) wzMonthDays(); wzShow(); };
$('#wzPaid').addEventListener('input', () => wz.emp && attSet($('#wzMonth').value, wz.emp.id, $('#wzPaid').value));
$('#wzStruct').onchange = () => { wzComps(); wzCalc(); };
$('#wzMonth').onchange = () => { wzMonthDays(); wzCalc(); };
['#wzGross', '#wzPaid', '#wzDays'].forEach(id => $(id).addEventListener('input', wzCalc));
$('#wzCompTable').addEventListener('input', wzCalc); $('#wzCompTable').addEventListener('change', wzCalc);
$('#wzSave').onclick = async () => {
  const { st, overrides, gross } = wzRead(); Object.assign(wz.emp, { structure: st.id, gross, overrides });
  await save(); renderEmployees(); wzComps(); wzCalc(); $('#wzSaveMsg').innerHTML = '<span class="ok">Saved as this employee\'s pay structure.</span>';
};
const wzRun = () => { wzCalc(); lastRun = { month: $('#wzMonth').value, monthDays: Number($('#wzDays').value), results: [wz.result] }; };
$('#wzPrint').onclick = () => { wzRun(); recordHistory(lastRun.results, lastRun.month); printSlips(lastRun.results); };
$('#wzPost').onclick = async () => { wzRun(); await postResults(lastRun.results, 'single', wzCalc, $('#wzPostMsg')); };


// ---------- History (previous months) ----------
function renderHistory() {
  const months = Object.keys(S.history || {}).sort().reverse();
  const sel = $('#histMonth'); const prevSel = sel.value;
  sel.innerHTML = months.length ? months.map(m => `<option value="${m}">${monthLabel(m)}</option>`).join('') : '<option value="">No records yet</option>';
  if (months.includes(prevSel)) sel.value = prevSel;
  const m = sel.value; const recs = Object.values((S.history || {})[m] || {});
  const base = (S.settings.url || '').replace(/\/+$/, '');
  const ids = [...new Set(recs.map(r => r.moveId).filter(Boolean))];
  $('#histSummary').innerHTML = m ? `${recs.length} employee(s) · Net total <b>${cur(recs.reduce((s, r) => s + r.net, 0))}</b> · ${ids.length ? 'Entries: ' + ids.map(id => `<a href="${esc(base)}/odoo/action-account.action_move_journal_line/${id}" target="_blank">#${id}</a>`).join(', ') : '<span class="hint">not posted</span>'}` : '';
  $('#histTable tbody').innerHTML = recs.sort((a, b) => String(a.emp.code).localeCompare(b.emp.code)).map(r => `<tr>
    <td>${esc(r.emp.code)}</td><td>${esc(r.emp.name)}</td><td>${esc(r.structure.name)}</td><td class="num">${r.paidDays} / ${r.monthDays}</td>
    <td class="num">${money(r.totalEarn)}</td><td class="num">${money(r.totalDed)}</td><td class="num"><b>${money(r.net)}</b></td>
    <td>${r.moveId ? `<a href="${esc(base)}/odoo/action-account.action_move_journal_line/${r.moveId}" target="_blank" class="ok">#${r.moveId}</a>` : '<span class="hint">Not posted</span>'}</td>
    <td><button class="link" data-hprint="${esc(r.emp.id)}">🖨 Payslip</button></td></tr>`).join('') || '<tr><td colspan="9" class="hint">Calculate or post a month to see it here.</td></tr>';
  $$('#histTable [data-hprint]').forEach(b => b.onclick = () => printSlips([histResult(m, b.dataset.hprint)], m));
}
const histResult = (m, id) => { const r = S.history[m][id]; return { ...r, structure: r.structure }; };
$('#histMonth').onchange = renderHistory;
$('#histPrintAll').onclick = () => { const m = $('#histMonth').value; if (m) printSlips(Object.keys(S.history[m]).map(id => histResult(m, id)), m); };
$('#histCsv').onclick = () => {
  const m = $('#histMonth').value; if (!m) return; const recs = Object.values(S.history[m]);
  const codes = [...new Set(recs.flatMap(r => r.lines.map(l => l.code)))];
  const rows = [['Code', 'Name', 'Paid days', ...codes, 'Earnings', 'Deductions', 'Net', 'Odoo entry']];
  recs.forEach(r => rows.push([r.emp.code, r.emp.name, r.paidDays, ...codes.map(c => (r.lines.find(l => l.code === c) || {}).amount ?? ''), r.totalEarn, r.totalDed, r.net, r.moveId || '']));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' })); a.download = `salary_${m}.csv`; a.click();
};
$('#histReopen').onclick = () => {
  const m = $('#histMonth').value; if (!m) return;
  $('#runMonth').value = m; const [y, mo] = m.split('-').map(Number); $('#runDays').value = new Date(y, mo, 0).getDate();
  $('nav button[data-tab=payroll]').click();
};

// ---------- Settings ----------
function toggleMode() { $$('label.api').forEach(l => l.style.display = $('#connMode').value === 'api' ? '' : 'none'); }
$('#connMode').onchange = toggleMode;
function renderSettings() {
  $('#odooUrl').value = S.settings.url || ''; $('#connMode').value = S.settings.mode || 'api'; $('#odooDb').value = S.settings.db || ''; $('#odooLogin').value = S.settings.login || ''; $('#odooKey').value = S.settings.key || ''; toggleMode(); $('#autoPost').value = S.settings.autoPost ?? '1'; $('#postMode').value = S.settings.postMode || 'batch'; $('#groupLines').value = S.settings.groupLines || '0';
  $('#journal').innerHTML = '<option value="">—</option>' + S.cache.journals.map(j => `<option value="${j.id}">${esc(j.name)} (${esc(j.code)})</option>`).join('');
  $('#journal').value = S.settings.journal || '';
  $$('[data-role]').forEach(sel => {
    sel.innerHTML = '<option value="">—</option>' + S.cache.accounts.map(a => `<option value="${a.id}">${esc(a.code)} ${esc(a.name)}</option>`).join('');
    sel.value = (S.settings.accounts || {})[sel.dataset.role] || '';
  });
}
$('#testConn').onclick = async () => {
  try { const o = new URL($('#odooUrl').value.trim()).origin; if (!o.endsWith('.odoo.com')) { const ok = await chrome.permissions.request({ origins: [o + '/*'] }); if (!ok) return $('#connMsg').innerHTML = '<span class="bad">Chrome permission for this server was not granted.</span>'; } } catch (_) { return $('#connMsg').innerHTML = '<span class="bad">Enter a valid Odoo URL, e.g. https://erp.example.com</span>'; }
  S.settings.url = $('#odooUrl').value.trim(); S.settings.mode = $('#connMode').value; S.settings.db = $('#odooDb').value.trim(); S.settings.login = $('#odooLogin').value.trim(); S.settings.key = $('#odooKey').value.trim(); rpcUid = null; useRpc = false; const msg = $('#connMsg');
  try {
    await save();
    msg.textContent = 'Connecting…';
    S.cache.journals = await odoo('account.journal', 'search_read', [[['type', '=', 'general']], ['name', 'code']]);
    await loadChart();
    try { [S.cache.company] = await odoo('res.company', 'search_read', [[], ['name', 'street', 'city', 'zip', 'currency_id']], { limit: 1 }); } catch (_) {}
    try { const cid = S.cache.company.currency_id[0]; const [c] = await odoo('res.currency', 'read', [[cid], ['name', 'symbol', 'position', 'decimal_places', 'currency_unit_label']]); S.cache.currency = { name: c.name, symbol: c.symbol, position: c.position, decimals: c.decimal_places, unitLabel: c.currency_unit_label }; } catch (_) {}
    const made = []; await autoAccounting(m => made.push(m)); await save(); renderSettings();
    msg.innerHTML = (made.length ? `<span class="hint">${esc(made.join('; '))}</span><br>` : '') + `<span class="ok">Connected to ${esc((S.cache.company || {}).name || 'Odoo')}${useRpc ? ' (classic API)' : ''}. Currency ${esc(CUR().name || '?')}. Accounting set up automatically.</span>`; renderEmployees(); renderStructures();
  } catch (e) { msg.innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
};
$('#saveAcc').onclick = async () => {
  S.settings.journal = $('#journal').value; S.settings.autoPost = $('#autoPost').value; S.settings.postMode = $('#postMode').value; S.settings.groupLines = $('#groupLines').value; S.settings.accounts = {};
  $$('[data-role]').forEach(s => { if (s.value) S.settings.accounts[s.dataset.role] = s.value; });
  await save(); alert('Accounting settings saved.');
};
$('#exportBtn').onclick = () => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ ...S, settings: { ...S.settings, key: '' } }, null, 2)], { type: 'application/json' }));
  a.download = `payroll_backup_${new Date().toISOString().slice(0, 10)}.json`; a.click();
};
$('#importFile').onchange = async ev => {
  const f = ev.target.files[0]; if (!f) return;
  try { const d = JSON.parse(await f.text()); if (!d.employees || !d.structures) throw new Error('Not a backup file'); if (!confirm('Replace all current data with this backup?')) return; S = d; await save(); init(); alert('Backup restored.'); }
  catch (e) { alert('Import failed: ' + e.message); }
};

async function init() { await load(); S.posted = S.posted || {}; renderEmployees(); fillEmp(null); renderStructures(); fillStructure(S.structures[0]); renderSettings(); }
init();

// ---------- Searchable dropdowns ----------
// Adds a search box to every dropdown with more than 6 options (accounts, employees, journals, structures...).
function makeSearchable(sel) {
  if (sel.dataset.searchable || sel.options.length <= 6) return;
  sel.dataset.searchable = '1';
  const box = document.createElement('input');
  box.type = 'search'; box.placeholder = '🔍 Search…'; box.className = 'sel-search';
  sel.parentNode.insertBefore(box, sel);
  box.addEventListener('input', () => {
    const q = box.value.trim().toLowerCase(); let first = null, shown = 0;
    for (const o of sel.options) {
      const hit = !q || o.text.toLowerCase().includes(q) || o.value === '';
      o.hidden = !hit; if (hit && o.value !== '') { shown++; if (!first) first = o; }
    }
    if (first && sel.selectedOptions[0] && sel.selectedOptions[0].hidden) { sel.value = first.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    box.title = q ? `${shown} match${shown === 1 ? '' : 'es'}` : '';
    sel.size = q && shown > 1 ? Math.min(shown + 1, 8) : 0;
  });
  box.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); const o = [...sel.options].find(o => !o.hidden && o.value !== ''); if (o) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); } box.value = ''; box.dispatchEvent(new Event('input')); }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); sel.focus(); }
  });
  sel.addEventListener('change', () => { if (sel.size) { box.value = ''; for (const o of sel.options) o.hidden = false; sel.size = 0; } });
}
const scanSelects = () => $$('select').forEach(makeSearchable);
new MutationObserver(scanSelects).observe(document.body, { childList: true, subtree: true });
scanSelects();
