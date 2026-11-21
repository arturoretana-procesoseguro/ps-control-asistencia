'use strict';
/* Control de Asistencia — panel de administración (sin dependencias) */
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { me: null, cat: {} };

async function api(url, opts = {}) {
  const r = await fetch('/api' + url, {
    method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401 && !url.startsWith('/login')) { showLogin(); throw new Error('Sesión expirada'); }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.error || data || 'Error');
  return data;
}
function toast(msg, err) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 3800);
}
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const isAdmin = () => state.me?.rol === 'admin';
const opts = (list, sel, empty = 'Todas', label = 'nombre') =>
  `<option value="">${esc(empty)}</option>` + list.map((x) => `<option value="${x.id}" ${String(sel) === String(x.id) ? 'selected' : ''}>${esc(x[label])}</option>`).join('');
const estadoBadge = (e) => {
  const c = { 'A tiempo': 'ok', Retardo: 'warn', Falta: 'bad', Descanso: '', Pendiente: 'pri', 'Día no laborable': 'info' }[e] ?? '';
  return `<span class="badge ${c}">${esc(e)}</span>`;
};
const origenBadge = (o) => {
  const m = { zkteco: ['ZKTeco', 'pri'], hikvision: ['Hikvision', 'info'], campo: ['Campo', 'ok'], manual: ['Manual', 'warn'], importacion: ['Importado', ''] };
  const [t, c] = m[o] || [o, ''];
  return `<span class="badge ${c}">${esc(t)}</span>`;
};
const geoBadge = (r) => r.origen !== 'campo' ? '' : r.dentro_geocerca === 1 ? '<span class="badge ok">Dentro</span>'
  : r.dentro_geocerca === 0 ? `<span class="badge bad">Fuera${r.distancia_m != null ? ' · ' + r.distancia_m + ' m' : ''}</span>` : '<span class="badge">Sin geocerca</span>';
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

async function loadCatalogos() {
  const [empresas, sedes, horarios] = await Promise.all([api('/empresas'), api('/sedes'), api('/horarios')]);
  state.cat = { empresas, sedes, horarios };
}

