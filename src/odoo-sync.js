'use strict';
/**
 * Sincronización con Odoo:
 *  1. Empleados de Odoo -> sistema (empate por "ID de credencial" = número en el checador).
 *  2. Empleados nuevos de Odoo -> checadores ZKTeco marcados con "Recibir altas de Odoo".
 *  3. Asistencia diaria (entrada y salida) -> Odoo Asistencias (hr.attendance).
 */
const { db } = require('./db');
const { nowLocal } = require('./util');
const { Odoo, localAUtc } = require('./odoo');
const { calcularAsistencia, addDays } = require('./reporte');
const { crearUsuarios, explicarError } = require('./zk-pull');

const CLAVES = ['odoo_url', 'odoo_db', 'odoo_login', 'odoo_api_key', 'odoo_activo', 'odoo_enviar_asist', 'odoo_asist_desde', 'odoo_horario_id'];
const getAjuste = (k) => db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(k)?.valor ?? null;
const setAjuste = (k, v) => db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').run(k, v == null ? null : String(v));

function getConfig({ conSecreto = false } = {}) {
  const c = Object.fromEntries(CLAVES.map((k) => [k, getAjuste(k)]));
  const tiene = !!c.odoo_api_key;
  if (!conSecreto) delete c.odoo_api_key;
  return {
    ...c, tiene_api_key: tiene,
    ultima_sync: getAjuste('odoo_ultima_sync'), ultimo_error: getAjuste('odoo_ultimo_error'),
    resumen: JSON.parse(getAjuste('odoo_resumen') || 'null'),
  };
}
function setConfig(b) {
  for (const k of CLAVES) {
    if (!(k in b)) continue;
    if (k === 'odoo_api_key' && !b[k]) continue; // vacío = conservar la actual
    setAjuste(k, b[k] === '' ? null : b[k]);
  }
  if (!getAjuste('odoo_asist_desde')) setAjuste('odoo_asist_desde', nowLocal().slice(0, 10));
}
function cliente() {
  const c = getConfig({ conSecreto: true });
  return new Odoo({ url: c.odoo_url, db: c.odoo_db, login: c.odoo_login, apiKey: c.odoo_api_key });
}

