// ---------- API ----------
const api = {
	async get(u) {
		const r = await fetch(u);
		if (!r.ok) throw new Error(await r.text());
		return r.json();
	},
	async send(m, u, b) {
		const r = await fetch(u, {
			method: m,
			headers: {'Content-Type': 'application/json'},
			body: b === undefined ? undefined : JSON.stringify(b)
		});
		if (!r.ok) throw new Error(await r.text());
		if (r.status === 204) return null;
		return r.json();
	},
	post(u, b) {
		return this.send('POST', u, b);
	},
	patch(u, b) {
		return this.send('PATCH', u, b);
	},
	del(u) {
		return this.send('DELETE', u);
	},
};

// ---------- State ----------
let state = {tab: 'jars', bottles: [], jars: [], honeytee: [], notes: []};
const STAGE_LABEL = {
	f1: 'F1', f2: 'F2', f3: 'F3', bottled: 'Разлито', chilling: 'Холодильник',
	stored: 'Хранение', consumed: 'Выпито', discarded: 'Выброшено', done: 'Готово'
};
const UNIT_LABEL = {g: 'г', ml: 'мл', pcs: 'шт'};
const MATERIAL_LABEL = {glass: 'Стекло', pet: 'ПЭТ', other: 'Другое'};

// ---------- Helpers ----------
function fmtDate(iso) {
	if (!iso) return '';
	return iso.slice(0, 16).replace('T', ' ');
}

function fmtDateOnly(iso) {
	if (!iso) return '';
	return iso.slice(0, 10);
}

function esc(s) {
	return (s ?? '').toString().replace(/[&<>"']/g, c => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;'
	}[c]));
}

function num(id) {
	const s = document.getElementById(id).value.trim();
	return s === '' ? null : parseFloat(s);
}

function v(id) {
	return document.getElementById(id).value.trim();
}

// ---------- Refresh / Tabs ----------
async function refresh() {
	[state.bottles, state.jars, state.honeytee, state.notes] = await Promise.all([
		api.get('/api/bottles'), api.get('/api/jars'), api.get('/api/honeytee'), api.get('/api/notes')
	]);
	render();
}

function switchTab(t) {
	state.tab = t;
	document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
	document.getElementById('tab-' + t).classList.add('active');
	// Скрываем FAB в разделе Бутылки (создание запрещено)
	const fab = document.getElementById('fabBtn');
	if (fab) fab.style.display = (t === 'bottles' || t === 'notes') ? 'none' : 'block';
	render();
}

function render() {
	const el = document.getElementById('content');
	if (state.tab === 'bottles') el.innerHTML = renderBottles();
	if (state.tab === 'jars') el.innerHTML = renderJars();
	if (state.tab === 'honeytee') el.innerHTML = renderHoneytee();
	if (state.tab === 'notes') el.innerHTML = renderNotes();
}

// ---------- Lists ----------
let currentJarOrigin = null;

function renderBottles() {
	if (!state.bottles.length) return '<div class="empty">В ожидании комбучи</div>';

	// группировка по jar_id
	const groups = new Map();
	for (const b of state.bottles) {
		const jid = b.jar_id || 0;
		if (!groups.has(jid)) {
			groups.set(jid, {
				jar_id: jid,
				jar_title: b.jar_title || ('#' + jid),
				bottles: [],
			});
		}
		groups.get(jid).bottles.push(b);
	}

	// сортировка групп по jar_id по убыванию (новые партии — сверху)
	const sortedGroups = [...groups.values()].sort((a, b) => b.jar_id - a.jar_id);

	// стадия для группового бейджа — если все бутылки партии в одной стадии, показываем её; иначе ничего
	function groupStage(bottles) {
		const stages = new Set(bottles.map(b => b.stage));
		if (stages.size === 1) return [...stages][0];
		return null;
	}

	return sortedGroups.map(g => {
		const st = groupStage(g.bottles);
		const badge = st ? `<span class="badge ${st}">${STAGE_LABEL[st] || st}</span>` : '';
		const count = g.bottles.length;
		// первая дата для заголовка
		const firstDate = g.bottles.map(b => b.created_at).sort()[0];
		const list = g.bottles.map(b => {
			return `
        <div class="card" style="padding:8px;margin:6px 0;cursor:pointer" onclick="openBottle(${b.id})">
          <b>${esc(b.title || ('#' + b.id))}</b> <span class="badge ${b.stage}">${STAGE_LABEL[b.stage] || b.stage}</span>
          <div class="meta">${b.volume_ml || '?'} мл (${MATERIAL_LABEL[b.material] || b.material}) • залито ${b.filled_ml || '?'} мл${b.abv != null ? ` • ≈ ${b.abv}% алкоголя` : ''}</div>
          ${b.additives && b.additives.length ? `<div class="meta">Добавки: ${b.additives.map(a => esc(a.name) + ' ' + a.amount + UNIT_LABEL[a.unit]).join(', ')}</div>` : ''}
        </div>
      `;
		}).join('');

		// группа свёрнута, если все бутылки в конечных статусах
		const allClosed = g.bottles.every(b => b.stage === 'consumed' || b.stage === 'discarded');
		const openAttr = allClosed ? '' : 'open';

		// статус ПЭТ: ищем ПЭТ-бутылку в партии
		const pet = g.bottles.find(b => b.material === 'pet');
		let petLabel = '';
		if (pet) {
			if (pet.pet_state === 'bubbled') {
				petLabel = `<span class="badge control">ПЭТ надулась</span>`;
			} else if (pet.pet_state === 'not_bubbled') {
				petLabel = `<span class="badge">ПЭТ ещё нет</span>`;
			} else {
				petLabel = `<span class="badge control">ПЭТ контроль</span>`;
			}
		}

		const st2 = f2Status(g, state.jars);

		let statusBadge = '';
		let finishBtn = '';
		if (st2 && st2.kind === 'ready') {
			statusBadge = `<span class="badge f2-ready">Время подошло</span>`;
			finishBtn = `<div class="row" style="margin:8px 0"><button class="primary" style="flex:1" onclick="finishF2Wizard(${g.jar_id})">Завершить F2 партии</button></div>`;
		} else if (st2 && st2.kind === 'carbonating') {
			statusBadge = `<span class="badge f2-carbonating" style="cursor:pointer" onclick="event.stopPropagation(); event.preventDefault(); f2StatusClick(${g.jar_id}, ${st2.pet ? st2.pet.id : 0})">Карбонизируемся...</span>`;
		}

		return `
      <details class="group" ${openAttr}>
        <summary class="group-summary">
          <span class="group-title">Партия ${esc(g.jar_title)}</span>
          <span class="group-meta">${count} ${count === 1 ? 'бутылка' : (count < 5 ? 'бутылки' : 'бутылок')} • ${fmtDateOnly(firstDate)}</span>
        </summary>
        <div class="group-body">
          ${statusBadge ? `<div style="margin:4px 0 8px">${statusBadge}</div>` : ''}
          ${list}
          ${finishBtn}
        </div>
      </details>
    `;
	}).join('');
}

function renderJars() {
	if (!state.jars.length) return '<div class="empty">Лимонадница пустует...</div>';

	const active = state.jars.filter(j => j.state !== 'bottled');
	const bottled = state.jars.filter(j => j.state === 'bottled');

	function cardHtml(j, hideDelete) {
		return `
      <div class="card">
        <div onclick="openJar(${j.id})" style="cursor:pointer">
          <h3>${esc(j.title || ('#' + j.id))} <span class="badge ${j.state}">${STAGE_LABEL[j.state] || j.state}</span></h3>
          <div class="meta">${fmtDateOnly(j.created_at)}${j.state === 'bottled'
			? ` • Объём: ${j.total_in_ml} мл • Разлито: ${j.total_filled_ml} мл • Остаток: ${j.leftover_ml} мл`
			: ` • Объём: ${j.total_in_ml} мл`}</div>
          ${j.reminder ? `<div class="reminder">${esc(j.reminder)}</div>` : ''}
        </div>
        <div class="row" style="margin-top:8px">
          ${j.state === 'f1' ? `<button class="primary" onclick="finishF1Wizard(${j.id})">Завершить F1</button>` : ''}
          ${(j.state === 'bottled' && !j.next_cycle_started) ? `<button class="primary" onclick="newCycle(${j.id})">Новый цикл</button>` : ''}
          ${(!j.bottles || j.bottles.length === 0) ? `<button class="danger" onclick="deleteJar(${j.id})">🗑 Удалить</button>` : ''}
        </div>
      </div>
    `;
	}

	let html = active.map(j => cardHtml(j, false)).join('');

	if (bottled.length) {
		const list = bottled.map(j => cardHtml(j, true)).join('');
		html += `
      <details class="group">
        <summary class="group-summary">
          <span class="group-title">Разлитые партии</span>
          <span class="group-meta">${bottled.length} шт</span>
        </summary>
        <div class="group-body">${list}</div>
      </details>
    `;
	}

	return html;
}

function renderHoneytee() {
	if (!state.honeytee.length) return '<div class="empty">Пора заварить чайку с мёдом!</div>';

	const active = state.honeytee.filter(h => !h.used);
	const used = state.honeytee.filter(h => h.used);

	function cardHtml(h, hideDelete) {
		return `
      <div class="card">
        <h3>${esc(h.title || ('Медочай #' + h.id))} ${h.used ? '<span class="badge done">использован</span>' : ''} ${h.is_draft ? '<span class="badge draft">черновик</span>' : ''}</h3>
        <div class="meta">${fmtDate(h.created_at)}</div>
        <div class="meta">Чай: ${esc(h.tea_type || '?')} ${h.tea_g || '?'} г при ${h.tea_temp ?? '?'}°C${h.tea_steep_min != null ? ' • ' + h.tea_steep_min + ' мин' : ''}</div>
        <div class="meta">Мёд: ${esc(h.honey_type || '?')} ${h.honey_g || '?'} г</div>
        <div class="meta">Объём: ${h.mead_ml || '?'} мл • ρ старт: ${h.density ?? '—'} °Brix</div>
        <div class="row" style="margin-top:8px">
          ${h.used ? '' : `<button class="ghost" onclick="openWizard('honeytee',${h.id})">✏️ Изменить</button>`}
          ${hideDelete ? '' : `<button class="danger" onclick="deleteHoneytee(${h.id})">🗑 Удалить</button>`}
        </div>
      </div>
    `;
	}

	let html = active.map(h => cardHtml(h, false)).join('');

	if (used.length) {
		const list = used.map(h => cardHtml(h, true)).join('');
		html += `
      <details class="group">
        <summary class="group-summary">
          <span class="group-title">Использованные медочаи</span>
          <span class="group-meta">${used.length} шт</span>
        </summary>
        <div class="group-body">${list}</div>
      </details>
    `;
	}

	return html;
}