// ---------------- Modal / formularios ----------------
function modal(title, html, onSubmit, { submitText = 'Guardar' } = {}) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<form class="modal"><h2>${esc(title)}</h2><div class="form">${html}</div>
    <div class="err-msg" style="margin-top:10px"></div>
    <div class="actions"><button type="button" class="btn" data-x>${onSubmit ? 'Cancelar' : 'Cerrar'}</button>${onSubmit ? `<button class="btn primary">${esc(submitText)}</button>` : ''}</div></form>`;
  const close = () => bg.remove();
  bg.querySelector('[data-x]').onclick = close;
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  bg.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try { await onSubmit(data, e.target); close(); } catch (err) { bg.querySelector('.err-msg').textContent = err.message; }
  };
  document.body.appendChild(bg);
  bg.querySelector('input,select,textarea')?.focus();
  return bg;
}
const field = (label, input, full) => `<label class="f ${full ? 'full' : ''}">${esc(label)}${input}</label>`;
const inp = (name, v = '', attrs = '') => `<input name="${name}" value="${esc(v)}" ${attrs}>`;
const sel = (name, html, attrs = '') => `<select name="${name}" ${attrs}>${html}</select>`;
const confirmar = (msg) => window.confirm(msg);

// ---------------- Vistas ----------------
const views = {};

views.tablero = { title: 'Tablero de hoy', async render(el) {
  const d = await api('/dashboard');
  const r = d.resumen;
  el.innerHTML = `
    <div class="grid kpis">
      <div class="card kpi ok"><div class="label">Presentes</div><div class="value">${d.presentes}</div><div class="small muted">de ${r.total - r.descanso} esperados</div></div>
      <div class="card kpi warn"><div class="label">Retardos</div><div class="value">${r.retardos}</div></div>
      <div class="card kpi bad"><div class="label">Faltas</div><div class="value">${r.faltas}</div><div class="small muted">${r.pendientes} aún en tolerancia</div></div>
      <div class="card kpi info"><div class="label">Registrados en campo</div><div class="value">${d.en_campo}</div><div class="small muted">${r.fuera_geocerca} fuera de geocerca</div></div>
    </div>
    ${d.numeros_sin_empleado ? `<div class="help" style="margin-bottom:14px">⚠️ Hay <b>${d.numeros_sin_empleado}</b> números de empleado con registros de checador que no están dados de alta. <a href="#/registros?sin_empleado=1">Ver registros</a></div>` : ''}
    <div class="grid two">
      <div class="card"><h2>Por empresa</h2>
        ${d.por_empresa.length ? `<div class="table-wrap"><table><thead><tr><th>Empresa</th><th class="num">Esperados</th><th class="num">Presentes</th><th class="num">Retardos</th><th class="num">Faltas</th></tr></thead><tbody>
        ${d.por_empresa.map((x) => `<tr><td>${esc(x.empresa)}</td><td class="num">${x.total}</td><td class="num">${x.presentes}</td><td class="num">${x.retardos}</td><td class="num">${x.faltas}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">Aún no hay empleados dados de alta. <a href="#/empleados">Agregar empleados</a></div>'}
        <h2 style="margin-top:18px">Últimos registros</h2>
        ${d.ultimos.length ? d.ultimos.map((u) => `<div class="list-row"><div><b>${esc(u.empleado || 'No. ' + u.empleado_numero)}</b>
          <div class="small muted">${esc(u.fecha_hora)} ${u.tipo ? '· ' + esc(u.tipo) : ''} ${u.dispositivo ? '· ' + esc(u.dispositivo) : ''}</div></div>
          <div>${origenBadge(u.origen)} ${geoBadge(u)}</div></div>`).join('') : '<div class="empty">Sin registros todavía</div>'}
      </div>
      <div class="card"><h2>Checadores</h2>
        ${d.dispositivos.length ? d.dispositivos.map((x) => {
          const mins = x.ultimo_contacto ? (new Date(d.ahora.replace(' ', 'T')) - new Date(x.ultimo_contacto.replace(' ', 'T'))) / 60000 : Infinity;
          const st = x.estado === 'pendiente' ? ['warn', 'Pendiente de aprobar'] : x.estado === 'inactivo' ? ['', 'Inactivo']
            : x.marca === 'zkteco' ? (mins < 10 ? ['ok', 'En línea'] : ['bad', 'Sin conexión']) : (x.ultimo_contacto ? ['ok', 'Configurado'] : ['warn', 'Sin eventos aún']);
          return `<div class="list-row"><div><span class="dot ${st[0]}"></span><b>${esc(x.nombre)}</b><div class="small muted">${x.marca === 'zkteco' ? 'ZKTeco' : 'Hikvision'} · último contacto ${esc(x.ultimo_contacto || 'nunca')}</div></div><span class="badge ${st[0]}">${st[1]}</span></div>`;
        }).join('') : '<div class="empty">No hay checadores registrados. <a href="#/dispositivos">Configurar</a></div>'}
      </div>
    </div>`;
} };

views.asistencia = { title: 'Reporte de asistencia', async render(el, q) {
  await loadCatalogos();
  const f = { desde: q.desde || addDays(today(), -6), hasta: q.hasta || today(), empresa_id: q.empresa_id || '', sede_id: q.sede_id || '', tipo: q.tipo || '', estado: q.estado || '', empleado_id: q.empleado_id || '' };
  el.innerHTML = `
    ${f.empleado_id ? `<input type="hidden" form="flt" name="empleado_id" value="${esc(f.empleado_id)}">` : ''}
    <form class="toolbar card" id="flt">
      ${field('Desde', `<input type="date" name="desde" value="${f.desde}">`)}
      ${field('Hasta', `<input type="date" name="hasta" value="${f.hasta}">`)}
      ${state.me.empresa_id ? '' : field('Empresa', sel('empresa_id', opts(state.cat.empresas, f.empresa_id)))}
      ${field('Sede', sel('sede_id', opts(state.cat.sedes, f.sede_id)))}
      ${field('Tipo', sel('tipo', `<option value="">Todos</option>${['oficina', 'campo', 'mixto'].map((t) => `<option ${f.tipo === t ? 'selected' : ''}>${t}</option>`).join('')}`))}
      ${field('Estado', sel('estado', `<option value="">Todos</option>${['A tiempo', 'Retardo', 'Falta', 'Pendiente', 'Descanso', 'Día no laborable'].map((t) => `<option ${f.estado === t ? 'selected' : ''}>${t}</option>`).join('')}`))}
      <button class="btn primary">Consultar</button>
      <a class="btn" href="/api/reporte.csv?${qs(f)}">⬇ Exportar Excel (CSV)</a>
    </form>
    <div id="res"><div class="empty">Cargando…</div></div>`;
  $('#flt', el).onsubmit = (e) => { e.preventDefault(); location.hash = '#/asistencia?' + qs(Object.fromEntries(new FormData(e.target))); };
  const d = await api('/reporte?' + qs(f));
  const r = d.resumen;
  $('#res', el).innerHTML = `
    <div class="grid kpis">
      <div class="card kpi ok"><div class="label">A tiempo</div><div class="value">${r.a_tiempo}</div></div>
      <div class="card kpi warn"><div class="label">Retardos</div><div class="value">${r.retardos}</div></div>
      <div class="card kpi bad"><div class="label">Faltas</div><div class="value">${r.faltas}</div></div>
      <div class="card kpi"><div class="label">Sin salida</div><div class="value">${r.sin_salida}</div></div>
      <div class="card kpi info"><div class="label">Fuera de geocerca</div><div class="value">${r.fuera_geocerca}</div></div>
    </div>
    ${d.filas.length ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>No.</th><th>Empleado</th><th>Empresa</th><th>Horario</th><th>Entrada</th><th>Salida</th><th class="num">Horas</th><th class="num">Retardo</th><th>Estado</th><th>Incidencias</th><th>Origen</th></tr></thead><tbody>
    ${d.filas.map((x) => `<tr><td>${x.fecha}</td><td class="mono">${esc(x.numero)}</td><td><a href="#/registros?numero=${encodeURIComponent(x.numero)}&desde=${x.fecha}&hasta=${x.fecha}">${esc(x.nombre)}</a></td>
      <td>${esc(x.empresa || '')}</td><td class="muted">${esc(x.horario)}</td><td>${x.entrada}</td><td>${x.salida}</td><td class="num">${x.horas}</td>
      <td class="num">${x.retardo_min ? x.retardo_min + ' min' : ''}</td><td>${estadoBadge(x.estado)}</td>
      <td class="small">${x.incidencias.map((i) => `<span class="badge ${/geocerca/.test(i) ? 'bad' : 'warn'}">${esc(i)}</span>`).join(' ')}</td><td class="small muted">${esc(x.origen)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty card">No hay empleados que coincidan con los filtros.</div>'}`;
} };

views.registros = { title: 'Registros de checada', async render(el, q) {
  const f = { desde: q.desde || addDays(today(), -6), hasta: q.hasta || today(), origen: q.origen || '', buscar: q.buscar || '', numero: q.numero || '', fuera: q.fuera || '', sin_empleado: q.sin_empleado || '', offset: Number(q.offset) || 0, limit: 100 };
  el.innerHTML = `
    <form class="toolbar card" id="flt">
      ${field('Desde', `<input type="date" name="desde" value="${f.desde}">`)}
      ${field('Hasta', `<input type="date" name="hasta" value="${f.hasta}">`)}
      ${field('Origen', sel('origen', `<option value="">Todos</option>${[['zkteco', 'ZKTeco'], ['hikvision', 'Hikvision'], ['campo', 'Campo'], ['manual', 'Manual'], ['importacion', 'Importado']].map(([v, t]) => `<option value="${v}" ${f.origen === v ? 'selected' : ''}>${t}</option>`).join('')}`))}
      ${field('Buscar', inp('buscar', f.buscar || f.numero, 'placeholder="Nombre o número"'))}
      <label class="f">&nbsp;<span><input type="checkbox" name="fuera" value="1" ${f.fuera ? 'checked' : ''}> Sólo fuera de geocerca</span></label>
      <label class="f">&nbsp;<span><input type="checkbox" name="sin_empleado" value="1" ${f.sin_empleado ? 'checked' : ''}> Sin empleado dado de alta</span></label>
      <button class="btn primary">Filtrar</button>
      <a class="btn" href="/api/registros.csv?${qs({ ...f, offset: '', limit: '' })}">⬇ CSV</a>
      <button type="button" class="btn" id="add">＋ Registro manual</button>
    </form>
    <div id="res"><div class="empty">Cargando…</div></div>`;
  $('#flt', el).onsubmit = (e) => { e.preventDefault(); location.hash = '#/registros?' + qs(Object.fromEntries(new FormData(e.target))); };
  $('#add', el).onclick = () => registroManual();
  const d = await api('/registros?' + qs(f));
  $('#res', el).innerHTML = d.rows.length ? `
    <div class="table-wrap"><table><thead><tr><th>Fecha y hora</th><th>No.</th><th>Empleado</th><th>Tipo</th><th>Origen</th><th>Dispositivo / ubicación</th><th>Geocerca</th><th>Foto</th><th>Nota</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>
    ${d.rows.map((r) => `<tr><td class="mono">${esc(r.fecha_hora)}</td><td class="mono">${esc(r.empleado_numero)}</td>
      <td>${r.empleado ? esc(r.empleado) : `<span class="badge warn">No registrado</span> ${isAdmin() ? `<a href="#" data-alta="${esc(r.empleado_numero)}" class="small">dar de alta</a>` : ''}`}</td>
      <td>${esc(r.tipo || '')}</td><td>${origenBadge(r.origen)}</td>
      <td>${r.lat != null ? `<a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${r.lat},${r.lng}">📍 Ver mapa</a> <span class="small muted">±${Math.round(r.precision_m || 0)} m</span>` : esc(r.dispositivo || '')}</td>
      <td>${geoBadge(r)}</td><td>${r.foto ? `<a target="_blank" href="/api/fotos/${encodeURIComponent(r.foto)}">📷 Ver</a>` : ''}</td>
      <td class="small" style="white-space:normal;max-width:260px">${esc(r.nota || '')}${r.creado_por ? ` <span class="muted">(${esc(r.creado_por)})</span>` : ''}</td>
      ${isAdmin() ? `<td>${r.anulado ? `<span class="badge" title="${esc(r.anulado_motivo || '')}">Anulado por ${esc(r.anulado_por || '')}</span>` : `<button class="btn sm danger" data-del="${r.id}">Anular</button>`}</td>` : ''}</tr>`).join('')}
    </tbody></table></div>
    <div class="pager"><span class="muted">${f.offset + 1}–${f.offset + d.rows.length} de ${d.total}</span>
      <span><button class="btn sm" id="prev" ${f.offset ? '' : 'disabled'}>← Anterior</button> <button class="btn sm" id="next" ${f.offset + d.rows.length < d.total ? '' : 'disabled'}>Siguiente →</button></span></div>`
    : '<div class="empty card">No hay registros en este periodo.</div>';
  const go = (off) => { location.hash = '#/registros?' + qs({ ...f, offset: off, limit: '' }); };
  $('#prev', el) && ($('#prev', el).onclick = () => go(Math.max(0, f.offset - 100)));
  $('#next', el) && ($('#next', el).onclick = () => go(f.offset + 100));
  el.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => modal('Anular checada', `
    <p class="full small muted" style="margin:0">La checada no se borra: queda anulada (no cuenta en reportes) y se registra en la bitácora con tu usuario y el motivo.</p>
    ${field('Motivo de la anulación', '<textarea name="motivo" rows="2" required minlength="5" placeholder="Ej. Checada duplicada, error del checador…"></textarea>', true)}`,
    async (d) => { await api(`/registros/${b.dataset.del}/anular`, { method: 'POST', body: d }); toast('Checada anulada'); route(); }, { submitText: 'Anular' }));
  el.querySelectorAll('[data-alta]').forEach((a) => a.onclick = (e) => { e.preventDefault(); editarEmpleado({ numero: a.dataset.alta }); });
} };

async function registroManual() {
  const emps = await api('/empleados');
  const now = new Date(); now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  modal('Registro manual', `
    ${field('Empleado', sel('empleado_numero', emps.filter((e) => e.activo).map((e) => `<option value="${esc(e.numero)}">${esc(e.numero)} · ${esc(e.nombre)}</option>`).join(''), 'required'), true)}
    ${field('Fecha y hora', `<input type="datetime-local" name="fecha_hora" value="${now.toISOString().slice(0, 16)}" required>`)}
    ${field('Tipo', sel('tipo', '<option value="entrada">Entrada</option><option value="salida">Salida</option><option value="">Sin tipo</option>'))}
    ${field('Motivo (obligatorio)', '<textarea name="nota" rows="2" required placeholder="Ej. Olvidó checar, falla del checador, comisión…"></textarea>', true)}
    <p class="small muted full" style="margin:0">El registro queda marcado como manual con tu usuario.</p>`,
  async (data) => { await api('/registros', { method: 'POST', body: data }); toast('Registro guardado'); route(); });
}

views.empleados = { title: 'Empleados', async render(el, q) {
  await loadCatalogos();
  const all = await api('/empleados' + (q.inactivos ? '?archivados=1' : ''));
  const buscar = (q.buscar || '').toLowerCase();
  const list = all.filter((e) => (!buscar || (e.nombre + ' ' + e.numero).toLowerCase().includes(buscar)) && (q.inactivos ? true : e.activo));
  el.innerHTML = `
    <form class="toolbar" id="flt">
      ${field('Buscar', inp('buscar', q.buscar || '', 'placeholder="Nombre o número"'))}
      <label class="f">&nbsp;<span><input type="checkbox" name="inactivos" value="1" ${q.inactivos ? 'checked' : ''}> Mostrar bajas</span></label>
      <button class="btn">Filtrar</button>
      <a class="btn" href="/api/empleados.csv">⬇ Exportar CSV</a>
      ${isAdmin() ? '<button type="button" class="btn primary" id="add">＋ Nuevo empleado</button>' : ''}
    </form>
    <div class="help" style="margin-bottom:14px">El <b>número de empleado</b> debe ser igual al ID de usuario dado de alta en el checador ZKTeco ("ID de usuario / PIN") o Hikvision ("ID de empleado / Employee No.").
    El personal <b>de campo</b> o <b>mixto</b> necesita un PIN para registrarse desde el celular en <code>${esc(location.origin)}/campo</code>.</div>
    ${list.length ? `<div class="table-wrap"><table><thead><tr><th>No.</th><th>Nombre</th><th>Puesto</th><th>Empresa</th><th>Sede</th><th>Horario</th><th>Tipo</th><th>PIN campo</th><th>Estado</th><th></th></tr></thead><tbody>
    ${list.map((e) => `<tr><td class="mono">${esc(e.numero)}</td><td><b>${esc(e.nombre)}</b></td><td>${esc(e.puesto || '')}</td><td>${esc(e.empresa || '')}</td>
      <td>${esc(e.sede || '')}</td><td class="small">${esc(e.horario || '')}</td><td><span class="badge ${e.tipo === 'campo' ? 'ok' : e.tipo === 'mixto' ? 'info' : 'pri'}">${esc(e.tipo)}</span></td>
      <td>${e.tipo === 'oficina' ? '' : e.tiene_pin ? '<span class="badge ok">Asignado</span>' : '<span class="badge warn">Falta PIN</span>'}</td>
      <td>${e.activo ? '<span class="badge ok">Activo</span>' : `<span class="badge">Baja${e.fecha_baja ? ' ' + esc(e.fecha_baja) : ''}</span>${e.archivado ? ' <span class="badge">Archivado</span>' : ''}`}</td>
      <td>${isAdmin() ? `<button class="btn sm" data-ed="${e.id}">Editar</button>` : ''} <a class="btn sm" href="#/asistencia?empleado_id=${e.id}">Asistencia</a></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty card">No hay empleados.</div>'}`;
  $('#flt', el).onsubmit = (e) => { e.preventDefault(); location.hash = '#/empleados?' + qs(Object.fromEntries(new FormData(e.target))); };
  $('#add', el) && ($('#add', el).onclick = () => editarEmpleado({}));
  el.querySelectorAll('[data-ed]').forEach((b) => b.onclick = () => editarEmpleado(all.find((x) => x.id == b.dataset.ed)));
} };

async function editarEmpleado(e) {
  if (!state.cat.empresas) await loadCatalogos();
  const nuevo = !e.id;
  const { empresas, sedes, horarios } = state.cat;
  modal(nuevo ? 'Nuevo empleado' : 'Editar empleado', `
    ${field('No. de empleado (ID en checador)', inp('numero', e.numero, 'required'))}
    ${field('Nombre completo', inp('nombre', e.nombre, 'required'))}
    ${field('Puesto', inp('puesto', e.puesto))}
    ${field('Empresa', sel('empresa_id', opts(empresas, e.empresa_id, '— Selecciona —')))}
    ${field('Sede / ubicación', sel('sede_id', opts(sedes, e.sede_id, '— Ninguna —')))}
    ${field('Horario', sel('horario_id', opts(horarios, e.horario_id, '— Sin horario —')))}
    ${field('Tipo de registro', sel('tipo', [['oficina', 'Oficina (checador)'], ['campo', 'Campo (celular)'], ['mixto', 'Mixto (ambos)']].map(([v, t]) => `<option value="${v}" ${e.tipo === v ? 'selected' : ''}>${t}</option>`).join('')))}
    ${field(nuevo ? 'PIN para campo (4–8 dígitos)' : 'Nuevo PIN (dejar vacío para no cambiar)', inp('pin', '', 'inputmode="numeric" pattern="[0-9]{4,8}" autocomplete="off"'))}
    ${nuevo ? '' : field('Estado', sel('activo', `<option value="1" ${e.activo ? 'selected' : ''}>Activo</option><option value="0" ${!e.activo ? 'selected' : ''}>Inactivo (baja)</option>`))}
    ${field('CURP', inp('curp', e.curp || '', 'maxlength="18" style="text-transform:uppercase"'))}${field('RFC', inp('rfc', e.rfc || '', 'maxlength="13" style="text-transform:uppercase"'))}
    ${field('NSS', inp('nss', e.nss || '', 'maxlength="11" inputmode="numeric"'))}
    <p class="small muted full" style="margin:0">La geocerca del personal de campo es la ubicación y el radio de su sede.</p>`,
  async (d) => {
    if (!d.pin) delete d.pin;
    for (const k of ['curp', 'rfc']) if (d[k]) d[k] = d[k].toUpperCase().trim();
    if ('activo' in d) d.activo = d.activo === '1';
    if ((d.tipo === 'campo' || d.tipo === 'mixto') && nuevo && !d.pin) throw new Error('Asigna un PIN para que pueda registrarse desde el celular');
    await api(nuevo ? '/empleados' : '/empleados/' + e.id, { method: nuevo ? 'POST' : 'PUT', body: d });
    toast('Empleado guardado'); route();
  });
}

views.dispositivos = { title: 'Checadores', async render(el) {
  await loadCatalogos();
  const list = await api('/dispositivos');
  const host = location.hostname, port = location.port || (location.protocol === 'https:' ? '443' : '80');
  el.innerHTML = `
    <div class="toolbar"><button class="btn primary" id="add-zk">＋ Agregar ZKTeco</button><button class="btn primary" id="add-hik">＋ Agregar Hikvision</button></div>
    ${list.length ? `<div class="table-wrap" style="margin-bottom:16px"><table><thead><tr><th>Nombre</th><th>Marca</th><th>Serie</th><th>Sede</th><th>Estado</th><th>IP</th><th>Último contacto</th><th class="num">Registros</th><th></th></tr></thead><tbody>
    ${list.map((d) => `<tr><td><b>${esc(d.nombre)}</b></td><td>${d.marca === 'zkteco' ? 'ZKTeco' : 'Hikvision'}</td><td class="mono">${esc(d.serie || '')}</td>
      <td>${esc(d.sede || '')}</td><td>${d.estado === 'activo' ? '<span class="badge ok">Activo</span>' : d.estado === 'pendiente' ? '<span class="badge warn">Pendiente</span>' : '<span class="badge">Inactivo</span>'}</td>
      <td class="small"><span class="mono">${esc(d.ip_lectura || d.ip || '')}</span>${d.ip_lectura ? '<br><span class="badge pri">Lectura directa</span>' : ''}${d.enviar_altas ? ' <span class="badge info">Altas de Odoo</span>' : ''}</td>
      <td class="small">${esc(d.ultimo_contacto || 'nunca')}${d.ultimo_error ? `<br><span class="badge bad" title="${esc(d.ultimo_error)}">Error de lectura</span>` : ''}</td><td class="num">${d.total_registros}</td>
      <td class="acciones">${d.estado === 'pendiente' ? `<button class="btn sm primary" data-ok="${d.id}">Aprobar</button> ` : ''}
        ${d.marca === 'hikvision' ? `<button class="btn sm" data-url="${d.id}">URL</button> ` : ''}
        ${d.ip_lectura ? `<button class="btn sm" data-probar="${d.id}">Probar</button> <button class="btn sm primary" data-sync="${d.id}">Sincronizar</button> <button class="btn sm" data-usr="${d.id}">Importar empleados</button> ` : ''}<button class="btn sm" data-ed="${d.id}">Editar</button> <button class="btn sm danger" data-del="${d.id}">Quitar</button></td></tr>`).join('')}
    </tbody></table></div>` : ''}
    <div class="grid two">
      <div class="card" style="grid-column:1/-1"><h2>ZKTeco sin ADMS (lectura directa por IP, ej. MB460)</h2><div class="help">
      Si tu checador no tiene la opción "Servidor en la nube / ADMS", agrégalo con <b>＋ Agregar ZKTeco</b> capturando su <b>IP</b> (puerto 4370).
      El sistema leerá sus checadas automáticamente cada ${'5'} minutos; también puedes usar <b>Sincronizar</b>. Con <b>Importar empleados</b> se dan de alta los usuarios que ya tiene el checador.
      <br><b>Requisito:</b> este servidor debe estar en la misma red que el checador y la clave de comunicación del equipo debe ser 0. Sólo se leen datos: no se borra nada del checador.</div></div>
      <div class="card"><h2>Configurar un ZKTeco (ADMS / PUSH)</h2><div class="help"><ol>
        <li>En el checador: <b>Menú → Comunicación → Servidor en la nube / ADMS</b> (<i>Cloud Server Setting</i>).</li>
        <li>Dirección del servidor: <code>${esc(host)}</code> · Puerto: <code>${esc(port)}</code> · HTTPS/Proxy: desactivado (salvo que publiquen el sitio con HTTPS).</li>
        <li>Al guardar, el equipo aparecerá aquí como <b>Pendiente</b> con su número de serie. Presiona <b>Aprobar</b>. También puedes darlo de alta antes con su SN.</li>
        <li>Al aprobarlo descarga todos los registros que tenga en memoria; los duplicados se descartan solos.</li>
      </ol><p class="small" style="margin:8px 0 0">El modelo debe soportar ADMS / PUSH (la mayoría de los equipos actuales: SpeedFace, ProFace, MB, iClock, K, uFace, etc.). Para equipos viejos sin ADMS usa <a href="#/importar">Importar</a>.</p></div></div>
      <div class="card"><h2>Configurar un Hikvision (HTTP Listening)</h2><div class="help"><ol>
        <li>Agrega el equipo aquí con <b>＋ Agregar Hikvision</b> y copia la URL que se genera.</li>
        <li>En la página web del equipo: <b>Configuración → Red → Configuración avanzada → HTTP Listening</b> (en otros firmwares: <i>Event → Alarm Server / Centro de alarmas</i>).</li>
        <li>IP de destino: <code>${esc(host)}</code>, puerto <code>${esc(port)}</code>, protocolo HTTP, URL: <code>/hikvision/&lt;token&gt;</code>.</li>
        <li>Activa <b>Notificar al centro de vigilancia</b> en los eventos de control de acceso / autenticación.</li>
      </ol><p class="small" style="margin:8px 0 0">El ID de empleado del equipo (Employee No.) debe coincidir con el número del empleado aquí. Para cargar historial anterior exporta desde iVMS-4200 o HikCentral y usa <a href="#/importar">Importar</a>.</p></div></div>
    </div>`;
  const sedesOpt = (v) => sel('sede_id', opts(state.cat.sedes, v, '— Sin sede —'));
  $('#add-zk', el).onclick = () => modal('Agregar checador ZKTeco', `
    ${field('Nombre', inp('nombre', '', 'required placeholder="Ej. Recepción oficina CDMX"'), true)}
    ${field('Número de serie (SN)', inp('serie', '', 'placeholder="Ej. CLXP212760296"'))}${field('Sede', sedesOpt())}
    ${field('IP del checador (lectura directa)', inp('ip_lectura', '', 'placeholder="Ej. 192.168.10.231"'))}${field('Puerto', inp('puerto', '4370', 'type="number"'))}
    <p class="small muted full" style="margin:0">Captura la <b>IP</b> si el equipo no tiene ADMS o quieres leerlo directamente. Para ADMS basta el número de serie.</p>`,
    async (d) => { await api('/dispositivos', { method: 'POST', body: { ...d, marca: 'zkteco' } }); toast('Checador agregado'); route(); });
  $('#add-hik', el).onclick = () => modal('Agregar checador Hikvision', `
    ${field('Nombre', inp('nombre', '', 'required placeholder="Ej. Acceso planta"'), true)}
    ${field('Número de serie (opcional)', inp('serie'))}${field('Sede', sedesOpt())}`,
    async (d) => { const r = await api('/dispositivos', { method: 'POST', body: { ...d, marca: 'hikvision' } }); await route(); mostrarUrl(r.id); });
  const byId = (id) => list.find((x) => x.id == id);
  const mostrarUrl = async (id) => {
    const d = (await api('/dispositivos')).find((x) => x.id == id);
    modal('URL de recepción para ' + d.nombre, `<div class="full">
      <p>Configura esto en <b>HTTP Listening</b> del equipo Hikvision:</p>
      <p>IP / dominio: <code>${esc(host)}</code> · Puerto: <code>${esc(port)}</code></p>
      <p>URL: <code>/hikvision/${esc(d.token)}</code></p>
      <p class="small muted">URL completa: <code>${esc(location.origin)}/hikvision/${esc(d.token)}</code><br>Trátala como contraseña: quien la conozca puede enviar registros a nombre de este equipo.</p></div>`, null);
  };
  el.querySelectorAll('[data-url]').forEach((b) => b.onclick = () => mostrarUrl(b.dataset.url));
  const ocupado = async (b, texto, fn) => {
    const t = b.textContent; b.disabled = true; b.textContent = texto;
    try { await fn(); } catch (e) { toast(e.message, true); } finally { b.disabled = false; b.textContent = t; }
  };
  el.querySelectorAll('[data-probar]').forEach((b) => b.onclick = () => ocupado(b, 'Conectando…', async () => {
    const i = await api(`/dispositivos/${b.dataset.probar}/probar`, { method: 'POST' });
    modal('Conexión exitosa ✅', `<div class="full"><table><tbody>
      ${[['Número de serie', i.serie], ['Modelo', i.nombre], ['Firmware', i.firmware], ['Plataforma', i.plataforma], ['Hora del checador', i.hora_equipo], ['Usuarios', i.usuarios], ['Checadas guardadas', i.checadas]]
        .map(([k, v]) => `<tr><td class="muted">${k}</td><td><b>${esc(v ?? '-')}</b></td></tr>`).join('')}</tbody></table></div>`, null);
  }));
  el.querySelectorAll('[data-sync]').forEach((b) => b.onclick = () => ocupado(b, 'Leyendo…', async () => {
    const r = await api(`/dispositivos/${b.dataset.sync}/sincronizar`, { method: 'POST' });
    toast(`Se leyeron ${r.leidas} checadas, ${r.nuevas} nuevas`); route();
  }));
  el.querySelectorAll('[data-usr]').forEach((b) => b.onclick = () => {
    const d = byId(b.dataset.usr);
    modal('Importar empleados desde ' + d.nombre, `
      <p class="full small muted" style="margin:0">Se crearán los usuarios del checador que aún no existan en el sistema (con su número y nombre). Los empleados existentes no se modifican. Después puedes completar sus datos en Empleados.</p>
      ${field('Empresa', sel('empresa_id', opts(state.cat.empresas, '', '— Selecciona —')))}${field('Sede', sel('sede_id', opts(state.cat.sedes, d.sede_id, '— Ninguna —')))}
      ${field('Horario', sel('horario_id', opts(state.cat.horarios, '', '— Sin horario —')))}`,
    async (x) => {
      const r = await api(`/dispositivos/${d.id}/importar-usuarios`, { method: 'POST', body: x });
      toast(`Usuarios en checador: ${r.en_checador}. Nuevos empleados: ${r.creados}. Ya existían: ${r.ya_existian}.`);
    }, { submitText: 'Importar' });
  });
  el.querySelectorAll('[data-ok]').forEach((b) => b.onclick = async () => { await api('/dispositivos/' + b.dataset.ok, { method: 'PUT', body: { estado: 'activo' } }); toast('Checador aprobado'); route(); });
  el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirmar('¿Quitar este checador? Los registros ya recibidos se conservan.')) return;
    await api('/dispositivos/' + b.dataset.del, { method: 'DELETE' }); route();
  });
  el.querySelectorAll('[data-ed]').forEach((b) => b.onclick = () => {
    const d = byId(b.dataset.ed);
    modal('Editar checador', `${field('Nombre', inp('nombre', d.nombre, 'required'), true)}
      ${field('Número de serie', inp('serie', d.serie))}${field('Sede', sedesOpt(d.sede_id))}
      ${d.marca === 'zkteco' ? field('IP lectura directa', inp('ip_lectura', d.ip_lectura || '', 'placeholder="vacío = sólo ADMS"')) + field('Puerto', inp('puerto', d.puerto || 4370, 'type="number"')) : ''}
      ${field('Estado', sel('estado', ['activo', 'pendiente', 'inactivo'].map((s) => `<option ${d.estado === s ? 'selected' : ''}>${s}</option>`).join('')))}
      ${d.marca === 'zkteco' ? `<label class="f full"><span><input type="checkbox" name="enviar_altas" value="1" ${d.enviar_altas ? 'checked' : ''}> Recibir altas de empleados de Odoo (crea en este checador a los empleados nuevos de Odoo; requiere IP de lectura directa)</span></label>` : ''}
      ${d.marca === 'hikvision' ? `<label class="f full"><span><input type="checkbox" name="regenerar_token" value="1"> Generar nueva URL (la anterior dejará de funcionar)</span></label>` : ''}`,
    async (x) => { await api('/dispositivos/' + d.id, { method: 'PUT', body: { ...x, regenerar_token: !!x.regenerar_token, ...(d.marca === 'zkteco' ? { enviar_altas: x.enviar_altas ? 1 : 0 } : {}) } }); toast('Guardado'); route(); });
  });
} };

