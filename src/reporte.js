'use strict';
const { db } = require('./db');
const { nowLocal } = require('./util');

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const minOf = (fh) => toMin(fh.slice(11, 16)) + Number(fh.slice(17, 19) || 0) / 60;
function addDays(d, n) {
  const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/**
 * Arma los pares entrada/salida de un día. Ignora checadas dobles (menos de 2 min de diferencia).
 * Si todas las checadas traen tipo, se respeta; si no, se alternan entrada, salida, entrada, salida...
 */
function jornadaDelDia(punches) {
  const p = [];
  for (const x of punches) if (!p.length || minOf(x.fecha_hora) - minOf(p[p.length - 1].fecha_hora) >= 2) p.push(x);
  const explicito = p.length > 0 && p.every((x) => x.tipo === 'entrada' || x.tipo === 'salida');
  const pares = []; let abierto = null;
  for (const x of p) {
    const entrada = explicito ? x.tipo === 'entrada' : abierto === null;
    if (entrada) { if (abierto) pares.push({ entrada: abierto, salida: null }); abierto = x; }
    else if (abierto) { pares.push({ entrada: abierto, salida: x }); abierto = null; }
    else pares.push({ entrada: null, salida: x });
  }
  if (abierto) pares.push({ entrada: abierto, salida: null });
  let efectivos = 0, descanso = 0, prevSalida = null;
  for (const par of pares) {
    if (par.entrada && par.salida) {
      efectivos += minOf(par.salida.fecha_hora) - minOf(par.entrada.fecha_hora);
      if (prevSalida) descanso += Math.max(0, minOf(par.entrada.fecha_hora) - minOf(prevSalida.fecha_hora));
      prevSalida = par.salida;
    }
  }
  const incompleto = pares.some((x) => !x.entrada || !x.salida);
  return { checadas: p, pares, efectivos_min: Math.round(efectivos), descanso_min: Math.round(descanso), incompleto };
}

/** Jornada máxima semanal (LFT, reducción gradual): 48 h en 2026, 46 en 2027, 44 en 2028, 42 en 2029, 40 desde 2030. */
function limiteSemanal(fecha) {
  const conf = db.prepare("SELECT valor FROM ajustes WHERE clave = 'jornada_max_semanal'").get()?.valor;
  if (conf && Number(conf) > 0) return Number(conf);
  const y = Number(String(fecha).slice(0, 4));
  return y <= 2026 ? 48 : y === 2027 ? 46 : y === 2028 ? 44 : y === 2029 ? 42 : 40;
}
const lunesDe = (d) => { const x = new Date(d + 'T12:00:00Z'); const dow = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dow); return x.toISOString().slice(0, 10); };

/**
 * Calcula la asistencia por empleado y día.
 * Reglas: entrada = primer registro (o primer "entrada" explícita); salida = último registro (o última "salida").
 * Retardo cuando la entrada es posterior a hora de entrada + tolerancia.
 */
