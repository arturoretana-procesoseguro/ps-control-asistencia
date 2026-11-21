'use strict';
/**
 * Estado de huella por empleado y checador:
 *   sin_alta    -> la persona no existe en el checador
 *   sin_huella  -> existe en el checador pero no tiene huella
 *   pendiente   -> RH solicitó el alta: tiene PIN para checar mientras registra su huella
 *   registrada  -> el checador ya tiene su huella
 */
const crypto = require('node:crypto');
const { db } = require('./db');
const { nowLocal } = require('./util');
const { leerUsuariosConHuellas, altaConPin, explicarError } = require('./zk-pull');

const clave = (n) => String(n ?? '').trim().replace(/^0+(?=\d)/, '').toUpperCase();
const dispositivo = (id) => {
  const d = db.prepare("SELECT * FROM dispositivos WHERE id = ? AND marca = 'zkteco'").get(Number(id));
  if (!d) throw new Error('Checador no encontrado');
  if (!d.ip_lectura) throw new Error('Este checador no tiene IP de lectura directa configurada');
  return d;
};
const upsert = db.prepare(`INSERT INTO huellas (empleado_id, dispositivo_id, estado, huellas, revisado_en, registrado_en)
  VALUES (@e, @d, @estado, @huellas, @ahora, @registrado)
  ON CONFLICT(empleado_id, dispositivo_id) DO UPDATE SET estado = excluded.estado, huellas = excluded.huellas, revisado_en = excluded.revisado_en,
    registrado_en = COALESCE(huellas.registrado_en, excluded.registrado_en)`);

function empleadosChecador() {
  return db.prepare(`SELECT e.id, e.numero, e.nombre, e.puesto, e.odoo_id, e.pin_checador, em.nombre empresa
                     FROM empleados e LEFT JOIN empresas em ON em.id = e.empresa_id
                     WHERE e.activo = 1 AND e.tipo IN ('oficina','mixto') ORDER BY e.nombre`).all();
}