views.importar = { title: 'Importar registros', async render(el) {
  el.innerHTML = `
    <div class="card" style="max-width:860px">
      <h2>Cargar archivo CSV de checadas</h2>
      <p class="muted">Sirve para equipos sin conexión ADMS, para recuperar historial o para cargar exportaciones de <b>ZKTime / ZKBio</b>, <b>iVMS-4200</b> o <b>HikCentral</b>.
      En Excel usa <i>Guardar como → CSV UTF-8</i>. Se necesita una columna con el número de empleado y otra con la fecha y hora (o "Fecha" y "Hora" por separado).</p>
      <p class="small muted">Ejemplo de plantilla: <code>numero,fecha_hora,tipo</code> · <code>1024,2026-11-20 08:57,entrada</code></p>
      <div class="toolbar"><input type="file" id="file" accept=".csv,.txt,text/csv"><button class="btn primary" id="prev" disabled>Revisar archivo</button></div>
      <div id="out"></div>
    </div>`;
  let contenido = '';
  $('#file', el).onchange = async (e) => { const f = e.target.files[0]; if (!f) return; contenido = await f.text(); $('#prev', el).disabled = false; $('#out', el).innerHTML = ''; };
  const run = async (confirmarImp) => {
    try {
      const r = await api('/importar', { method: 'POST', body: { contenido, confirmar: confirmarImp } });
      $('#out', el).innerHTML = `
        <div class="help" style="margin:10px 0">Columnas detectadas: número = <b>${esc(r.columnas.numero)}</b>, fecha/hora = <b>${esc(r.columnas.fecha_hora)}</b>${r.columnas.tipo ? `, tipo = <b>${esc(r.columnas.tipo)}</b>` : ''}.<br>
        ${r.total} registros válidos${confirmarImp ? `, <b>${r.nuevos} nuevos importados</b> (${r.total - r.nuevos} ya existían)` : ''}.
        ${r.errores.length ? `<br><span style="color:var(--bad)">${r.errores.length} filas con errores.</span>` : ''}
        ${r.sin_empleado.length ? `<br>⚠️ ${r.sin_empleado.length} números no están dados de alta como empleados: ${r.sin_empleado.slice(0, 20).map(esc).join(', ')}${r.sin_empleado.length > 20 ? '…' : ''}` : ''}</div>
        ${confirmarImp ? '' : `<div class="table-wrap"><table><thead><tr><th>No. empleado</th><th>Fecha y hora</th><th>Tipo</th></tr></thead><tbody>
          ${r.muestra.map((x) => `<tr><td>${esc(x.empleado_numero)}</td><td>${esc(x.fecha_hora)}</td><td>${esc(x.tipo || '')}</td></tr>`).join('')}</tbody></table></div>
          <p class="small muted">Vista previa de las primeras 10 filas.</p><button class="btn primary" id="go">Importar ${r.total} registros</button>`}
        ${r.errores.length ? `<details style="margin-top:10px"><summary>Ver errores</summary><pre class="small">${r.errores.map(esc).join('\n')}</pre></details>` : ''}`;
      $('#go', el) && ($('#go', el).onclick = () => run(true));
      if (confirmarImp) toast(`${r.nuevos} registros importados`);
    } catch (e) { $('#out', el).innerHTML = `<div class="help" style="margin-top:10px;color:var(--bad)">${esc(e.message)}</div>`; }
  };
  $('#prev', el).onclick = () => run(false);
} };

