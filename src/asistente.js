'use strict';
/**
 * Asistente de asistencia.
 *  - Motor local (siempre disponible, ningún dato sale del servidor): entiende preguntas frecuentes en español.
 *  - Motor Claude (opcional, con API key de Anthropic): responde preguntas libres usando las mismas
 *    funciones de datos como herramientas. Sólo se envían a Anthropic la pregunta y los datos que la responden.
 */
const { db } = require('./db');
const { nowLocal, bitacora } = require('./util');
const { calcularAsistencia, resumen, addDays, lunesDe, reportePersonalizado, registroJornada, tendencia } = require('./reporte');

const getAjuste = (k) => db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(k)?.valor ?? null;
const setAjuste = (k, v) => db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').run(k, v == null ? null : String(v));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const pl = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const hmTxt = (h) => { const n = Number(h || 0); return `${Math.floor(n)}:${String(Math.round((n % 1) * 60)).padStart(2, '0')} h`; };
const fechaTxt = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// ====================== Funciones de datos (comunes a ambos motores) ======================
function empleadosActivos(empresaId) {
  return db.prepare(`SELECT e.id, e.numero, e.nombre, e.puesto, em.nombre empresa FROM empleados e LEFT JOIN empresas em ON em.id = e.empresa_id
                     WHERE e.activo = 1 AND COALESCE(e.archivado, 0) = 0 ${empresaId ? 'AND e.empresa_id = ?' : ''}`).all(...(empresaId ? [empresaId] : []));
}
/** Busca empleados por nombre o número, tolerando acentos, mayúsculas y nombres incompletos. */
function buscarEmpleados(texto, empresaId) {
  const t = norm(texto).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((x) => x.length > 1);
  if (!t.length) return [];
  return empleadosActivos(empresaId).map((e) => {
    const n = norm(e.nombre).split(/\s+/);
    let score = t.includes(norm(e.numero)) ? 10 : 0;
    for (const x of t) if (n.includes(x)) score += 2; else if (n.some((y) => y.startsWith(x) && x.length >= 3)) score += 1;
    return { ...e, score };
  }).filter((e) => e.score >= 2).sort((a, b) => b.score - a.score).slice(0, 10);
}
function empresas() { return db.prepare('SELECT id, nombre FROM empresas ORDER BY nombre').all(); }

const datos = {
  resumen_periodo({ desde, hasta, empresa_id }) {
    const filas = calcularAsistencia({ desde, hasta, empresa_id });
    const r = resumen(filas);
    return { desde, hasta, ...r, presentes: filas.filter((f) => f.entrada).length, personas: new Set(filas.map((f) => f.empleado_id)).size };
  },
  dias({ desde, hasta, empresa_id, empleado_id, estado, limite = 200 }) {
    let filas = calcularAsistencia({ desde, hasta, empresa_id, empleado_id });
    if (estado) filas = filas.filter((f) => f.estado === estado);
    return filas.slice(0, limite).map((f) => ({ fecha: f.fecha, numero: f.numero, nombre: f.nombre, empresa: f.empresa, entrada: f.entrada, salida: f.salida,
      horas: f.efectivas, extra: f.extra, retardo_min: f.retardo_min, estado: f.estado, incidencias: f.incidencias }));
  },
  agrupado({ desde, hasta, agrupar = 'empleado', empresa_id, empleado_id }) {
    return reportePersonalizado({ desde, hasta, agrupar, empresa_id, empleado_id }).rows;
  },
  semanas({ desde, hasta, empresa_id, empleado_id }) {
    return registroJornada({ desde, hasta, empresa_id, empleado_id }).semanas;
  },
  huellas_pendientes(empresaId) {
    return db.prepare(`SELECT e.numero, e.nombre, d.nombre checador, h.estado, h.solicitado_en FROM huellas h JOIN empleados e ON e.id = h.empleado_id
                       JOIN dispositivos d ON d.id = h.dispositivo_id WHERE h.estado IN ('pendiente','sin_huella','sin_alta') AND e.activo = 1
                       ${empresaId ? 'AND e.empresa_id = ?' : ''} ORDER BY h.estado, e.nombre`).all(...(empresaId ? [empresaId] : []));
  },
};

