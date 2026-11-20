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
 * Calcula la asistencia por empleado y día.
 * Reglas: entrada = primer registro (o primer "entrada" explícita); salida = último registro (o última "salida").
 * Retardo cuando la entrada es posterior a hora de entrada + tolerancia.
 */
function calcularAsistencia({ desde, hasta, empresa_id, sede_id, empleado_id, tipo }) {
  const where = ['e.activo = 1'];
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

  const regs = db.prepare(`
    SELECT empleado_numero, fecha_hora, tipo, origen, dentro_geocerca
    FROM registros WHERE fecha_hora >= ? AND fecha_hora < ? ORDER BY fecha_hora`)
    .all(desde + ' 00:00:00', addDays(hasta, 1) + ' 00:00:00');
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

module.exports = { calcularAsistencia, resumen, addDays };