views.catalogos = { title: 'Empresas, sedes y horarios', async render(el, q) {
  await loadCatalogos();
  const tab = q.tab || 'empresas';
  const { empresas, sedes, horarios } = state.cat;
  const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  el.innerHTML = `<div class="tabs">${[['empresas', 'Empresas'], ['sedes', 'Sedes y geocercas'], ['horarios', 'Horarios']].map(([k, t]) => `<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${t}</button>`).join('')}</div><div id="tab"></div>`;
  el.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { location.hash = '#/catalogos?tab=' + b.dataset.tab; });
  const t = $('#tab', el);
  const delBtn = (ent, id) => `<button class="btn sm danger" data-del="${ent}/${id}">Eliminar</button>`;
  if (tab === 'empresas') {
    t.innerHTML = `<div class="toolbar"><button class="btn primary" id="add">＋ Nueva empresa</button></div>
      <div class="table-wrap"><table><thead><tr><th>Empresa</th><th>Razón social</th><th>RFC</th><th>Registro patronal</th><th></th></tr></thead><tbody>
      ${empresas.map((e) => `<tr><td><b>${esc(e.nombre)}</b></td><td>${esc(e.razon_social || '')}</td><td class="mono">${esc(e.rfc || '')}</td><td class="mono">${esc(e.registro_patronal || '')}</td><td style="text-align:right"><button class="btn sm" data-ed="${e.id}">Editar</button> ${delBtn('empresas', e.id)}</td></tr>`).join('')}</tbody></table></div>`;
    const form = (e = {}) => modal(e.id ? 'Editar empresa' : 'Nueva empresa', `${field('Nombre', inp('nombre', e.nombre, 'required'), true)}
      ${field('Razón social', inp('razon_social', e.razon_social || ''), true)}${field('RFC', inp('rfc', e.rfc || '', 'maxlength="13" style="text-transform:uppercase"'))}
      ${field('Registro patronal IMSS', inp('registro_patronal', e.registro_patronal || ''))}
      <p class="small muted full" style="margin:0">Estos datos aparecen en el encabezado del Registro de jornada.</p>`,
      async (d) => { await api(e.id ? '/empresas/' + e.id : '/empresas', { method: e.id ? 'PUT' : 'POST', body: d }); route(); });
    $('#add', t).onclick = () => form();
    t.querySelectorAll('[data-ed]').forEach((b) => b.onclick = () => form(empresas.find((x) => x.id == b.dataset.ed)));
  }
  if (tab === 'sedes') {
    t.innerHTML = `<div class="toolbar"><button class="btn primary" id="add">＋ Nueva sede</button></div>
      <div class="help" style="margin-bottom:12px">La <b>geocerca</b> es la ubicación de la sede y un radio en metros. Cuando alguien de campo checa fuera de ese radio, el registro se guarda pero queda marcado como <b>Fuera de geocerca</b>. Para personal que se mueve entre clientes, crea una sede por cliente o deja la sede sin coordenadas para no validar la ubicación.</div>
      ${sedes.length ? `<div class="table-wrap"><table><thead><tr><th>Sede</th><th>Empresa</th><th>Dirección</th><th>Coordenadas</th><th class="num">Radio</th><th></th></tr></thead><tbody>
      ${sedes.map((s) => `<tr><td><b>${esc(s.nombre)}</b></td><td>${esc(s.empresa || '')}</td><td class="small">${esc(s.direccion || '')}</td>
        <td>${s.lat != null ? `<a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${s.lat},${s.lng}">${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</a>` : '<span class="muted">Sin geocerca</span>'}</td>
        <td class="num">${s.radio_m || ''} m</td><td style="text-align:right"><button class="btn sm" data-ed="${s.id}">Editar</button> ${delBtn('sedes', s.id)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty card">Sin sedes</div>'}`;
    const form = (s = {}) => {
      const m = modal(s.id ? 'Editar sede' : 'Nueva sede', `
        ${field('Nombre', inp('nombre', s.nombre, 'required'))}${field('Empresa', sel('empresa_id', opts(empresas, s.empresa_id, '— Selecciona —')))}
        ${field('Dirección', inp('direccion', s.direccion), true)}
        ${field('Latitud', inp('lat', s.lat ?? '', 'inputmode="decimal" placeholder="19.4326"'))}${field('Longitud', inp('lng', s.lng ?? '', 'inputmode="decimal" placeholder="-99.1332"'))}
        ${field('Radio de geocerca (m)', inp('radio_m', s.radio_m ?? 200, 'type="number" min="20" max="20000"'))}
        <div class="f full"><button type="button" class="btn sm" id="gps">📍 Usar mi ubicación actual</button><span class="small muted">Tip: en Google Maps haz clic derecho sobre el lugar para copiar las coordenadas.</span></div>`,
      async (d) => {
        d.lat = d.lat === '' ? null : Number(d.lat); d.lng = d.lng === '' ? null : Number(d.lng); d.radio_m = Number(d.radio_m) || 200;
        if ((d.lat == null) !== (d.lng == null)) throw new Error('Captura latitud y longitud, o deja ambas vacías');
        await api(s.id ? '/sedes/' + s.id : '/sedes', { method: s.id ? 'PUT' : 'POST', body: d }); route();
      });
      $('#gps', m).onclick = () => navigator.geolocation.getCurrentPosition(
        (p) => { m.querySelector('[name=lat]').value = p.coords.latitude.toFixed(6); m.querySelector('[name=lng]').value = p.coords.longitude.toFixed(6); },
        (e) => toast('No se pudo obtener la ubicación: ' + e.message, true), { enableHighAccuracy: true });
    };
    $('#add', t).onclick = () => form();
    t.querySelectorAll('[data-ed]').forEach((b) => b.onclick = () => form(sedes.find((x) => x.id == b.dataset.ed)));
  }
  if (tab === 'horarios') {
    t.innerHTML = `<div class="toolbar"><button class="btn primary" id="add">＋ Nuevo horario</button></div>
      <div class="table-wrap"><table><thead><tr><th>Horario</th><th>Entrada</th><th>Salida</th><th class="num">Tolerancia</th><th>Días laborables</th><th></th></tr></thead><tbody>
      ${horarios.map((h) => `<tr><td><b>${esc(h.nombre)}</b></td><td>${esc(h.entrada)}</td><td>${esc(h.salida)}</td><td class="num">${h.tolerancia_min} min</td>
        <td>${String(h.dias || '').split(',').filter(Boolean).map((d) => DIAS[d]).join(', ')}</td>
        <td style="text-align:right"><button class="btn sm" data-ed="${h.id}">Editar</button> ${delBtn('horarios', h.id)}</td></tr>`).join('')}</tbody></table></div>`;
    const form = (h = { dias: '1,2,3,4,5', tolerancia_min: 10 }) => modal(h.id ? 'Editar horario' : 'Nuevo horario', `
      ${field('Nombre', inp('nombre', h.nombre, 'required placeholder="Ej. Oficina L-V 9 a 18"'), true)}
      ${field('Hora de entrada', `<input type="time" name="entrada" value="${esc(h.entrada || '09:00')}" required>`)}
      ${field('Hora de salida', `<input type="time" name="salida" value="${esc(h.salida || '18:00')}" required>`)}
      ${field('Tolerancia (min)', inp('tolerancia_min', h.tolerancia_min, 'type="number" min="0" max="120"'))}
      <div class="f full">Días laborables<div style="display:flex;gap:10px;flex-wrap:wrap;color:var(--text)">
        ${DIAS.map((d, i) => `<label><input type="checkbox" name="d${i}" ${String(h.dias).split(',').includes(String(i)) ? 'checked' : ''}> ${d}</label>`).join('')}</div></div>`,
    async (d) => {
      const dias = DIAS.map((_, i) => (d['d' + i] ? i : null)).filter((x) => x !== null).join(',');
      await api(h.id ? '/horarios/' + h.id : '/horarios', { method: h.id ? 'PUT' : 'POST', body: { nombre: d.nombre, entrada: d.entrada, salida: d.salida, tolerancia_min: Number(d.tolerancia_min) || 0, dias } });
      route();
    });
    $('#add', t).onclick = () => form();
    t.querySelectorAll('[data-ed]').forEach((b) => b.onclick = () => form(horarios.find((x) => x.id == b.dataset.ed)));
  }
  t.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirmar('¿Eliminar? Sólo es posible si no tiene empleados u otra información asociada.')) return;
    try { await api('/' + b.dataset.del, { method: 'DELETE' }); route(); } catch (e) { toast(e.message, true); }
  });
} };