function calcularAsistencia({ desde, hasta, empresa_id, sede_id, empleado_id, tipo, incluirArchivo = false, todos = false }) {
  const where = [todos ? '1 = 1' : 'e.activo = 1'];
  const params = [];
  if (empresa_id) { where.push('e.empresa_id = ?'); params.push(Number(empresa_id)); }
  if (sede_id) { where.push('e.sede_id = ?'); params.push(Number(sede_id)); }
  if (empleado_id) { where.push('e.id = ?'); params.push(Number(empleado_id)); }
  if (tipo) { where.push('e.tipo = ?'); params.push(tipo); }
  const empleados = db.prepare(`
    SELECT e.*, em.nombre empresa, s.nombre sede, h.nombre horario, h.entrada h_entrada, h.salida h_salida,
           h.tolerancia_min, h.dias
    FROM empleados e
    LEFT JOIN empresas em ON em.id = e.empresa_id
    LEFT JOIN sedes s ON s.id = e.sede_id
    LEFT JOIN horarios h ON h.id = e.horario_id
    WHERE ${where.join(' AND ')} ORDER BY e.nombre`).all(...params);

  const rango = [desde + ' 00:00:00', addDays(hasta, 1) + ' 00:00:00'];
  const cols = 'empleado_numero, fecha_hora, tipo, origen, dentro_geocerca, creado_por';
  const regs = db.prepare(`
    SELECT ${cols} FROM registros WHERE anulado = 0 AND fecha_hora >= ? AND fecha_hora < ?
    ${incluirArchivo ? `UNION SELECT ${cols} FROM registros_archivo WHERE anulado = 0 AND fecha_hora >= ? AND fecha_hora < ?` : ''}
    ORDER BY fecha_hora`).all(...rango, ...(incluirArchivo ? rango : []));
  // Primera checada de cada persona: antes de ella no se cuentan faltas (aún no trabajaba o no había historial)
  const primera = new Map(db.prepare(`SELECT empleado_numero n, MIN(fecha_hora) f FROM (
      SELECT empleado_numero, fecha_hora FROM registros WHERE anulado = 0
      UNION ALL SELECT empleado_numero, fecha_hora FROM registros_archivo WHERE anulado = 0) GROUP BY empleado_numero`).all().map((r) => [r.n, r.f.slice(0, 10)]));
  const porEmpDia = new Map();
  for (const r of regs) {
    const k = r.empleado_numero + '|' + r.fecha_hora.slice(0, 10);
    if (!porEmpDia.has(k)) porEmpDia.set(k, []);
    porEmpDia.get(k).push(r);
  }

  const hoy = nowLocal().slice(0, 10);
  const filas = [];
  for (let d = desde; d <= hasta; d = addDays(d, 1)) {
    const dow = new Date(d + 'T12:00:00Z').getUTCDay();
    for (const e of empleados) {
      const punches = porEmpDia.get(e.numero + '|' + d) || [];
      const laborable = !!e.h_entrada && String(e.dias || '').split(',').map(Number).includes(dow);
      const fila = {
        fecha: d, empleado_id: e.id, numero: e.numero, nombre: e.nombre, empresa: e.empresa, sede: e.sede,
        tipo_empleado: e.tipo, horario: e.h_entrada ? `${e.h_entrada}-${e.h_salida}` : '',
        entrada: '', salida: '', horas: '', retardo_min: 0, registros: punches.length,
        origen: [...new Set(punches.map((p) => p.origen))].join(', '),
        fuera_geocerca: punches.some((p) => p.dentro_geocerca === 0), estado: '', incidencias: [],
        puesto: e.puesto, curp: e.curp, rfc: e.rfc, nss: e.nss, empresa_id: e.empresa_id,
        descanso_min: 0, efectivas: '', extra: 0, manuales: punches.filter((p) => p.origen === 'manual').length, pares: [],
      };
      if (!punches.length) {
        const p1 = primera.get(e.numero);
        if (!p1) fila.estado = 'Sin registros';            // nunca ha checado: no se cuenta como falta
        else if (d < p1) fila.estado = 'Sin historial';
        else if (!laborable) fila.estado = 'Descanso';
        else if (d > hoy) fila.estado = 'Pendiente';
        else if (d === hoy && minOf(nowLocal()) < toMin(e.h_entrada) + e.tolerancia_min) fila.estado = 'Pendiente';
        else fila.estado = 'Falta';
        filas.push(fila);
        continue;
      }
      const ent = punches.find((p) => p.tipo === 'entrada') || punches[0];
      const sal = [...punches].reverse().find((p) => p.tipo === 'salida') || (punches.length > 1 ? punches[punches.length - 1] : null);
      fila.entrada = ent.fecha_hora.slice(11, 16);
      if (sal && sal.fecha_hora > ent.fecha_hora) {
        fila.salida = sal.fecha_hora.slice(11, 16);
        fila.horas = ((minOf(sal.fecha_hora) - minOf(ent.fecha_hora)) / 60).toFixed(2);
      }
      const j = jornadaDelDia(punches);
      fila.pares = j.pares.map((x) => [x.entrada?.fecha_hora.slice(11, 16) || null, x.salida?.fecha_hora.slice(11, 16) || null]);
      fila.descanso_min = j.descanso_min;
      if (j.efectivos_min > 0) fila.efectivas = (j.efectivos_min / 60).toFixed(2);
      else if (fila.horas) fila.efectivas = fila.horas;
      const pactada = e.h_entrada ? (toMin(e.h_salida) - toMin(e.h_entrada)) / 60 : null;
      const ef = Number(fila.efectivas || 0);
      fila.extra = Number((laborable ? (pactada != null ? Math.max(0, ef - pactada) : 0) : ef).toFixed(2));
      if (j.incompleto && punches.length > 1 && j.pares.length > 1) fila.incidencias.push('Checadas incompletas');
      if (fila.manuales) fila.incidencias.push(`${fila.manuales} registro(s) manual(es)`);
      if (!laborable) {
        fila.estado = 'Día no laborable';
      } else {
        const limite = toMin(e.h_entrada) + Number(e.tolerancia_min || 0);
        const llegada = minOf(ent.fecha_hora);
        if (llegada > limite) {
          fila.retardo_min = Math.round(llegada - toMin(e.h_entrada));
          fila.estado = 'Retardo';
        } else fila.estado = 'A tiempo';
        if (fila.salida && minOf(sal.fecha_hora) < toMin(e.h_salida)) fila.incidencias.push('Salida anticipada');
        if (!fila.salida && d < hoy) fila.incidencias.push('Sin registro de salida');
      }
      if (fila.fuera_geocerca) fila.incidencias.push('Registro fuera de geocerca');
      filas.push(fila);
    }
  }
  return filas;
}