function renderNotes() {
	const notes = state.notes || [];
	const list = notes.map(n => `
    <div class="card" style="padding:10px;margin-bottom:8px">
      <div class="meta">${fmtDate(n.created_at)}</div>
      <div style="white-space:pre-wrap;word-break:break-word;margin:6px 0">${esc(n.text)}</div>
      <div class="row" style="margin-top:6px">
        <button class="ghost" onclick="editNoteForm(${n.id})">✏️ Изменить</button>
        <button class="danger" onclick="deleteNote(${n.id})">🗑 Удалить</button>
      </div>
    </div>
  `).join('') || '<div class="empty">Заметок пока нет</div>';

	return `
    <div class="card" style="margin-bottom:12px">
      <div class="cyl-row">
        <label>Диаметр, см</label>
        <input id="cyl_d" type="number" step="0.1" value="14.2" oninput="calcCylinder()">
        <label>Высота, см</label>
        <span class="cyl-hint">(</span>
        <input id="cyl_h" type="number" step="0.1" oninput="calcCylinder()">
        <span class="cyl-hint">− 0.7)</span>
        <div class="cyl-out" id="cyl_out">≈ — мл</div>
      </div>
    </div>
    <div class="row" style="margin-bottom:8px">
      <button class="primary" onclick="addNoteForm()">+ Новая заметка</button>
    </div>
    ${list}
  `;
}

// ---------- Modal ----------
function openModal(html) {
	document.getElementById('modalRoot').innerHTML = `<div class="modal-bg" onclick="if(event.target===this) closeModal()"><div class="modal">${html}</div></div>`;
}

function closeModal() {
	document.getElementById('modalRoot').innerHTML = '';
}

// ---------- Field defs ----------
const FIELD_DEFS = {
	honeytee: {
		title: 'Новый медочай',
		endpoint: '/api/honeytee',
		allowDraft: true,
		fields: [
			{key: 'tea_type', label: 'Вид чая', type: 'text', required: true, group: 'Чай'},
			{key: 'tea_g', label: 'Чай, г', type: 'number', step: '0.1', required: true, group: 'Чай'},
			{
				key: 'tea_temp',
				label: 'Температура заваривания, °C',
				type: 'number',
				step: '1',
				required: true,
				group: 'Чай'
			},
			{
				key: 'tea_steep_min',
				label: 'Время заваривания, мин',
				type: 'number',
				step: '1',
				required: true,
				group: 'Чай'
			},
			{
				key: '__info_cool',
				label: 'Остудить чай до 25°C',
				type: 'info',
				text: 'Остуди чай до 25°C перед добавлением мёда.',
				group: 'Мёд'
			},
			{key: 'honey_type', label: 'Сорт мёда', type: 'text', required: true, group: 'Мёд'},
			{key: 'honey_g', label: 'Мёд, г', type: 'number', step: '0.1', required: true, group: 'Мёд'},
			{
				key: 'mead_ml',
				label: 'Объём готового медочая, мл',
				type: 'number',
				step: '1',
				required: true,
				group: 'Итог'
			},
			{key: 'density', label: 'ρ старт, °Brix', type: 'number', step: '0.1', group: 'Итог'},
		],
	},
	jar: {
		title: 'Новая база',
		endpoint: '/api/jars',
		fields: [
			{key: 'honeytee_id', label: 'Медочай', type: 'honeytee_select', required: true},
			{key: 'starter_ml', label: 'Объём стартера, мл', type: 'number', step: '1', required: true},
			{key: '__warn_volume', label: 'Проверить объём', type: 'warn'},
			{
				key: '__info_pour',
				label: 'Долить',
				type: 'info',
				text: 'Долей медочай в лимонадницу по стенке. Сверху должно остаться 1-2 см для дыхания.'
			},
			{
				key: '__info_mix',
				label: 'Перемешать',
				type: 'info',
				text: 'Перемешай: слей ~50 мл через краник и залей обратно по стенке.'
			},
			{
				key: '__info_ph',
				label: 'Проверить pH',
				type: 'info',
				text: 'Измерь pH на свежей пробе.<br>Если pH ≥ 4.5 — добавь сусло из F1 и повтори.<br>Если pH < 3 — слей часть стартера и увеличь объём медочая.'
			},
			{key: 'ph', label: 'pH свежей пробы', type: 'number', step: '0.01', required: true},
		],
	},
};

// ---------- Wizard ----------
let wiz = null;

async function openCreate() {
	if (state.tab === 'honeytee') return openWizard('honeytee');
	if (state.tab === 'jars') return openWizard('jar');
}

async function openWizard(entity, id) {
	const def = FIELD_DEFS[entity];
	let data = {};
	if (id) data = await api.get(`${def.endpoint}/${id}`);
	const values = {};
	for (const f of def.fields) {
		if (f.type === 'info' || f.type === 'warn') continue;
		values[f.key] = data[f.key] ?? null;
	}
	const idx0 = def.fields.findIndex(f => f.type !== 'info' && f.type !== 'warn');
	wiz = {entity, mode: id ? 'edit' : 'create', id, def, values, idx: idx0 < 0 ? 0 : idx0};
	renderWizard();
}

function wizFieldHasValue(f) {
	const v = wiz.values[f.key];
	return !(v === null || v === '' || v === undefined);
}

function canSaveAll() {
	if (wiz.mode === 'edit') return true;
	if (wiz.def.allowDraft) return true;  // черновики разрешены
	for (const f of wiz.def.fields) {
		if (f.type === 'info' || f.type === 'warn') continue;
		if (!f.required) continue;
		if (!wizFieldHasValue(f)) return false;
	}
	return true;
}

function renderWizard() {
	const def = wiz.def;
	const isEdit = wiz.mode === 'edit';

	// активная группа
	const activeGroup = def.fields[wiz.idx]?.group || '';

	// поля только активной группы — план
	const planFields = def.fields
		.map((f, i) => ({f, i}))
		.filter(({f}) => (f.group || '') === activeGroup);

	const plan = planFields.map(({f, i}) => {
		let icon;
		if (f.type === 'info' || f.type === 'warn') icon = 'ℹ️';
		else if (wizFieldHasValue(f)) icon = '✅';
		else if (f.required) icon = '⬜';
		else icon = '❔';
		const cur = i === wiz.idx ? ' current' : '';
		const val = (f.type === 'info' || f.type === 'warn') ? '' : (wiz.values[f.key] ?? '');
		return `<li class="${cur}" onclick="jumpTo(${i})">
      <span class="st">${icon}</span>
      <span class="name">${esc(f.label)}</span>
      <span class="val">${esc(val)}</span>
    </li>`;
	}).join('');

	const f = def.fields[wiz.idx];
	let body;
	if (f.type === 'info') {
		body = `<div class="info-box">${f.text}</div>`;
	} else if (f.type === 'warn') {
		const h = state.honeytee.find(x => x.id === wiz.values.honeytee_id);
		const total = (wiz.values.starter_ml || 0) + (h ? (h.mead_ml || 0) : 0);
		if (total > 2300) {
			body = `<div class="warn-box">Сумма объёмов ${total} мл превышает 2300 мл. Лимонадница может перелиться.</div>`;
		} else {
			body = `<div class="info-box">Общий объём: ${total} мл из 2300 мл.</div>`;
		}
	} else {
		body = renderInputForField(f);
	}

	const canNext = (f.type === 'info' || f.type === 'warn') ? true : (wizFieldHasValue(f) || !f.required);
	const isLast = wiz.idx === def.fields.length - 1;
	const canSave = canSaveAll();

	const tabsHtml = def.fields.some(x => x.group) ? renderStageTabs(def, wiz.idx, wizFieldHasValue) : '';

	openModal(`
    <div class="modal-head">
      <h2>${isEdit ? 'Редактирование' : esc(def.title)}</h2>
      <button class="primary" id="w_save" onclick="submitWizard()" ${canSave ? '' : 'disabled'}>💾 Сохранить</button>
    </div>
    ${tabsHtml ? `<div class="stage-tabs">${tabsHtml}</div>` : ''}
    <ul class="plan">${plan}</ul>
    <div class="step-title">Шаг ${wiz.idx + 1} из ${def.fields.length}: <b>${esc(f.label)}</b></div>
    ${body}
    <div class="wiz-actions">
      <button class="ghost" onclick="wizPrev()" ${wiz.idx === 0 ? 'disabled' : ''}>← Назад</button>
      <button class="primary" id="w_next" onclick="wizNext()" ${(canNext && !isLast) ? '' : 'disabled'}>Далее →</button>
    </div>
    <div class="actions">
      <button class="ghost" onclick="closeModal()">Отмена</button>
    </div>
  `);
	attachInputEvents();
}

function renderInputForField(f) {
	const v = wiz.values[f.key];
	if (f.type === 'number') {
		return `<input id="w_input" type="number" step="${f.step || '1'}" value="${v ?? ''}" autofocus>`;
	}
	if (f.type === 'honeytee_select') {
		const available = state.honeytee.filter(h => !h.used && !h.is_draft);
		if (!available.length) {
			return `<div class="info-box">Нет доступных медочаев.<br><br>
        <button class="primary" onclick="closeModal(); switchTab('honeytee'); openWizard('honeytee')">Создать медочай</button>
      </div>`;
		}
		return `<select id="w_input">
      <option value="">— выберите медочай —</option>
      ${available.map(h => `<option value="${h.id}" ${String(h.id) === String(v) ? 'selected' : ''}>${esc(h.title || ('#' + h.id))}</option>`).join('')}
    </select>`;
	}
	if (f.type === 'textarea') {
		return `<textarea id="w_input" rows="3" autofocus>${esc(v ?? '')}</textarea>`;
	}
	return `<input id="w_input" type="text" value="${esc(v ?? '')}" autofocus>`;
}