views.usuarios = { title: 'Usuarios del sistema', async render(el) {
  await loadCatalogos();
  const list = await api('/usuarios');
  el.innerHTML = `<div class="toolbar"><button class="btn primary" id="add">＋ Nuevo usuario</button></div>
    <div class="help" style="margin-bottom:12px"><b>Administrador</b>: acceso total. <b>Supervisor</b>: consulta asistencia y registros y captura registros manuales; si se le asigna una empresa sólo ve a esa empresa.</div>
    <div class="table-wrap"><table><thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Empresa</th><th></th></tr></thead><tbody>
    ${list.map((u) => `<tr><td class="mono">${esc(u.usuario)}</td><td>${esc(u.nombre || '')}</td><td><span class="badge ${u.rol === 'admin' ? 'pri' : ''}">${u.rol === 'admin' ? 'Administrador' : 'Supervisor'}</span></td>
      <td>${esc(u.empresa || 'Todas')}</td><td style="text-align:right"><button class="btn sm" data-ed="${u.id}">Editar</button> ${u.id === state.me.id ? '' : `<button class="btn sm danger" data-del="${u.id}">Eliminar</button>`}</td></tr>`).join('')}</tbody></table></div>`;
  const form = (u = {}) => modal(u.id ? 'Editar usuario' : 'Nuevo usuario', `
    ${field('Usuario', inp('usuario', u.usuario, `required ${u.id ? 'disabled' : ''} autocomplete="off"`))}${field('Nombre', inp('nombre', u.nombre))}
    ${field('Rol', sel('rol', `<option value="supervisor" ${u.rol === 'supervisor' ? 'selected' : ''}>Supervisor</option><option value="admin" ${u.rol === 'admin' ? 'selected' : ''}>Administrador</option>`))}
    ${field('Empresa (supervisor)', sel('empresa_id', opts(state.cat.empresas, u.empresa_id, 'Todas')))}
    ${field(u.id ? 'Nueva contraseña (opcional)' : 'Contraseña (mín. 8)', inp('password', '', `type="password" autocomplete="new-password" ${u.id ? '' : 'required'} minlength="8"`), true)}`,
  async (d) => { if (!d.password) delete d.password; await api(u.id ? '/usuarios/' + u.id : '/usuarios', { method: u.id ? 'PUT' : 'POST', body: d }); toast('Usuario guardado'); route(); });
  $('#add', el).onclick = () => form();
  el.querySelectorAll('[data-ed]').forEach((b) => b.onclick = () => form(list.find((x) => x.id == b.dataset.ed)));
  el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (confirmar('¿Eliminar usuario?')) { await api('/usuarios/' + b.dataset.del, { method: 'DELETE' }); route(); } });
} };