function resumen(filas) {
  const r = { total: filas.length, a_tiempo: 0, retardos: 0, faltas: 0, descanso: 0, pendientes: 0, fuera_geocerca: 0, sin_salida: 0 };
  for (const f of filas) {
    if (f.estado === 'A tiempo') r.a_tiempo++;
    else if (f.estado === 'Retardo') r.retardos++;
    else if (f.estado === 'Falta') r.faltas++;
    else if (f.estado === 'Descanso') r.descanso++;
    else if (f.estado === 'Pendiente') r.pendientes++;
    else if (f.estado === 'Sin registros' || f.estado === 'Sin historial') r.sin_registros = (r.sin_registros || 0) + 1;
    if (f.fuera_geocerca) r.fuera_geocerca++;
    if (f.incidencias.includes('Sin registro de salida')) r.sin_salida++;
  }
  return r;
}

const MEDIO = { zkteco: 'Biométrico', hikvision: 'Biométrico', campo: 'Móvil con GPS', manual: 'Captura manual', importacion: 'Importado' };

/**
 * Registro de jornada (formato para consulta de la autoridad): días con inicio, fin, descansos, horas efectivas,
 * horas extra y medio de registro; y por semana, horas contra el límite legal y la conformidad del trabajador.
 */
function registroJornada({ desde, hasta, empresa_id, empleado_id }) {
  const filas = calcularAsistencia({ desde, hasta, empresa_id, empleado_id, incluirArchivo: true, todos: true })
    .filter((f) => f.registros > 0 || f.estado === 'Falta');
  const conf = new Map(db.prepare('SELECT empleado_id, semana, fecha FROM conformidades').all().map((c) => [c.empleado_id + '|' + c.semana, c.fecha]));
  const dias = filas.map((f) => ({
    ...f, medio: [...new Set(f.origen.split(', ').filter(Boolean).map((o) => MEDIO[o] || o))].join(', '),
    semana: lunesDe(f.fecha),
  }));
  const semanas = new Map();
  for (const d of dias) {
    const k = d.empleado_id + '|' + d.semana;
    if (!semanas.has(k)) semanas.set(k, { empleado_id: d.empleado_id, numero: d.numero, nombre: d.nombre, empresa: d.empresa, semana: d.semana, dias: 0, horas: 0, extra: 0, limite: limiteSemanal(d.semana) });
    const w = semanas.get(k);
    if (d.entrada) w.dias++;
    w.horas += Number(d.efectivas || 0); w.extra += Number(d.extra || 0);
  }
  const resumenSemanas = [...semanas.values()].map((w) => ({
    ...w, horas: Number(w.horas.toFixed(2)), extra: Number(w.extra.toFixed(2)),
    excede: w.horas > w.limite, conformidad: conf.get(w.empleado_id + '|' + w.semana) || null,
  }));
  const empresas = db.prepare('SELECT id, nombre, razon_social, rfc, registro_patronal FROM empresas').all();
  return { desde, hasta, dias, semanas: resumenSemanas, empresas };
}