function renderStageTabs(def, currentIdx, hasValueFn) {
	// собираем группы полей
	const groups = [];
	for (let i = 0; i < def.fields.length; i++) {
		const f = def.fields[i];
		const g = f.group || '';
		if (!groups.length || groups[groups.length - 1].name !== g) {
			groups.push({name: g, items: []});
		}
		groups[groups.length - 1].items.push({f, i});
	}

	// определяем активную группу
	const activeGroup = def.fields[currentIdx]?.group || '';
	// определяем, все ли обязательные поля группы заполнены
	const groupDone = (grp) => grp.items.every(({f}) =>
		f.type === 'info' || f.type === 'warn' || !f.required || hasValueFn(f)
	);

	return groups.map(grp => {
		const isActive = grp.name === activeGroup;
		const done = groupDone(grp);
		const firstIdx = grp.items[0].i;
		return `<button class="stage-tab ${isActive ? 'active' : ''}" onclick="jumpTo(${firstIdx})">
      ${esc(grp.name)} ${done ? '✓' : ''}
    </button>`;
	}).join('');
}

function attachInputEvents() {
	const el = document.getElementById('w_input');
	if (!el) return;
	const f = wiz.def.fields[wiz.idx];
	const update = () => {
		const raw = el.value;
		if (f.type === 'number') wiz.values[f.key] = raw === '' ? null : parseFloat(raw);
		else if (f.type === 'honeytee_select') wiz.values[f.key] = raw === '' ? null : parseInt(raw);
		else wiz.values[f.key] = raw;
		const canNext = wizFieldHasValue(f) || !f.required;
		const isLast = wiz.idx === wiz.def.fields.length - 1;
		const btnNext = document.getElementById('w_next');
		if (btnNext) btnNext.disabled = !(canNext && !isLast);
		const btnSave = document.getElementById('w_save');
		if (btnSave) btnSave.disabled = !canSaveAll();
		updatePlan();
	};
	el.addEventListener('input', update);
	el.addEventListener('change', update);
}

function updatePlan() {
	const def = wiz.def;
	const activeGroup = def.fields[wiz.idx]?.group || '';

	const planEl = document.querySelector('.plan');
	if (planEl) {
		const planFields = def.fields
			.map((f, i) => ({f, i}))
			.filter(({f}) => (f.group || '') === activeGroup);
		planEl.innerHTML = planFields.map(({f, i}) => {
			let icon;
			if (f.type === 'info' || f.type === 'warn') icon = 'ℹ️';
			else if (wizFieldHasValue(f)) icon = '✅';
			else if (f.required) icon = '⬜';
			else icon = '❔';
			const cur = i === wiz.idx ? ' current' : '';
			const val = (f.type === 'info' || f.type === 'warn') ? '' : (wiz.values[f.key] ?? '');
			return `<li class="${cur}" onclick="jumpTo(${i})">
        <span class="st">${icon}</span>
        <span class="name">${esc(f.label)}</span>
        <span class="val">${esc(val)}</span>
      </li>`;
		}).join('');
	}

	// обновляем табы — галочки
	const tabsEl = document.querySelector('.stage-tabs');
	if (tabsEl) {
		tabsEl.innerHTML = renderStageTabs(def, wiz.idx, wizFieldHasValue);
	}
}

function syncCurrentInput() {
	const el = document.getElementById('w_input');
	if (!el) return;
	const f = wiz.def.fields[wiz.idx];
	const raw = el.value;
	if (f.type === 'number') wiz.values[f.key] = raw === '' ? null : parseFloat(raw);
	else if (f.type === 'honeytee_select') wiz.values[f.key] = raw === '' ? null : parseInt(raw);
	else wiz.values[f.key] = raw;
}

function jumpTo(i) {
	if (wiz.idx === i) return;
	syncCurrentInput();
	wiz.idx = i;
	renderWizard();
}

function wizPrev() {
	if (wiz.idx > 0) jumpTo(wiz.idx - 1);
}

function wizNext() {
	if (wiz.idx < wiz.def.fields.length - 1) jumpTo(wiz.idx + 1);
}

async function submitWizard() {
	syncCurrentInput();
	// для черновиков пропускаем проверку обязательных
	if (!wiz.def.allowDraft) {
		for (const f of wiz.def.fields) {
			if (f.type === 'info' || f.type === 'warn') continue;
			if (f.required && !wizFieldHasValue(f)) {
				alert('Обязательное поле не заполнено: ' + f.label);
				const i = wiz.def.fields.findIndex(x => x.key === f.key);
				jumpTo(i);
				return;
			}
		}
	}
	const body = {};
	for (const f of wiz.def.fields) {
		if (f.type === 'info' || f.type === 'warn') continue;
		body[f.key] = wiz.values[f.key];
	}
	// если создаём базу из «нового цикла», передаём родителя
	if (wiz.entity === 'jar' && wiz.mode === 'create' && wiz.fromJarId) {
		body.from_jar_id = wiz.fromJarId;
	}
	try {
		if (wiz.mode === 'create') await api.post(wiz.def.endpoint, body);
		else await api.patch(`${wiz.def.endpoint}/${wiz.id}`, body);
		closeModal();
		await refresh();
	} catch (e) {
		alert('Ошибка: ' + e.message);
	}
}

// ---------- Bottle ----------
async function openBottle(id) {
	const b = await api.get('/api/bottles/' + id);
	const isClosed = (b.stage === 'consumed' || b.stage === 'discarded');
	const additivesEditable = (b.stage === 'f2') || b.has_additives;

	const additives = (b.additives || []).map((a, i) => {
		const inner = `
      <div style="flex:1;min-width:0">
        <b>${esc(a.name)}</b> · ${a.amount} ${UNIT_LABEL[a.unit]}${a.note ? ' · ' + esc(a.note) : ''}
      </div>
    `;
		if (!additivesEditable) {
			return `<div class="card" style="padding:8px;margin:6px 0;display:flex;align-items:center;gap:8px">${inner}</div>`;
		}
		return `<div class="card" style="padding:8px;margin:6px 0;cursor:pointer;display:flex;align-items:center;gap:8px" onclick="editAdditiveForm(${id}, ${i})">${inner}<span style="font-size:14px;flex-shrink:0">✏️</span></div>`;
	}).join('') || '<div class="meta">Нет добавок</div>';
	const BOTTLE_EDITABLE = new Set(['note', 'tasting']);
	const events = (b.events || []).map(e => {
		const p = e.payload ? JSON.parse(e.payload) : {};
		let summary = e.event_type;
		if (e.event_type === 'additive_added') summary = `добавка: ${esc(p.name)} ${p.amount}${UNIT_LABEL[p.unit] || ''}`;
		else if (e.event_type === 'additive_removed') summary = `удалена добавка: ${esc(p.name || '')}`;
		else if (e.event_type === 'bottled') summary = 'бутылка создана';
		else if (e.event_type === 'f2_finished') summary = `F2 завершена (карб. ${p.carbonation || '?'})`;
		else if (e.event_type === 'pet_check') summary = `проверка ПЭТ: ${p.bubbled ? 'надулась' : 'ещё нет'}`;
		else if (e.event_type === 'chill_out') summary = 'достали из холодильника';
		else if (e.event_type === 'discarded') summary = `🗑 выброшено: ${esc(p.reason || 'без причины')}`;
		else if (e.event_type === 'stage_changed') summary = `стадия → ${e.stage}`;
		else if (e.event_type === 'note') summary = `«${esc(p.text || '')}»`;
		else if (e.event_type === 'tasting') summary = `🍷 ${p.rating ? '★'.repeat(p.rating) + '☆'.repeat(5 - p.rating) + ' · ' : ''}${esc(p.note || 'без комментария')}`;

		const btns = BOTTLE_EDITABLE.has(e.event_type)
			? `<button class="ghost" onclick="editBottleEvent(${e.id}, ${id})">✏️</button>
         <button class="danger" onclick="deleteBottleEvent(${e.id}, ${id})">🗑</button>`
			: '';
		return `<li>
      <span class="ev-text">${fmtDate(e.created_at)} — ${summary}</span>
      <span>${btns}</span>
    </li>`;
	}).join('') || '<li>нет событий</li>';

	const stage = b.stage;
	let actionsHtml = '';

	if (stage === 'f2') {
		actionsHtml = '';
	} else if (stage === 'chilling') {
		actionsHtml = `
      <div class="info-box">В холодильнике${b.chill_hours != null ? ': ' + b.chill_hours + ' ч' : ''}.</div>
    `;
	} else if (stage === 'stored') {
		actionsHtml = ``;
	} else if (stage === 'f3') {

		actionsHtml = `<div class="info-box">F3 в разработке.</div>`;
	}

	openModal(`
    <div class="modal-head">
      <h2>${esc(b.title)} <span class="badge ${b.stage}">${STAGE_LABEL[b.stage] || b.stage}</span>${b.material === 'pet' ? ' <span class="badge control">Контроль</span>' : ''}</h2>
      ${(() => {
		const isF2 = b.stage === 'f2';
		const canEdit = !isClosed && (isF2 || (b.additives && b.additives.length));
		const canDelete = !isClosed;
		if (!canEdit && !canDelete) return '';
		return `
          <div class="head-actions">
            ${canEdit ? `<button class="ghost" onclick="editBottle(${id})" title="Изменить">✏️</button>` : ''}
            ${canDelete ? `<button class="danger" onclick="deleteBottle(${id})" title="Удалить">🗑</button>` : ''}
          </div>
        `;
	})()}
    </div>
                  <div class="card" style="padding:8px;margin:8px 0;cursor:pointer" onclick="openJar(${b.jar ? b.jar.id : 0}, ${id})">
      <b>Партия: ${b.jar ? esc(b.jar.title) : '—'}</b>
      ${b.jar ? `<div class="meta">${fmtDate(b.jar.created_at)}</div>` : ''}
    </div>
    <div class="meta">${b.volume_ml} мл (${MATERIAL_LABEL[b.material] || b.material}) • залито ${b.filled_ml} мл</div>
    ${b.abv != null ? `<div class="meta">≈ ${b.abv}% алкоголя</div>` : ''}
    ${b.carbonation != null ? `<div class="meta">Карбонизация: ${'★'.repeat(b.carbonation)}${'☆'.repeat(5 - b.carbonation)}</div>` : ''}
    ${b.sediment != null ? `<div class="meta">Осадок: ${b.sediment ? 'да' : 'нет'}${b.sediment_note ? ' (' + esc(b.sediment_note) + ')' : ''}</div>` : ''}
    ${b.chill_hours != null ? `<div class="meta">В холодильнике: ${b.chill_hours} ч</div>` : ''}

    ${actionsHtml}

    ${(additivesEditable || (b.additives && b.additives.length)) ? `
      <h3 style="margin-top:14px;font-size:14px">Добавки</h3>
      ${additives}
      ${additivesEditable
		? `<div class="row" style="margin-top:8px">
             <button class="ghost" onclick="addAdditiveForm(${id})">+ Добавить добавку</button>
           </div>`
		: ''}
    ` : ''}

    <h3 style="margin-top:14px;font-size:14px">История</h3>
    <ul class="events">${events}</ul>
      <div class="row" style="margin-top:8px">
        <button class="ghost" onclick="addBottleEntry(${id})">+ Запись</button>
      </div>

    ${renderBottleStageActions(b, id)}

    <div class="actions">
      <button class="ghost" onclick="closeModal()">Закрыть</button>
    </div>
  `);
}