// ====================== Motor local ======================
function periodo(q, hoy) {
  const lun = lunesDe(hoy);
  let m;
  if (/\bayer\b/.test(q)) { const d = addDays(hoy, -1); return { desde: d, hasta: d, txt: 'ayer' }; }
  if (/antier|anteayer/.test(q)) { const d = addDays(hoy, -2); return { desde: d, hasta: d, txt: 'antier' }; }
  if (/semana pasada/.test(q)) return { desde: addDays(lun, -7), hasta: addDays(lun, -1), txt: 'la semana pasada' };
  if (/(esta|la) semana/.test(q)) return { desde: lun, hasta: hoy, txt: 'esta semana' };
  if (/mes pasado/.test(q)) { const d = new Date(hoy.slice(0, 8) + '01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); const ini = d.toISOString().slice(0, 10); return { desde: ini, hasta: addDays(hoy.slice(0, 8) + '01', -1), txt: 'el mes pasado' }; }
  if (/(este|el) mes/.test(q)) return { desde: hoy.slice(0, 8) + '01', hasta: hoy, txt: 'este mes' };
  if ((m = q.match(/ultim[oa]s? (\d{1,3}) dias/))) return { desde: addDays(hoy, -(Number(m[1]) - 1)), hasta: hoy, txt: `los últimos ${m[1]} días` };
  if ((m = q.match(/quincena/))) { const ini = hoy.slice(8) <= '15' ? hoy.slice(0, 8) + '01' : hoy.slice(0, 8) + '16'; return { desde: ini, hasta: hoy, txt: 'esta quincena' }; }
  for (let i = 0; i < 12; i++) if (q.includes(MESES[i])) {
    let y = Number(hoy.slice(0, 4)); if (i + 1 > Number(hoy.slice(5, 7))) y--;
    const ini = `${y}-${String(i + 1).padStart(2, '0')}-01`; const fin = addDays(new Date(Date.UTC(y, i + 1, 1)).toISOString().slice(0, 10), -1);
    return { desde: ini, hasta: fin < hoy ? fin : hoy, txt: `en ${MESES[i]}` };
  }
  if ((m = q.match(/(\d{4}-\d{2}-\d{2})/))) return { desde: m[1], hasta: m[1], txt: `el ${m[1]}` };
  return null;
}

const SUGERENCIAS = ['¿Quién faltó hoy?', '¿Quién llegó tarde esta semana?', '¿Quién tiene más retardos este mes?', 'Horas extra de la semana pasada', '¿Quién no ha checado hoy?', 'Huellas pendientes', '¿Cómo va Ana López este mes?', 'Semanas sobre el límite legal'];

function responderLocal(pregunta, { empresaForzada } = {}) {
  const hoy = nowLocal().slice(0, 10);
  const q = norm(pregunta);
  const per = periodo(q, hoy);
  let empresaId = empresaForzada || null, empresaTxt = '';
  if (!empresaForzada) for (const e of empresas()) if (q.includes(norm(e.nombre))) { empresaId = e.id; empresaTxt = ` en ${e.nombre}`; }
  const r = (texto, extra = {}) => ({ motor: 'local', texto, sugerencias: extra.sugerencias || SUGERENCIAS.slice(0, 4), ...extra });

  // persona mencionada (quitando palabras comunes)
  const vacias = /\b(quien|quienes|cuantos|cuantas|que|como|va|van|esta|este|semana|mes|hoy|ayer|faltas?|falto|retardos?|tarde|horas?|extra|de|del|la|el|los|las|en|a|y|con|tiene|tienen|mas|llego|llegaron|checado|checo|no|ha|han|resumen|asistencia|pasada|pasado|ultimos|dias|por|para|mi|me|dame|muestra|ver|cual|sobre|limite|legal|semanas|huellas?|pendientes?|salida|sin|personal|empleados?|todos|quincena|antier|registro|jornada)\b/g;
  const resto = q.replace(vacias, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  let persona = null;
  if (resto.length >= 3) {
    const c = buscarEmpleados(resto, empresaId);
    if (c.length && (c.length === 1 || c[0].score > c[1].score)) persona = c[0];
    else if (c.length > 1 && /\b(como va|resumen|asistencia de|faltas de|retardos de|horas de)\b/.test(q)) {
      return r(`Encontré varias personas que coinciden con “${resto}”. ¿A quién te refieres?`, { sugerencias: c.slice(0, 5).map((x) => `¿Cómo va ${x.nombre} este mes?`) });
    }
  }

  // ---- huellas
  if (/huella/.test(q)) {
    const h = datos.huellas_pendientes(empresaId);
    const pend = h.filter((x) => x.estado === 'pendiente');
    if (!h.length) return r('✅ Todas las personas revisadas tienen su huella registrada.');
    return r(`Hay **${pend.length}** personas con huella pendiente y **${h.length - pend.length}** sin huella o sin alta en el checador.`, {
      tabla: { columnas: ['No.', 'Nombre', 'Checador', 'Estado'], filas: h.slice(0, 50).map((x) => [x.numero, x.nombre, x.checador, { pendiente: 'Huella pendiente', sin_huella: 'Sin huella', sin_alta: 'No está en el checador' }[x.estado]]) },
      acciones: [{ label: 'Abrir Huellas', href: '#/huellas' }] });
  }
  // ---- límite legal
  if (/limite|exced|48 horas|46 horas|sobre el limite/.test(q)) {
    const p = per || { desde: addDays(lunesDe(hoy), -28), hasta: hoy, txt: 'las últimas 4 semanas' };
    const s = datos.semanas({ ...p, empresa_id: empresaId }).filter((w) => w.excede || w.horas > w.limite * 0.95);
    if (!s.length) return r(`Nadie rebasó ni se acercó a la jornada máxima semanal ${p.txt}${empresaTxt}. 👍`);
    return r(`${s.filter((w) => w.excede).length} semanas sobre el límite y ${s.filter((w) => !w.excede).length} a menos de 5% del límite ${p.txt}${empresaTxt}.`, {
      tabla: { columnas: ['Semana', 'Nombre', 'Horas', 'Límite', 'Extra'], filas: s.map((w) => [w.semana, w.nombre, hmTxt(w.horas), w.limite + ' h', hmTxt(w.extra)]) },
      acciones: [{ label: 'Ver registro de jornada', href: `#/jornada?desde=${p.desde}&hasta=${p.hasta}` }] });
  }
  // ---- no han checado hoy
  if (/no ha(n)? (checado|llegado)|sin checar|faltan por llegar|quien(es)? no (vino|vinieron|llego|llegaron)/.test(q) && !per) {
    const f = datos.dias({ desde: hoy, hasta: hoy, empresa_id: empresaId }).filter((x) => !x.entrada && ['Falta', 'Pendiente'].includes(x.estado));
    return r(f.length ? `**${f.length}** personas no han checado hoy${empresaTxt}.` : `Todas las personas esperadas hoy${empresaTxt} ya checaron. ✅`,
      f.length ? { tabla: { columnas: ['No.', 'Nombre', 'Empresa', 'Estado'], filas: f.map((x) => [x.numero, x.nombre, x.empresa, x.estado === 'Pendiente' ? 'Aún en tolerancia' : 'Falta']) } } : {});
  }
  const p = per || { desde: hoy, hasta: hoy, txt: 'hoy' };
  const sufijo = `${p.txt}${empresaTxt}`;

  // ---- persona concreta
  if (persona && !/quien/.test(q)) {
    const pp = per || { desde: hoy.slice(0, 8) + '01', hasta: hoy, txt: 'este mes' };
    const t = datos.agrupado({ ...pp, agrupar: 'empleado', empleado_id: persona.id })[0];
    const d = datos.dias({ ...pp, empleado_id: persona.id }).filter((x) => !['Descanso', 'Pendiente', 'Sin historial'].includes(x.estado));
    if (!t || (!t.laborables && !t.asistencias)) return r(`No hay historial de ${persona.nombre} ${pp.txt}: no tiene checadas en ese periodo ni antes.`, { acciones: [{ label: 'Abrir ficha', emp: persona.id }] });
    const txt = `**${persona.nombre}** (No. ${persona.numero}${persona.puesto ? ', ' + persona.puesto : ''}) ${pp.txt}: ${pl(t.asistencias, 'asistencia', 'asistencias')}, ` +
      `**${pl(t.faltas, 'falta', 'faltas')}**, **${pl(t.retardos, 'retardo', 'retardos')}** (${t.min_retardo} min), ${hmTxt(t.horas)} trabajadas` +
      `${t.extra ? ` y ${hmTxt(t.extra)} extra` : ''}. Puntualidad: ${t.pct_puntualidad ?? '—'}%.`;
    return r(txt, { tabla: { columnas: ['Fecha', 'Entrada', 'Salida', 'Horas', 'Estado'], filas: d.slice(-15).map((x) => [fechaTxt(x.fecha), x.entrada || '—', x.salida || '—', x.horas ? hmTxt(x.horas) : '—', x.estado + (x.retardo_min ? ` (+${x.retardo_min} min)` : '')]) },
      acciones: [{ label: 'Abrir ficha', emp: persona.id }, { label: 'Registro de jornada', href: `#/jornada?empleado_id=${persona.id}&desde=${pp.desde}&hasta=${pp.hasta}` }],
      sugerencias: [`¿Cómo va ${persona.nombre} el mes pasado?`, `Retardos de ${persona.nombre} esta semana`, '¿Quién tiene más retardos este mes?'] });
  }
  // ---- ranking de retardos / faltas
  if (/(mas|mayor) (retardos|faltas|horas extra)|quien (llega|llego) mas tarde|ranking|top/.test(q)) {
    const metrica = /falta/.test(q) ? 'faltas' : /extra/.test(q) ? 'extra' : 'retardos';
    const pp = per || { desde: hoy.slice(0, 8) + '01', hasta: hoy, txt: 'este mes' };
    const rows = datos.agrupado({ ...pp, agrupar: 'empleado', empresa_id: empresaId }).filter((x) => x[metrica] > 0).sort((a, b) => b[metrica] - a[metrica] || b.min_retardo - a.min_retardo).slice(0, 10);
    if (!rows.length) return r(`Nadie tiene ${metrica === 'extra' ? 'horas extra' : metrica} ${pp.txt}${empresaTxt}. 🎉`);
    const nom = { retardos: 'retardos', faltas: 'faltas', extra: 'horas extra' }[metrica];
    return r(`Las personas con más ${nom} ${pp.txt}${empresaTxt}:`, {
      tabla: { columnas: ['Nombre', metrica === 'extra' ? 'Horas extra' : nom[0].toUpperCase() + nom.slice(1), metrica === 'retardos' ? 'Minutos' : 'Asistencias'],
        filas: rows.map((x) => [x.grupo, metrica === 'extra' ? hmTxt(x.extra) : x[metrica], metrica === 'retardos' ? x.min_retardo : x.asistencias]) },
      acciones: [{ label: 'Abrir en Reportes', href: '#/reportes' }] });
  }
  // ---- faltas
  if (/falt|ausen|no vino|no vinieron/.test(q)) {
    const f = datos.dias({ ...p, empresa_id: empresaId, estado: 'Falta' });
    return r(f.length ? `**${f.length}** falta${f.length > 1 ? 's' : ''} ${sufijo}.` : `Nadie faltó ${sufijo}. ✅`,
      f.length ? { tabla: { columnas: ['Fecha', 'No.', 'Nombre', 'Empresa'], filas: f.map((x) => [fechaTxt(x.fecha), x.numero, x.nombre, x.empresa]) } } : {});
  }
  // ---- retardos
  if (/retard|tarde/.test(q)) {
    const f = datos.dias({ ...p, empresa_id: empresaId, estado: 'Retardo' }).sort((a, b) => b.retardo_min - a.retardo_min);
    const tot = f.reduce((a, x) => a + x.retardo_min, 0);
    return r(f.length ? `**${f.length}** retardo${f.length > 1 ? 's' : ''} ${sufijo}, ${tot} minutos en total.` : `No hubo retardos ${sufijo}. ✅`,
      f.length ? { tabla: { columnas: ['Fecha', 'Nombre', 'Entrada', 'Minutos tarde'], filas: f.map((x) => [fechaTxt(x.fecha), x.nombre, x.entrada, '+' + x.retardo_min]) } } : {});
  }
  // ---- horas extra / horas
  if (/hora/.test(q)) {
    const pp = per || { desde: lunesDe(hoy), hasta: hoy, txt: 'esta semana' };
    const rows = datos.agrupado({ ...pp, agrupar: 'empleado', empresa_id: empresaId });
    if (/extra/.test(q)) {
      const x = rows.filter((y) => y.extra > 0).sort((a, b) => b.extra - a.extra);
      const tot = x.reduce((a, y) => a + y.extra, 0);
      return r(x.length ? `${hmTxt(tot)} extra en total ${pp.txt}${empresaTxt}, de ${x.length} personas.` : `No hubo horas extra ${pp.txt}${empresaTxt}.`,
        x.length ? { tabla: { columnas: ['Nombre', 'Horas extra', 'Horas efectivas'], filas: x.slice(0, 30).map((y) => [y.grupo, hmTxt(y.extra), hmTxt(y.horas)]) } } : {});
    }
    const tot = rows.reduce((a, y) => a + y.horas, 0);
    return r(`${hmTxt(tot)} trabajadas ${pp.txt}${empresaTxt} entre ${rows.filter((y) => y.horas > 0).length} personas.`, {
      tabla: { columnas: ['Nombre', 'Horas efectivas', 'Asistencias'], filas: rows.sort((a, b) => b.horas - a.horas).slice(0, 30).map((y) => [y.grupo, hmTxt(y.horas), y.asistencias]) } });
  }
  // ---- sin salida
  if (/sin salida|no (checo|checaron) (su )?salida/.test(q)) {
    const pp = per || { desde: addDays(hoy, -7), hasta: addDays(hoy, -1), txt: 'los últimos 7 días' };
    const f = datos.dias({ ...pp, empresa_id: empresaId }).filter((x) => x.incidencias.includes('Sin registro de salida'));
    return r(f.length ? `${f.length} días sin registro de salida ${pp.txt}.` : `Todos registraron su salida ${pp.txt}. ✅`,
      f.length ? { tabla: { columnas: ['Fecha', 'Nombre', 'Entrada'], filas: f.map((x) => [fechaTxt(x.fecha), x.nombre, x.entrada]) }, acciones: [{ label: 'Capturar registro manual', href: '#/registros' }] } : {});
  }
  // ---- presentes / resumen
  if (/present|vino|vinieron|asist|llegaron|resumen|como (vamos|estamos|va el dia)|hoy/.test(q) || per) {
    const s = datos.resumen_periodo({ ...p, empresa_id: empresaId });
    const esperados = s.total - s.descanso;
    return r(`Resumen ${sufijo}: **${s.presentes}** asistencias de ${esperados} esperadas, **${s.retardos}** retardos, **${s.faltas}** faltas` +
      `${s.pendientes ? ` y ${s.pendientes} aún en tolerancia` : ''}${s.fuera_geocerca ? `; ${s.fuera_geocerca} registros fuera de geocerca` : ''}.`,
      { sugerencias: [`¿Quién faltó ${p.txt}?`, `¿Quién llegó tarde ${p.txt}?`, 'Horas extra de esta semana', 'Huellas pendientes'] });
  }
  return r('Puedo responder sobre asistencias, faltas, retardos, horas trabajadas y extra, salidas sin registrar, huellas pendientes, el límite legal de horas y el resumen de cualquier persona. Prueba con alguna de estas preguntas:',
    { sugerencias: SUGERENCIAS });
}

/** Hallazgos del día para la tarjeta "Resumen IA" del tablero (motor local). */
function hallazgos({ empresaForzada } = {}) {
  const hoy = nowLocal().slice(0, 10);
  const t = tendencia({ dias: 14, empresa_id: empresaForzada });
  const out = [];
  const dHoy = t.dias[t.dias.length - 1];
  const laborables = t.dias.slice(0, -1).filter((d) => d.a_tiempo + d.retardo + d.falta > 0);
  const prom = (k) => laborables.length ? laborables.reduce((a, d) => a + d[k], 0) / laborables.length : 0;
  if (dHoy && laborables.length) {
    const pr = prom('retardo');
    if (dHoy.retardo > pr * 1.5 && dHoy.retardo >= 3) out.push({ tipo: 'warn', texto: `Hoy hay ${dHoy.retardo} retardos, más que el promedio de ${pr.toFixed(1)} de los últimos días.` });
    else if (dHoy.retardo + dHoy.a_tiempo > 0) out.push({ tipo: 'ok', texto: `Puntualidad de hoy: ${Math.round((dHoy.a_tiempo / Math.max(1, dHoy.a_tiempo + dHoy.retardo)) * 100)}% (promedio reciente ${Math.round((prom('a_tiempo') / Math.max(1, prom('a_tiempo') + prom('retardo'))) * 100)}%).` });
  }
  // rachas de retardos
  const ult = calcularAsistencia({ desde: addDays(hoy, -10), hasta: hoy, empresa_id: empresaForzada });
  const porEmp = new Map();
  for (const f of ult) { if (!porEmp.has(f.empleado_id)) porEmp.set(f.empleado_id, []); porEmp.get(f.empleado_id).push(f); }
  for (const fs of porEmp.values()) {
    let racha = 0;
    for (const f of [...fs].reverse()) { if (['Descanso', 'Pendiente', 'Sin historial'].includes(f.estado)) continue; if (f.estado === 'Retardo') racha++; else break; }
    if (racha >= 3) out.push({ tipo: 'warn', texto: `${fs[0].nombre} lleva ${racha} retardos seguidos.`, emp: fs[0].empleado_id });
  }
  const top = t.top_retardos[0];
  if (top && top.retardos >= 4) out.push({ tipo: 'info', texto: `${top.nombre} acumula ${top.retardos} retardos (${top.minutos} min) en 14 días.`, emp: top.empleado_id });
  const sem = registroJornada({ desde: lunesDe(hoy), hasta: hoy, empresa_id: empresaForzada }).semanas.filter((w) => w.horas > w.limite * 0.9);
  if (sem.length) out.push({ tipo: 'warn', texto: `${sem.length} persona(s) se acercan a la jornada máxima semanal (${sem[0].limite} h).` });
  const pend = datos.huellas_pendientes(empresaForzada).filter((x) => x.estado === 'pendiente').length;
  if (pend) out.push({ tipo: 'info', texto: `${pend} persona(s) con huella pendiente de registrar.`, href: '#/huellas' });
  if (!out.length) out.push({ tipo: 'ok', texto: 'Sin novedades: la asistencia va dentro de lo normal.' });
  return out.slice(0, 5);
}

// ====================== Motor Claude ======================
function configIA() {
  return { activo: getAjuste('ia_activo') === '1', tiene_api_key: !!getAjuste('ia_api_key'), modelo: getAjuste('ia_modelo') || 'claude-opus-5-5' };
}
function setConfigIA(b, usuario) {
  if ('activo' in b) setAjuste('ia_activo', b.activo ? '1' : '0');
  if (b.modelo) setAjuste('ia_modelo', String(b.modelo).trim());
  if (b.api_key) setAjuste('ia_api_key', String(b.api_key).trim());
  if (b.borrar_api_key) setAjuste('ia_api_key', null);
  bitacora(usuario, 'Configuración de IA', 'ia', null, { activo: b.activo, modelo: b.modelo, api_key_cambiada: !!b.api_key || !!b.borrar_api_key });
  return configIA();
}

const SISTEMA = `Eres el asistente de control de asistencia de Grupo Proceso Seguro (México). Respondes en español, de forma breve y clara, a personal de Recursos Humanos.
Usa SIEMPRE las herramientas para obtener datos; nunca inventes nombres, cifras ni fechas. Si una pregunta es ambigua (por ejemplo, hay varias personas con el mismo nombre), dilo y pide que precise.
Las fechas van en formato YYYY-MM-DD y la zona horaria es la de la Ciudad de México. Las horas efectivas excluyen el tiempo de comida. La jornada máxima semanal legal es 48 h en 2026, 46 h en 2027, 44 h en 2028, 42 h en 2029 y 40 h desde 2030.
Cuando listes varias personas o días, usa una tabla en Markdown. No des consejos legales definitivos; sugiere revisar con el área legal cuando aplique.`;

async function responderClaude(pregunta, historial, { empresaForzada } = {}) {
  const Anthropic = (() => { const m = require('@anthropic-ai/sdk'); return m.default || m; })();
  const { betaTool } = require('@anthropic-ai/sdk/helpers/beta/json-schema');
  const cfg = configIA();
  const client = new Anthropic({ apiKey: getAjuste('ia_api_key'), timeout: 120000, maxRetries: 2 });
  const fecha = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Fecha YYYY-MM-DD' };
  const emp = (id) => (empresaForzada || id || null);
  const json = (x) => JSON.stringify(x);
  const usadas = [];
  const herramienta = (def) => betaTool({ ...def, strict: true, run: async (input) => { usadas.push(def.name); try { return json(await def.run2(input)); } catch (e) { return json({ error: e.message }); } } });
  const tools = [
    herramienta({ name: 'buscar_empleado', description: 'Busca empleados activos por nombre o número (tolera acentos y nombres incompletos). Devuelve id, número, nombre, puesto y empresa.',
      inputSchema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'], additionalProperties: false },
      run2: ({ texto }) => buscarEmpleados(texto, empresaForzada).map(({ score, ...e }) => e) }),
    herramienta({ name: 'listar_empresas', description: 'Lista las empresas con su id.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run2: () => empresas() }),
    herramienta({ name: 'resumen_periodo', description: 'Totales de un periodo: asistencias, a tiempo, retardos, faltas, pendientes, sin salida y fuera de geocerca.',
      inputSchema: { type: 'object', properties: { desde: fecha, hasta: fecha, empresa_id: { type: ['integer', 'null'] } }, required: ['desde', 'hasta', 'empresa_id'], additionalProperties: false },
      run2: (i) => datos.resumen_periodo({ ...i, empresa_id: emp(i.empresa_id) }) }),
    herramienta({ name: 'dias_por_empleado', description: 'Detalle por día y empleado: entrada, salida, horas efectivas, horas extra, minutos de retardo, estado (A tiempo, Retardo, Falta, Descanso, Pendiente, Día no laborable) e incidencias. Filtra por estado y/o empleado. Máximo 200 filas.',
      inputSchema: { type: 'object', properties: { desde: fecha, hasta: fecha, empresa_id: { type: ['integer', 'null'] }, empleado_id: { type: ['integer', 'null'] }, estado: { type: ['string', 'null'], enum: ['A tiempo', 'Retardo', 'Falta', 'Descanso', 'Pendiente', 'Día no laborable', null] } }, required: ['desde', 'hasta', 'empresa_id', 'empleado_id', 'estado'], additionalProperties: false },
      run2: (i) => datos.dias({ ...i, empresa_id: emp(i.empresa_id) }) }),
    herramienta({ name: 'reporte_agrupado', description: 'Métricas agregadas por empleado, empresa, sede, puesto, tipo, día, semana, mes o día de la semana: días laborables, asistencias, faltas, retardos, minutos de retardo, horas, horas extra, % asistencia, % puntualidad, sin salida, fuera de geocerca, registros manuales.',
      inputSchema: { type: 'object', properties: { desde: fecha, hasta: fecha, agrupar: { type: 'string', enum: ['empleado', 'empresa', 'sede', 'puesto', 'tipo', 'dia', 'semana', 'mes', 'dia_semana'] }, empresa_id: { type: ['integer', 'null'] }, empleado_id: { type: ['integer', 'null'] } }, required: ['desde', 'hasta', 'agrupar', 'empresa_id', 'empleado_id'], additionalProperties: false },
      run2: (i) => datos.agrupado({ ...i, empresa_id: emp(i.empresa_id) }) }),
    herramienta({ name: 'jornada_semanal', description: 'Horas efectivas por empleado y semana contra la jornada máxima legal, horas extra y si el trabajador confirmó su registro.',
      inputSchema: { type: 'object', properties: { desde: fecha, hasta: fecha, empresa_id: { type: ['integer', 'null'] }, empleado_id: { type: ['integer', 'null'] } }, required: ['desde', 'hasta', 'empresa_id', 'empleado_id'], additionalProperties: false },
      run2: (i) => datos.semanas({ ...i, empresa_id: emp(i.empresa_id) }) }),
    herramienta({ name: 'huellas_pendientes', description: 'Personas sin huella registrada en los checadores (pendiente, sin huella o sin alta).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run2: () => datos.huellas_pendientes(empresaForzada) }),
  ];
  const mensajes = [];
  for (const h of (historial || []).slice(-6)) if (h && typeof h.texto === 'string' && ['user', 'assistant'].includes(h.rol)) mensajes.push({ role: h.rol, content: h.texto.slice(0, 4000) });
  mensajes.push({ role: 'user', content: `Hoy es ${nowLocal()}.\n\n${pregunta}` });
  const params = {
    model: cfg.modelo, max_tokens: 16000, system: SISTEMA, tools, messages: mensajes,
    output_config: { effort: 'medium' }, max_iterations: 8,
  };
  let final;
  try {
    // Fallback del lado del servidor si el modelo declina por política (se recomienda activarlo por defecto)
    final = await client.beta.messages.toolRunner({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }).runUntilDone();
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError && /fallback/i.test(String(e.message))) final = await client.beta.messages.toolRunner(params).runUntilDone();
    else throw e;
  }
  if (final.stop_reason === 'refusal') return { motor: 'claude', texto: 'El modelo no pudo responder esta pregunta. Intenta formularla de otra manera.', sugerencias: SUGERENCIAS.slice(0, 4) };
  const texto = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { motor: 'claude', modelo: final.model, texto: texto || 'Sin respuesta.', herramientas: [...new Set(usadas)], sugerencias: [] };
}

async function responder(pregunta, historial, opts = {}) {
  pregunta = String(pregunta || '').trim().slice(0, 1000);
  if (!pregunta) return { motor: 'local', texto: '¿En qué te ayudo?', sugerencias: SUGERENCIAS };
  const cfg = configIA();
  if (opts.motor !== 'local' && cfg.activo && cfg.tiene_api_key) {
    try { return await responderClaude(pregunta, historial, opts); }
    catch (e) {
      const Anthropic = (() => { const m = require('@anthropic-ai/sdk'); return m.default || m; })();
      const motivo = e instanceof Anthropic.AuthenticationError ? 'la API key de Anthropic no es válida'
        : e instanceof Anthropic.RateLimitError ? 'se alcanzó el límite de uso de la API'
        : e instanceof Anthropic.APIConnectionError ? 'no hay conexión con Anthropic' : (e.message || 'error desconocido');
      const r = responderLocal(pregunta, opts);
      return { ...r, aviso: `Claude no está disponible (${motivo}); respondió el motor local.` };
    }
  }
  return responderLocal(pregunta, opts);
}

module.exports = { responder, responderLocal, hallazgos, configIA, setConfigIA, buscarEmpleados, SUGERENCIAS };