// ---------------- Reportes personalizados ----------------
const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const AGRUPAR = {
  empleado: (f) => [f.empleado_id, `${f.nombre} (${f.numero})`],
  empresa: (f) => [f.empresa || 'Sin empresa', f.empresa || 'Sin empresa'],
  sede: (f) => [f.sede || 'Sin sede', f.sede || 'Sin sede'],
  puesto: (f) => [f.puesto || 'Sin puesto', f.puesto || 'Sin puesto'],
  tipo: (f) => [f.tipo_empleado, f.tipo_empleado],
  dia: (f) => [f.fecha, f.fecha],
  semana: (f) => [lunesDe(f.fecha), 'Semana del ' + lunesDe(f.fecha)],
  mes: (f) => [f.fecha.slice(0, 7), f.fecha.slice(0, 7)],
  dia_semana: (f) => { const d = new Date(f.fecha + 'T12:00:00Z').getUTCDay(); return [(d + 6) % 7, DIAS_SEMANA[d]]; },
};
const METRICAS = {
  laborables: 'Días laborables', asistencias: 'Asistencias', faltas: 'Faltas', retardos: 'Retardos', min_retardo: 'Minutos de retardo',
  horas: 'Horas efectivas', extra: 'Horas extra', pct_asistencia: '% asistencia', pct_puntualidad: '% puntualidad',
  sin_salida: 'Sin registro de salida', fuera_geocerca: 'Fuera de geocerca', manuales: 'Registros manuales', personas: 'Personas',
};
function reportePersonalizado({ desde, hasta, agrupar = 'empleado', empresa_id, sede_id, tipo, estado, empleado_id }) {
  const key = AGRUPAR[agrupar] || AGRUPAR.empleado;
  let filas = calcularAsistencia({ desde, hasta, empresa_id, sede_id, tipo, empleado_id });
  if (estado) filas = filas.filter((f) => f.estado === estado);
  const grupos = new Map();
  for (const f of filas) {
    const [k, etiqueta] = key(f);
    if (!grupos.has(k)) grupos.set(k, { clave: k, grupo: etiqueta, laborables: 0, asistencias: 0, asist_lab: 0, faltas: 0, retardos: 0, a_tiempo: 0, min_retardo: 0, horas: 0, extra: 0, sin_salida: 0, fuera_geocerca: 0, manuales: 0, _p: new Set() });
    const g = grupos.get(k);
    const lab = ['A tiempo', 'Retardo', 'Falta'].includes(f.estado);
    g._p.add(f.empleado_id);
    if (lab) g.laborables++;
    if (f.entrada) { g.asistencias++; if (lab) g.asist_lab++; }
    if (f.estado === 'Falta') g.faltas++;
    if (f.estado === 'Retardo') { g.retardos++; g.min_retardo += f.retardo_min; }
    if (f.estado === 'A tiempo') g.a_tiempo++;
    g.horas += Number(f.efectivas || 0); g.extra += Number(f.extra || 0);
    if (f.incidencias.includes('Sin registro de salida')) g.sin_salida++;
    if (f.fuera_geocerca) g.fuera_geocerca++;
    g.manuales += f.manuales || 0;
  }
  const rows = [...grupos.values()].map((g) => ({
    clave: g.clave, grupo: g.grupo, laborables: g.laborables, asistencias: g.asistencias, faltas: g.faltas, retardos: g.retardos, min_retardo: g.min_retardo,
    horas: Number(g.horas.toFixed(2)), extra: Number(g.extra.toFixed(2)),
    pct_asistencia: g.laborables ? Number(((g.asist_lab / g.laborables) * 100).toFixed(1)) : null,
    pct_puntualidad: g.asist_lab ? Number(((g.a_tiempo / g.asist_lab) * 100).toFixed(1)) : null,
    sin_salida: g.sin_salida, fuera_geocerca: g.fuera_geocerca, manuales: g.manuales, personas: g._p.size,
  }));
  return { desde, hasta, agrupar, metricas: METRICAS, rows };
}

/** Tendencia para el tablero: estados por día, horas de llegada y retardos acumulados. */
function tendencia({ dias = 14, empresa_id }) {
  const hoy = require('./util').nowLocal().slice(0, 10);
  const desde = addDays(hoy, -(dias - 1));
  const filas = calcularAsistencia({ desde, hasta: hoy, empresa_id });
  const porDia = new Map();
  for (let d = desde; d <= hoy; d = addDays(d, 1)) porDia.set(d, { fecha: d, a_tiempo: 0, retardo: 0, falta: 0 });
  const llegadas = new Map(); const ret = new Map();
  for (const f of filas) {
    const x = porDia.get(f.fecha);
    if (f.estado === 'A tiempo') x.a_tiempo++; else if (f.estado === 'Retardo') x.retardo++; else if (f.estado === 'Falta') x.falta++;
    if (f.entrada) { const m = toMin(f.entrada); const b = Math.floor(m / 15) * 15; llegadas.set(b, (llegadas.get(b) || 0) + 1); }
    if (f.estado === 'Retardo') { const r = ret.get(f.empleado_id) || { nombre: f.nombre, numero: f.numero, empleado_id: f.empleado_id, retardos: 0, minutos: 0 }; r.retardos++; r.minutos += f.retardo_min; ret.set(f.empleado_id, r); }
  }
  const bins = [...llegadas.keys()].sort((a, b) => a - b);
  const hist = [];
  if (bins.length) for (let b = Math.max(bins[0], 5 * 60); b <= Math.min(bins[bins.length - 1], 13 * 60); b += 15) hist.push({ desde: `${String(Math.floor(b / 60)).padStart(2, '0')}:${String(b % 60).padStart(2, '0')}`, n: llegadas.get(b) || 0 });
  return { desde, hasta: hoy, dias: [...porDia.values()], llegadas: hist, top_retardos: [...ret.values()].sort((a, b) => b.retardos - a.retardos || b.minutos - a.minutos).slice(0, 8) };
}

module.exports = { calcularAsistencia, resumen, addDays, jornadaDelDia, limiteSemanal, lunesDe, registroJornada, reportePersonalizado, tendencia, METRICAS };