function renderBottleStageActions(b, id) {
	const stage = b.stage;
	let mainBtn = '';
	let dangerBtn = '';

	// основное действие по стадии
	if (stage === 'f2') {
		// Завершение F2 теперь только из списка бутылок (кнопка под партией)
		mainBtn = '';
	} else if (stage === 'f3') {
		// когда появится F3-действие — здесь
	} else if (stage === 'chilling') {
		mainBtn = `<button class="primary" style="flex:1" onclick="chillOutWithCheck(${id}, ${b.chill_hours != null ? b.chill_hours : 0})">Достать из холодильника</button>`;
	} else if (stage === 'stored') {
		mainBtn = `<button class="primary" style="flex:1" onclick="consumeBottleForm(${id})">Выпито</button>`;
	}

	// опасное действие — для всех активных стадий
	if (stage !== 'consumed' && stage !== 'discarded') {
		dangerBtn = `<button class="danger" style="flex:1" onclick="discardBottleForm(${id})">🗑 Выбросить</button>`;
	}

	if (!mainBtn && !dangerBtn) return '';

	return `<div class="row" style="margin-top:14px">
    ${mainBtn}
    ${dangerBtn}
  </div>`;
}

async function editBottle(id) {
	const b = await api.get('/api/bottles/' + id);
	openModal(`
    <h2>Редактировать ${esc(b.title)}</h2>
    <label>Тара</label>
    <input type="text" value="${MATERIAL_LABEL[b.material] || b.material} ${b.volume_ml ?? ''} мл" disabled>
    <label>Залито, мл</label>
    <input id="eb_fill" type="number" value="${b.filled_ml ?? ''}">
    <label>Заметки</label>
    <textarea id="eb_notes" rows="2">${esc(b.notes || '')}</textarea>
    <div class="actions">
      <button class="ghost" onclick="closeModal()">Отмена</button>
      <button class="primary" onclick="saveBottle(${id})">Сохранить</button>
    </div>
  `);
}

function addBottleEntry(bottleId) {
	openModal(`
    <h2>Заметка</h2>
    <label>Текст</label>
    <textarea id="bn_text" rows="3" autofocus></textarea>
    <div class="actions">
      <button class="ghost" onclick="openBottle(${bottleId})">Назад</button>
      <button class="primary" onclick="submitBottleNote(${bottleId})">Сохранить</button>
    </div>
  `);
}

async function submitBottleNote(bottleId) {
	const text = document.getElementById('bn_text').value.trim();
	if (!text) {
		alert('Введите текст');
		return;
	}
	await api.post('/api/events', {
		entity_type: 'bottle', entity_id: bottleId,
		event_type: 'note', payload: {text},
	});
	await refresh();
	openBottle(bottleId);
}

async function editBottleEvent(eid, bottleId) {
	const events = await api.get(`/api/events?entity_type=bottle&entity_id=${bottleId}`);
	const ev = events.find(e => e.id === eid);
	if (!ev) {
		alert('Событие не найдено');
		return;
	}
	const p = ev.payload ? JSON.parse(ev.payload) : {};

	if (ev.event_type === 'note') {
		openModal(`
      <h2>Редактировать заметку</h2>
      <label>Текст</label>
      <textarea id="bn_text" rows="3">${esc(p.text || '')}</textarea>
      <div class="actions">
        <button class="ghost" onclick="openBottle(${bottleId})">Назад</button>
        <button class="primary" onclick="saveBottleNote(${eid}, ${bottleId})">Сохранить</button>
      </div>
    `);
	} else if (ev.event_type === 'tasting') {
		openModal(`
      <h2>Редактировать отзыв</h2>
      <label>Оценка</label>
      <select id="te_rating">
        <option value="">— без оценки —</option>
        <option value="5" ${p.rating === 5 ? 'selected' : ''}>5 — отлично</option>
        <option value="4" ${p.rating === 4 ? 'selected' : ''}>4 — хорошо</option>
        <option value="3" ${p.rating === 3 ? 'selected' : ''}>3 — нормально</option>
        <option value="2" ${p.rating === 2 ? 'selected' : ''}>2 — так себе</option>
        <option value="1" ${p.rating === 1 ? 'selected' : ''}>1 — плохо</option>
      </select>
      <label>Комментарий</label>
      <textarea id="te_note" rows="3">${esc(p.note || '')}</textarea>
      <div class="actions">
        <button class="ghost" onclick="openBottle(${bottleId})">Назад</button>
        <button class="primary" onclick="saveBottleTasting(${eid}, ${bottleId})">Сохранить</button>
      </div>
    `);
	} else {
		alert('Это событие нельзя редактировать');
	}
}

async function saveBottleNote(eid, bottleId) {
	const text = document.getElementById('bn_text').value.trim();
	if (!text) {
		alert('Введите текст');
		return;
	}
	try {
		await api.patch('/api/events/' + eid, {payload: {text}});
		await refresh();
		openBottle(bottleId);
	} catch (e) {
		alert(e.message);
	}
}

async function saveBottleTasting(eid, bottleId) {
	const ratingStr = document.getElementById('te_rating').value;
	const note = document.getElementById('te_note').value.trim();
	try {
		await api.patch('/api/events/' + eid, {
			payload: {
				rating: ratingStr ? parseInt(ratingStr) : null,
				note: note || null,
			}
		});
		await refresh();
		openBottle(bottleId);
	} catch (e) {
		alert(e.message);
	}
}

async function deleteBottleEvent(eid, bottleId) {
	if (!confirm('Удалить событие?')) return;
	try {
		await api.del('/api/events/' + eid);
		await refresh();
		openBottle(bottleId);
	} catch (e) {
		alert(e.message);
	}
}

async function saveBottle(id) {
	const body = {
		filled_ml: num('eb_fill'),
		notes: v('eb_notes') || null,
	};
	await api.patch('/api/bottles/' + id, body);
	closeModal();
	refresh();
}

async function deleteBottle(id) {
	if (!confirm('Удалить бутылку?')) return;
	try {
		await api.del('/api/bottles/' + id);
		closeModal();
		refresh();
	} catch (e) {
		alert(e.message);
	}
}

// ---------- Bottle status ----------
function chillOutWithCheck(bottleId, chillHours) {
	const MIN_HOURS = 12;
	if (chillHours >= MIN_HOURS) {
		// всё ок, достаём без вопросов
		chillOut(bottleId);
		return;
	}
	const left = Math.max(0, MIN_HOURS - chillHours);
	openModal(`
    <h2>Рано доставать?</h2>
    <div class="info-box">
      Бутылка в холодильнике всего ${chillHours} ч. Рекомендуется подождать ещё ${left} ч (минимум 12 ч).
    </div>
    <p>Достать всё равно?</p>
    <div class="actions">
      <button class="ghost" onclick="openBottle(${bottleId})">Отмена</button>
      <button class="primary" onclick="chillOut(${bottleId})">Всё равно достать</button>
    </div>
  `);
}

async function chillOut(bottleId) {
	await api.post(`/api/bottles/${bottleId}/chill_out`);
	await refresh();
	openBottle(bottleId);
}