views.odoo = { title: 'Integración con Odoo', async render(el) {
  await loadCatalogos();
  const c = await api('/odoo');
  const r = c.resumen;
  const chk = (n, v) => `<input type="checkbox" name="${n}" value="1" ${v === '1' ? 'checked' : ''}>`;
  el.innerHTML = `
    <div class="grid two" style="align-items:start">
      <form class="card" id="cfg"><h2>Conexión</h2>
        <div class="grid" style="grid-template-columns:1fr 1fr">
          ${field('Dirección de Odoo', inp('odoo_url', c.odoo_url || '', 'placeholder="https://miempresa.odoo.com" required'), true)}
          ${field('Base de datos (opcional en Odoo Online)', inp('odoo_db', c.odoo_db || '', 'placeholder="miempresa"'))}
          ${field('Usuario (correo del dueño de la API key)', inp('odoo_login', c.odoo_login || '', 'placeholder="rh@empresa.com"'))}
          ${field('API key', inp('odoo_api_key', '', `type="password" autocomplete="new-password" placeholder="${c.tiene_api_key ? '•••••• guardada (dejar vacío para conservar)' : 'Pega aquí la API key'}"`), true)}
          ${field('Horario para empleados nuevos', sel('odoo_horario_id', opts(state.cat.horarios, c.odoo_horario_id, '— Sin horario —')))}
          ${field('Enviar asistencias desde', `<input type="date" name="odoo_asist_desde" value="${esc(c.odoo_asist_desde || today())}">`)}
          <label class="f full"><span>${chk('odoo_activo', c.odoo_activo)} Sincronizar automáticamente cada 10 minutos</span></label>
          <label class="f full"><span>${chk('odoo_enviar_asist', c.odoo_enviar_asist)} Enviar entradas y salidas a Odoo Asistencias</span></label>
        </div>
        <div class="toolbar" style="margin:14px 0 0">
          <button class="btn primary">Guardar</button>
          <button type="button" class="btn" id="probar">Probar conexión</button>
          <button type="button" class="btn" id="sync">Sincronizar ahora</button>
        </div>
        <div class="small muted">${c.ultima_sync ? 'Última sincronización: ' + esc(c.ultima_sync) : 'Aún no se ha sincronizado'}
          ${c.ultimo_error ? `<br><span style="color:var(--bad)">Último error: ${esc(c.ultimo_error)}</span>` : ''}</div>
      </form>
      <div class="card"><h2>Cómo obtener la API key</h2><div class="help"><ol>
        <li>En Odoo, haz clic en tu foto (arriba a la derecha) → <b>Mi perfil</b> (o <b>Preferencias</b>).</li>
        <li>Pestaña <b>Seguridad de la cuenta</b> → <b>Nueva clave API</b>. Ponle un nombre como "Checadores" y copia la clave (sólo se muestra una vez).</li>
        <li>El usuario debe tener permiso de <b>Empleados: Oficial</b> y <b>Asistencias: Administrador</b>.</li>
        <li>En Odoo Online, la API sólo funciona en el plan <b>Personalizado</b> (Custom).</li>
      </ol>
      <p class="small" style="margin:8px 0 0"><b>Cómo se empatan:</b> el <b>ID de credencial</b> de cada empleado en Odoo (Ficha → Configuración de RR. HH.) debe ser igual a su número en el checador. Nombre, puesto y empresa se toman de Odoo. Si archivan a alguien en Odoo, queda inactivo aquí.</p>
      <p class="small" style="margin:8px 0 0"><b>Altas al checador:</b> en <a href="#/dispositivos">Checadores</a> → Editar, activa "Recibir altas de empleados de Odoo". Después la persona debe registrar su huella o rostro en el equipo.</p></div></div>
    </div>
    <div id="res" style="margin-top:14px"></div>`;
  const form = $('#cfg', el);
  const datos = () => { const d = Object.fromEntries(new FormData(form)); d.odoo_activo = d.odoo_activo ? '1' : '0'; d.odoo_enviar_asist = d.odoo_enviar_asist ? '1' : '0'; return d; };
  const ocupado = async (b, texto, fn) => { const t = b.textContent; b.disabled = true; b.textContent = texto; try { await fn(); } catch (e) { toast(e.message, true); } finally { b.disabled = false; b.textContent = t; } };
  form.onsubmit = async (e) => { e.preventDefault(); try { await api('/odoo', { method: 'PUT', body: datos() }); toast('Configuración guardada'); route(); } catch (err) { toast(err.message, true); } };
  $('#probar', el).onclick = (e) => ocupado(e.target, 'Probando…', async () => {
    await api('/odoo', { method: 'PUT', body: datos() });
    const p = await api('/odoo/probar', { method: 'POST' });
    modal('Conexión con Odoo exitosa ✅', `<div class="full"><table><tbody>
      ${[['Versión de Odoo', p.version], ['API', p.api], ['Empleados activos', p.empleados], ['Con ID de credencial', p.con_credencial], ['Asistencias', p.asistencias]]
        .map(([k, v]) => `<tr><td class="muted">${k}</td><td><b>${esc(v ?? '-')}</b></td></tr>`).join('')}</tbody></table></div>`, null);
  });
  $('#sync', el).onclick = (e) => ocupado(e.target, 'Sincronizando…', async () => {
    await api('/odoo', { method: 'PUT', body: datos() });
    await api('/odoo/sincronizar', { method: 'POST' }); toast('Sincronización terminada'); route();
  });
  if (!r) return;
  const E = r.empleados, A = r.asistencias;
  const sinCred = E.sin_credencial || [];
  $('#res', el).innerHTML = `
    <h2>Resultado de la última sincronización <span class="small muted">(${esc(r.fecha)})</span></h2>
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Empleados en Odoo</div><div class="value">${E.odoo_total}</div></div>
      <div class="card kpi ok"><div class="label">Empatados</div><div class="value">${E.vinculados}</div><div class="small muted">${E.actualizados} actualizados · ${E.bajas} bajas</div></div>
      <div class="card kpi info"><div class="label">Nuevos desde Odoo</div><div class="value">${E.nuevos.length}</div></div>
      <div class="card kpi warn"><div class="label">Sin empatar</div><div class="value">${E.solo_local.length + sinCred.length}</div><div class="small muted">${E.solo_local.length} sólo aquí · ${sinCred.length} sólo en Odoo</div></div>
      <div class="card kpi"><div class="label">Asistencias a Odoo</div><div class="value">${A.activo ? A.enviadas + A.actualizadas : '—'}</div><div class="small muted">${A.activo ? `${A.errores.length} con error` : 'desactivado'}</div></div>
    </div>
    ${(E.conflictos || []).length ? `<div class="help" style="margin-bottom:14px;color:var(--bad)">${E.conflictos.map(esc).join('<br>')}</div>` : ''}
    <div class="grid two" style="align-items:start">
      <div class="card"><h2>Empleados del checador sin empate en Odoo</h2>
        <p class="small muted">Elige a quién corresponde en Odoo y presiona <b>Vincular</b>: se guardará su número como ID de credencial en Odoo y aquí tomará el nombre de Odoo.</p>
        ${E.solo_local.length ? `<div class="table-wrap"><table><thead><tr><th>No.</th><th>Nombre aquí</th><th>Empleado en Odoo</th><th></th></tr></thead><tbody>
        ${E.solo_local.map((l) => `<tr><td class="mono">${esc(l.numero)}</td><td>${esc(l.nombre)}</td>
          <td>${sinCred.length ? `<select data-sel="${l.id}" style="max-width:240px"><option value="">— Elegir —</option>${sinCred.map((o) => `<option value="${o.id}" ${l.sugerencia?.id === o.id ? 'selected' : ''}>${esc(o.nombre)}</option>`).join('')}</select>` : '<span class="muted small">No hay empleados de Odoo sin ID de credencial</span>'}</td>
          <td>${sinCred.length ? `<button class="btn sm primary" data-vin="${l.id}">Vincular</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">Todos los empleados están empatados ✅</div>'}
      </div>
      <div class="card"><h2>En Odoo sin ID de credencial</h2>
        <p class="small muted">Estos empleados no tienen número de checador en Odoo. Captúralo en Odoo o vincúlalos desde la lista de la izquierda.</p>
        ${sinCred.length ? sinCred.map((o) => `<div class="list-row"><span>${esc(o.nombre)}</span></div>`).join('') : '<div class="empty">Ninguno ✅</div>'}
        ${E.nuevos.length ? `<h3 style="margin-top:14px">Dados de alta desde Odoo</h3>${E.nuevos.map((n) => `<div class="list-row"><span class="mono">${esc(n.numero)}</span><span>${esc(n.nombre)}</span></div>`).join('')}` : ''}
        ${(r.checadores || []).length ? `<h3 style="margin-top:14px">Altas enviadas a checadores</h3>${r.checadores.map((x) => `<div class="list-row"><b>${esc(x.dispositivo)}</b><span>${x.error ? `<span class="badge bad">${esc(x.error)}</span>` : `${x.creados.length} creados${x.omitidos.length ? ` · ${x.omitidos.length} omitidos` : ''}`}</span></div>
          ${(x.creados || []).map((u) => `<div class="small muted">＋ ${esc(u.numero)} ${esc(u.nombre)} — falta registrar huella/rostro</div>`).join('')}
          ${(x.omitidos || []).map((u) => `<div class="small" style="color:var(--warn)">${esc(u.numero)}: ${esc(u.motivo)}</div>`).join('')}`).join('')}` : ''}
        ${A.activo && A.errores.length ? `<h3 style="margin-top:14px">Asistencias no enviadas</h3>${A.errores.map((x) => `<div class="small" style="color:var(--bad)">${esc(x)}</div>`).join('')}` : ''}
      </div>
    </div>`;
  el.querySelectorAll('[data-vin]').forEach((b) => b.onclick = () => ocupado(b, '…', async () => {
    const odoo_id = el.querySelector(`[data-sel="${b.dataset.vin}"]`).value;
    if (!odoo_id) throw new Error('Elige el empleado de Odoo');
    const x = await api('/odoo/vincular', { method: 'POST', body: { empleado_id: Number(b.dataset.vin), odoo_id: Number(odoo_id) } });
    toast('Vinculado con ' + x.nombre); b.closest('tr').remove();
  }));
} };

views.depurar = { title: 'Depuración de empleados y checadas', async render(el) {
  const info = await api('/depurar/ultima');
  const mes = today().slice(0, 8) + '01';
  el.innerHTML = `
    <form class="card" id="f" style="margin-bottom:14px">
      <p class="muted" style="margin-top:0">Deja sólo a los empleados activos. <b>Se conservan</b> los vinculados con Odoo; <b>se dan de baja</b> los archivados en Odoo, los duplicados y los que no están en Odoo y no han checado recientemente.
      Los que no están en Odoo pero <b>sí checaron</b> se muestran para revisión y no se tocan.</p>
      <div class="help" style="margin-bottom:12px">⚖️ Por obligación legal (LFT art. 132 fr. XXXIV y art. 804) <b>nada se borra del sistema</b>: las bajas y las checadas viejas pasan al <b>archivo histórico</b>,
      salen de las pantallas y reportes del día a día y se pueden consultar en <a href="#/jornada">Registro de jornada</a> cuando lo pida la autoridad. Del checador físico sí se borran los usuarios.</div>
      <div class="toolbar" style="margin:0">
        ${field('Conservar checadas desde', `<input type="date" name="desde" value="${esc(info.asistencia_desde || mes)}">`)}
        ${field('Inactivo si no checa en (días)', inp('dias', '30', 'type="number" min="1" max="365" style="width:120px"'))}
        <label class="f">&nbsp;<span><input type="checkbox" name="borrar_en_checador" value="1" checked> Borrar también del checador (con sus huellas)</span></label>
        <label class="f">&nbsp;<span><input type="checkbox" name="vaciar_memoria" value="1"> Vaciar la memoria de checadas del checador</span></label>
        <button class="btn primary">Vista previa</button>
      </div>
      ${info.asistencia_desde ? `<p class="small muted" style="margin:8px 0 0">Actualmente se aceptan checadas desde el <b>${esc(info.asistencia_desde)}</b>.</p>` : ''}
      ${info.ultima ? `<p class="small muted" style="margin:4px 0 0">Última depuración: ${esc(info.ultima.fecha)} · ${info.ultima.empleados_archivados ?? info.ultima.empleados_eliminados} bajas y ${info.ultima.checadas_archivadas ?? info.ultima.checadas_borradas} checadas archivadas.</p>` : ''}
    </form>
    <div id="out"></div>`;
  const datos = () => { const d = Object.fromEntries(new FormData($('#f', el))); d.borrar_en_checador = !!d.borrar_en_checador; d.vaciar_memoria = !!d.vaciar_memoria; return d; };
  const tabla = (rows, cols) => rows.length ? `<div class="table-wrap" style="max-height:420px;overflow:auto"><table><thead><tr>${cols.map((c) => `<th>${c[0]}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(c[1](r) ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="empty">Ninguno</div>';
  $('#f', el).onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = ev.submitter; btn.disabled = true; btn.textContent = 'Analizando…';
    try {
      const d = datos();
      const p = await api('/depurar/vista-previa', { method: 'POST', body: d });
      const totBorrarDev = p.checadores.reduce((a, c) => a + (c.borrar?.length || 0), 0);
      $('#out', el).innerHTML = `
        <div class="grid kpis">
          <div class="card kpi ok"><div class="label">Se conservan</div><div class="value">${p.conservar}</div><div class="small muted">vinculados con Odoo</div></div>
          <div class="card kpi bad"><div class="label">Se dan de baja</div><div class="value">${p.eliminar.length}</div><div class="small muted">se archivan con su historial</div></div>
          <div class="card kpi warn"><div class="label">A revisar</div><div class="value">${p.revisar.length}</div><div class="small muted">checan pero no están en Odoo</div></div>
          <div class="card kpi bad"><div class="label">Usuarios a borrar del checador</div><div class="value">${d.borrar_en_checador ? totBorrarDev : 0}</div></div>
          <div class="card kpi"><div class="label">Checadas al archivo</div><div class="value">${p.checadas_viejas + p.checadas_de_eliminados}</div><div class="small muted">anteriores al ${esc(p.desde)} y de las bajas</div></div>
        </div>
        <div class="grid two" style="align-items:start">
          <div class="card"><h2>Se dan de baja (${p.eliminar.length})</h2>${tabla(p.eliminar, [['No.', (r) => r.numero], ['Nombre', (r) => r.nombre], ['Última checada', (r) => r.ultima || 'nunca'], ['Motivo', (r) => r.motivo]])}</div>
          <div class="card"><h2>A revisar (${p.revisar.length})</h2><p class="small muted">Siguen checando pero no están vinculados con Odoo. No se borran: vincúlalos en <a href="#/odoo">Odoo</a> o dales de alta allá.</p>
            ${tabla(p.revisar, [['No.', (r) => r.numero], ['Nombre', (r) => r.nombre], ['Última checada', (r) => r.ultima]])}</div>
        </div>
        ${p.checadores.map((c) => `<div class="card" style="margin-top:14px"><h2>Checador ${esc(c.dispositivo)}</h2>
          ${c.error ? `<div class="help" style="color:var(--bad)">${esc(c.error)}</div>` : c.omitido ? '<p class="muted">No se leerá el checador.</p>' : `
          <p class="small muted">${c.usuarios} usuarios en el equipo. ${d.borrar_en_checador ? `Se borrarán <b>${c.borrar.length}</b> (con sus huellas).` : 'No se borrará ninguno.'}
          ${c.protegidos.length ? ` ${c.protegidos.length} administradores del equipo se conservan siempre.` : ''} ${c.revisar.length ? ` ${c.revisar.length} usuarios del equipo que no están en el sistema pero checaron recientemente se conservan.` : ''}
          ${d.vaciar_memoria ? ' Antes de vaciar la memoria se leerán sus últimas checadas.' : ''}</p>
          ${d.borrar_en_checador ? tabla(c.borrar, [['No.', (r) => r.numero], ['Nombre en el checador', (r) => r.nombre], ['Última checada', (r) => r.ultima || 'nunca']]) : ''}`}</div>`).join('')}
        <div class="card" style="margin-top:14px;border-color:var(--bad)">
          <h2>Aplicar depuración</h2>
          <p class="small">Se guardará un respaldo de la base de datos antes de aplicar. En el sistema nada se borra (se archiva). <b>Lo que se borre del checador (usuarios y huellas) no se puede recuperar.</b></p>
          <div class="toolbar" style="margin:0">${field('Escribe DEPURAR para confirmar', inp('conf', '', 'id="conf" autocomplete="off"'))}<button class="btn primary" id="go" style="background:var(--bad);border-color:var(--bad)">Aplicar</button></div>
        </div>`;
      $('#go', el).onclick = async () => {
        if ($('#conf', el).value.trim() !== 'DEPURAR') return toast('Escribe DEPURAR para confirmar', true);
        const b = $('#go', el); b.disabled = true; b.textContent = 'Aplicando…';
        try {
          const r = await api('/depurar/aplicar', { method: 'POST', body: { ...d, confirmacion: 'DEPURAR' } });
          $('#out', el).innerHTML = `<div class="card"><h2>Depuración terminada ✅</h2>
            <p>${r.empleados_archivados} empleados dados de baja y ${r.checadas_archivadas} checadas enviadas al archivo histórico.</p>
            ${r.checadores.map((c) => `<p><b>${esc(c.dispositivo)}:</b> ${c.error ? `<span style="color:var(--bad)">${esc(c.error)}</span>` : `${(c.borrados || []).length} usuarios borrados${(c.protegidos || []).length ? `, ${c.protegidos.length} administradores conservados` : ''}${c.memoria_vaciada ? ', memoria de checadas vaciada' : ''}`}</p>`).join('')}
            <p class="small muted">Respaldo: <code>${esc(r.respaldo)}</code></p></div>`;
        } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'Aplicar'; }
      };
    } catch (e) { $('#out', el).innerHTML = `<div class="help" style="color:var(--bad)">${esc(e.message)}</div>`; }
    finally { btn.disabled = false; btn.textContent = 'Vista previa'; }
  };
} };

// ---------------- Utilidades interactivas ----------------
function ordenarPor(lista, key, dir) {
  const f = (v) => (v == null ? '' : typeof v === 'number' ? v : String(v).toLowerCase());
  return [...lista].sort((a, b) => (f(a[key]) > f(b[key]) ? 1 : f(a[key]) < f(b[key]) ? -1 : 0) * (dir === 'desc' ? -1 : 1));
}
function imprimirPins(personas, checador) {
  $('#print-area').innerHTML = personas.map((p) => `<div class="slip">
    <div><b>Grupo Proceso Seguro · Alta en checador</b></div>
    <div style="margin-top:6px">${esc(p.nombre)} — No. de empleado <b>${esc(p.numero)}</b></div>
    <div>Checador: <b>${esc(checador)}</b></div>
    <div style="margin:8px 0">PIN: <span class="pinbig">${esc(p.pin)}</span></div>
    <div style="font-size:12px">Mientras registras tu huella, checa con: <b>tu número de empleado → OK → PIN</b>.
    Acude con Recursos Humanos para registrar tu huella en el checador. No compartas tu PIN.</div></div>`).join('');
  setTimeout(() => window.print(), 50);
}

const ESTADOS_HUELLA = {
  registrada: ['Registrada', 'ok', '✅'], pendiente: ['Huella pendiente', 'warn', '⏳'], sin_huella: ['Sin huella', 'bad', '✋'],
  sin_alta: ['No está en el checador', 'bad', '➕'], sin_revisar: ['Sin revisar', '', '❔'],
};

views.huellas = { title: 'Registro de huellas', async render(el, q) {
  const devs = (await api('/dispositivos')).filter((d) => d.marca === 'zkteco' && d.ip_lectura);
  if (!devs.length) { el.innerHTML = '<div class="empty card">Primero agrega un checador ZKTeco con IP de lectura directa en <a href="#/dispositivos">Checadores</a>.</div>'; return; }
  const devId = Number(q.dev) || devs[0].id;
  const st = { filtro: q.f || 'todos', buscar: '', soloOdoo: false, sort: 'nombre', dir: 'asc', sel: new Set(), data: null };
  el.innerHTML = `
    <div class="card" style="margin-bottom:14px;display:flex;gap:14px;align-items:center;flex-wrap:wrap">
      ${devs.length > 1 ? field('Checador', sel('dev', devs.map((d) => `<option value="${d.id}" ${d.id === devId ? 'selected' : ''}>${esc(d.nombre)}</option>`).join(''), 'id="dev"')) : `<div><div class="muted small">Checador</div><b>${esc(devs[0].nombre)}</b></div>`}
      <div style="flex:1;min-width:240px"><div class="progress" id="bar"></div><div class="small muted" id="barlbl" style="margin-top:6px"></div></div>
      ${isAdmin() ? '<button class="btn primary" id="scan">🔄 Revisar checador ahora</button>' : ''}
    </div>
    <div class="chips" id="chips"></div>
    <div class="toolbar"><div class="searchbox"><input id="q" placeholder="Buscar por nombre o número…" autocomplete="off"></div>
      <label class="small"><input type="checkbox" id="soloOdoo"> Sólo empleados de Odoo</label></div>
    <div id="tabla"><div class="card"><div class="skeleton" style="width:60%"></div><div class="skeleton" style="margin-top:10px"></div><div class="skeleton" style="margin-top:10px;width:80%"></div></div></div>
    <div id="bar-acc"></div>`;
  $('#dev', el)?.addEventListener('change', (e) => { location.hash = '#/huellas?dev=' + e.target.value; });

  const visibles = () => {
    const b = st.buscar.toLowerCase();
    return ordenarPor(st.data.filas.filter((f) => (st.filtro === 'todos' || f.estado === st.filtro)
      && (!st.soloOdoo || f.en_odoo) && (!b || (f.nombre + ' ' + f.numero).toLowerCase().includes(b))), st.sort, st.dir);
  };
  const pintarResumen = () => {
    const r = st.data.resumen, total = st.data.filas.length || 1;
    const col = { registrada: 'var(--ok)', pendiente: 'var(--warn)', sin_huella: 'var(--bad)', sin_alta: '#f97316', sin_revisar: 'var(--border)' };
    $('#bar', el).innerHTML = Object.keys(col).map((k) => r[k] ? `<span title="${ESTADOS_HUELLA[k][0]}: ${r[k]}" style="width:${(r[k] / total) * 100}%;background:${col[k]}"></span>` : '').join('');
    const rev = st.data.filas.map((f) => f.revisado_en).filter(Boolean).sort().pop();
    $('#barlbl', el).innerHTML = `<b>${r.registrada || 0}</b> de ${st.data.filas.length} con huella registrada · ${rev ? 'revisado ' + esc(rev) : 'aún no se revisa el checador'}`;
    $('#chips', el).innerHTML = [['todos', 'Todos', st.data.filas.length, '']].concat(Object.entries(ESTADOS_HUELLA).map(([k, v]) => [k, v[0], r[k] || 0, v[1]]))
      .filter(([k, , n]) => k === 'todos' || n).map(([k, t, n, c]) => `<button class="chip ${st.filtro === k ? 'on' : ''}" data-f="${k}">${c ? `<span class="dot ${c}"></span>` : ''}${esc(t)} <b>${n}</b></button>`).join('');
    el.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { st.filtro = b.dataset.f; st.sel.clear(); pintarResumen(); pintarTabla(); });
  };
  const pintarAcciones = () => {
    const n = st.sel.size;
    $('#bar-acc', el).innerHTML = n && isAdmin() ? `<div class="actionbar"><b>${n} seleccionado${n > 1 ? 's' : ''}</b>
      <span>Agregar huella en</span>${sel('devsel', devs.map((d) => `<option value="${d.id}" ${d.id === devId ? 'selected' : ''}>${esc(d.nombre)}</option>`).join(''), 'id="devsel"')}
      <button class="btn primary" id="go">☝️ Agregar huella</button>
      <button class="btn sm" id="pins" style="background:transparent;color:#fff">🖨️ Imprimir PIN</button>
      <button class="btn sm" id="clr" style="background:transparent;color:#fff;border-color:#334155">Cancelar</button></div>` : '';
    if (!n) return;
    $('#clr', el).onclick = () => { st.sel.clear(); pintarTabla(); };
    $('#pins', el).onclick = () => {
      const ps = st.data.filas.filter((f) => st.sel.has(f.id) && f.pin_checador).map((f) => ({ ...f, pin: f.pin_checador }));
      if (!ps.length) return toast('Ninguno de los seleccionados tiene PIN todavía. Usa "Agregar huella".', true);
      imprimirPins(ps, st.data.dispositivo.nombre);
    };
    $('#go', el).onclick = () => agregarHuella([...st.sel], Number($('#devsel', el).value));
  };
  const pintarTabla = () => {
    const rows = visibles();
    const th = (k, t) => `<th class="sortable ${st.sort === k ? st.dir : ''}" data-s="${k}">${t}</th>`;
    $('#tabla', el).innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr>
      ${isAdmin() ? `<th style="width:34px"><input type="checkbox" id="all" ${rows.every((r) => st.sel.has(r.id)) ? 'checked' : ''}></th>` : ''}
      ${th('numero', 'No.')}${th('nombre', 'Empleado')}${th('empresa', 'Empresa')}${th('estado', 'Estado')}${th('huellas', 'Huellas')}<th>PIN</th>${th('solicitado_en', 'Solicitado')}<th></th></tr></thead><tbody>
      ${rows.map((f) => { const [t, c, i] = ESTADOS_HUELLA[f.estado] || ESTADOS_HUELLA.sin_revisar; return `<tr class="${st.sel.has(f.id) ? 'sel' : ''}">
        ${isAdmin() ? `<td><input type="checkbox" data-c="${f.id}" ${st.sel.has(f.id) ? 'checked' : ''}></td>` : ''}
        <td class="mono">${esc(f.numero)}</td>
        <td><b>${esc(f.nombre)}</b><div class="small muted">${esc(f.puesto || '')}${f.en_odoo ? '' : ' <span class="badge warn">No está en Odoo</span>'}</div></td>
        <td class="small">${esc(f.empresa || '')}</td>
        <td><span class="badge ${c}">${i} ${t}</span>${f.registrado_en && f.estado === 'registrada' ? `<div class="small muted">${esc(f.registrado_en.slice(0, 10))}</div>` : ''}</td>
        <td class="num">${f.huellas ?? '–'}</td>
        <td>${f.pin_checador ? `<span class="pin">${esc(f.pin_checador)}</span>` : ''}</td>
        <td class="small">${f.solicitado_en ? `${esc(f.solicitado_en.slice(0, 16))}<div class="muted">${esc(f.solicitado_por || '')}</div>` : ''}</td>
        <td style="white-space:nowrap">${isAdmin() ? (f.estado !== 'registrada'
          ? `<button class="btn sm primary" data-add="${f.id}" title="Dar de alta en el checador con PIN">☝️ Agregar</button> <button class="btn sm" data-ok="${f.id}" title="Marcar como registrada (por ejemplo, si se registró con rostro)">✓</button>`
          : `<button class="btn sm" data-pend="${f.id}" title="Volver a huella pendiente">↺</button>`) : ''}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="empty card">No hay empleados con este filtro.</div>';
    el.querySelectorAll('[data-s]').forEach((h) => h.onclick = () => { st.dir = st.sort === h.dataset.s && st.dir === 'asc' ? 'desc' : 'asc'; st.sort = h.dataset.s; pintarTabla(); });
    el.querySelectorAll('[data-c]').forEach((c) => c.onchange = () => { c.checked ? st.sel.add(Number(c.dataset.c)) : st.sel.delete(Number(c.dataset.c)); pintarTabla(); });
    $('#all', el) && ($('#all', el).onchange = (e) => { rows.forEach((r) => (e.target.checked ? st.sel.add(r.id) : st.sel.delete(r.id))); pintarTabla(); });
    el.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => agregarHuella([Number(b.dataset.add)], devId));
    el.querySelectorAll('[data-ok]').forEach((b) => b.onclick = () => marcar(b.dataset.ok, 'registrada'));
    el.querySelectorAll('[data-pend]').forEach((b) => b.onclick = () => marcar(b.dataset.pend, 'pendiente'));
    pintarAcciones();
  };
  const marcar = async (id, estado) => { await api(`/huellas/${devId}/marcar`, { method: 'POST', body: { empleado_id: Number(id), estado } }); await cargar(); toast('Actualizado'); };
  const agregarHuella = async (ids, dev) => {
    const nombreDev = devs.find((d) => d.id === dev)?.nombre;
    if (!confirmar(`Se dará de alta a ${ids.length} persona(s) en ${nombreDev} con un PIN para checar mientras registran su huella. ¿Continuar?`)) return;
    toast('Escribiendo en el checador…');
    try {
      const r = await api(`/huellas/${dev}/agregar`, { method: 'POST', body: { empleado_ids: ids } });
      st.sel.clear();
      const m = modal(`Alta en ${r.dispositivo} ✅`, `<div class="full">
        <p class="small muted" style="margin-top:0">Entrega a cada persona su PIN. Mientras registra su huella puede checar con su número de empleado y su PIN.</p>
        <div class="table-wrap"><table><thead><tr><th>No.</th><th>Nombre</th><th>PIN</th><th>Odoo</th></tr></thead><tbody>
        ${r.hechos.map((h) => `<tr><td class="mono">${esc(h.numero)}</td><td>${esc(h.nombre)}</td><td><span class="pin">${esc(h.pin)}</span></td><td>${h.odoo === 'ok' ? '<span class="badge ok">PIN guardado</span>' : h.odoo ? `<span class="badge warn" title="${esc(h.odoo)}">No se guardó</span>` : '—'}</td></tr>`).join('')}
        </tbody></table></div>
        ${r.errores.length ? `<div class="help" style="margin-top:10px;color:var(--bad)">${r.errores.map((e) => `${esc(e.numero)}: ${esc(e.motivo)}`).join('<br>')}</div>` : ''}
        <button type="button" class="btn primary" id="print" style="margin-top:12px">🖨️ Imprimir comprobantes</button></div>`, null);
      $('#print', m).onclick = () => imprimirPins(r.hechos, r.dispositivo);
      await cargar();
    } catch (e) { toast(e.message, true); }
  };
  const cargar = async (escanear) => {
    st.data = escanear ? await api(`/huellas/${devId}/escanear`, { method: 'POST' }) : await api('/huellas/' + devId);
    pintarResumen(); pintarTabla();
  };
  $('#q', el).oninput = (e) => { st.buscar = e.target.value; pintarTabla(); };
  $('#soloOdoo', el).onchange = (e) => { st.soloOdoo = e.target.checked; pintarTabla(); };
  $('#scan', el) && ($('#scan', el).onclick = async (e) => {
    const b = e.target; b.disabled = true; b.textContent = 'Leyendo checador…';
    try { await cargar(true); toast('Checador revisado'); } catch (err) { toast(err.message, true); } finally { b.disabled = false; b.textContent = '🔄 Revisar checador ahora'; }
  });
  await cargar();
  if (!st.data.filas.some((f) => f.revisado_en) && isAdmin()) $('#scan', el).click();
} };

const lunesLocal = (d) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
const horasTxt = (h) => { const n = Number(h || 0); const hh = Math.floor(n); const mm = Math.round((n - hh) * 60); return n ? `${hh}:${String(mm).padStart(2, '0')}` : '—'; };

views.jornada = { title: 'Registro de jornada', async render(el, q) {
  await loadCatalogos();
  const hoy = today(), lun = lunesLocal(hoy);
  const presets = { semana: [lun, hoy], pasada: [addDays(lun, -7), addDays(lun, -1)], quincena: [hoy.slice(8) <= '15' ? hoy.slice(0, 8) + '01' : hoy.slice(0, 8) + '16', hoy], mes: [hoy.slice(0, 8) + '01', hoy] };
  const f = { desde: q.desde || presets.pasada[0], hasta: q.hasta || presets.pasada[1], empresa_id: q.empresa_id || '', empleado_id: q.empleado_id || '' };
  const emps = await api('/empleados?archivados=1');
  el.innerHTML = `
    <div class="help" style="margin-bottom:14px">⚖️ Formato de <b>registro electrónico de la jornada</b> (LFT art. 132 fr. XXXIV): inicio y fin de jornada, descansos, horas efectivas y extra, medio de registro y conformidad del trabajador.
      Incluye el archivo histórico y a las personas dadas de baja. Jornada máxima semanal aplicada: 48 h en 2026, 46 h en 2027 (reducción gradual hasta 40 h en 2030).</div>
    <form class="toolbar card" id="flt">
      <div class="chips" style="margin:0;width:100%">${Object.entries({ semana: 'Esta semana', pasada: 'Semana pasada', quincena: 'Quincena', mes: 'Este mes' }).map(([k, t]) => `<button type="button" class="chip ${presets[k][0] === f.desde && presets[k][1] === f.hasta ? 'on' : ''}" data-p="${k}">${t}</button>`).join('')}</div>
      ${field('Desde', `<input type="date" name="desde" value="${f.desde}">`)}${field('Hasta', `<input type="date" name="hasta" value="${f.hasta}">`)}
      ${state.me.empresa_id ? '' : field('Empresa', sel('empresa_id', opts(state.cat.empresas, f.empresa_id)))}
      ${field('Empleado', sel('empleado_id', opts(emps, f.empleado_id, 'Todos')))}
      <button class="btn primary">Consultar</button>
      <a class="btn" href="/api/jornada.csv?${qs(f)}">⬇ Excel (CSV)</a>
      <button type="button" class="btn" id="print">🖨️ Imprimir formato</button>
    </form>
    <div id="res"><div class="card"><div class="skeleton"></div><div class="skeleton" style="margin-top:10px;width:70%"></div></div></div>`;
  el.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => { const [d, h] = presets[b.dataset.p]; location.hash = '#/jornada?' + qs({ ...f, desde: d, hasta: h }); });
  $('#flt', el).onsubmit = (e) => { e.preventDefault(); location.hash = '#/jornada?' + qs(Object.fromEntries(new FormData(e.target))); };
  const r = await api('/jornada?' + qs(f));
  const diasDe = (w) => r.dias.filter((d) => d.empleado_id === w.empleado_id && d.semana === w.semana);
  const tot = r.semanas.reduce((a, w) => ({ h: a.h + w.horas, x: a.x + w.extra, exc: a.exc + (w.excede ? 1 : 0), conf: a.conf + (w.conformidad ? 1 : 0) }), { h: 0, x: 0, exc: 0, conf: 0 });
  $('#res', el).innerHTML = `
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Horas efectivas</div><div class="value">${horasTxt(tot.h)}</div></div>
      <div class="card kpi warn"><div class="label">Horas extra</div><div class="value">${horasTxt(tot.x)}</div></div>
      <div class="card kpi bad"><div class="label">Semanas sobre el límite</div><div class="value">${tot.exc}</div></div>
      <div class="card kpi ok"><div class="label">Conformidad del trabajador</div><div class="value">${tot.conf}<span class="small muted"> / ${r.semanas.length}</span></div><div class="small muted">semanas confirmadas</div></div>
    </div>
    ${r.semanas.length ? `<div class="table-wrap"><table><thead><tr><th></th><th>Semana</th><th>No.</th><th>Empleado</th><th>Empresa</th><th class="num">Días</th><th>Horas vs. límite</th><th class="num">Extra</th><th>Conformidad</th></tr></thead><tbody>
    ${r.semanas.map((w, i) => { const pct = Math.min(100, (w.horas / w.limite) * 100); return `<tr class="expand" data-i="${i}"><td>▸</td><td>${esc(w.semana)}</td><td class="mono">${esc(w.numero)}</td><td><b>${esc(w.nombre)}</b></td><td class="small">${esc(w.empresa || '')}</td>
      <td class="num">${w.dias}</td><td><div style="display:flex;gap:8px;align-items:center"><div class="meter ${w.excede ? 'bad' : pct > 90 ? 'warn' : ''}" style="flex:1"><span style="width:${pct}%"></span></div><span class="small">${horasTxt(w.horas)} / ${w.limite} h</span></div></td>
      <td class="num">${w.extra ? horasTxt(w.extra) : ''}</td><td>${w.conformidad ? `<span class="badge ok" title="${esc(w.conformidad)}">✔ Confirmada</span>` : '<span class="badge">Pendiente</span>'}</td></tr>
      <tr class="detalle hidden" data-d="${i}"><td></td><td colspan="8"><table><thead><tr><th>Fecha</th><th>Entradas y salidas</th><th class="num">Descanso</th><th class="num">Efectivas</th><th class="num">Extra</th><th>Medio</th><th>Estado</th><th>Incidencias</th></tr></thead><tbody>
        ${diasDe(w).map((d) => `<tr><td>${esc(d.fecha)}</td><td><span class="pares">${d.pares.map((x) => `<span>${x[0] || '¿?'} – ${x[1] || '¿?'}</span>`).join('')}</span></td>
          <td class="num">${d.descanso_min ? d.descanso_min + ' min' : ''}</td><td class="num">${horasTxt(d.efectivas)}</td><td class="num">${d.extra ? horasTxt(d.extra) : ''}</td>
          <td class="small">${esc(d.medio)}</td><td>${estadoBadge(d.estado)}</td><td class="small">${d.incidencias.map(esc).join('; ')}</td></tr>`).join('')}</tbody></table></td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="empty card">Sin registros en el periodo.</div>'}`;
  el.querySelectorAll('[data-i]').forEach((tr) => tr.onclick = () => { const d = el.querySelector(`[data-d="${tr.dataset.i}"]`); d.classList.toggle('hidden'); tr.firstElementChild.textContent = d.classList.contains('hidden') ? '▸' : '▾'; });
  $('#print', el).onclick = () => {
    const porEmp = new Map(); for (const d of r.dias) { if (!porEmp.has(d.empleado_id)) porEmp.set(d.empleado_id, []); porEmp.get(d.empleado_id).push(d); }
    const emp = (id) => r.empresas.find((x) => x.id === id) || {};
    $('#print-area').innerHTML = [...porEmp.values()].map((dias) => { const d0 = dias[0], em = emp(d0.empresa_id), ws = r.semanas.filter((w) => w.empleado_id === d0.empleado_id); return `<div class="formato">
      <h2>Registro electrónico de la jornada laboral</h2>
      <div>Patrón: <b>${esc(em.razon_social || em.nombre || d0.empresa || '')}</b> · RFC: ${esc(em.rfc || '—')} · Registro patronal: ${esc(em.registro_patronal || '—')}</div>
      <div>Trabajador: <b>${esc(d0.nombre)}</b> · No. ${esc(d0.numero)} · Puesto: ${esc(d0.puesto || '—')} · CURP: ${esc(d0.curp || '—')} · RFC: ${esc(d0.rfc || '—')} · NSS: ${esc(d0.nss || '—')}</div>
      <div>Periodo: ${esc(r.desde)} al ${esc(r.hasta)} · Emitido: ${esc(new Date().toLocaleString('es-MX'))}</div>
      <table><thead><tr><th>Fecha</th><th>Inicio</th><th>Fin</th><th>Entradas y salidas</th><th>Descanso</th><th>Horas efectivas</th><th>Horas extra</th><th>Medio de registro</th><th>Observaciones</th></tr></thead><tbody>
      ${dias.map((d) => `<tr><td>${esc(d.fecha)}</td><td>${esc(d.entrada || '')}</td><td>${esc(d.salida || '')}</td><td>${d.pares.map((x) => `${x[0] || '¿?'}–${x[1] || '¿?'}`).join(', ')}</td><td>${d.descanso_min ? d.descanso_min + ' min' : ''}</td>
        <td>${horasTxt(d.efectivas)}</td><td>${d.extra ? horasTxt(d.extra) : ''}</td><td>${esc(d.medio)}</td><td>${esc([d.estado, ...d.incidencias].filter(Boolean).join('; '))}</td></tr>`).join('')}</tbody></table>
      <table><thead><tr><th>Semana</th><th>Horas efectivas</th><th>Jornada máxima</th><th>Horas extra</th><th>Conformidad electrónica del trabajador</th></tr></thead><tbody>
      ${ws.map((w) => `<tr><td>${esc(w.semana)}</td><td>${horasTxt(w.horas)}</td><td>${w.limite} h</td><td>${horasTxt(w.extra)}</td><td>${w.conformidad ? 'Confirmada el ' + esc(w.conformidad) : 'Pendiente'}</td></tr>`).join('')}</tbody></table>
      <div class="firmas"><div>Nombre y firma del trabajador</div><div>Nombre y firma del representante del patrón</div></div></div>`; }).join('') || '<p>Sin registros.</p>';
    setTimeout(() => window.print(), 50);
  };
} };

views.bitacora = { title: 'Bitácora de cambios', async render(el, q) {
  const f = { desde: q.desde || addDays(today(), -30), hasta: q.hasta || today(), buscar: q.buscar || '', offset: Number(q.offset) || 0 };
  el.innerHTML = `<div class="help" style="margin-bottom:14px">Registro inalterable de las acciones hechas por personas: capturas y anulaciones de checadas, cambios de empleados, altas en checadores, depuraciones, configuración y conformidades. No se puede editar ni borrar.</div>
    <form class="toolbar card" id="flt">${field('Desde', `<input type="date" name="desde" value="${f.desde}">`)}${field('Hasta', `<input type="date" name="hasta" value="${f.hasta}">`)}
      <div class="searchbox">${inp('buscar', f.buscar, 'placeholder="Usuario, acción o dato…"')}</div><button class="btn primary">Filtrar</button></form><div id="res"></div>`;
  $('#flt', el).onsubmit = (e) => { e.preventDefault(); location.hash = '#/bitacora?' + qs(Object.fromEntries(new FormData(e.target))); };
  const r = await api('/bitacora?' + qs({ ...f, limit: 100 }));
  const fmt = (d) => { try { const o = JSON.parse(d); return Object.entries(o).map(([k, v]) => `<b>${esc(k)}</b>: ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(' · '); } catch { return esc(d || ''); } };
  $('#res', el).innerHTML = r.rows.length ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Referencia</th><th>Detalle</th></tr></thead><tbody>
    ${r.rows.map((x) => `<tr><td class="mono small">${esc(x.fecha)}</td><td>${esc(x.usuario)}</td><td><b>${esc(x.accion)}</b></td><td class="small">${esc([x.entidad, x.entidad_id].filter(Boolean).join(' #'))}</td>
      <td class="small" style="white-space:normal;max-width:520px">${fmt(x.detalle)}</td></tr>`).join('')}</tbody></table></div>
    <div class="pager"><span class="muted">${f.offset + 1}–${f.offset + r.rows.length} de ${r.total}</span><span>
      <button class="btn sm" id="prev" ${f.offset ? '' : 'disabled'}>← Anterior</button> <button class="btn sm" id="next" ${f.offset + r.rows.length < r.total ? '' : 'disabled'}>Siguiente →</button></span></div>`
    : '<div class="empty card">Sin movimientos en el periodo.</div>';
  $('#prev', el) && ($('#prev', el).onclick = () => { location.hash = '#/bitacora?' + qs({ ...f, offset: Math.max(0, f.offset - 100) }); });
  $('#next', el) && ($('#next', el).onclick = () => { location.hash = '#/bitacora?' + qs({ ...f, offset: f.offset + 100 }); });
} };

// ---------------- Router ----------------
async function route() {
  const [p, query] = (location.hash.slice(2) || 'tablero').split('?');
  let name = views[p] ? p : 'tablero';
  if (!isAdmin() && ['dispositivos', 'importar', 'catalogos', 'usuarios', 'odoo', 'depurar', 'bitacora'].includes(name)) name = 'tablero';
  const v = views[name];
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === name));
  $('#title').textContent = v.title;
  $('#sidebar').classList.remove('open');
  const el = $('#view');
  try { await v.render(el, Object.fromEntries(new URLSearchParams(query || ''))); }
  catch (e) { el.innerHTML = `<div class="empty card" style="color:var(--bad)">${esc(e.message)}</div>`; }
}

function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
async function start() {
  try { state.me = await api('/me'); } catch { return showLogin(); }
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#who').textContent = `${state.me.nombre || state.me.usuario} · ${isAdmin() ? 'Administrador' : 'Supervisor'}`;
  document.querySelectorAll('#nav .adm').forEach((a) => a.classList.toggle('hidden', !isAdmin()));
  route();
}
$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); $('#login-err').textContent = ''; start(); }
  catch (err) { $('#login-err').textContent = err.message; }
};
$('#btn-logout').onclick = async () => { await api('/logout', { method: 'POST' }); location.hash = ''; showLogin(); };
$('#btn-pass').onclick = () => modal('Cambiar mi contraseña', `${field('Contraseña actual', inp('actual', '', 'type="password" required'), true)}
  ${field('Nueva contraseña (mín. 8)', inp('nueva', '', 'type="password" required minlength="8"'), true)}`,
  async (d) => { await api('/mi-password', { method: 'POST', body: d }); toast('Contraseña actualizada'); });
$('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');
window.addEventListener('hashchange', () => state.me && route());
start();
