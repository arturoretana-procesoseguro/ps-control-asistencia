'use strict';
/**
 * Depuración: deja sólo a los empleados activos y descarta checadas viejas.
 *  - Se conservan: empleados vinculados con Odoo y activos.
 *  - Se eliminan: archivados en Odoo, duplicados de 12 dígitos, y los que no están en Odoo y no checan desde hace N días.
 *  - A revisar (no se tocan): no están en Odoo pero sí checaron en los últimos N días.
 *  - Checadas anteriores a la fecha elegida se borran y ya no se aceptan al recibirlas.
 * En los checadores ZKTeco con lectura directa también se borran esos usuarios (nunca los administradores del equipo).
 */
const path = require('node:path');
const fs = require('node:fs');
const { db, DATA_DIR } = require('./db');
const { nowLocal } = require('./util');
const { addDays } = require('./reporte');
const { leerUsuarios, borrarUsuarios, vaciarChecadas, explicarError } = require('./zk-pull');
const zkSync = require('./zk-sync');

const getAjuste = (k) => db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(k)?.valor ?? null;
const setAjuste = (k, v) => db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').run(k, v);
const clave = (n) => String(n ?? '').trim().replace(/^0+(?=\d)/, '').toUpperCase();

function ultimaChecada() {
  return new Map(db.prepare('SELECT empleado_numero n, MAX(fecha_hora) u FROM registros GROUP BY empleado_numero').all().map((r) => [clave(r.n), r.u]));
}

async function vistaPrevia({ dias = 30, desde, leerChecadores = true } = {}) {
  if (!getAjuste('odoo_ultima_sync')) throw new Error('Primero sincroniza con Odoo: la depuración usa a Odoo para saber quién está activo.');
  dias = Math.max(1, Number(dias) || 30);
  const hoy = nowLocal().slice(0, 10);
  const limite = addDays(hoy, -dias);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '')) desde = hoy.slice(0, 8) + '01';
  const ult = ultimaChecada();

  const conservar = [], eliminar = [], revisar = [];
  for (const e of db.prepare('SELECT id, numero, nombre, odoo_id, activo FROM empleados ORDER BY nombre').all()) {
    const u = ult.get(clave(e.numero)) || null;
    const x = { id: e.id, numero: e.numero, nombre: e.nombre, ultima: u };
    if (e.odoo_id && e.activo) conservar.push(x);
    else if (e.odoo_id) eliminar.push({ ...x, motivo: 'Archivado en Odoo' });
    else if (e.numero.length > 9) eliminar.push({ ...x, motivo: 'Duplicado con número de más de 9 dígitos' });
    else if (u && u >= limite) revisar.push({ ...x, motivo: `No está en Odoo, pero checó el ${u.slice(0, 10)}` });
    else eliminar.push({ ...x, motivo: u ? `No está en Odoo y no checa desde ${u.slice(0, 10)}` : 'No está en Odoo y nunca ha checado' });
  }
  const numEliminar = new Set(eliminar.map((e) => clave(e.numero)));
  const numConocidos = new Set([...conservar, ...revisar, ...eliminar].map((e) => clave(e.numero)));

  const checadores = [];
  const devs = db.prepare("SELECT * FROM dispositivos WHERE marca='zkteco' AND estado='activo' AND ip_lectura IS NOT NULL AND ip_lectura <> ''").all();
  for (const d of devs) {
    if (!leerChecadores) { checadores.push({ id: d.id, dispositivo: d.nombre, omitido: true }); continue; }
    try {
      const us = await leerUsuarios(d.ip_lectura, d.puerto || 4370);
      const borrar = [], protegidos = [], revisarDev = [];
      for (const u of us) {
        const k = clave(u.numero);
        const ul = ult.get(k) || null;
        let quitar = numEliminar.has(k);
        if (!numConocidos.has(k)) { // está en el checador pero no en el sistema
          if (ul && ul >= limite) { revisarDev.push({ numero: u.numero, nombre: u.nombre, ultima: ul }); continue; }
          quitar = true;
        }
        if (!quitar) continue;
        (u.admin ? protegidos : borrar).push({ numero: u.numero, nombre: u.nombre, ultima: ul });
      }
      checadores.push({ id: d.id, dispositivo: d.nombre, usuarios: us.length, borrar, protegidos, revisar: revisarDev });
    } catch (e) {
      checadores.push({ id: d.id, dispositivo: d.nombre, error: explicarError(e) });
    }
  }
  const checadasViejas = db.prepare('SELECT COUNT(*) c FROM registros WHERE fecha_hora < ?').get(desde + ' 00:00:00').c;
  const checadasEliminados = eliminar.length
    ? db.prepare(`SELECT COUNT(*) c FROM registros WHERE fecha_hora >= ? AND empleado_numero IN (${eliminar.map(() => '?').join(',')})`).get(desde + ' 00:00:00', ...eliminar.map((e) => e.numero)).c
    : 0;
  return { dias, limite, desde, conservar: conservar.length, eliminar, revisar, checadores, checadas_viejas: checadasViejas, checadas_de_eliminados: checadasEliminados };
}