function discardBottleForm(bottleId) {
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

async function discardBottle(bottleId) {
	const reason = document.getElementById('disc_reason').value.trim();
	if (!reason) {
		alert('Укажите причину');
		return;
	}
	try {
		await api.post('/api/events', {
			entity_type: 'bottle',
			entity_id: bottleId,
			stage: 'discarded',
			event_type: 'discarded',
			payload: {reason},
		});
		await api.post(`/api/bottles/${bottleId}/stage`, {stage: 'discarded'});
		await refresh();
		openBottle(bottleId);
	} catch (e) {
		alert('Ошибка: ' + e.message);
	}
}

function consumeBottleForm(bottleId) {
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

async function consumeBottle(bottleId) {
	const ratingStr = document.getElementById('cons_rating').value;
	const note = document.getElementById('cons_note').value.trim();
	try {
		if (ratingStr || note) {
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
		await api.post(`/api/bottles/${bottleId}/stage`, {stage: 'consumed'});
		await refresh();
		openBottle(bottleId);
	} catch (e) {
		alert('Ошибка: ' + e.message);
	}
}

// ---------- Additives ----------
function addAdditiveForm(bottleId) {
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

async function submitAdditive(bottleId) {
	const body = {
		name: v('ad_name'),
		amount: num('ad_amount'),
		unit: v('ad_unit'),
		note: v('ad_note') || null,
	};
	if (!body.name || body.amount === null) {
		alert('Заполните название и количество');
		return;
	}
	try {
		await api.post(`/api/bottles/${bottleId}/additives`, body);
		await refresh();
		openBottle(bottleId);
	} catch (e) {
		alert(e.message);
	}
}

async function submitEditAdditive(bottleId, idx) {
	const body = {
		name: v('ad_name'),
		amount: num('ad_amount'),
		unit: v('ad_unit'),
		note: v('ad_note') || null,
	};
	if (!body.name || body.amount === null) {
		alert('Заполните название и количество');
		return;
	}
	try {
		await api.patch(`/api/bottles/${bottleId}/additives/${idx}`, body);
		await refresh();
		openBottle(bottleId);
	} catch (e) {
		alert(e.message);
	}
}

async function editAdditiveForm(bottleId, idx) {
	const b = await api.get('/api/bottles/' + bottleId);
	const a = (b.additives || [])[idx];
	if (!a) {
		alert('Добавка не найдена');
		return;
	}
	openModal(`
    <h2>Добавка</h2>
    <label>Название</label><input id="ad_name" type="text" value="${esc(a.name || '')}" autofocus>
    <label>Количество</label><input id="ad_amount" type="number" step="0.1" value="${a.amount ?? ''}">
    <label>Единица</label>
    <select id="ad_unit">
      <option value="g" ${a.unit === 'g' ? 'selected' : ''}>граммы</option>
      <option value="ml" ${a.unit === 'ml' ? 'selected' : ''}>миллилитры</option>
      <option value="pcs" ${a.unit === 'pcs' ? 'selected' : ''}>штуки</option>
    </select>
    <label>Заметка</label><textarea id="ad_note" rows="2">${esc(a.note || '')}</textarea>
    <div class="actions">
      <button class="ghost" onclick="openBottle(${bottleId})">Назад</button>
      <button class="danger" onclick="removeAdditiveFromForm(${bottleId}, ${idx})">🗑 Удалить</button>
      <button class="primary" onclick="submitEditAdditive(${bottleId}, ${idx})">Сохранить</button>
    </div>
  `);
}

async function removeAdditiveFromForm(bottleId, idx) {
	if (!confirm('Удалить добавку?')) return;
	try {
		await api.del(`/api/bottles/${bottleId}/additives/${idx}`);
		await refresh();
		openBottle(bottleId);
	} catch (e) {
		alert(e.message);
	}
}

// ---------- Jar ----------
async function openJar(id, fromBottleId) {
	currentJarOrigin = fromBottleId || null;
	const j = await api.get('/api/jars/' + id);

	const bottles = (j.bottles || []).map(b => `
    <div class="card" style="padding:8px;margin-bottom:6px" onclick="openBottle(${b.id})">
            <b>${esc(b.title)}</b> <span class="badge ${b.stage}">${STAGE_LABEL[b.stage] || b.stage}</span>
      <div class="meta">${b.volume_ml} мл (${MATERIAL_LABEL[b.material] || b.material}) • залито ${b.filled_ml} мл</div>
      ${b.additives && b.additives.length ? `<div class="meta">Добавки: ${b.additives.map(a => esc(a.name) + ' ' + a.amount + UNIT_LABEL[a.unit]).join(', ')}</div>` : ''}
    </div>
  `).join('');

	const history = renderJarHistory(j.events || [], id);

	openModal(`
    <div class="modal-head">
      <h2>${esc(j.title)} <span class="badge ${j.state}">${STAGE_LABEL[j.state] || j.state}</span></h2>
      ${j.state === 'bottled' ? '' : `
        <div class="head-actions">
          <button class="danger" onclick="deleteJarFromModal(${id})" title="Удалить базу">🗑</button>
        </div>
      `}
    </div>
    <div class="meta">Создана: ${fmtDate(j.created_at)}</div>
        ${j.honeytee ? `
        <div class="card" style="padding:8px;margin:8px 0;cursor:pointer" onclick="openHoneytee(${j.honeytee.id}, ${id}, ${fromBottleId || 'null'})">
        <b>Медочай</b>
        <div class="meta">${esc(j.honeytee.tea_type || '?')} ${j.honeytee.tea_g || '?'} г • ${esc(j.honeytee.honey_type || '?')} ${j.honeytee.honey_g || '?'} г</div>
      </div>
    ` : '<div class="meta">Медочай: —</div>'}
    <div class="meta">Медочай: ${j.honeytee && j.honeytee.mead_ml ? j.honeytee.mead_ml + ' мл' : '—'} • Стартер: ${j.starter_ml || '?'} мл</div>
    <div class="meta">ρ старт: ${j.rho_start != null ? j.rho_start + ' °Brix' : '—'}${j.state === 'bottled' ? ` • ρ финал: ${j.rho_final != null ? j.rho_final + ' °Brix' : '—'}` : ''}</div>
    <div class="meta">pH старт: ${j.ph ?? '—'}${j.final_ph != null ? ' • pH финал: ' + j.final_ph : ''}</div>
    ${j.state === 'bottled' ? `
		${j.abv != null ? `<div class="meta"><b>≈ ${j.abv}% алкоголя</b></div>` : ''}
      <div class="meta">Разлито: ${j.total_filled_ml} мл из ${j.total_in_ml} мл</div>
      <div class="meta">Остаток: <b>${j.leftover_ml} мл</b></div>
    ` : ''}
    ${j.reminder ? `<div class="reminder">${esc(j.reminder)}</div>` : ''}

    ${j.state === 'f1' ? `
      <h3 style="margin-top:14px;font-size:14px">История F1</h3>
      <ul class="events">${history}</ul>
      <div class="row" style="margin-top:8px">
        <button class="ghost" onclick="addJarEntry(${id})">+ Запись</button>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="primary" style="flex:1" onclick="finishF1Wizard(${id})">Завершить F1</button>
      </div>
    ` : ''}

    ${j.state === 'bottled' ? `
      <h3 style="margin-top:14px;font-size:14px">История</h3>
      <ul class="events">${history}</ul>
      ${!j.next_cycle_started ? `
        <div class="row" style="margin-top:8px">
          <button class="primary" onclick="newCycle(${id})">Новый цикл</button>
        </div>
      ` : ''}
    ` : ''}

    ${bottles ? `<h3 style="margin-top:14px;font-size:14px">Бутылки партии</h3>${bottles}` : ''}
        <div class="actions">
      ${fromBottleId
		? `<button class="ghost" onclick="openBottle(${fromBottleId})">← Назад к бутылке</button>`
		: `<button class="ghost" onclick="closeModal()">Закрыть</button>`}
    </div>
  `);
}

function renderJarHistory(events, jarId) {
	if (!events || !events.length) return '<li>нет событий</li>';
	const sorted = [...events].sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
	const EDITABLE = new Set(['ph', 'note']);

	// какие типы событий показываем в истории
	const VISIBLE = new Set([
		'ph', 'note', 'created',
		'f1_finished', 'bottled',
		'new_cycle_started',
	]);

	const items = [];
	for (const ev of sorted) {
		if (!VISIBLE.has(ev.event_type)) continue;

		const p = ev.payload ? JSON.parse(ev.payload) : {};
		let summary = ev.event_type;

		if (ev.event_type === 'ph') summary = `pH ${p.value ?? '?'}`;
		else if (ev.event_type === 'note') summary = `«${esc(p.text || '')}»`;
		else if (ev.event_type === 'created') summary = 'создание базы';
		else if (ev.event_type === 'f1_finished') summary = `F1 завершена (pH ${p.final_ph}, ρ финал ${p.rho_final ?? '—'})`;
		else if (ev.event_type === 'bottled') summary = `розлив: ${p.bottles_count} бутылок, ${p.total_filled_ml} мл`;
		else if (ev.event_type === 'new_cycle_started') summary = `запущен новый цикл: #${p.new_jar_id ?? '?'}`;

		const btns = EDITABLE.has(ev.event_type)
			? `<button class="ghost" onclick="editJarEvent(${ev.id}, ${jarId})">✏️</button>
         <button class="danger" onclick="deleteJarEvent(${ev.id}, ${jarId})">🗑</button>`
			: '';

		items.push(`<li>
      <span class="ev-text">${fmtDate(ev.created_at)} — ${summary}</span>
      <span>${btns}</span>
    </li>`);
	}

	if (!items.length) return '<li>нет событий</li>';
	return items.reverse().join('');
}

async function addJarEntry(jarId) {
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

async function submitJarEntry(jarId) {
	const phRaw = document.getElementById('ev_val').value.trim();
	const note = document.getElementById('ev_text').value.trim();
	const ph = phRaw === '' ? null : parseFloat(phRaw);
	if (phRaw !== '' && isNaN(ph)) {
		alert('pH должен быть числом');
		return;
	}
	if (ph === null && !note) {
		alert('Заполните хотя бы одно поле');
		return;
	}
	try {
		// создаём pH-событие если есть
		if (ph !== null) {
			await api.post('/api/events', {
				entity_type: 'jar', entity_id: jarId,
				event_type: 'ph', payload: {value: ph},
			});
		}
		// создаём заметку если есть
		if (note) {
			await api.post('/api/events', {
				entity_type: 'jar', entity_id: jarId,
				event_type: 'note', payload: {text: note},
			});
		}
		await refresh();
		openJar(jarId, currentJarOrigin);
	} catch (e) {
		alert('Ошибка: ' + e.message);
	}
}

async function editJarEvent(eid, jarId) {
	const events = await api.get(`/api/events?entity_type=jar&entity_id=${jarId}`);
	const ev = events.find(e => e.id === eid);
	if (!ev) {
		alert('Событие не найдено');
		return;
	}
	const p = ev.payload ? JSON.parse(ev.payload) : {};
	if (ev.event_type === 'ph') {
		openModal(`
      <h2>Редактировать pH</h2>
      <label>Значение</label><input id="ev_val" type="number" step="0.01" value="${p.value ?? ''}">
      <div class="actions">
        <button class="ghost" onclick="openJar(${jarId})">Назад</button>
        <button class="primary" onclick="saveJarEventPh(${eid}, ${jarId})">Сохранить</button>
      </div>
    `);
	} else if (ev.event_type === 'note') {
		openModal(`
      <h2>Редактировать заметку</h2>
      <label>Текст</label><textarea id="ev_text" rows="3">${esc(p.text || '')}</textarea>
      <div class="actions">
        <button class="ghost" onclick="openJar(${jarId})">Назад</button>
        <button class="primary" onclick="saveJarEventNote(${eid}, ${jarId})">Сохранить</button>
      </div>
    `);
	} else {
		alert('Это событие нельзя редактировать');
	}
}

async function saveJarEventPh(eid, jarId) {
	const val = num('ev_val');
	if (val === null || isNaN(val)) {
		alert('Введите число');
		return;
	}
	await api.patch('/api/events/' + eid, {payload: {value: val}});
	await refresh();
	openJar(jarId, currentJarOrigin);
}

async function saveJarEventNote(eid, jarId) {
	const text = v('ev_text');
	if (!text) {
		alert('Введите текст');
		return;
	}
	await api.patch('/api/events/' + eid, {payload: {text}});
	await refresh();
	openJar(jarId, currentJarOrigin);
}

async function deleteJarEvent(eid, jarId) {
	if (!confirm('Удалить событие?')) return;
	await api.del('/api/events/' + eid);
	await refresh();
	if (jarId) openJar(jarId, currentJarOrigin);
	else closeModal();
}

async function deleteJar(id) {
	if (!confirm('Удалить базу? Это возможно только если у неё нет бутылок.')) return;
	try {
		await api.del('/api/jars/' + id);
		refresh();
	} catch (e) {
		alert(e.message);
	}
}

async function deleteJarFromModal(id) {
	if (!confirm('Удалить базу? Это возможно только если у неё нет бутылок.')) return;
	try {
		await api.del('/api/jars/' + id);
		closeModal();
		await refresh();
	} catch (e) {
		alert(e.message);
	}
}

// ---------- Honeytee ----------
async function openHoneytee(id, fromJarId, fromBottleId) {
	const h = await api.get('/api/honeytee/' + id);
	openModal(`
    <h2>${esc(h.title || ('Медочай #' + h.id))}</h2>
    <div class="meta">Создан: ${fmtDate(h.created_at)}</div>
    <h3 style="margin-top:12px;font-size:14px">Состав</h3>
    <div class="meta">Чай: ${esc(h.tea_type || '?')} — ${h.tea_g || '?'} г</div>
    <div class="meta">Температура заваривания: ${h.tea_temp ?? '—'} °C</div>
    <div class="meta">Время заваривания: ${h.tea_steep_min ?? '—'} мин</div>
    <div class="meta">Мёд: ${esc(h.honey_type || '?')} — ${h.honey_g || '?'} г</div>
    <h3 style="margin-top:12px;font-size:14px">Итог</h3>
    <div class="meta">Объём: ${h.mead_ml || '?'} мл</div>
    <div class="meta">ρ старт: ${h.density ?? '—'} °Brix</div>
    <div class="meta">Использован: ${h.used ? 'да' : 'нет'}</div>
        <div class="actions">
      ${h.used ? '' : `<button class="ghost" onclick="closeModal(); openWizard('honeytee', ${h.id})">✏️ Изменить</button>`}
            ${fromJarId
		? `<button class="ghost" onclick="openJar(${fromJarId}, ${fromBottleId || 'null'})">← Назад к базе</button>`
		: `<button class="ghost" onclick="closeModal()">Закрыть</button>`}
    </div>
  `);
}

async function deleteHoneytee(id) {
	if (!confirm('Удалить медочай?')) return;
	try {
		await api.del('/api/honeytee/' + id);
		refresh();
	} catch (e) {
		alert(e.message);
	}
}

// ---------- Notes tab ----------
function calcCylinder() {
	const d = parseFloat(document.getElementById('cyl_d').value);
	const h = parseFloat(document.getElementById('cyl_h').value);
	const out = document.getElementById('cyl_out');
	if (!out) return;
	if (isNaN(d) || isNaN(h) || d <= 0 || h <= 0) {
		out.textContent = '≈ — мл';
		return;
	}
	// объём цилиндра: π * (d/2)^2 * h; 1 см³ = 1 мл
	// вычитаем 0.7 см из высоты (поправка на бортик/уровень)
	const hEff = h - 0.7;
	if (hEff <= 0) {
		out.textContent = '≈ — мл';
		return;
	}
	const v = Math.PI * Math.pow(d / 2, 2) * hEff;
	out.textContent = `≈ ${v.toFixed(1)} мл`;
}

function addNoteForm() {
	openModal(`
    <h2>Новая заметка</h2>
    <label>Текст</label>
    <textarea id="note_text" rows="6" autofocus></textarea>
    <div class="actions">
      <button class="ghost" onclick="closeModal()">Отмена</button>
      <button class="primary" onclick="submitNote()">Сохранить</button>
    </div>
  `);
}

async function submitNote() {
	const text = document.getElementById('note_text').value.trim();
	if (!text) {
		alert('Введите текст');
		return;
	}
	try {
		await api.post('/api/notes', {text});
		closeModal();
		await refresh();
	} catch (e) {
		alert(e.message);
	}
}

async function editNoteForm(id) {
	const note = (state.notes || []).find(n => n.id === id);
	if (!note) {
		alert('Заметка не найдена');
		return;
	}
	openModal(`
    <h2>Редактировать заметку</h2>
    <label>Текст</label>
    <textarea id="note_text" rows="6">${esc(note.text)}</textarea>
    <div class="actions">
      <button class="ghost" onclick="closeModal()">Отмена</button>
      <button class="primary" onclick="saveNote(${id})">Сохранить</button>
    </div>
  `);
}

async function saveNote(id) {
	const text = document.getElementById('note_text').value.trim();
	if (!text) {
		alert('Введите текст');
		return;
	}
	try {
		await api.patch('/api/notes/' + id, {text});
		closeModal();
		await refresh();
	} catch (e) {
		alert(e.message);
	}
}

async function deleteNote(id) {
	if (!confirm('Удалить заметку?')) return;
	try {
		await api.del('/api/notes/' + id);
		await refresh();
	} catch (e) {
		alert(e.message);
	}
}

// ---------- F1 finish wizard ----------
async function finishF1Wizard(jarId) {
	const jar = await api.get('/api/jars/' + jarId);
	const totalInMl = jar.total_in_ml || 0;

	const wizF1 = {
		jarId,
		totalInMl,
		step: 0,
		fields: [
			{key: 'final_ph', label: 'Финальный pH', type: 'number', step: '0.01', required: true},
			{key: 'rho_final', label: 'ρ финал, °Brix', type: 'number', step: '0.1', required: false},
			{key: '__bottles', label: 'Бутылки', type: 'bottles'},
		],
		values: {final_ph: null, rho_final: null},
		bottles: [],
	};

	function hasValue(f) {
		if (f.type === 'bottles') return wizF1.bottles.length > 0;
		const v = wizF1.values[f.key];
		return !(v === null || v === '' || v === undefined);
	}

	function canSave() {
		// хотя бы одна бутылка
		if (!wizF1.bottles.length) return false;
		// все обязательные поля заполнены
		for (const f of wizF1.fields) {
			if (!f.required) continue;
			if (!hasValue(f)) return false;
		}
		// не разлито больше, чем есть
		const totalFilled = wizF1.bottles.reduce((s, b) => s + (b.filled_ml || 0), 0);
		return totalFilled <= wizF1.totalInMl;
	}

	function render() {
		const step = wizF1.step;
		const f = wizF1.fields[step];
		const isLast = step === wizF1.fields.length - 1;

		const plan = wizF1.fields.map((fld, i) => {
			let icon;
			if (hasValue(fld)) icon = '✅';
			else if (fld.required) icon = '⬜';
			else icon = '❔';
			const cur = i === step ? ' current' : '';
			let val = '';
			if (fld.type === 'bottles') val = wizF1.bottles.length ? `${wizF1.bottles.length} шт` : '';
			else val = wizF1.values[fld.key] ?? '';
			return `<li class="${cur}" onclick="finishF1Jump(${i})">
        <span class="st">${icon}</span>
        <span class="name">${esc(fld.label)}</span>
        <span class="val">${esc(val)}</span>
      </li>`;
		}).join('');

		let body;
		if (f.type === 'bottles') {
			const list = wizF1.bottles.map((b, i) => {
				const addStr = (b.additives && b.additives.length)
					? `<div class="meta">Добавки: ${b.additives.map(a => esc(a.name) + ' ' + a.amount + UNIT_LABEL[a.unit]).join(', ')}</div>`
					: '';
				return `
          <div class="card" style="padding:8px;margin-bottom:6px">
            <b>${esc(b.title)}</b>
            <div class="meta">${b.volume_ml} мл (${MATERIAL_LABEL[b.material] || b.material}) • залито ${b.filled_ml} мл</div>
            ${addStr}
            <div class="row" style="margin-top:6px">
              <button class="danger" onclick="finishF1RemoveBottle(${i})">Удалить</button>
            </div>
          </div>
        `;
			}).join('') || '<div class="empty">Бутылок пока нет</div>';

			const totalFilled = wizF1.bottles.reduce((s, b) => s + (b.filled_ml || 0), 0);
			const leftover = wizF1.totalInMl - totalFilled;
			const over = leftover < 0;

			const summary = `
        <div class="${over ? 'warn-box' : 'info-box'}">
          <div>Разлито: ${totalFilled} мл из ${wizF1.totalInMl} мл</div>
          <div><b>Остаток в лимонаднице: ${leftover} мл</b></div>
          ${over ? '<div>Разлито больше, чем есть в базе — поправь объёмы бутылок.</div>' : ''}
        </div>
      `;

			body = `
        <div style="margin-bottom:8px">${list}</div>
        <button class="ghost" style="width:100%" onclick="finishF1AddBottleForm()">+ Добавить бутылку</button>
        ${summary}
      `;
		} else if (f.type === 'number') {
			const v = wizF1.values[f.key];
			body = `<input id="f1_input" type="number" step="${f.step || '1'}" value="${v ?? ''}" autofocus>`;
		}

		const canNext = hasValue(f) || !f.required;
		const canSv = canSave();

		openModal(`
      <div class="modal-head">
        <h2>Завершение F1</h2>
        <button class="primary" id="f1_save" onclick="finishF1Save()" ${canSv ? '' : 'disabled'}>💾 Сохранить</button>
      </div>
      <ul class="plan">${plan}</ul>
      <div class="step-title">Шаг ${step + 1} из ${wizF1.fields.length}: <b>${esc(f.label)}</b></div>
      ${body}
      <div class="wiz-actions">
        <button class="ghost" onclick="finishF1Prev()" ${step === 0 ? 'disabled' : ''}>← Назад</button>
        <button class="primary" id="f1_next" onclick="finishF1Next()" ${(canNext && !isLast) ? '' : 'disabled'}>Далее →</button>
      </div>
      <div class="actions">
        <button class="ghost" onclick="closeModal()">Отмена</button>
      </div>
    `);

		const input = document.getElementById('f1_input');
		if (input) {
			const onInput = () => {
				const raw = input.value;
				wizF1.values[f.key] = raw === '' ? null : parseFloat(raw);
				const canNext2 = hasValue(f) || !f.required;
				const isLast2 = wizF1.step === wizF1.fields.length - 1;
				const btnNext = document.getElementById('f1_next');
				if (btnNext) btnNext.disabled = !(canNext2 && !isLast2);
				const btnSave = document.getElementById('f1_save');
				if (btnSave) btnSave.disabled = !canSave();
				updateF1Plan();
			};
			input.addEventListener('input', onInput);
		}

		window.finishF1Prev = () => {
			if (wizF1.step > 0) {
				syncF1Input();
				wizF1.step--;
				render();
			}
		};
		window.finishF1Next = () => {
			if (wizF1.step < wizF1.fields.length - 1) {
				syncF1Input();
				wizF1.step++;
				render();
			}
		};
		window.finishF1Jump = (i) => {
			syncF1Input();
			wizF1.step = i;
			render();
		};
	}

	window.finishF1RefreshWizard = () => {
		render();
	};

	function syncF1Input() {
		const input = document.getElementById('f1_input');
		if (!input) return;
		const f = wizF1.fields[wizF1.step];
		if (f.type === 'number') {
			wizF1.values[f.key] = input.value === '' ? null : parseFloat(input.value);
		}
	}

	function updateF1Plan() {
		const planEl = document.querySelector('.plan');
		if (!planEl) return;
		planEl.innerHTML = wizF1.fields.map((fld, i) => {
			let icon;
			if (hasValue(fld)) icon = '✅';
			else if (fld.required) icon = '⬜';
			else icon = '❔';
			const cur = i === wizF1.step ? ' current' : '';
			let val = '';
			if (fld.type === 'bottles') val = wizF1.bottles.length ? `${wizF1.bottles.length} шт` : '';
			else val = wizF1.values[fld.key] ?? '';
			return `<li class="${cur}" onclick="finishF1Jump(${i})">
        <span class="st">${icon}</span>
        <span class="name">${esc(fld.label)}</span>
        <span class="val">${esc(val)}</span>
      </li>`;
		}).join('');
	}

	window.finishF1RemoveBottle = (i) => {
		wizF1.bottles.splice(i, 1);
		render();
	};

	window.finishF1AddBottleForm = () => {
		let tempAdditives = [];
		let draft = {volume_ml: 330, material: 'glass', filled_ml: null};

		function renderAdditivesBlock() {
			if (!tempAdditives.length) return '<div class="meta">Нет добавок</div>';
			return tempAdditives.map((a, i) => `
        <div class="additive-item">
          <div class="text">${esc(a.name)} — ${a.amount} ${UNIT_LABEL[a.unit]}${a.note ? ' • ' + esc(a.note) : ''}</div>
          <button class="ghost" onclick="finishF1EditTempAdditiveForm(${i})" style="padding:4px 8px;font-size:13px">✏️</button>
          <button class="danger" onclick="finishF1RemoveTempAdditive(${i})" style="padding:4px 8px;font-size:13px">✕</button>
        </div>
      `).join('');
		}

		function syncDraft(){
		  const matEl = document.getElementById('fb_mat');
		  const fillEl = document.getElementById('fb_fill');
		  if(matEl) draft.material = matEl.value;
		  draft.volume_ml = draft.material === 'pet' ? 300 : 330;
		  if(fillEl) draft.filled_ml = fillEl.value === '' ? null : parseFloat(fillEl.value);
		}

		function renderBottleForm() {
			openModal(`
        <h2>Новая бутылка</h2>
        <label>Тара</label>
        <select id="fb_mat">
          <option value="glass" ${draft.material === 'glass' ? 'selected' : ''}>Стекло 330 мл</option>
          <option value="pet" ${draft.material === 'pet' ? 'selected' : ''}>ПЭТ 300 мл (контрольная)</option>
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

		window.finishF1EditTempAdditiveForm = (idx) => {
			syncDraft();
			const a = tempAdditives[idx];
			if (!a) {
				alert('Добавка не найдена');
				return;
			}
			openModal(`
        <h2>Редактировать добавку</h2>
        <label>Название</label><input id="tad_name" type="text" value="${esc(a.name || '')}" autofocus>
        <label>Количество</label><input id="tad_amount" type="number" step="0.1" value="${a.amount ?? ''}">
        <label>Единица</label>
        <select id="tad_unit">
          <option value="g" ${a.unit === 'g' ? 'selected' : ''}>граммы</option>
          <option value="ml" ${a.unit === 'ml' ? 'selected' : ''}>миллилитры</option>
          <option value="pcs" ${a.unit === 'pcs' ? 'selected' : ''}>штуки</option>
        </select>
        <label>Заметка (необязательно)</label><textarea id="tad_note" rows="2">${esc(a.note || '')}</textarea>
        <div class="actions">
          <button class="ghost" onclick="finishF1BackToBottleForm()">Назад</button>
          <button class="primary" onclick="finishF1ConfirmEditTempAdditive(${idx})">Сохранить</button>
        </div>
      `);
		};

		window.finishF1ConfirmEditTempAdditive = (idx) => {
			const name = v('tad_name');
			const amount = num('tad_amount');
			if (!name || amount === null) {
				alert('Заполните название и количество');
				return;
			}
			tempAdditives[idx] = {
				name,
				amount,
				unit: v('tad_unit'),
				note: v('tad_note') || null,
			};
			renderBottleForm();
		};
		window.finishF1AddTempAdditiveForm = () => {
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
		window.finishF1BackToBottleForm = () => {
			renderBottleForm();
		};
		window.finishF1ConfirmTempAdditive = () => {
			const name = v('tad_name');
			const amount = num('tad_amount');
			if (!name || amount === null) {
				alert('Заполните название и количество');
				return;
			}
			tempAdditives.push({name, amount, unit: v('tad_unit'), note: v('tad_note') || null});
			renderBottleForm();
		};
		window.finishF1RemoveTempAdditive = (i) => {
			tempAdditives.splice(i, 1);
			renderBottleForm();
		};
		window.finishF1ConfirmBottle = ()=>{
		  syncDraft();
		  const mat = draft.material;
		  const vol = mat === 'pet' ? 300 : 330;
		  if(mat === 'pet' && wizF1.bottles.some(b=>b.material === 'pet')){
			alert('Контрольная ПЭТ в партии уже есть'); return;
		  }
		  if(!draft.filled_ml){
			alert('Заполните «Залито, мл»'); return;
		  }
		  const n = wizF1.bottles.length + 1;
		  wizF1.bottles.push({
			title: `#${wizF1.jarId}.${n}`,
			volume_ml: vol,
			material: mat,
			filled_ml: draft.filled_ml,
			additives: [...tempAdditives],
		  });
		  window.finishF1RefreshWizard();
		};
		renderBottleForm();
	};

	window.finishF1Save = async () => {
		syncF1Input();
		for (const f of wizF1.fields) {
			if (!f.required) continue;
			if (!hasValue(f)) {
				alert('Заполните обязательное поле: ' + f.label);
				return;
			}
		}
		const totalFilled = wizF1.bottles.reduce((s, b) => s + (b.filled_ml || 0), 0);
		if (totalFilled > wizF1.totalInMl) {
			alert('Разлито больше, чем есть в базе');
			return;
		}
		try {
			await api.post(`/api/jars/${jarId}/finish_f1`, {
				final_ph: wizF1.values.final_ph,
				rho_final: wizF1.values.rho_final,
				bottles: wizF1.bottles.map(b => ({
					volume_ml: b.volume_ml,
					material: b.material,
					filled_ml: b.filled_ml,
					additives: b.additives || [],
				})),
			});
			closeModal();
			await refresh();
		} catch (e) {
			alert('Ошибка: ' + e.message);
		}
	};

	render();
}

// ---------- F2 finish wizard ----------
async function finishF2Wizard(jarId, fromBottleId) {
	const wizF2 = {
		jarId,
		fromBottleId,
		step: 0,
		fields: [
			{key: 'carbonation', label: 'Карбонизация (1–5)', type: 'number', step: '1', required: true},
			{key: 'sediment', label: 'Осадок', type: 'select', required: true},
			{key: 'sediment_note', label: 'Заметка об осадке', type: 'text', required: false},
			{key: '__info', label: 'Что дальше', type: 'info'},
		],
		values: {carbonation: null, sediment: null, sediment_note: ''},
	};

	function hasValue(f) {
		if (f.type === 'info') return true;
		const v = wizF2.values[f.key];
		return !(v === null || v === '' || v === undefined);
	}

	function canSave() {
		for (const f of wizF2.fields) {
			if (f.type === 'info') continue;
			if (!f.required) continue;
			if (!hasValue(f)) return false;
		}
		return true;
	}

	function render() {
		const step = wizF2.step;
		const f = wizF2.fields[step];
		const isLast = step === wizF2.fields.length - 1;

		const plan = wizF2.fields.map((fld, i) => {
			let icon;
			if (fld.type === 'info') icon = 'ℹ️';
			else if (hasValue(fld)) icon = '✅';
			else if (fld.required) icon = '⬜';
			else icon = '❔';
			const cur = i === step ? ' current' : '';
			let val = '';
			if (fld.type === 'info') val = '';
			else if (fld.key === 'sediment') val = wizF2.values[fld.key] === 'yes' ? 'Да' : (wizF2.values[fld.key] === 'no' ? 'Нет' : '');
			else val = wizF2.values[fld.key] ?? '';
			return `<li class="${cur}" onclick="f2Jump(${i})">
        <span class="st">${icon}</span>
        <span class="name">${esc(fld.label)}</span>
        <span class="val">${esc(val)}</span>
      </li>`;
		}).join('');

		let body;
		if (f.type === 'info') {
			const bottles = state.bottles.filter(b => b.jar_id === jarId);
			const toFridge = bottles.filter(b => !b.has_additives);
			const toF3 = bottles.filter(b => b.has_additives);

			const lines = [];
			if (toFridge.length) {
				lines.push(`<div style="margin-top:8px"><b>→ В холодильник:</b> ${toFridge.map(b => esc(b.title)).join(', ')}</div>`);
			}
			if (toF3.length) {
				lines.push(`<div style="margin-top:${lines.length ? '4px' : '8px'}"><b>→ На F3:</b> ${toF3.map(b => esc(b.title)).join(', ')}</div>`);
			}
			if (!lines.length) {
				lines.push('<div style="margin-top:8px">В партии нет бутылок.</div>');
			}

			body = `
        <div class="info-box">
          <div>После завершения F2 партия расходится путями:</div>
          ${lines.join('')}
        </div>
      `;
		} else if (f.key === 'carbonation') {
			body = `<input id="f2_input" type="number" min="1" max="5" step="1" value="${wizF2.values.carbonation}" autofocus>`;
		} else if (f.key === 'sediment') {
			body = `<select id="f2_input">
        <option value="" ${!wizF2.values.sediment ? 'selected' : ''}>— выберите —</option>
        <option value="no" ${wizF2.values.sediment === 'no' ? 'selected' : ''}>Нет</option>
        <option value="yes" ${wizF2.values.sediment === 'yes' ? 'selected' : ''}>Да</option>
      </select>`;
		} else {
			body = `<textarea id="f2_input" rows="2" autofocus>${esc(wizF2.values.sediment_note || '')}</textarea>`;
		}

		const canNext = (f.type === 'info') ? true : (hasValue(f) || !f.required);
		const canSv = canSave();

		openModal(`
      <div class="modal-head">
        <h2>Завершение F2</h2>
        <button class="primary" id="f2_save" onclick="f2Finish()" ${canSv ? '' : 'disabled'}>💾 Сохранить</button>
      </div>
      <ul class="plan">${plan}</ul>
      <div class="step-title">Шаг ${step + 1} из ${wizF2.fields.length}: <b>${esc(f.label)}</b></div>
      ${body}
      <div class="wiz-actions">
        <button class="ghost" onclick="f2Prev()" ${step === 0 ? 'disabled' : ''}>← Назад</button>
        <button class="primary" id="f2_next" onclick="f2Next()" ${(canNext && !isLast) ? '' : 'disabled'}>Далее →</button>
      </div>
      <div class="actions">
        <button class="ghost" onclick="f2Cancel()">Отмена</button>
      </div>
    `);

		// навесить input-listener
		const input = document.getElementById('f2_input');
		if (input) {
			const onInput = () => {
				const raw = input.value;
				if (f.key === 'carbonation') wizF2.values.carbonation = raw === '' ? null : parseInt(raw);
				else if (f.key === 'sediment') wizF2.values.sediment = raw;
				else wizF2.values.sediment_note = raw;
				const canNext2 = (hasValue(f) || !f.required);
				const isLast2 = wizF2.step === wizF2.fields.length - 1;
				const btnNext = document.getElementById('f2_next');
				if (btnNext) btnNext.disabled = !(canNext2 && !isLast2);
				const btnSave = document.getElementById('f2_save');
				if (btnSave) btnSave.disabled = !canSave();
				updatePlan();
			};
			input.addEventListener('input', onInput);
			input.addEventListener('change', onInput);
		}

		window.f2Prev = () => {
			if (wizF2.step > 0) {
				syncF2Input();
				wizF2.step--;
				render();
			}
		};
		window.f2Next = () => {
			if (wizF2.step < wizF2.fields.length - 1) {
				syncF2Input();
				wizF2.step++;
				render();
			}
		};
		window.f2Jump = (i) => {
			syncF2Input();
			wizF2.step = i;
			render();
		};
	}

	function syncF2Input() {
		const input = document.getElementById('f2_input');
		if (!input) return;
		const f = wizF2.fields[wizF2.step];
		const raw = input.value;
		if (f.key === 'carbonation') wizF2.values.carbonation = raw === '' ? null : parseInt(raw);
		else if (f.key === 'sediment') wizF2.values.sediment = raw;
		else if (f.key === 'sediment_note') wizF2.values.sediment_note = raw;
	}

	function updatePlan() {
		const planEl = document.querySelector('.plan');
		if (!planEl) return;
		planEl.innerHTML = wizF2.fields.map((fld, i) => {
			let icon;
			if (fld.type === 'info') icon = 'ℹ️';
			else if (hasValue(fld)) icon = '✅';
			else if (fld.required) icon = '⬜';
			else icon = '❔';
			const cur = i === wizF2.step ? ' current' : '';
			let val = '';
			if (fld.type === 'info') val = '';
			else if (fld.key === 'sediment') val = wizF2.values[fld.key] === 'yes' ? 'Да' : (wizF2.values[fld.key] === 'no' ? 'Нет' : '');
			else val = wizF2.values[fld.key] ?? '';
			return `<li class="${cur}" onclick="f2Jump(${i})">
        <span class="st">${icon}</span>
        <span class="name">${esc(fld.label)}</span>
        <span class="val">${esc(val)}</span>
      </li>`;
		}).join('');
	}

	window.f2Cancel = () => {
		if (fromBottleId) openBottle(fromBottleId);
		else closeModal();
	};

	window.f2Finish = async () => {
		syncF2Input();
		// проверка обязательных
		for (const f of wizF2.fields) {
			if (f.type === 'info') continue;
			if (!f.required) continue;
			if (!hasValue(f)) {
				alert('Заполните обязательное поле: ' + f.label);
				return;
			}
		}
		const c = wizF2.values.carbonation;
		if (isNaN(c) || c < 1 || c > 5) {
			alert('Карбонизация: введите число от 1 до 5');
			return;
		}
		const data = {
			carbonation: c,
			sediment: wizF2.values.sediment === 'yes',
			sediment_note: wizF2.values.sediment_note || null,
		};
		try {
			await api.post(`/api/jars/${jarId}/finish_f2`, data);
			await refresh();
			if (fromBottleId) openBottle(fromBottleId);
			else closeModal();
		} catch (e) {
			alert('Ошибка: ' + e.message);
		}
	};

	render();
}

function f2Status(g, jars) {
	// ищем базу партии
	const jar = jars.find(j => j.id === g.jar_id);
	if (!jar || jar.state !== 'bottled') return null;

	// все бутылки партии должны быть в f2
	const allF2 = g.bottles.every(b => b.stage === 'f2');
	if (!allF2) return null;

	// ПЭТ в партии
	const pet = g.bottles.find(b => b.material === 'pet');

	// Условие "время подошло": ПЭТ надулась ИЛИ прошло 3 дня с f1_end ИЛИ форс-флаг
	let timePassed = false;
	if (jar.f1_end) {
		const t = new Date(jar.f1_end).getTime();
		const days = (Date.now() - t) / (1000 * 60 * 60 * 24);
		timePassed = days >= 3;
	}

	const bubbled = pet && pet.pet_state === 'bubbled';
	const forced = !!jar.f2_force_ready;

	if (bubbled || timePassed || forced) {
		return {kind: 'ready', pet};
	}
	return {kind: 'carbonating', pet};
}

async function f2StatusClick(jarId, petBottleId) {
	if (petBottleId) {
		openModal(`
      <h2>ПЭТ надулась?</h2>
      <div class="actions" style="flex-direction:column">
        <button class="primary" onclick="f2StatusAnswer(${petBottleId}, ${jarId}, true)">Да, надулась</button>
        <button class="ghost" onclick="f2StatusAnswer(${petBottleId}, ${jarId}, false)">Ещё нет</button>
      </div>
    `);
	} else {
		// считаем дни до планового завершения (3 дня от f1_end)
		const jar = state.jars.find(j => j.id === jarId);
		let daysLeftText = '';
		if (jar && jar.f1_end) {
			const t = new Date(jar.f1_end).getTime();
			const daysPassed = (Date.now() - t) / (1000 * 60 * 60 * 24);
			const daysLeft = Math.max(0, Math.ceil(3 - daysPassed));
			if (daysLeft === 0) {
				daysLeftText = 'Плановое завершение: уже пора.';
			} else if (daysLeft === 1) {
				daysLeftText = 'Плановое завершение через 1 день.';
			} else {
				daysLeftText = `Плановое завершение через ${daysLeft} дня.`;
			}
		}
		openModal(`
      <h2>Контрольной ПЭТ нет</h2>
      ${daysLeftText ? `<p class="meta">${daysLeftText}</p>` : ''}
      <p>Завершить карбонизацию прямо сейчас?</p>
      <div class="actions" style="flex-direction:column">
        <button class="primary" onclick="f2ForceReady(${jarId})">Да, время подошло</button>
        <button class="ghost" onclick="closeModal()">Ещё нет</button>
      </div>
    `);
	}
}

async function f2StatusAnswer(petBottleId, jarId, bubbled) {
	try {
		await api.post(`/api/bottles/${petBottleId}/pet_check`, {bubbled});
		closeModal();
		await refresh();
	} catch (e) {
		alert(e.message);
	}
}

async function f2ForceReady(jarId) {
	try {
		await api.post(`/api/jars/${jarId}/force_f2_ready`);
		closeModal();
		await refresh();
	} catch (e) {
		alert(e.message);
	}
}

// ---------- New cycle ----------
async function newCycle(jarId) {
	const jar = await api.get('/api/jars/' + jarId);
	const leftover = jar.leftover_ml;
	const r = await api.post(`/api/jars/${jarId}/new_cycle`);
	if (!r.available_honeytee.length) {
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
	// запомним, что новая база создаётся из этой
	wiz.fromJarId = jarId;
	if (leftover && leftover > 0 && wiz && wiz.entity === 'jar') {
		wiz.values.starter_ml = leftover;
		renderWizard();
	}
}

// ---------- Backup ----------
async function doBackup() {
	const r = await api.post('/api/backup');
	alert('Бэкап: ' + r.file);
}

function openRestore() {
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

async function submitRestore() {
	const f = document.getElementById('f_file').files[0];
	if (!f) {
		alert('Выберите файл');
		return;
	}
	const fd = new FormData();
	fd.append('file', f);
	const r = await fetch('/api/restore', {method: 'POST', body: fd});
	if (!r.ok) {
		alert('Ошибка: ' + await r.text());
		return;
	}
	closeModal();
	refresh();
	alert('Готово');
}

// ---------- Init ----------
refresh();
switchTab('jars');