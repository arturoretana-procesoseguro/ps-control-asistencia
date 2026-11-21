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
        if (!laborable) fila.estado = 'Descanso';
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

module.exports = { calcularAsistencia, resumen, addDays, jornadaDelDia, limiteSemanal, lunesDe, registroJornada };