/** Lee el checador y actualiza el estado de huella de todos los empleados activos de oficina. */
async function escanear(dispositivoId) {
  const d = dispositivo(dispositivoId);
  let usuarios;
  try { usuarios = await leerUsuariosConHuellas(d.ip_lectura, d.puerto || 4370); }
  catch (e) { throw new Error('No se pudo leer el checador: ' + explicarError(e)); }
  const porNum = new Map(usuarios.map((u) => [clave(u.numero), u]));
  const previos = new Map(db.prepare('SELECT * FROM huellas WHERE dispositivo_id = ?').all(d.id).map((h) => [h.empleado_id, h]));
  const ahora = nowLocal();
  const lecturaHuellas = usuarios.some((u) => u.huellas !== null);
  db.exec('BEGIN');
  try {
    for (const e of empleadosChecador()) {
      const u = porNum.get(clave(e.numero));
      const prev = previos.get(e.id);
      let estado;
      if (!u) estado = prev?.estado === 'pendiente' ? 'pendiente' : 'sin_alta';
      else if (u.huellas > 0) estado = 'registrada';
      else if (u.huellas === null) estado = prev?.estado && prev.estado !== 'sin_alta' ? prev.estado : 'sin_huella';
      else estado = prev?.estado === 'pendiente' ? 'pendiente' : (prev?.estado === 'registrada' && prev.huellas === null ? 'registrada' : 'sin_huella');
      upsert.run({ e: e.id, d: d.id, estado, huellas: u ? u.huellas : null, ahora, registrado: estado === 'registrada' ? ahora : null });
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { lectura_huellas: lecturaHuellas, usuarios_en_checador: usuarios.length };
}

function listar(dispositivoId) {
  const d = db.prepare('SELECT id, nombre, ip_lectura FROM dispositivos WHERE id = ?').get(Number(dispositivoId));
  if (!d) throw new Error('Checador no encontrado');
  const h = new Map(db.prepare('SELECT * FROM huellas WHERE dispositivo_id = ?').all(d.id).map((x) => [x.empleado_id, x]));
  const filas = empleadosChecador().map((e) => {
    const x = h.get(e.id);
    return { ...e, en_odoo: !!e.odoo_id, estado: x?.estado || 'sin_revisar', huellas: x?.huellas ?? null,
      solicitado_por: x?.solicitado_por || null, solicitado_en: x?.solicitado_en || null, registrado_en: x?.registrado_en || null, revisado_en: x?.revisado_en || null };
  });
  const resumen = filas.reduce((a, f) => ((a[f.estado] = (a[f.estado] || 0) + 1), a), {});
  return { dispositivo: d, resumen, filas };
}

function nuevoPin(numero, usados) {
  for (let i = 0; i < 50; i++) {
    const pin = String(crypto.randomInt(1000, 10000));
    if (/^(\d)\1{3}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin) || pin === String(numero) || usados.has(pin)) continue;
    return pin;
  }
  return String(crypto.randomInt(1000, 10000));
}

/**
 * Solicita el registro de huella: da de alta (o actualiza) a las personas en el checador con PIN y las marca como pendientes.
 * El PIN también se guarda en Odoo (campo PIN del empleado) si hay conexión configurada.
 */
async function agregar(dispositivoId, empleadoIds, usuario, { escribirPinOdoo } = {}) {
  const d = dispositivo(dispositivoId);
  const ids = [...new Set((empleadoIds || []).map(Number))].filter(Boolean);
  if (!ids.length) throw new Error('Selecciona al menos un empleado');
  const emps = db.prepare(`SELECT * FROM empleados WHERE activo = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const usados = new Set(db.prepare('SELECT pin_checador p FROM empleados WHERE pin_checador IS NOT NULL').all().map((r) => r.p));
  for (const e of emps) {
    if (!e.pin_checador) { e.pin_checador = nuevoPin(e.numero, usados); usados.add(e.pin_checador); }
  }
  let r;
  try { r = await altaConPin(d.ip_lectura, d.puerto || 4370, emps.map((e) => ({ numero: e.numero, nombre: e.nombre, pin: e.pin_checador }))); }
  catch (e) { throw new Error('No se pudo escribir en el checador: ' + explicarError(e)); }
  const ok = new Set(r.hechos.map((h) => clave(h.numero)));
  const ahora = nowLocal();
  const resultado = [];
  for (const e of emps) {
    if (!ok.has(clave(e.numero))) continue;
    db.prepare('UPDATE empleados SET pin_checador = ? WHERE id = ?').run(e.pin_checador, e.id);
    const prev = db.prepare('SELECT estado FROM huellas WHERE empleado_id = ? AND dispositivo_id = ?').get(e.id, d.id);
    const estado = prev?.estado === 'registrada' ? 'registrada' : 'pendiente';
    db.prepare(`INSERT INTO huellas (empleado_id, dispositivo_id, estado, solicitado_por, solicitado_en, revisado_en) VALUES (?,?,?,?,?,?)
                ON CONFLICT(empleado_id, dispositivo_id) DO UPDATE SET estado = excluded.estado, solicitado_por = excluded.solicitado_por, solicitado_en = excluded.solicitado_en`)
      .run(e.id, d.id, estado, usuario, ahora, ahora);
    let odoo = null;
    if (escribirPinOdoo && e.odoo_id) {
      try { await escribirPinOdoo(e.odoo_id, e.pin_checador); odoo = 'ok'; } catch (err) { odoo = err.message; }
    }
    resultado.push({ id: e.id, numero: e.numero, nombre: e.nombre, pin: e.pin_checador, estado, odoo });
  }
  return { dispositivo: d.nombre, hechos: resultado, errores: r.errores };
}

/** Marca manualmente el estado (p. ej. registrada con rostro). */
function marcar(dispositivoId, empleadoId, estado, usuario) {
  if (!['registrada', 'pendiente', 'sin_huella'].includes(estado)) throw new Error('Estado inválido');
  const ahora = nowLocal();
  db.prepare(`INSERT INTO huellas (empleado_id, dispositivo_id, estado, solicitado_por, revisado_en, registrado_en) VALUES (?,?,?,?,?,?)
              ON CONFLICT(empleado_id, dispositivo_id) DO UPDATE SET estado = excluded.estado, revisado_en = excluded.revisado_en,
              registrado_en = CASE WHEN excluded.estado = 'registrada' THEN excluded.registrado_en ELSE huellas.registrado_en END`)
    .run(Number(empleadoId), Number(dispositivoId), estado, usuario, ahora, estado === 'registrada' ? ahora : null);
  return { ok: true };
}

/** Revisa en segundo plano los checadores con huellas pendientes (lo llama la sincronización). */
async function revisarPendientes(dispositivoId) {
  const n = db.prepare("SELECT COUNT(*) c FROM huellas WHERE dispositivo_id = ? AND estado = 'pendiente'").get(dispositivoId).c;
  if (!n) return null;
  const antes = n;
  await escanear(dispositivoId);
  const despues = db.prepare("SELECT COUNT(*) c FROM huellas WHERE dispositivo_id = ? AND estado = 'pendiente'").get(dispositivoId).c;
  return { registradas: antes - despues, pendientes: despues };
}

module.exports = { escanear, listar, agregar, marcar, revisarPendientes };