async function aplicar({ dias, desde, borrar_en_checador = true, vaciar_memoria = false }) {
  const p = await vistaPrevia({ dias, desde, leerChecadores: !!borrar_en_checador || !!vaciar_memoria });

  // 1. Respaldo de la base de datos
  const dir = path.join(DATA_DIR, 'respaldos');
  fs.mkdirSync(dir, { recursive: true });
  const respaldo = path.join(dir, `asistencia_antes_depurar_${nowLocal().replace(/[^0-9]/g, '').slice(0, 12)}.db`);
  db.exec(`VACUUM INTO '${respaldo.replace(/'/g, "''")}'`);

  // 2. Si se va a vaciar la memoria del checador, primero se leen sus últimas checadas
  const res = { respaldo, checadores: [] };
  if (vaciar_memoria) {
    for (const c of p.checadores.filter((x) => !x.error)) {
      const d = db.prepare('SELECT * FROM dispositivos WHERE id = ?').get(c.id);
      try { await zkSync.sincronizar(d); } catch (e) { c.error = 'No se vació: ' + e.message; }
    }
  }

  // 3. Base de datos: fecha mínima, checadas viejas y empleados eliminados
  setAjuste('asistencia_desde', p.desde);
  db.exec('BEGIN');
  try {
    res.checadas_borradas = Number(db.prepare('DELETE FROM registros WHERE fecha_hora < ?').run(p.desde + ' 00:00:00').changes);
    db.prepare('DELETE FROM odoo_asistencias WHERE fecha < ?').run(p.desde);
    let borradasEmp = 0;
    for (const e of p.eliminar) {
      borradasEmp += Number(db.prepare('DELETE FROM registros WHERE empleado_numero = ?').run(e.numero).changes);
      db.prepare('DELETE FROM odoo_asistencias WHERE empleado_id = ?').run(e.id);
      db.prepare('DELETE FROM empleados WHERE id = ?').run(e.id);
    }
    res.checadas_borradas += borradasEmp;
    res.empleados_eliminados = p.eliminar.length;
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  // 4. Checadores
  for (const c of p.checadores) {
    const r = { dispositivo: c.dispositivo, protegidos: (c.protegidos || []).map((u) => u.numero) };
    if (c.error) { r.error = c.error; res.checadores.push(r); continue; }
    const d = db.prepare('SELECT * FROM dispositivos WHERE id = ?').get(c.id);
    if (borrar_en_checador && c.borrar?.length) {
      try { const b = await borrarUsuarios(d.ip_lectura, d.puerto || 4370, c.borrar.map((u) => u.numero)); r.borrados = b.borrados; r.protegidos.push(...b.protegidos); }
      catch (e) { r.error = explicarError(e); }
    }
    if (vaciar_memoria && !r.error) {
      try { await vaciarChecadas(d.ip_lectura, d.puerto || 4370); r.memoria_vaciada = true; }
      catch (e) { r.error = 'No se pudo vaciar la memoria: ' + explicarError(e); }
    }
    res.checadores.push(r);
  }
  res.fecha = nowLocal();
  setAjuste('ultima_depuracion', JSON.stringify(res));
  console.log(`[Depuración] ${res.empleados_eliminados} empleados y ${res.checadas_borradas} checadas eliminados. Respaldo: ${respaldo}`);
  return res;
}

module.exports = { vistaPrevia, aplicar };