const clave = (n) => String(n ?? '').trim().replace(/^0+(?=\d)/, '').toUpperCase();
const m2oNombre = (v) => (Array.isArray(v) ? v[1] : null);
const normNombre = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((x) => x.length > 1);
function parecido(a, b) {
  const A = new Set(normNombre(a)), B = new Set(normNombre(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.max(A.size, B.size);
}

async function probar() {
  const o = cliente();
  const version = await o.version().catch(() => null);
  const emps = await o.searchRead('hr.employee', [], ['id', 'name', 'barcode'], { context: { active_test: true } });
  let asistencias = 'ok';
  try { await o.searchRead('hr.attendance', [], ['id'], { limit: 1 }); }
  catch (e) { asistencias = 'Sin acceso a Asistencias: ' + e.message; }
  return {
    version, api: o.modo === 'json2' ? 'JSON-2' : 'JSON-RPC', empleados: emps.length,
    con_credencial: emps.filter((e) => e.barcode).length, asistencias,
  };
}

function empresaId(nombre) {
  if (!nombre) return null;
  const e = db.prepare('SELECT id FROM empresas WHERE lower(nombre) = lower(?)').get(nombre);
  if (e) return e.id;
  return Number(db.prepare('INSERT INTO empresas (nombre) VALUES (?)').run(nombre).lastInsertRowid);
}

/** Números de empleado reservados para personal de campo (no se envían al checador). Ej. ODOO_RANGO_CAMPO=4000-4999 */
function esDeCampo(numero) {
  const m = String(process.env.ODOO_RANGO_CAMPO ?? '4000-4999').match(/^(\d+)-(\d+)$/);
  const n = Number(numero);
  return !!m && /^\d+$/.test(numero) && n >= Number(m[1]) && n <= Number(m[2]);
}

async function sincronizarEmpleados(o) {
  const emps = await o.searchRead('hr.employee', [], ['id', 'name', 'barcode', 'job_title', 'company_id', 'active'], { context: { active_test: false } });
  const locales = db.prepare('SELECT * FROM empleados').all();
  const porOdoo = new Map(locales.filter((l) => l.odoo_id).map((l) => [l.odoo_id, l]));
  const porNum = new Map(locales.map((l) => [clave(l.numero), l]));
  const horarioDef = getAjuste('odoo_horario_id');
  const r = { odoo_total: emps.filter((e) => e.active).length, vinculados: 0, desvinculados: 0, nuevos: [], actualizados: 0, bajas: 0, sin_credencial: [], solo_local: [], conflictos: [] };
  const usados = new Set();

  for (const e of emps) {
    const bc = e.barcode ? clave(e.barcode) : null;
    const loc = bc ? porNum.get(bc) : null;
    // El ID de credencial manda: si el vínculo anterior ya no coincide, se deshace.
    const viejo = porOdoo.get(e.id);
    if (viejo && viejo !== loc && clave(viejo.numero) !== bc) {
      db.prepare('UPDATE empleados SET odoo_id = NULL, activo = CASE WHEN length(numero) > 9 THEN 0 ELSE activo END WHERE id = ?').run(viejo.id);
      viejo.odoo_id = null;
      r.desvinculados++;
    }
    if (!bc) { if (e.active) r.sin_credencial.push({ id: e.id, nombre: e.name }); continue; }
    if (loc && usados.has(loc.id)) { r.conflictos.push(`El número ${loc.numero} está como ID de credencial en más de un empleado de Odoo (${e.name})`); continue; }
    if (loc) {
      usados.add(loc.id);
      const vals = { odoo_id: e.id, nombre: e.name, puesto: e.job_title || loc.puesto, empresa_id: empresaId(m2oNombre(e.company_id)) ?? loc.empresa_id, activo: e.active ? 1 : 0 };
      const cambio = Object.entries(vals).some(([k, v]) => loc[k] !== v);
      if (cambio) {
        db.prepare('UPDATE empleados SET odoo_id=?, nombre=?, puesto=?, empresa_id=?, activo=? WHERE id=?')
          .run(vals.odoo_id, vals.nombre, vals.puesto, vals.empresa_id, vals.activo, loc.id);
        if (loc.activo && !e.active) r.bajas++; else r.actualizados++;
      }
      r.vinculados++;
    } else if (e.active) {
      const numero = String(e.barcode).trim();
      const tipo = esDeCampo(numero) ? 'campo' : 'oficina';
      const id = Number(db.prepare(`INSERT INTO empleados (numero, nombre, puesto, empresa_id, horario_id, tipo, activo, odoo_id)
                                    VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(numero, e.name, e.job_title || null, empresaId(m2oNombre(e.company_id)), horarioDef ? Number(horarioDef) : null, tipo, e.id).lastInsertRowid);
      usados.add(id);
      r.nuevos.push({ numero, nombre: e.name, ...(numero.length > 9 ? { aviso: 'ID de credencial de más de 9 caracteres: no cabe en el checador' } : {}) });
      r.vinculados++;
    }
  }
  const sinCred = r.sin_credencial;
  r.solo_local = db.prepare('SELECT id, numero, nombre FROM empleados WHERE activo = 1 AND odoo_id IS NULL ORDER BY nombre').all()
    .map((l) => {
      const sug = sinCred.map((o2) => ({ ...o2, score: parecido(l.nombre, o2.nombre) })).sort((a, b) => b.score - a.score)[0];
      return { ...l, sugerencia: sug && sug.score >= 0.5 ? { id: sug.id, nombre: sug.nombre } : null };
    });
  return r;
}

/** Crea en los checadores marcados los empleados (de Odoo) que todavía no existen en el equipo. */
async function enviarAltasAChecadores() {
  const devs = db.prepare("SELECT * FROM dispositivos WHERE marca='zkteco' AND estado='activo' AND enviar_altas=1 AND ip_lectura IS NOT NULL AND ip_lectura <> ''").all();
  const res = [];
  for (const d of devs) {
    const emps = db.prepare(`SELECT numero, nombre FROM empleados WHERE activo = 1 AND odoo_id IS NOT NULL AND tipo IN ('oficina','mixto')
                             ${d.sede_id ? 'AND (sede_id = ? OR sede_id IS NULL)' : ''}`).all(...(d.sede_id ? [d.sede_id] : []));
    try {
      const r = await crearUsuarios(d.ip_lectura, d.puerto || 4370, emps);
      res.push({ dispositivo: d.nombre, creados: r.creados, omitidos: r.omitidos.filter((x) => x.motivo !== 'ya existe en el checador') });
      if (r.creados.length) console.log(`[Odoo -> ${d.nombre}] ${r.creados.length} usuarios creados en el checador`);
    } catch (e) {
      res.push({ dispositivo: d.nombre, error: explicarError(e) });
    }
  }
  return res;
}

async function enviarAsistencias(o) {
  if (getAjuste('odoo_enviar_asist') !== '1') return { activo: false };
  const hoy = nowLocal().slice(0, 10);
  let desde = getAjuste('odoo_asist_desde') || hoy;
  const limite = addDays(hoy, -60);
  if (desde < limite) desde = limite;
  const filas = calcularAsistencia({ desde, hasta: hoy }).filter((f) => f.entrada && f.salida);
  const emp = new Map(db.prepare('SELECT id, odoo_id FROM empleados WHERE odoo_id IS NOT NULL').all().map((e) => [e.id, e.odoo_id]));
  const r = { activo: true, desde, enviadas: 0, actualizadas: 0, sin_cambio: 0, errores: [] };
  for (const f of filas) {
    const odooEmp = emp.get(f.empleado_id);
    if (!odooEmp) continue;
    const ci = localAUtc(`${f.fecha} ${f.entrada}:00`), co = localAUtc(`${f.fecha} ${f.salida}:00`);
    const prev = db.prepare('SELECT * FROM odoo_asistencias WHERE empleado_id = ? AND fecha = ?').get(f.empleado_id, f.fecha);
    if (prev?.odoo_id && prev.check_in === ci && prev.check_out === co) { r.sin_cambio++; continue; }
    try {
      let id = prev?.odoo_id;
      if (id) { await o.write('hr.attendance', id, { check_in: ci, check_out: co }); r.actualizadas++; }
      else { id = await o.create('hr.attendance', { employee_id: odooEmp, check_in: ci, check_out: co }); r.enviadas++; }
      db.prepare(`INSERT INTO odoo_asistencias (empleado_id, fecha, odoo_id, check_in, check_out, error, enviado_en) VALUES (?,?,?,?,?,NULL,?)
                  ON CONFLICT(empleado_id, fecha) DO UPDATE SET odoo_id=excluded.odoo_id, check_in=excluded.check_in, check_out=excluded.check_out, error=NULL, enviado_en=excluded.enviado_en`)
        .run(f.empleado_id, f.fecha, id, ci, co, nowLocal());
    } catch (e) {
      const msg = String(e.message).slice(0, 300);
      db.prepare(`INSERT INTO odoo_asistencias (empleado_id, fecha, error) VALUES (?,?,?)
                  ON CONFLICT(empleado_id, fecha) DO UPDATE SET error=excluded.error`).run(f.empleado_id, f.fecha, msg);
      r.errores.push(`${f.fecha} ${f.nombre}: ${msg}`);
    }
  }
  r.errores = r.errores.slice(0, 30);
  return r;
}

let ocupado = false;
async function sincronizarTodo() {
  if (ocupado) throw new Error('Ya hay una sincronización con Odoo en curso');
  ocupado = true;
  try {
    const o = cliente();
    const empleados = await sincronizarEmpleados(o);
    const checadores = await enviarAltasAChecadores();
    const asistencias = await enviarAsistencias(o);
    const resumen = { fecha: nowLocal(), empleados, checadores, asistencias };
    setAjuste('odoo_resumen', JSON.stringify(resumen));
    setAjuste('odoo_ultima_sync', resumen.fecha);
    setAjuste('odoo_ultimo_error', null);
    return resumen;
  } catch (e) {
    setAjuste('odoo_ultimo_error', `${nowLocal()} · ${e.message}`);
    throw e;
  } finally { ocupado = false; }
}

/** Vincula un empleado local con uno de Odoo escribiendo el número del checador como ID de credencial en Odoo. */
async function vincular(empleadoId, odooId) {
  const loc = db.prepare('SELECT * FROM empleados WHERE id = ?').get(Number(empleadoId));
  if (!loc) throw new Error('Empleado no encontrado');
  const o = cliente();
  const [e] = await o.searchRead('hr.employee', [['id', '=', Number(odooId)]], ['id', 'name', 'barcode', 'job_title'], { context: { active_test: false } });
  if (!e) throw new Error('El empleado no existe en Odoo');
  if (e.barcode && clave(e.barcode) !== clave(loc.numero)) throw new Error(`En Odoo ya tiene el ID de credencial ${e.barcode}`);
  if (!e.barcode) await o.write('hr.employee', e.id, { barcode: loc.numero });
  db.prepare('UPDATE empleados SET odoo_id = ?, nombre = ?, puesto = COALESCE(?, puesto) WHERE id = ?').run(e.id, e.name, e.job_title || null, loc.id);
  return { ok: true, nombre: e.name };
}

function iniciarProgramador() {
  const min = Number(process.env.ODOO_SYNC_MIN ?? 10);
  if (!min) return;
  setInterval(async () => {
    if (getAjuste('odoo_activo') !== '1' || ocupado) return;
    try { await sincronizarTodo(); } catch (e) { console.log('[Odoo] ' + e.message); }
  }, min * 60e3);
  console.log(`  Sincronización con Odoo: cada ${min} min (si está activada)`);
}

/** Guarda el PIN del empleado en Odoo (campo "PIN" de la ficha), si hay conexión configurada. */
async function escribirPin(odooId, pin) {
  if (!getAjuste('odoo_api_key')) return null;
  await cliente().write('hr.employee', Number(odooId), { pin: String(pin) });
  return true;
}

module.exports = { escribirPin, getConfig, setConfig, probar, sincronizarTodo, vincular, iniciarProgramador };
