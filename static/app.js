// ---------- API ----------
const api = {
  async get(u){ const r = await fetch(u); if(!r.ok) throw new Error(await r.text()); return r.json(); },
  async send(m, u, b){
    const r = await fetch(u,{method:m,headers:{'Content-Type':'application/json'},body:b===undefined?undefined:JSON.stringify(b)});
    if(!r.ok) throw new Error(await r.text());
    if(r.status===204) return null;
    return r.json();
  },
  post(u,b){ return this.send('POST',u,b); },
  patch(u,b){ return this.send('PATCH',u,b); },
  del(u){ return this.send('DELETE',u); },
};

// ---------- State ----------
let state = { tab:'jars', bottles:[], jars:[], honeytee:[] };
const STAGE_LABEL = {
  f1:'F1', f2:'F2', f3:'F3', bottled:'Разлито', chilling:'Холодильник',
  stored:'Хранение', consumed:'Выпито', discarded:'Выброшено', done:'Готово'
};
const UNIT_LABEL = { g:'г', ml:'мл', pcs:'шт' };
const MATERIAL_LABEL = { glass:'Стекло', pet:'ПЭТ', other:'Другое' };

// ---------- Helpers ----------
function fmtDate(iso){ if(!iso) return ''; return iso.slice(0,16).replace('T',' '); }
function fmtDateOnly(iso){ if(!iso) return ''; return iso.slice(0,10); }
function esc(s){ return (s??'').toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function num(id){ const s = document.getElementById(id).value.trim(); return s===''? null : parseFloat(s); }
function v(id){ return document.getElementById(id).value.trim(); }

// ---------- Refresh / Tabs ----------
async function refresh(){
  [state.bottles, state.jars, state.honeytee] = await Promise.all([
    api.get('/api/bottles'), api.get('/api/jars'), api.get('/api/honeytee')
  ]);
  render();
}
function switchTab(t){
  state.tab = t;
  document.querySelectorAll('.tabs button').forEach(b=>b.classList.remove('active'));
  document.getElementById('tab-'+t).classList.add('active');
  // Скрываем FAB в разделе Бутылки (создание запрещено)
  const fab = document.getElementById('fabBtn');
  if(fab) fab.style.display = (t === 'bottles') ? 'none' : 'block';
  render();
}

function render(){
  const el = document.getElementById('content');
  if(state.tab==='bottles') el.innerHTML = renderBottles();
  if(state.tab==='jars')    el.innerHTML = renderJars();
  if(state.tab==='honeytee') el.innerHTML = renderHoneytee();
}

// ---------- Lists ----------
function renderBottles(){
  if(!state.bottles.length) return '<div class="empty">В ожидании комбучи</div>';

  // группировка по jar_id
  const groups = new Map();
  for(const b of state.bottles){
    const jid = b.jar_id || 0;
    if(!groups.has(jid)){
      groups.set(jid, {
        jar_id: jid,
        jar_title: b.jar_title || ('#'+jid),
        bottles: [],
      });
    }
    groups.get(jid).bottles.push(b);
  }

  // сортировка групп по jar_id по убыванию (новые партии — сверху)
  const sortedGroups = [...groups.values()].sort((a,b)=> b.jar_id - a.jar_id);

  // стадия для группового бейджа — если все бутылки партии в одной стадии, показываем её; иначе ничего
  function groupStage(bottles){
    const stages = new Set(bottles.map(b=>b.stage));
    if(stages.size === 1) return [...stages][0];
    return null;
  }

  return sortedGroups.map(g=>{
    const st = groupStage(g.bottles);
    const badge = st ? `<span class="badge ${st}">${STAGE_LABEL[st]||st}</span>` : '';
    const count = g.bottles.length;
    // первая дата для заголовка
    const firstDate = g.bottles.map(b=>b.created_at).sort()[0];
    const list = g.bottles.map(b=>{
      const isClosed = b.stage === 'consumed' || b.stage === 'discarded';
      return `
        <div class="card" style="padding:8px;margin:6px 0">
          <div onclick="openBottle(${b.id})" style="cursor:pointer">
            <b>${esc(b.title||('#'+b.id))}</b> <span class="badge ${b.stage}">${STAGE_LABEL[b.stage]||b.stage}</span>${b.material==='pet'?' <span class="badge control">Контроль</span>':''}
            <div class="meta">${b.volume_ml||'?'} мл (${MATERIAL_LABEL[b.material]||b.material}) • залито ${b.filled_ml||'?'} мл • ρ финал ${b.density??'—'}</div>
            ${b.additives && b.additives.length ? `<div class="meta">Добавки: ${b.additives.map(a=>esc(a.name)+' '+a.amount+UNIT_LABEL[a.unit]).join(', ')}</div>`:''}
          </div>
          ${isClosed ? '' : `
            <div class="row" style="margin-top:6px">
              <button class="ghost" onclick="editBottle(${b.id})">✏️ Изменить</button>
              <button class="danger" onclick="deleteBottleFromList(${b.id})">🗑 Удалить</button>
            </div>
          `}
        </div>
      `;
    }).join('');

        // группа свёрнута, если все бутылки в конечных статусах
    const allClosed = g.bottles.every(b => b.stage === 'consumed' || b.stage === 'discarded');
    const openAttr = allClosed ? '' : 'open';

    return `
      <details class="group" ${openAttr}>
        <summary class="group-summary">
          <span class="group-title">Партия ${esc(g.jar_title)} ${badge}</span>
          <span class="group-meta">${count} ${count===1?'бутылка':(count<5?'бутылки':'бутылок')} • ${fmtDateOnly(firstDate)}</span>
        </summary>
        <div class="group-body">${list}</div>
      </details>
    `;
  }).join('');
}

let currentJarOrigin = null;

function renderJars(){
  if(!state.jars.length) return '<div class="empty">Лимонадница пустует...</div>';
  return state.jars.map(j=>`
    <div class="card">
      <div onclick="openJar(${j.id})">
        <h3>${esc(j.title||('#'+j.id))} <span class="badge ${j.state}">${STAGE_LABEL[j.state]||j.state}</span></h3>
        <div class="meta">${fmtDateOnly(j.created_at)} • стартер ${j.starter_ml||'?'} мл • pH старт ${j.ph??'—'}${j.final_ph!=null?' • pH финал '+j.final_ph:''}</div>
        ${j.state==='bottled'?`<div class="meta">Разлито: ${j.total_filled_ml} мл из ${j.total_in_ml} мл • Остаток: ${j.leftover_ml} мл</div>`:''}
        ${j.reminder?`<div class="reminder">${esc(j.reminder)}</div>`:''}
      </div>
      <div class="row" style="margin-top:8px">
        ${j.state==='f1'?`<button class="primary" onclick="finishF1Wizard(${j.id})">Завершить F1</button>`:''}
        ${j.state==='bottled'?`<button class="primary" onclick="newCycle(${j.id})">Новый цикл</button>`:''}
        <button class="danger" onclick="deleteJar(${j.id})">🗑 Удалить</button>
      </div>
    </div>`).join('');
}

function renderHoneytee(){
  if(!state.honeytee.length) return '<div class="empty">Пора заварить чайку с мёдом!</div>';
  return state.honeytee.map(h=>`
    <div class="card">
      <h3>${esc(h.title||('Медочай #'+h.id))} ${h.used?'<span class="badge done">использован</span>':''}</h3>
      <div class="meta">${fmtDate(h.created_at)}</div>
      <div class="meta">Чай: ${esc(h.tea_type||'?')} ${h.tea_g||'?'} г при ${h.tea_temp??'?'}°C</div>
      <div class="meta">Мёд: ${esc(h.honey_type||'?')} ${h.honey_g||'?'} г</div>
      <div class="meta">Объём: ${h.mead_ml||'?'} мл • ρ старт: ${h.density??'—'} °Brix</div>
      <div class="row" style="margin-top:8px">
        ${h.used?'':`<button class="ghost" onclick="openWizard('honeytee',${h.id})">✏️ Изменить</button>`}
        <button class="danger" onclick="deleteHoneytee(${h.id})">🗑 Удалить</button>
      </div>
    </div>`).join('');
}

// ---------- Modal ----------
function openModal(html){
  document.getElementById('modalRoot').innerHTML = `<div class="modal-bg" onclick="if(event.target===this) closeModal()"><div class="modal">${html}</div></div>`;
}
function closeModal(){ document.getElementById('modalRoot').innerHTML=''; }

// ---------- Field defs ----------
const FIELD_DEFS = {
  honeytee: {
    title: 'Новый медочай',
    endpoint: '/api/honeytee',
    fields: [
      { key:'tea_type',   label:'Вид чая',              type:'text',   required:true },
      { key:'tea_g',      label:'Чай, г',               type:'number', step:'0.1', required:true },
      { key:'tea_temp',   label:'Температура заваривания, °C', type:'number', step:'1', required:true },
      { key:'__info_cool', label:'Остудить до 25°C', type:'info', text:'Остуди жидкость до 25°C перед добавлением мёда.' },
      { key:'honey_type', label:'Сорт мёда',            type:'text',   required:true },
      { key:'honey_g',    label:'Мёд, г',               type:'number', step:'0.1', required:true },
      { key:'mead_ml',    label:'Объём готового медочая, мл', type:'number', step:'1', required:true },
      { key:'density',    label:'ρ старт, °Brix',       type:'number', step:'0.1' },
    ],
  },
  jar: {
    title: 'Новая база',
    endpoint: '/api/jars',
    fields: [
      { key:'honeytee_id', label:'Медочай',   type:'honeytee_select', required:true },
      { key:'starter_ml',  label:'Объём стартера, мл', type:'number', step:'1', required:true },
      { key:'__warn_volume', label:'Проверить объём', type:'warn' },
      { key:'__info_pour', label:'Долить', type:'info', text:'Долей медочай в лимонадницу по стенке. Сверху должно остаться 1-2 см для дыхания.' },
      { key:'__info_mix',  label:'Перемешать', type:'info', text:'Перемешай: слей ~50 мл через краник и залей обратно по стенке.' },
      { key:'__info_ph',   label:'Проверить pH', type:'info', text:'Измерь pH на свежей пробе. Если pH ≥ 4.5 — добавь сусло из F1 и повтори. Если pH < 4.5 — переходи к F1.' },
      { key:'ph',          label:'pH свежей пробы', type:'number', step:'0.01', required:true },
    ],
  },
};

// ---------- Wizard ----------
let wiz = null;

async function openCreate(){
  if(state.tab==='honeytee') return openWizard('honeytee');
  if(state.tab==='jars')     return openWizard('jar');
}

async function openWizard(entity, id){
  const def = FIELD_DEFS[entity];
  let data = {};
  if(id) data = await api.get(`${def.endpoint}/${id}`);
  const values = {};
  for(const f of def.fields){
    if(f.type==='info'||f.type==='warn') continue;
    values[f.key] = data[f.key] ?? null;
  }
  const idx0 = def.fields.findIndex(f => f.type!=='info' && f.type!=='warn');
  wiz = { entity, mode: id?'edit':'create', id, def, values, idx: idx0<0?0:idx0 };
  renderWizard();
}

function wizFieldHasValue(f){
  const v = wiz.values[f.key];
  return !(v === null || v === '' || v === undefined);
}

function canSaveAll(){
  if(wiz.mode === 'edit') return true;
  for(const f of wiz.def.fields){
    if(f.type === 'info' || f.type === 'warn') continue;
    if(!f.required) continue;
    if(!wizFieldHasValue(f)) return false;
  }
  return true;
}

function renderWizard(){
  const def = wiz.def;
  const isEdit = wiz.mode==='edit';
  const plan = def.fields.map((f,i)=>{
    let icon;
    if(f.type==='info'||f.type==='warn') icon = 'ℹ️';
    else if(wizFieldHasValue(f)) icon = '✅';
    else if(f.required) icon = '⬜';
    else icon = '❔';
    const cur = i===wiz.idx ? ' current' : '';
    const val = (f.type==='info'||f.type==='warn') ? '' : (wiz.values[f.key] ?? '');
    return `<li class="${cur}" onclick="jumpTo(${i})">
      <span class="st">${icon}</span>
      <span class="name">${esc(f.label)}</span>
      <span class="val">${esc(val)}</span>
    </li>`;
  }).join('');

  const f = def.fields[wiz.idx];
  let body;
  if(f.type === 'info'){
    body = `<div class="info-box">${esc(f.text)}</div>`;
  } else if(f.type === 'warn'){
    const h = state.honeytee.find(x=>x.id === wiz.values.honeytee_id);
    const total = (wiz.values.starter_ml||0) + (h? (h.mead_ml||0) : 0);
    if(total > 1500){
      body = `<div class="warn-box">Сумма объёмов ${total} мл превышает 1500 мл. Лимонадница может перелиться.</div>`;
    } else {
      body = `<div class="info-box">Общий объём: ${total} мл из 1500 мл.</div>`;
    }
  } else {
    body = renderInputForField(f);
  }

  const canNext = (f.type==='info'||f.type==='warn') ? true : (wizFieldHasValue(f) || !f.required);
  const isLast = wiz.idx === def.fields.length - 1;
  const canSave = canSaveAll();

  openModal(`
    <div class="modal-head">
      <h2>${isEdit ? 'Редактирование' : esc(def.title)}</h2>
      <button class="primary" id="w_save" onclick="submitWizard()" ${canSave?'':'disabled'}>💾 Сохранить</button>
    </div>
    <ul class="plan">${plan}</ul>
    <div class="step-title">Шаг ${wiz.idx+1} из ${def.fields.length}: <b>${esc(f.label)}</b></div>
    ${body}
    <div class="wiz-actions">
      <button class="ghost" onclick="wizPrev()" ${wiz.idx===0?'disabled':''}>← Назад</button>
      <button class="primary" id="w_next" onclick="wizNext()" ${(canNext && !isLast)?'':'disabled'}>Далее →</button>
    </div>
    <div class="actions">
      <button class="ghost" onclick="closeModal()">Отмена</button>
    </div>
  `);
  attachInputEvents();
}

function renderInputForField(f){
  const v = wiz.values[f.key];
  if(f.type === 'number'){
    return `<input id="w_input" type="number" step="${f.step||'1'}" value="${v ?? ''}" autofocus>`;
  }
  if(f.type === 'honeytee_select'){
    const available = state.honeytee.filter(h => !h.used || (wiz.mode === 'edit'));
    if(!available.length){
      return `<div class="info-box">Нет доступных медочаев.<br><br>
        <button class="primary" onclick="closeModal(); switchTab('honeytee'); openWizard('honeytee')">Создать медочай</button>
      </div>`;
    }
    return `<select id="w_input">
      <option value="">— выберите медочай —</option>
      ${available.map(h=>`<option value="${h.id}" ${String(h.id)===String(v)?'selected':''}>${esc(h.title||('#'+h.id))}</option>`).join('')}
    </select>`;
  }
  if(f.type === 'textarea'){
    return `<textarea id="w_input" rows="3" autofocus>${esc(v ?? '')}</textarea>`;
  }
  return `<input id="w_input" type="text" value="${esc(v ?? '')}" autofocus>`;
}

function attachInputEvents(){
  const el = document.getElementById('w_input');
  if(!el) return;
  const f = wiz.def.fields[wiz.idx];
  const update = ()=>{
    const raw = el.value;
    if(f.type==='number') wiz.values[f.key] = raw===''?null:parseFloat(raw);
    else if(f.type==='honeytee_select') wiz.values[f.key] = raw===''?null:parseInt(raw);
    else wiz.values[f.key] = raw;
    const canNext = wizFieldHasValue(f) || !f.required;
    const isLast = wiz.idx === wiz.def.fields.length - 1;
    const btnNext = document.getElementById('w_next');
    if(btnNext) btnNext.disabled = !(canNext && !isLast);
    const btnSave = document.getElementById('w_save');
    if(btnSave) btnSave.disabled = !canSaveAll();
    updatePlan();
  };
  el.addEventListener('input', update);
  el.addEventListener('change', update);
}

function updatePlan(){
  const planEl = document.querySelector('.plan');
  if(!planEl) return;
  planEl.innerHTML = wiz.def.fields.map((f,i)=>{
    let icon;
    if(f.type==='info'||f.type==='warn') icon = 'ℹ️';
    else if(wizFieldHasValue(f)) icon = '✅';
    else if(f.required) icon = '⬜';
    else icon = '❔';
    const cur = i===wiz.idx ? ' current' : '';
    const val = (f.type==='info'||f.type==='warn') ? '' : (wiz.values[f.key] ?? '');
    return `<li class="${cur}" onclick="jumpTo(${i})">
      <span class="st">${icon}</span>
      <span class="name">${esc(f.label)}</span>
      <span class="val">${esc(val)}</span>
    </li>`;
  }).join('');
}

function syncCurrentInput(){
  const el = document.getElementById('w_input');
  if(!el) return;
  const f = wiz.def.fields[wiz.idx];
  const raw = el.value;
  if(f.type==='number') wiz.values[f.key] = raw===''?null:parseFloat(raw);
  else if(f.type==='honeytee_select') wiz.values[f.key] = raw===''?null:parseInt(raw);
  else wiz.values[f.key] = raw;
}

function jumpTo(i){
  if(wiz.idx === i) return;
  syncCurrentInput();
  wiz.idx = i;
  renderWizard();
}
function wizPrev(){ if(wiz.idx>0) jumpTo(wiz.idx-1); }
function wizNext(){ if(wiz.idx < wiz.def.fields.length-1) jumpTo(wiz.idx+1); }

async function submitWizard(){
  syncCurrentInput();
  for(const f of wiz.def.fields){
    if(f.type==='info'||f.type==='warn') continue;
    if(f.required && !wizFieldHasValue(f)){
      alert('Обязательное поле не заполнено: '+f.label);
      const i = wiz.def.fields.findIndex(x=>x.key===f.key);
      jumpTo(i); return;
    }
  }
  const body = {};
  for(const f of wiz.def.fields){
    if(f.type==='info'||f.type==='warn') continue;
    body[f.key] = wiz.values[f.key];
  }
  try {
    if(wiz.mode==='create') await api.post(wiz.def.endpoint, body);
    else await api.patch(`${wiz.def.endpoint}/${wiz.id}`, body);
    closeModal();
    await refresh();
  } catch(e){
    alert('Ошибка: '+e.message);
  }
}

// ---------- Bottle edit ----------
async function editBottle(id){
  const b = await api.get('/api/bottles/'+id);
  openModal(`
    <h2>Редактировать ${esc(b.title)}${b.material==='pet'?' <span class="badge control">Контроль</span>':''}</h2>
    <label>Объём бутылки, мл</label>
    <input id="eb_vol" type="number" value="${b.volume_ml??''}">
    <label>Материал</label>
    <input type="text" value="${MATERIAL_LABEL[b.material]||b.material}" disabled>
    <label>Залито, мл</label>
    <input id="eb_fill" type="number" value="${b.filled_ml??''}">
    <label>ρ финал, °Brix</label>
    <input id="eb_dens" type="number" step="0.1" value="${b.density??''}">
    <label>Заметки</label>
    <textarea id="eb_notes" rows="2">${esc(b.notes||'')}</textarea>
    <div class="actions">
      <button class="ghost" onclick="closeModal()">Отмена</button>
      <button class="primary" onclick="saveBottle(${id})">Сохранить</button>
    </div>
  `);
}
async function saveBottle(id){
  const body = {
    volume_ml: num('eb_vol'),
    filled_ml: num('eb_fill'),
    density: num('eb_dens'),
    notes: v('eb_notes') || null,
  };
  await api.patch('/api/bottles/'+id, body);
  closeModal(); refresh();
}
async function deleteBottleFromList(id){
  if(!confirm('Удалить бутылку?')) return;
  try {
    await api.del('/api/bottles/'+id);
    await refresh();
  } catch(e){ alert(e.message); }
}
async function deleteBottle(id){ if(!confirm('Удалить бутылку?')) return; try{ await api.del('/api/bottles/'+id); closeModal(); refresh(); }catch(e){ alert(e.message); } }
async function deleteJar(id){ if(!confirm('Удалить базу? Это возможно только если у неё нет бутылок.')) return; try{ await api.del('/api/jars/'+id); refresh(); }catch(e){ alert(e.message); } }
async function deleteJarFromModal(id){
  if(!confirm('Удалить базу? Это возможно только если у неё нет бутылок.')) return;
  try {
    await api.del('/api/jars/'+id);
    closeModal();
    await refresh();
  } catch(e){ alert(e.message); }
}
async function deleteHoneytee(id){ if(!confirm('Удалить медочай?')) return; try{ await api.del('/api/honeytee/'+id); refresh(); }catch(e){ alert(e.message); } }

// ---------- F1 finish wizard ----------
async function finishF1Wizard(jarId){
  const jar = await api.get('/api/jars/'+jarId);
  const totalInMl = jar.total_in_ml || 0;

  const wizF1 = {
    jarId,
    totalInMl,
    step: 0,
    fields: [
      { key:'final_ph',  label:'Финальный pH', type:'number', step:'0.01', required:true },
      { key:'rho_final', label:'ρ финал, °Brix', type:'number', step:'0.1', required:false },
      { key:'__bottles', label:'Бутылки', type:'bottles' },
    ],
    values: { final_ph: null, rho_final: null },
    bottles: [],
  };

  function hasValue(f){
    if(f.type === 'bottles') return wizF1.bottles.length > 0;
    const v = wizF1.values[f.key];
    return !(v === null || v === '' || v === undefined);
  }
  function canSave(){
    // хотя бы одна бутылка
    if(!wizF1.bottles.length) return false;
    // все обязательные поля заполнены
    for(const f of wizF1.fields){
      if(!f.required) continue;
      if(!hasValue(f)) return false;
    }
    // не разлито больше, чем есть
    const totalFilled = wizF1.bottles.reduce((s,b)=>s+(b.filled_ml||0), 0);
    if(totalFilled > wizF1.totalInMl) return false;
    return true;
  }

  function render(){
    const step = wizF1.step;
    const f = wizF1.fields[step];
    const isLast = step === wizF1.fields.length - 1;

    const plan = wizF1.fields.map((fld,i)=>{
      let icon;
      if(hasValue(fld)) icon = '✅';
      else if(fld.required) icon = '⬜';
      else icon = '❔';
      const cur = i===step ? ' current' : '';
      let val = '';
      if(fld.type === 'bottles') val = wizF1.bottles.length ? `${wizF1.bottles.length} шт` : '';
      else val = wizF1.values[fld.key] ?? '';
      return `<li class="${cur}" onclick="finishF1Jump(${i})">
        <span class="st">${icon}</span>
        <span class="name">${esc(fld.label)}</span>
        <span class="val">${esc(val)}</span>
      </li>`;
    }).join('');

    let body;
    if(f.type === 'bottles'){
      const list = wizF1.bottles.map((b,i)=>{
        const addStr = (b.additives && b.additives.length)
          ? `<div class="meta">Добавки: ${b.additives.map(a=>esc(a.name)+' '+a.amount+UNIT_LABEL[a.unit]).join(', ')}</div>`
          : '';
        return `
          <div class="card" style="padding:8px;margin-bottom:6px">
            <b>${esc(b.title)}</b>
            <div class="meta">${b.volume_ml} мл (${MATERIAL_LABEL[b.material]||b.material}) • залито ${b.filled_ml} мл</div>
            ${addStr}
            <div class="row" style="margin-top:6px">
              <button class="danger" onclick="finishF1RemoveBottle(${i})">Удалить</button>
            </div>
          </div>
        `;
      }).join('') || '<div class="empty">Бутылок пока нет</div>';

      const totalFilled = wizF1.bottles.reduce((s,b)=>s+(b.filled_ml||0), 0);
      const leftover = wizF1.totalInMl - totalFilled;
      const over = leftover < 0;

      const summary = `
        <div class="${over?'warn-box':'info-box'}">
          <div>Разлито: ${totalFilled} мл из ${wizF1.totalInMl} мл</div>
          <div><b>Остаток в лимонаднице: ${leftover} мл</b></div>
          ${over ? '<div>Разлито больше, чем есть в базе — поправь объёмы бутылок.</div>' : ''}
        </div>
      `;

      body = `
        <div class="info-box" style="background:#fbf6ec;border-left-color:var(--accent);color:#5a4420">
          Если pH ≥ 4.5 — часть жидкости из бутылок нужно вернуть в лимонадницу. Уменьши «залито» у этих бутылок, тогда остаток пересчитается.
        </div>
        <div style="margin-bottom:8px">${list}</div>
        <button class="ghost" style="width:100%" onclick="finishF1AddBottleForm()">+ Добавить бутылку</button>
        ${summary}
      `;
    } else if(f.type === 'number'){
      const v = wizF1.values[f.key];
      body = `<input id="f1_input" type="number" step="${f.step||'1'}" value="${v ?? ''}" autofocus>`;
    }

    const canNext = hasValue(f) || !f.required;
    const canSv = canSave();

    openModal(`
      <div class="modal-head">
        <h2>Завершение F1</h2>
        <button class="primary" id="f1_save" onclick="finishF1Save()" ${canSv?'':'disabled'}>💾 Сохранить</button>
      </div>
      <ul class="plan">${plan}</ul>
      <div class="step-title">Шаг ${step+1} из ${wizF1.fields.length}: <b>${esc(f.label)}</b></div>
      ${body}
      <div class="wiz-actions">
        <button class="ghost" onclick="finishF1Prev()" ${step===0?'disabled':''}>← Назад</button>
        <button class="primary" id="f1_next" onclick="finishF1Next()" ${(canNext && !isLast)?'':'disabled'}>Далее →</button>
      </div>
      <div class="actions">
        <button class="ghost" onclick="closeModal()">Отмена</button>
      </div>
    `);

    const input = document.getElementById('f1_input');
    if(input){
      const onInput = ()=>{
        const raw = input.value;
        wizF1.values[f.key] = raw === '' ? null : parseFloat(raw);
        const canNext2 = hasValue(f) || !f.required;
        const isLast2 = wizF1.step === wizF1.fields.length - 1;
        const btnNext = document.getElementById('f1_next');
        if(btnNext) btnNext.disabled = !(canNext2 && !isLast2);
        const btnSave = document.getElementById('f1_save');
        if(btnSave) btnSave.disabled = !canSave();
        updateF1Plan();
      };
      input.addEventListener('input', onInput);
    }

    window.finishF1Prev = ()=>{ if(wizF1.step > 0){ syncF1Input(); wizF1.step--; render(); } };
    window.finishF1Next = ()=>{ if(wizF1.step < wizF1.fields.length-1){ syncF1Input(); wizF1.step++; render(); } };
    window.finishF1Jump = (i)=>{ syncF1Input(); wizF1.step = i; render(); };
  }

  window.finishF1RefreshWizard = ()=>{ render(); };

  function syncF1Input(){
    const input = document.getElementById('f1_input');
    if(!input) return;
    const f = wizF1.fields[wizF1.step];
    if(f.type === 'number'){
      wizF1.values[f.key] = input.value === '' ? null : parseFloat(input.value);
    }
  }
  function updateF1Plan(){
    const planEl = document.querySelector('.plan');
    if(!planEl) return;
    planEl.innerHTML = wizF1.fields.map((fld,i)=>{
      let icon;
      if(hasValue(fld)) icon = '✅';
      else if(fld.required) icon = '⬜';
      else icon = '❔';
      const cur = i===wizF1.step ? ' current' : '';
      let val = '';
      if(fld.type === 'bottles') val = wizF1.bottles.length ? `${wizF1.bottles.length} шт` : '';
      else val = wizF1.values[fld.key] ?? '';
      return `<li class="${cur}" onclick="finishF1Jump(${i})">
        <span class="st">${icon}</span>
        <span class="name">${esc(fld.label)}</span>
        <span class="val">${esc(val)}</span>
      </li>`;
    }).join('');
  }

  window.finishF1RemoveBottle = (i)=>{ wizF1.bottles.splice(i,1); render(); };

  window.finishF1AddBottleForm = ()=>{
    let tempAdditives = [];
    let draft = { volume_ml: null, material: 'glass', filled_ml: null };

        function renderAdditivesBlock(){
      if(!tempAdditives.length) return '<div class="meta">Нет добавок</div>';
      return tempAdditives.map((a,i)=>`
        <div class="additive-item">
          <div class="text">${esc(a.name)} — ${a.amount} ${UNIT_LABEL[a.unit]}${a.note?' • '+esc(a.note):''}</div>
          <button class="ghost" onclick="finishF1EditTempAdditiveForm(${i})" style="padding:4px 8px;font-size:13px">✏️</button>
          <button class="danger" onclick="finishF1RemoveTempAdditive(${i})" style="padding:4px 8px;font-size:13px">✕</button>
        </div>
      `).join('');
    }
    function syncDraft(){
      const volEl = document.getElementById('fb_vol');
      const matEl = document.getElementById('fb_mat');
      const fillEl = document.getElementById('fb_fill');
      if(volEl) draft.volume_ml = volEl.value === '' ? null : parseFloat(volEl.value);
      if(matEl) draft.material = matEl.value;
      if(fillEl) draft.filled_ml = fillEl.value === '' ? null : parseFloat(fillEl.value);
    }
    function renderBottleForm(){
      openModal(`
        <h2>Новая бутылка</h2>
        <label>Объём бутылки, мл</label><input id="fb_vol" type="number" value="${draft.volume_ml ?? ''}">
        <label>Материал</label>
        <select id="fb_mat">
          <option value="glass" ${draft.material==='glass'?'selected':''}>Стекло</option>
          <option value="pet" ${draft.material==='pet'?'selected':''}>ПЭТ (контрольная)</option>
          <option value="other" ${draft.material==='other'?'selected':''}>Другое</option>
        </select>
        <label>Залито, мл</label><input id="fb_fill" type="number" value="${draft.filled_ml ?? ''}">
        <h3 style="margin-top:14px;font-size:14px">Добавки (необязательно)</h3>
        ${renderAdditivesBlock()}
        <div class="row" style="margin-top:8px">
          <button class="ghost" onclick="finishF1AddTempAdditiveForm()">+ Добавить добавку</button>
        </div>
        <div class="actions">
          <button class="ghost" onclick="window.finishF1RefreshWizard()">Назад</button>
          <button class="primary" onclick="finishF1ConfirmBottle()">Добавить</button>
        </div>
      `);
    }
	    window.finishF1EditTempAdditiveForm = (idx)=>{
      syncDraft();
      const a = tempAdditives[idx];
      if(!a){ alert('Добавка не найдена'); return; }
      openModal(`
        <h2>Редактировать добавку</h2>
        <label>Название</label><input id="tad_name" type="text" value="${esc(a.name||'')}" autofocus>
        <label>Количество</label><input id="tad_amount" type="number" step="0.1" value="${a.amount ?? ''}">
        <label>Единица</label>
        <select id="tad_unit">
          <option value="g" ${a.unit==='g'?'selected':''}>граммы</option>
          <option value="ml" ${a.unit==='ml'?'selected':''}>миллилитры</option>
          <option value="pcs" ${a.unit==='pcs'?'selected':''}>штуки</option>
        </select>
        <label>Заметка (необязательно)</label><textarea id="tad_note" rows="2">${esc(a.note||'')}</textarea>
        <div class="actions">
          <button class="ghost" onclick="finishF1BackToBottleForm()">Назад</button>
          <button class="primary" onclick="finishF1ConfirmEditTempAdditive(${idx})">Сохранить</button>
        </div>
      `);
    };

    window.finishF1ConfirmEditTempAdditive = (idx)=>{
      const name = v('tad_name');
      const amount = num('tad_amount');
      if(!name || amount===null){ alert('Заполните название и количество'); return; }
      tempAdditives[idx] = {
        name,
        amount,
        unit: v('tad_unit'),
        note: v('tad_note') || null,
      };
      renderBottleForm();
    };
    window.finishF1AddTempAdditiveForm = ()=>{
      syncDraft();
      openModal(`
        <h2>Добавка</h2>
        <div class="info-box">Добавки ускоряют карбонизацию.</div>
        <label>Название</label><input id="tad_name" type="text" autofocus>
        <label>Количество</label><input id="tad_amount" type="number" step="0.1">
        <label>Единица</label>
        <select id="tad_unit">
          <option value="g">граммы</option>
          <option value="ml">миллилитры</option>
          <option value="pcs">штуки</option>
        </select>
        <label>Заметка (необязательно)</label><textarea id="tad_note" rows="2"></textarea>
        <div class="actions">
          <button class="ghost" onclick="finishF1BackToBottleForm()">Назад</button>
          <button class="primary" onclick="finishF1ConfirmTempAdditive()">Добавить</button>
        </div>
      `);
    };
    window.finishF1BackToBottleForm = ()=>{ renderBottleForm(); };
    window.finishF1ConfirmTempAdditive = ()=>{
      const name = v('tad_name');
      const amount = num('tad_amount');
      if(!name || amount===null){ alert('Заполните название и количество'); return; }
      tempAdditives.push({ name, amount, unit: v('tad_unit'), note: v('tad_note') || null });
      renderBottleForm();
    };
    window.finishF1RemoveTempAdditive = (i)=>{ tempAdditives.splice(i,1); renderBottleForm(); };
    window.finishF1ConfirmBottle = ()=>{
      syncDraft();
      const mat = draft.material;
      if(mat === 'pet' && wizF1.bottles.some(b=>b.material === 'pet')){
        alert('Контрольная ПЭТ в партии уже есть'); return;
      }
      if(!draft.volume_ml || !draft.filled_ml){
        alert('Заполните объём и залитое'); return;
      }
      const n = wizF1.bottles.length + 1;
      wizF1.bottles.push({
        title: `#${wizF1.jarId}.${n}`,
        volume_ml: draft.volume_ml,
        material: mat,
        filled_ml: draft.filled_ml,
        additives: [...tempAdditives],
      });
      window.finishF1RefreshWizard();
    };
    renderBottleForm();
  };

  window.finishF1Save = async ()=>{
    syncF1Input();
    for(const f of wizF1.fields){
      if(!f.required) continue;
      if(!hasValue(f)){
        alert('Заполните обязательное поле: ' + f.label);
        return;
      }
    }
    const totalFilled = wizF1.bottles.reduce((s,b)=>s+(b.filled_ml||0), 0);
    if(totalFilled > wizF1.totalInMl){
      alert('Разлито больше, чем есть в базе'); return;
    }
    try {
      await api.post(`/api/jars/${jarId}/finish_f1`, {
        final_ph: wizF1.values.final_ph,
        rho_final: wizF1.values.rho_final,
        bottles: wizF1.bottles.map(b=>({
          volume_ml: b.volume_ml,
          material: b.material,
          filled_ml: b.filled_ml,
          additives: b.additives || [],
        })),
      });
      closeModal();
      await refresh();
    } catch(e){ alert('Ошибка: '+e.message); }
  };

  render();
}

// ---------- F2 finish ----------
async function finishF2Wizard(jarId, fromBottleId){
  const wizF2 = {
    jarId,
    fromBottleId,
    step: 0,
        fields: [
      { key:'carbonation',  label:'Карбонизация (1–5)', type:'number', step:'1', required:true },
      { key:'sediment',     label:'Осадок',           type:'select', required:true },
      { key:'sediment_note',label:'Заметка об осадке',type:'text',   required:false },
      { key:'__info',       label:'Что дальше',      type:'info' },
    ],
    values: { carbonation: null, sediment: null, sediment_note: '' },
  };

  function hasValue(f){
    if(f.type === 'info') return true;
    const v = wizF2.values[f.key];
    return !(v === null || v === '' || v === undefined);
  }
  function canSave(){
    for(const f of wizF2.fields){
      if(f.type === 'info') continue;
      if(!f.required) continue;
      if(!hasValue(f)) return false;
    }
    return true;
  }

  function render(){
    const step = wizF2.step;
    const f = wizF2.fields[step];
    const isLast = step === wizF2.fields.length - 1;

    const plan = wizF2.fields.map((fld,i)=>{
      let icon;
      if(fld.type==='info') icon = 'ℹ️';
      else if(hasValue(fld)) icon = '✅';
      else if(fld.required) icon = '⬜';
      else icon = '❔';
      const cur = i===step ? ' current' : '';
      let val = '';
      if(fld.type === 'info') val = '';
            else if(fld.key === 'sediment') val = wizF2.values[fld.key] === 'yes' ? 'Да' : (wizF2.values[fld.key] === 'no' ? 'Нет' : '');
      else val = wizF2.values[fld.key] ?? '';
      return `<li class="${cur}" onclick="f2Jump(${i})">
        <span class="st">${icon}</span>
        <span class="name">${esc(fld.label)}</span>
        <span class="val">${esc(val)}</span>
      </li>`;
    }).join('');

    let body;
        if(f.type === 'info'){
      const bottles = state.bottles.filter(b => b.jar_id === jarId);
      const toFridge = bottles.filter(b => !b.has_additives);
      const toF3 = bottles.filter(b => b.has_additives);

      const lines = [];
      if(toFridge.length){
        lines.push(`<div style="margin-top:8px"><b>→ В холодильник:</b> ${toFridge.map(b => esc(b.title)).join(', ')}</div>`);
      }
      if(toF3.length){
        lines.push(`<div style="margin-top:${lines.length?'4px':'8px'}"><b>→ На F3:</b> ${toF3.map(b => esc(b.title)).join(', ')}</div>`);
      }
      if(!lines.length){
        lines.push('<div style="margin-top:8px">В партии нет бутылок.</div>');
      }

      body = `
        <div class="info-box">
          <div>После завершения F2 партия расходится путями:</div>
          ${lines.join('')}
        </div>
      `;
    } else if(f.key === 'carbonation'){
      body = `<input id="f2_input" type="number" min="1" max="5" step="1" value="${wizF2.values.carbonation}" autofocus>`;
        } else if(f.key === 'sediment'){
      body = `<select id="f2_input">
        <option value="" ${!wizF2.values.sediment?'selected':''}>— выберите —</option>
        <option value="no" ${wizF2.values.sediment==='no'?'selected':''}>Нет</option>
        <option value="yes" ${wizF2.values.sediment==='yes'?'selected':''}>Да</option>
      </select>`;
    } else {
      body = `<textarea id="f2_input" rows="2" autofocus>${esc(wizF2.values.sediment_note || '')}</textarea>`;
    }

    const canNext = (f.type==='info') ? true : (hasValue(f) || !f.required);
    const canSv = canSave();

    openModal(`
      <div class="modal-head">
        <h2>Завершение F2</h2>
        <button class="primary" id="f2_save" onclick="f2Finish()" ${canSv?'':'disabled'}>💾 Сохранить</button>
      </div>
      <ul class="plan">${plan}</ul>
      <div class="step-title">Шаг ${step+1} из ${wizF2.fields.length}: <b>${esc(f.label)}</b></div>
      ${body}
      <div class="wiz-actions">
        <button class="ghost" onclick="f2Prev()" ${step===0?'disabled':''}>← Назад</button>
        <button class="primary" id="f2_next" onclick="f2Next()" ${(canNext && !isLast)?'':'disabled'}>Далее →</button>
      </div>
      <div class="actions">
        <button class="ghost" onclick="f2Cancel()">Отмена</button>
      </div>
    `);

    // навесить input-listener
    const input = document.getElementById('f2_input');
    if(input){
      const onInput = ()=>{
        const raw = input.value;
        if(f.key === 'carbonation') wizF2.values.carbonation = raw === '' ? null : parseInt(raw);
        else if(f.key === 'sediment') wizF2.values.sediment = raw;
        else wizF2.values.sediment_note = raw;
        const canNext2 = (hasValue(f) || !f.required);
        const isLast2 = wizF2.step === wizF2.fields.length - 1;
        const btnNext = document.getElementById('f2_next');
        if(btnNext) btnNext.disabled = !(canNext2 && !isLast2);
        const btnSave = document.getElementById('f2_save');
        if(btnSave) btnSave.disabled = !canSave();
        updatePlan();
      };
      input.addEventListener('input', onInput);
      input.addEventListener('change', onInput);
    }

    window.f2Prev = ()=>{ if(wizF2.step > 0){ syncF2Input(); wizF2.step--; render(); } };
    window.f2Next = ()=>{ if(wizF2.step < wizF2.fields.length-1){ syncF2Input(); wizF2.step++; render(); } };
    window.f2Jump = (i)=>{ syncF2Input(); wizF2.step = i; render(); };
  }

  function syncF2Input(){
    const input = document.getElementById('f2_input');
    if(!input) return;
    const f = wizF2.fields[wizF2.step];
    const raw = input.value;
    if(f.key === 'carbonation') wizF2.values.carbonation = raw === '' ? null : parseInt(raw);
    else if(f.key === 'sediment') wizF2.values.sediment = raw;
    else if(f.key === 'sediment_note') wizF2.values.sediment_note = raw;
  }

  function updatePlan(){
    const planEl = document.querySelector('.plan');
    if(!planEl) return;
    planEl.innerHTML = wizF2.fields.map((fld,i)=>{
      let icon;
      if(fld.type==='info') icon = 'ℹ️';
      else if(hasValue(fld)) icon = '✅';
      else if(fld.required) icon = '⬜';
      else icon = '❔';
      const cur = i===wizF2.step ? ' current' : '';
      let val = '';
      if(fld.type === 'info') val = '';
            else if(fld.key === 'sediment') val = wizF2.values[fld.key] === 'yes' ? 'Да' : (wizF2.values[fld.key] === 'no' ? 'Нет' : '');
      else val = wizF2.values[fld.key] ?? '';
      return `<li class="${cur}" onclick="f2Jump(${i})">
        <span class="st">${icon}</span>
        <span class="name">${esc(fld.label)}</span>
        <span class="val">${esc(val)}</span>
      </li>`;
    }).join('');
  }

  window.f2Cancel = ()=>{
    if(fromBottleId) openBottle(fromBottleId);
    else closeModal();
  };

  window.f2Finish = async ()=>{
    syncF2Input();
    // проверка обязательных
    for(const f of wizF2.fields){
      if(f.type === 'info') continue;
      if(!f.required) continue;
      if(!hasValue(f)){
        alert('Заполните обязательное поле: ' + f.label);
        return;
      }
    }
    const c = wizF2.values.carbonation;
    if(isNaN(c) || c < 1 || c > 5){ alert('Карбонизация: введите число от 1 до 5'); return; }
    const data = {
      carbonation: c,
      sediment: wizF2.values.sediment === 'yes',
      sediment_note: wizF2.values.sediment_note || null,
    };
    try {
      await api.post(`/api/jars/${jarId}/finish_f2`, data);
      await refresh();
      if(fromBottleId) openBottle(fromBottleId);
      else closeModal();
    } catch(e){ alert('Ошибка: '+e.message); }
  };

  render();
}

async function openHoneytee(id, fromJarId, fromBottleId){
  const h = await api.get('/api/honeytee/'+id);
  openModal(`
    <h2>${esc(h.title||('Медочай #'+h.id))}</h2>
    <div class="meta">Создан: ${fmtDate(h.created_at)}</div>
    <h3 style="margin-top:12px;font-size:14px">Состав</h3>
    <div class="meta">Чай: ${esc(h.tea_type||'?')} — ${h.tea_g||'?'} г</div>
    <div class="meta">Температура заваривания: ${h.tea_temp??'—'} °C</div>
    <div class="meta">Мёд: ${esc(h.honey_type||'?')} — ${h.honey_g||'?'} г</div>
    <h3 style="margin-top:12px;font-size:14px">Итог</h3>
    <div class="meta">Объём: ${h.mead_ml||'?'} мл</div>
    <div class="meta">ρ старт: ${h.density??'—'} °Brix</div>
    <div class="meta">Использован: ${h.used ? 'да' : 'нет'}</div>
        <div class="actions">
      ${h.used ? '' : `<button class="ghost" onclick="closeModal(); openWizard('honeytee', ${h.id})">✏️ Изменить</button>`}
            ${fromJarId
        ? `<button class="ghost" onclick="openJar(${fromJarId}, ${fromBottleId || 'null'})">← Назад к базе</button>`
        : `<button class="ghost" onclick="closeModal()">Закрыть</button>`}
    </div>
  `);
}

// ---------- Jar card ----------
async function openJar(id, fromBottleId){
  currentJarOrigin = fromBottleId || null;
  const j = await api.get('/api/jars/'+id);

  const bottles = (j.bottles||[]).map(b=>`
    <div class="card" style="padding:8px;margin-bottom:6px" onclick="openBottle(${b.id})">
            <b>${esc(b.title)}</b> <span class="badge ${b.stage}">${STAGE_LABEL[b.stage]||b.stage}</span>${b.material==='pet'?' <span class="badge control">Контроль</span>':''}
      <div class="meta">${b.volume_ml} мл (${MATERIAL_LABEL[b.material]||b.material}) • ρ финал ${b.density??'—'}</div>
      ${b.additives && b.additives.length ? `<div class="meta">Добавки: ${b.additives.map(a=>esc(a.name)+' '+a.amount+UNIT_LABEL[a.unit]).join(', ')}</div>`:''}
    </div>
  `).join('');

  const history = renderJarHistory(j.events||[], id);

    openModal(`
    <div class="modal-head">
      <h2>${esc(j.title)} <span class="badge ${j.state}">${STAGE_LABEL[j.state]||j.state}</span></h2>
      <div class="head-actions">
        <button class="danger" onclick="deleteJarFromModal(${id})" title="Удалить базу">🗑</button>
      </div>
    </div>
    <div class="meta">Создана: ${fmtDate(j.created_at)}</div>
        ${j.honeytee ? `
        <div class="card" style="padding:8px;margin:8px 0;cursor:pointer" onclick="openHoneytee(${j.honeytee.id}, ${id}, ${fromBottleId || 'null'})">
        <b>Медочай: ${esc(j.honeytee.title)}</b>
        <div class="meta">${fmtDate(j.honeytee.created_at)} • ${esc(j.honeytee.tea_type||'?')} ${j.honeytee.tea_g||'?'} г • ${esc(j.honeytee.honey_type||'?')} ${j.honeytee.honey_g||'?'} г</div>
        <div class="meta">Объём: ${j.honeytee.mead_ml||'?'} мл • ρ старт: ${j.honeytee.density??'—'}</div>
      </div>
    ` : '<div class="meta">Медочай: —</div>'}
    <div class="meta">Медочай: ${j.honeytee&&j.honeytee.mead_ml?j.honeytee.mead_ml+' мл':'—'} • Стартер на входе: ${j.starter_ml||'?'} мл</div>
    <div class="meta">ρ старт: ${j.rho_start??'—'} • ρ финал: ${j.rho_final??'—'} • pH старт: ${j.ph??'—'}${j.final_ph!=null?' • pH финал: '+j.final_ph:''}</div>
    ${j.state==='bottled'?`<div class="meta">Разлито: ${j.total_filled_ml} мл из ${j.total_in_ml} мл • Остаток: <b>${j.leftover_ml} мл</b></div>`:''}
    ${j.reminder?`<div class="reminder">${esc(j.reminder)}</div>`:''}

    ${j.state==='f1' ? `
      <h3 style="margin-top:14px;font-size:14px">История F1</h3>
      <ul class="events">${history}</ul>
      <div class="row" style="margin-top:8px">
        <button class="ghost" onclick="addJarEntry(${id})">+ Запись</button>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="primary" style="flex:1" onclick="finishF1Wizard(${id})">Завершить F1</button>
      </div>
    ` : ''}

    ${j.state==='bottled' ? `
      <h3 style="margin-top:14px;font-size:14px">История</h3>
      <ul class="events">${history}</ul>
      <div class="row" style="margin-top:8px">
        <button class="primary" onclick="newCycle(${id})">Новый цикл</button>
      </div>
    ` : ''}

    ${bottles?`<h3 style="margin-top:14px;font-size:14px">Бутылки партии</h3>${bottles}`:''}
        <div class="actions">
      ${fromBottleId
        ? `<button class="ghost" onclick="openBottle(${fromBottleId})">← Назад к бутылке</button>`
        : `<button class="ghost" onclick="closeModal()">Закрыть</button>`}
    </div>
  `);
}

function renderJarHistory(events, jarId){
  if(!events || !events.length) return '<li>нет событий</li>';
  const sorted = [...events].sort((a,b)=> (a.created_at > b.created_at ? 1 : -1));
  const EDITABLE = new Set(['ph', 'note']);

  return sorted.map(ev=>{
    const p = ev.payload ? JSON.parse(ev.payload) : {};
    let summary = ev.event_type;

    if(ev.event_type==='ph') summary = `pH ${p.value ?? '?'}`;
    else if(ev.event_type==='note') summary = `«${esc(p.text||'')}»`;
    else if(ev.event_type==='created') summary = 'создание базы';
    else if(ev.event_type==='f1_finished') summary = `F1 завершена (pH ${p.final_ph}, ρ финал ${p.rho_final ?? '—'})`;
    else if(ev.event_type==='bottled') summary = `розлив: ${p.bottles_count} бутылок, ${p.total_filled_ml} мл`;
    else if(ev.event_type==='f2_finished') summary = 'F2 завершена';

    const btns = EDITABLE.has(ev.event_type)
      ? `<button class="ghost" onclick="editJarEvent(${ev.id}, ${jarId})">✏️</button>
         <button class="danger" onclick="deleteJarEvent(${ev.id}, ${jarId})">🗑</button>`
      : '';

    return `<li>
      <span class="ev-text">${fmtDate(ev.created_at)} — ${summary}</span>
      <span>${btns}</span>
    </li>`;
  }).reverse().join('');
}
async function addJarEntry(jarId){
  openModal(`
    <h2>Запись</h2>
    <label>pH (необязательно)</label>
    <input id="ev_val" type="number" step="0.01" autofocus>
    <label>Заметка (необязательно)</label>
    <textarea id="ev_text" rows="3"></textarea>
    <div class="actions">
      <button class="ghost" onclick="openJar(${jarId}, currentJarOrigin)">Назад</button>
      <button class="primary" onclick="submitJarEntry(${jarId})">Сохранить</button>
    </div>
  `);
}

async function submitJarEntry(jarId){
  const phRaw = document.getElementById('ev_val').value.trim();
  const note = document.getElementById('ev_text').value.trim();
  const ph = phRaw === '' ? null : parseFloat(phRaw);
  if(phRaw !== '' && isNaN(ph)){ alert('pH должен быть числом'); return; }
  if(ph === null && !note){ alert('Заполните хотя бы одно поле'); return; }
  try {
    // создаём pH-событие если есть
    if(ph !== null){
      await api.post('/api/events', {
        entity_type:'jar', entity_id: jarId,
        event_type:'ph', payload:{ value: ph },
      });
    }
    // создаём заметку если есть
    if(note){
      await api.post('/api/events', {
        entity_type:'jar', entity_id: jarId,
        event_type:'note', payload:{ text: note },
      });
    }
    await refresh();
    openJar(jarId, currentJarOrigin);
  } catch(e){ alert('Ошибка: '+e.message); }
}

async function addJarPh(jarId){
  openModal(`
    <h2>Замер pH</h2>
    <label>Значение</label><input id="ev_val" type="number" step="0.01" autofocus>
    <div class="actions">
      <button class="ghost" onclick="openJar(${jarId})">Назад</button>
      <button class="primary" onclick="submitJarPh(${jarId})">Сохранить</button>
    </div>
  `);
}
async function submitJarPh(jarId){
  const val = num('ev_val');
  if(val===null || isNaN(val)){ alert('Введите число'); return; }
  await api.post('/api/events', { entity_type:'jar', entity_id: jarId, event_type:'ph', payload:{ value: val } });
  await refresh(); openJar(jarId, currentJarOrigin);
}
async function addJarNote(jarId){
  openModal(`
    <h2>Заметка</h2>
    <label>Текст</label><textarea id="ev_text" rows="3" autofocus></textarea>
    <div class="actions">
      <button class="ghost" onclick="openJar(${jarId})">Назад</button>
      <button class="primary" onclick="submitJarNote(${jarId})">Сохранить</button>
    </div>
  `);
}
async function submitJarNote(jarId){
  const text = v('ev_text');
  if(!text){ alert('Введите текст'); return; }
  await api.post('/api/events', { entity_type:'jar', entity_id: jarId, event_type:'note', payload:{ text } });
  await refresh(); openJar(jarId, currentJarOrigin);
}
async function editJarEvent(eid, jarId){
  const events = await api.get(`/api/events?entity_type=jar&entity_id=${jarId}`);
  const ev = events.find(e=>e.id===eid);
  if(!ev){ alert('Событие не найдено'); return; }
  const p = ev.payload ? JSON.parse(ev.payload) : {};
  if(ev.event_type === 'ph'){
    openModal(`
      <h2>Редактировать pH</h2>
      <label>Значение</label><input id="ev_val" type="number" step="0.01" value="${p.value ?? ''}">
      <div class="actions">
        <button class="ghost" onclick="openJar(${jarId})">Назад</button>
        <button class="primary" onclick="saveJarEventPh(${eid}, ${jarId})">Сохранить</button>
      </div>
    `);
  } else if(ev.event_type === 'note'){
    openModal(`
      <h2>Редактировать заметку</h2>
      <label>Текст</label><textarea id="ev_text" rows="3">${esc(p.text||'')}</textarea>
      <div class="actions">
        <button class="ghost" onclick="openJar(${jarId})">Назад</button>
        <button class="primary" onclick="saveJarEventNote(${eid}, ${jarId})">Сохранить</button>
      </div>
    `);
  } else {
    alert('Это событие нельзя редактировать');
  }
}
async function saveJarEventPh(eid, jarId){
  const val = num('ev_val');
  if(val===null || isNaN(val)){ alert('Введите число'); return; }
  await api.patch('/api/events/'+eid, { payload: { value: val } });
  await refresh(); openJar(jarId, currentJarOrigin);
}
async function saveJarEventNote(eid, jarId){
  const text = v('ev_text');
  if(!text){ alert('Введите текст'); return; }
  await api.patch('/api/events/'+eid, { payload: { text } });
  await refresh(); openJar(jarId, currentJarOrigin);
}
async function deleteJarEvent(eid, jarId){
  if(!confirm('Удалить событие?')) return;
  await api.del('/api/events/'+eid);
  await refresh();
  if(jarId) openJar(jarId, currentJarOrigin);
  else closeModal();
}

// ---------- Bottle card ----------
async function openBottle(id){
  const b = await api.get('/api/bottles/'+id);
  const isClosed = (b.stage === 'consumed' || b.stage === 'discarded');

  const additives = (b.additives||[]).map((a,i)=>{
    const inner = `
      <div style="flex:1;min-width:0">
        <b>${esc(a.name)}</b> · ${a.amount} ${UNIT_LABEL[a.unit]}${a.note?' · '+esc(a.note):''}
      </div>
    `;
    if(isClosed){
      return `<div class="card" style="padding:8px;margin:6px 0;display:flex;align-items:center;gap:8px">${inner}</div>`;
    }
    return `<div class="card" style="padding:8px;margin:6px 0;cursor:pointer;display:flex;align-items:center;gap:8px" onclick="editAdditiveForm(${id}, ${i})">${inner}<span style="font-size:14px;flex-shrink:0">✏️</span></div>`;
  }).join('') || '<div class="meta">Нет добавок</div>';

  const events = (b.events||[]).map(e=>{
    const p = e.payload ? JSON.parse(e.payload) : {};
    let summary = e.event_type;
    if(e.event_type==='additive_added') summary = `добавка: ${esc(p.name)} ${p.amount}${UNIT_LABEL[p.unit]||''}`;
    else if(e.event_type==='additive_removed') summary = `удалена добавка: ${esc(p.name||'')}`;
    else if(e.event_type==='bottled') summary = 'бутылка создана';
    else if(e.event_type==='f2_finished') summary = `F2 завершена (карб. ${p.carbonation||'?'})`;
    else if(e.event_type==='pet_check') summary = `проверка ПЭТ: ${p.bubbled?'надулась':'ещё нет'}`;
    else if(e.event_type==='chill_out') summary = 'достали из холодильника';
	 else if(e.event_type==='discarded') summary = `🗑 выброшено: ${esc(p.reason||'без причины')}`;
    else if(e.event_type==='stage_changed') summary = `стадия → ${e.stage}`;
    else if(e.event_type==='tasting') summary = `🍷 ${p.rating ? '★'.repeat(p.rating)+'☆'.repeat(5-p.rating)+' · ' : ''}${esc(p.note||'без комментария')}`;
    return `<li><span class="ev-text">${fmtDate(e.created_at)} — ${summary}</span></li>`;
  }).join('') || '<li>нет событий</li>';

  const stage = b.stage;
  let actionsHtml = '';

  if(stage === 'f2'){
    let petStatus = { has_pet: false };
    try { petStatus = await api.get(`/api/jars/${b.jar_id}/pet_status`); } catch(e){}
    const isPet = b.material === 'pet';

    if(isPet){
      actionsHtml = `
        <h3 style="margin-top:14px;font-size:14px">Контрольная ПЭТ</h3>
        <div class="meta">Статус: ${b.pet_state==='bubbled'?'✅ надулась':(b.pet_state==='not_bubbled'?'⬜ ещё нет':'не проверяли')}
          ${b.pet_last_check?' • '+fmtDate(b.pet_last_check):''}</div>
        <div class="row" style="margin-top:8px">
          <button class="ghost" onclick="petCheckBottle(${id})">Проверить ПЭТ</button>
        </div>
      `;
        } else {
      actionsHtml = `
        <div class="meta" style="margin-top:12px">Статус ПЭТ партии: ${
          petStatus.has_pet
            ? (petStatus.pet_state==='bubbled'?'✅ надулась':(petStatus.pet_state==='not_bubbled'?'⬜ ещё нет':'не проверяли'))
            : 'контрольной ПЭТ нет'
        }</div>
      `;
    }
  } else if(stage === 'chilling'){
    actionsHtml = `
      <div class="info-box">В холодильнике${b.chill_hours!=null?': '+b.chill_hours+' ч':''}.</div>
    `;
    } else if(stage === 'stored'){
    actionsHtml = ``;
  } else if(stage === 'f3'){
    
    actionsHtml = `<div class="info-box">F3 в разработке.</div>`;
  }

  openModal(`
    <div class="modal-head">
      <h2>${esc(b.title)} <span class="badge ${b.stage}">${STAGE_LABEL[b.stage]||b.stage}</span>${b.material==='pet'?' <span class="badge control">Контроль</span>':''}</h2>
      ${isClosed ? '' : `
        <div class="head-actions">
          <button class="ghost" onclick="editBottle(${id})" title="Изменить">✏️</button>
          <button class="danger" onclick="deleteBottle(${id})" title="Удалить">🗑</button>
        </div>
      `}
    </div>
                  <div class="card" style="padding:8px;margin:8px 0;cursor:pointer" onclick="openJar(${b.jar ? b.jar.id : 0}, ${id})">
      <b>Партия: ${b.jar?esc(b.jar.title):'—'}</b>
      ${b.jar ? `<div class="meta">${fmtDate(b.jar.created_at)}</div>` : ''}
    </div>
    <div class="meta">${b.volume_ml} мл (${MATERIAL_LABEL[b.material]||b.material}) • залито ${b.filled_ml} мл • ρ финал ${b.density??'—'} °Brix</div>
    ${b.chill_hours!=null?`<div class="meta">В холодильнике: ${b.chill_hours} ч</div>`:''}
    ${b.pet_bottle && b.material!=='pet' ? `<div class="meta">Контрольная ПЭТ: ${esc(b.pet_bottle.title)} — ${b.pet_bottle.pet_state==='bubbled'?'надулась':(b.pet_bottle.pet_state==='not_bubbled'?'ещё нет':'не проверяли')}</div>`:''}

    ${actionsHtml}

    <h3 style="margin-top:14px;font-size:14px">Добавки</h3>
    ${additives}
    ${!isClosed
      ? `<div class="row" style="margin-top:8px">
           <button class="ghost" onclick="addAdditiveForm(${id})">+ Добавить добавку</button>
         </div>`
      : ''}

    <h3 style="margin-top:14px;font-size:14px">История</h3>
    <ul class="events">${events}</ul>

    ${renderBottleStageActions(b, id)}

    <div class="actions">
      <button class="ghost" onclick="closeModal()">Закрыть</button>
    </div>
  `);
}

function renderBottleStageActions(b, id){
  const stage = b.stage;
  let mainBtn = '';
  let dangerBtn = '';

  // основное действие по стадии
  if(stage === 'f2'){
    mainBtn = `<button class="primary" style="flex:1" onclick="finishF2Wizard(${b.jar_id}, ${id})">Завершить F2 партии</button>`;
  } else if(stage === 'f3'){
    // когда появится F3-действие — здесь
  } else if(stage === 'chilling'){
    mainBtn = `<button class="primary" style="flex:1" onclick="chillOut(${id})">Достать из холодильника</button>`;
  } else if(stage === 'stored'){
    mainBtn = `<button class="primary" style="flex:1" onclick="consumeBottleForm(${id})">Выпито</button>`;
  }

  // опасное действие — для всех активных стадий
  if(stage !== 'consumed' && stage !== 'discarded'){
    dangerBtn = `<button class="danger" onclick="discardBottleForm(${id})">🗑 Выбросить</button>`;
  }

  if(!mainBtn && !dangerBtn) return '';

  return `<div class="row" style="margin-top:14px">
    ${mainBtn}
    ${dangerBtn}
  </div>`;
}

async function petCheckBottle(bottleId){
  openModal(`
    <h2>Проверка ПЭТ</h2>
    <p>ПЭТ-бутылка надулась?</p>
    <div class="actions" style="flex-direction:column">
      <button class="primary" onclick="submitPetCheckBottle(${bottleId}, true)">Да, надулась</button>
      <button class="ghost" onclick="submitPetCheckBottle(${bottleId}, false)">Ещё нет</button>
      <button class="ghost" onclick="openBottle(${bottleId})">Отмена</button>
    </div>
  `);
}
async function submitPetCheckBottle(bottleId, bubbled){
  await api.post(`/api/bottles/${bottleId}/pet_check`, { bubbled });
  await refresh(); openBottle(bottleId);
}
async function editAdditiveForm(bottleId, idx){
  const b = await api.get('/api/bottles/'+bottleId);
  const a = (b.additives||[])[idx];
  if(!a){ alert('Добавка не найдена'); return; }
  openModal(`
    <h2>Добавка</h2>
    <label>Название</label><input id="ad_name" type="text" value="${esc(a.name||'')}" autofocus>
    <label>Количество</label><input id="ad_amount" type="number" step="0.1" value="${a.amount ?? ''}">
    <label>Единица</label>
    <select id="ad_unit">
      <option value="g" ${a.unit==='g'?'selected':''}>граммы</option>
      <option value="ml" ${a.unit==='ml'?'selected':''}>миллилитры</option>
      <option value="pcs" ${a.unit==='pcs'?'selected':''}>штуки</option>
    </select>
    <label>Заметка</label><textarea id="ad_note" rows="2">${esc(a.note||'')}</textarea>
    <div class="actions">
      <button class="ghost" onclick="openBottle(${bottleId})">Назад</button>
      <button class="danger" onclick="removeAdditiveFromForm(${bottleId}, ${idx})">🗑 Удалить</button>
      <button class="primary" onclick="submitEditAdditive(${bottleId}, ${idx})">Сохранить</button>
    </div>
  `);
}
async function removeAdditiveFromForm(bottleId, idx){
  if(!confirm('Удалить добавку?')) return;
  try {
    await api.del(`/api/bottles/${bottleId}/additives/${idx}`);
    await refresh();
    openBottle(bottleId);
  } catch(e){ alert(e.message); }
}

async function submitEditAdditive(bottleId, idx){
  const body = {
    name: v('ad_name'),
    amount: num('ad_amount'),
    unit: v('ad_unit'),
    note: v('ad_note') || null,
  };
  if(!body.name || body.amount===null){ alert('Заполните название и количество'); return; }
  try {
    await api.patch(`/api/bottles/${bottleId}/additives/${idx}`, body);
    await refresh();
    openBottle(bottleId);
  } catch(e){ alert(e.message); }
}
function addAdditiveForm(bottleId){
  openModal(`
    <h2>Добавить добавку</h2>
    <div class="info-box">Добавки ускоряют карбонизацию. Следи за ПЭТ чаще.</div>
    <label>Название</label><input id="ad_name" type="text" autofocus>
    <label>Количество</label><input id="ad_amount" type="number" step="0.1">
    <label>Единица</label>
    <select id="ad_unit">
      <option value="g">граммы</option>
      <option value="ml">миллилитры</option>
      <option value="pcs">штуки</option>
    </select>
    <label>Заметка</label><textarea id="ad_note" rows="2"></textarea>
    <div class="actions">
      <button class="ghost" onclick="openBottle(${bottleId})">Назад</button>
      <button class="primary" onclick="submitAdditive(${bottleId})">Добавить</button>
    </div>
  `);
}
async function submitAdditive(bottleId){
  const body = {
    name: v('ad_name'),
    amount: num('ad_amount'),
    unit: v('ad_unit'),
    note: v('ad_note') || null,
  };
  if(!body.name || body.amount===null){ alert('Заполните название и количество'); return; }
  try {
    await api.post(`/api/bottles/${bottleId}/additives`, body);
    await refresh(); openBottle(bottleId);
  } catch(e){ alert(e.message); }
}
async function removeAdditive(bottleId, idx){
  if(!confirm('Удалить добавку?')) return;
  await api.del(`/api/bottles/${bottleId}/additives/${idx}`);
  await refresh(); openBottle(bottleId);
}
async function chillOut(bottleId){
  await api.post(`/api/bottles/${bottleId}/chill_out`);
  await refresh(); openBottle(bottleId);
}
async function setBottleStage(bottleId, stage){
  if(!confirm('Перевести в стадию «'+ (STAGE_LABEL[stage]||stage) +'»?')) return;
  await api.post(`/api/bottles/${bottleId}/stage`, { stage });
  await refresh(); openBottle(bottleId);
}
function discardBottleForm(bottleId){
  openModal(`
    <h2>Выбросить бутылку</h2>
    <label>Причина (обязательно)</label>
    <textarea id="disc_reason" rows="3" placeholder="Плесень, запах, разорвало, испортилось…" autofocus></textarea>
    <div class="actions">
      <button class="ghost" onclick="openBottle(${bottleId})">Назад</button>
      <button class="danger" onclick="discardBottle(${bottleId})">Выбросить</button>
    </div>
  `);
}

async function discardBottle(bottleId){
  const reason = document.getElementById('disc_reason').value.trim();
  if(!reason){ alert('Укажите причину'); return; }
  try {
    await api.post('/api/events', {
      entity_type: 'bottle',
      entity_id: bottleId,
      stage: 'discarded',
      event_type: 'discarded',
      payload: { reason },
    });
    await api.post(`/api/bottles/${bottleId}/stage`, { stage: 'discarded' });
    await refresh();
    openBottle(bottleId);
  } catch(e){ alert('Ошибка: '+e.message); }
}
function consumeBottleForm(bottleId){
  openModal(`
    <h2>Отзыв о бутылке</h2>
    <label>Оценка (1–5)</label>
    <select id="cons_rating">
      <option value="">— без оценки —</option>
      <option value="5">5 — отлично</option>
      <option value="4">4 — хорошо</option>
      <option value="3">3 — нормально</option>
      <option value="2">2 — так себе</option>
      <option value="1">1 — плохо</option>
    </select>
    <label>Комментарий</label>
    <textarea id="cons_note" rows="3" placeholder="Вкус, газирование, аромат…"></textarea>
    <div class="actions">
      <button class="ghost" onclick="openBottle(${bottleId})">Назад</button>
      <button class="primary" onclick="consumeBottle(${bottleId})">Выпито</button>
    </div>
  `);
}

async function consumeBottle(bottleId){
  const ratingStr = document.getElementById('cons_rating').value;
  const note = document.getElementById('cons_note').value.trim();
  try {
    if(ratingStr || note){
      await api.post('/api/events', {
        entity_type: 'bottle',
        entity_id: bottleId,
        stage: 'consumed',
        event_type: 'tasting',
        payload: {
          rating: ratingStr ? parseInt(ratingStr) : null,
          note: note || null,
        },
      });
    }
    await api.post(`/api/bottles/${bottleId}/stage`, { stage: 'consumed' });
    await refresh();
    openBottle(bottleId);
  } catch(e){ alert('Ошибка: '+e.message); }
}

// ---------- New cycle ----------
async function newCycle(jarId){
  const jar = await api.get('/api/jars/'+jarId);
  const leftover = jar.leftover_ml;
  const r = await api.post(`/api/jars/${jarId}/new_cycle`);
  if(!r.available_honeytee.length){
    openModal(`
      <h2>Нет доступных медочаев</h2>
      <p>Чтобы начать новый цикл, сначала создайте медочай.</p>
      <div class="actions">
        <button class="ghost" onclick="closeModal()">Отмена</button>
        <button class="primary" onclick="closeModal(); switchTab('honeytee'); openWizard('honeytee')">Создать медочай</button>
      </div>
    `);
    return;
  }
  closeModal();
  await openWizard('jar');
  if(leftover && leftover > 0 && wiz && wiz.entity === 'jar'){
    wiz.values.starter_ml = leftover;
    renderWizard();
  }
}

// ---------- Backup ----------
async function doBackup(){ const r = await api.post('/api/backup'); alert('Бэкап: '+r.file); }
function openRestore(){
  openModal(`
    <h2>Восстановление из бэкапа</h2>
    <p>Текущие данные будут перезаписаны.</p>
    <input type="file" id="f_file" accept="application/json">
    <div class="actions">
      <button class="ghost" onclick="closeModal()">Отмена</button>
      <button class="primary" onclick="submitRestore()">Загрузить</button>
    </div>
  `);
}
async function submitRestore(){
  const f = document.getElementById('f_file').files[0];
  if(!f){ alert('Выберите файл'); return; }
  const fd = new FormData(); fd.append('file', f);
  const r = await fetch('/api/restore', { method:'POST', body: fd });
  if(!r.ok){ alert('Ошибка: '+await r.text()); return; }
  closeModal(); refresh(); alert('Готово');
}

// ---------- Init ----------
refresh();
switchTab('jars');